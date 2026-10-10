//! # freshell-freshagent — the fresh-agent REST surface (opencode slice)
//!
//! The additive Phase 3.7 wiring that lets the equivalence oracle drive a live
//! opencode/Kimi T2 turn THROUGH the Rust server exactly as it drives the original,
//! and prove `original≡rust` at T2. A faithful port of the opencode path of
//! `server/agent-api/router.ts` (create-tab / send-keys / capture) on top of the
//! [`freshell_opencode`] serve client (`real-transport`).
//!
//! ## Surface (only what the opencode T2 invariant set + baseline need)
//!
//! | Route | Ports | Behaviour |
//! |---|---|---|
//! | `POST /api/tabs {agent:'opencode',…}` | `router.ts:695` + `createFreshAgentPane:546` | mint a `freshopencode-*` placeholder pane (NO serve yet — lazy), broadcast `ui.command{tab.create}`, return `{data:{tabId,paneId,sessionId}}` |
//! | `POST /api/panes/:id/send-keys` | `router.ts:1669` | **cold-start** the `opencode serve` (DEV-0001 fix → NO warm-proxy), create the durable `ses_*`, broadcast `freshAgent.session.materialized` + `sessions.changed`, drive one turn, resolve on the **idle edge** (`status:'idle'`) |
//! | `GET /api/panes/:id/capture` | `router.ts:904` | render the transcript (`listMessages`) as text |
//!
//! ## Cold-start = the DEV-0001 fingerprint
//!
//! The original needs an `OPENCODE_CMD` warm-proxy to step around DEV-0001's cold-serve
//! health-probe wedge. The Rust port carries the fix natively ([`freshell_opencode`]'s
//! bounded per-probe health wait), so the first `send-keys` cold-starts the real serve
//! with **no warm-proxy** — the observable fingerprint the T2-rust test asserts.
//!
//! ## Broadcasts
//!
//! `ui.command` / `freshAgent.session.materialized` / `sessions.changed` are pushed as
//! pre-serialized [`freshell_protocol`] frames onto a shared [`tokio::sync::broadcast`]
//! bus that the `freshell-ws` connections fan out to every client (incl. the oracle's
//! capture socket), so its `wsServerMessageTypes` set matches the original baseline.
//!
//! ## Safety
//!
//! All session data lands under the server's **isolated HOME** (the real `opencode serve`
//! writes `<HOME>/.local/share/opencode/opencode.db`); the user's store is never touched.
//! The spawned serve inherits the server's ownership sentinels and is reaped by
//! [`FreshAgentState::shutdown`] (SIGTERM + the `/proc` ownership sweep) and, as a
//! backstop, by the harness sentinel sweep — no orphans.

pub mod claude;
pub(crate) mod claude_snapshot;
pub mod codex;
pub(crate) mod codex_sidecar_tracking;
pub mod hosted_rest;
pub mod identity_sink;
pub mod layout_store;
pub mod layout_tree;
pub mod model_capabilities;
pub mod naming;
pub mod native_history;
pub mod opencode_ws;
pub mod pane_ops;
mod pane_resize;
pub mod rollback_record;
pub mod session_handoff;
pub mod session_lease;
pub mod session_metadata;
pub mod snapshot;
pub mod spawn_gate;
pub(crate) mod summary;
pub mod target_resolver;
pub mod terminal_tabs;

pub use claude::FreshClaudeState;
// Kata 09v1 + SYNC-06: the TWO claude_snapshot items visible outside this
// crate — the raw-file existence check freshell-server's IndexExistenceProbe
// shares with the attach arm, and the original-cwd reader the resume-resolve
// claude fallback pairs with it (`claude-transcript-locator.ts` parity).
// Keep the rest of claude_snapshot crate-private.
pub use claude_snapshot::{
    locate_transcript, locate_transcript_checked, locate_transcript_selected, transcript_cwd,
    transcript_cwd_bounded, transcript_cwd_checked, SelectedTranscript,
};
pub use codex::FreshCodexState;
pub use identity_sink::{
    BindProvenance, ClaimCommit, CloseAnswer, FreshAgentBindingUpsert, FreshAgentSettings,
    PaneIdentitySink, ProvenanceUpdate, SharedPaneIdentitySink, SinkAliasClearWrite,
    SinkCloseError, SinkCloseWrite, SinkCommitWrite, SinkWrite,
};
pub use opencode_ws::FreshOpencodeState;
pub use rollback_record::{
    now_ms, rollback_ack_frame, rollback_broadcast_frame, rollback_error_frame, RollbackDirection,
    RollbackEntry, RollbackModeReq, RollbackRecord, RollbackRequest, CODEX_OLD_CLI_COPY,
    LEDGER_WRITE_REFUSAL_COPY, OPENCODE_OLD_CLI_COPY, REDO_DESTROYED_MESSAGE, REDO_EMPTY_MESSAGE,
    REDO_REMOVED_HISTORY_COPY, ROLLBACK_BUSY_MESSAGE, ROLLBACK_RECORD_VERSION, UNDO_EMPTY_MESSAGE,
};
pub use snapshot::SnapshotState;
pub use spawn_gate::{SpawnGate, SpawnGateError};
// Unified agent names (Task 1): the injected naming interface the store
// (freshell-server) implements and WS/fresh composition consumes.
pub use naming::{
    BindNameInput, NameActivity, NameActivityReason, NameError, NameFuture, NameTransition,
    NameTransitionReason, NamingSink, NativeNameObservation, NativeNameOrigin, PendingNameInput,
    RenameNameInput, SessionNaming,
};

/// Task 13b: the injected cross-kind liveness probe -- `(provider, session_id) -> bool`,
/// true when a live terminal PTY currently owns that session. Constructed by
/// `freshell-server`'s `main.rs` over the SAME probes the terminal D7 create-rung guard
/// uses (identity owner + registry row), so this crate never imports `freshell-ws`.
/// Defaults to "always false" (behavior-preserving for constructors that don't wire it).
pub type TerminalLivenessProbe = std::sync::Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;

/// Door 3 (resume-validation): the gate-fired callback shape --
/// `(provider, stale_session_id)`. In production, `freshell-server`'s main.rs
/// implements it as pane-ledger `retire_missing` + `tracing::warn!`.
pub type OnStaleResume = std::sync::Arc<dyn Fn(&str, &str) + Send + Sync>;

/// Door 3 (resume-validation): the injected ASYNC sidecar-liveness probe --
/// `(mode, session_id) -> is that session live inside a fresh-agent sidecar`.
/// The REST create gate's registry consult is `TerminalRegistry`/PTY-scoped
/// and structurally BLIND to sessions live inside the fresh-agent sidecars
/// (sidecars never get PTY rows), so the in-gate liveness precondition needs
/// this second arm. Precedent: [`TerminalLivenessProbe`] solves the SAME
/// cross-crate liveness problem in the opposite direction -- same shape, made
/// async. Constructed by `freshell-server`'s `main.rs` over the SAME sidecar
/// instances the WS door's D7 join consults, so this crate never imports
/// `freshell-ws`. `None` (not wired, e.g. bare unit-test states) => the arm
/// contributes false.
pub type SidecarLivenessProbe = std::sync::Arc<
    dyn Fn(&str, &str) -> std::pin::Pin<Box<dyn std::future::Future<Output = bool> + Send>>
        + Send
        + Sync,
>;

/// Handle pairing the shared gate with the permit-wait timeout
/// (`CreateProtectConfig.spawn_timeout_ms`, resolved once in main.rs so both
/// doors share one env snapshot).
#[derive(Clone)]
pub(crate) struct RestSpawnGate {
    pub(crate) gate: Arc<spawn_gate::SpawnGate>,
    pub(crate) timeout: std::time::Duration,
}

/// One call shape for every fresh-agent provider's coordinator claim (kata
/// b8ke Task 3). The claim happens FIRST (before the provider lease) at every
/// lifecycle entry point — the coordinator is the cross-kind authority; the
/// provider lease stays as the same-kind/TTL backstop.
pub mod ownership_lane {
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    use freshell_ownership::{
        BeginOutcome, CommitOutcome, FailOutcome, ObservedFence, OperationTicket, OwnerIdentity,
        ReleaseClaim, RuntimeOwnerKind, RuntimeOwnershipRegistry, StopClaim, StopOutcome,
    };

    /// The typed half-fence refusal (b8ke delta review F7): a lifecycle
    /// request carried exactly ONE of the observed epoch/generation pair.
    /// The pair is one fence — half of it is not "no fence", it is an
    /// invalid one, and the caller must answer the typed error without
    /// touching the coordinator (never the silent legacy downgrade, which
    /// let an old-generation half-fenced request recreate a runtime after
    /// the key went Vacant).
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub struct WireFenceError;

    impl WireFenceError {
        /// The stable typed error code carried by every refusal surface
        /// (WS error frames, REST 400 bodies).
        pub fn code(&self) -> &'static str {
            "INVALID_FENCE"
        }

        /// The refusal message (the wire pair must arrive complete).
        pub fn message(&self) -> &'static str {
            "observedEpoch and observedGeneration must be sent together — a half-fence is invalid"
        }
    }

    /// The stamp a lane retains beside its live-session entry after
    /// `commit_live` (round-2 review): the later `StopClaim` (explicit kill)
    /// and `ReleaseClaim` (exit watcher) source — the believed runtime
    /// identity plus the `(epoch, generation)` its commit stamped.
    #[derive(Clone, Debug)]
    pub struct OwnershipStamp {
        pub epoch: u64,
        pub generation: u64,
        pub operation_id: String,
        pub owner: OwnerIdentity,
    }

    impl OwnershipStamp {
        /// The fenced stop claim an explicit `freshAgent.kill` carries
        /// (round-2 review): the lane's believed runtime identity plus the
        /// `(epoch, generation)` its `commit_live` stamped.
        pub fn stop_claim(&self) -> StopClaim {
            StopClaim {
                expected_kind: RuntimeOwnerKind::FreshAgent,
                expected_runtime: Some(self.owner.clone()),
                observed: ObservedFence {
                    epoch: self.epoch,
                    generation: self.generation,
                },
            }
        }

        /// The fenced release claim an exit watcher carries (round-1 review):
        /// a delayed watcher event can never erase a newer owner or an
        /// in-flight handoff — the registry no-ops on any mismatch.
        pub fn release_claim(&self) -> ReleaseClaim {
            ReleaseClaim {
                operation_id: self.operation_id.clone(),
                generation: self.generation,
                runtime: Some(self.owner.clone()),
            }
        }
    }

    /// The per-lane retained-commit index: canonical session id → the stamp
    /// its `commit_live` left (round-2 review: kill paths build their fenced
    /// `StopClaim`s from here; exit watchers take + release theirs). Shared
    /// between the REST state and the WS opencode slice (a REST-materialized
    /// `ses_*` can be killed through the WS lane and vice versa).
    pub type OwnershipStamps = Arc<Mutex<HashMap<String, OwnershipStamp>>>;

    /// What an exit watcher needs to release coordinator ownership on
    /// natural exit (kata b8ke Task 3): the registry + the lane's retained
    /// stamps, captured at spawn time; the watcher takes the stamp at exit
    /// and releases with its fenced claim (a delayed watcher can never
    /// erase a newer owner or an in-flight handoff — the registry no-ops on
    /// mismatch).
    #[derive(Clone)]
    pub struct OwnershipWatch {
        pub registry: Arc<RuntimeOwnershipRegistry>,
        pub stamps: OwnershipStamps,
        pub provider: &'static str,
        /// Runtime identity captured when the watcher takes ownership of a
        /// sidecar. A watcher without this identity must not consume a
        /// retained stamp: a replacement may already use the same session id.
        expected_runtime: Option<OwnerIdentity>,
    }

    impl OwnershipWatch {
        pub fn new(
            registry: Arc<RuntimeOwnershipRegistry>,
            stamps: OwnershipStamps,
            provider: &'static str,
        ) -> Self {
            Self {
                registry,
                stamps,
                provider,
                expected_runtime: None,
            }
        }

        /// Bind this watch to the child runtime it observes. The coordinator
        /// stamp is created at the registration tail, after the watcher is
        /// constructed, so the watcher fills in the concrete pid here before
        /// either exit branch can run.
        pub fn for_runtime(mut self, session_id: &str, pid: Option<u32>) -> Self {
            self.expected_runtime = Some(OwnerIdentity {
                kind: RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some(session_id.to_string()),
                pid,
                ownership_id: None,
                unit_id: None,
                hold: freshell_ownership::HoldKind::Main,
            });
            self
        }

        /// Take the retained stamp (if any) and release it — the exit
        /// watcher's natural-death hook.
        pub fn release(&self, session_id: &str, initiator: &str) -> bool {
            release_retained_stamp_if_matches(
                &Some(Arc::clone(&self.registry)),
                &self.stamps,
                self.provider,
                session_id,
                initiator,
                self.expected_runtime.as_ref(),
            )
        }

        /// Record a natural exit whose complete writer tree is not yet
        /// confirmed. The retained stamp supplies the exact coordinator
        /// operation/generation; a mismatched replacement is ignored.
        pub fn fence_unconfirmed(
            &self,
            session_id: &str,
            reason: freshell_ownership::FenceReason,
        ) -> freshell_ownership::FenceOutcome {
            let Some(expected_runtime) = self.expected_runtime.as_ref() else {
                return freshell_ownership::FenceOutcome::ForeignOperation;
            };
            let Some(stamp) = peek_retained_stamp(&self.stamps, session_id) else {
                return freshell_ownership::FenceOutcome::ForeignOperation;
            };
            if stamp.owner.kind != expected_runtime.kind
                || stamp.owner.terminal_id != expected_runtime.terminal_id
                || stamp.owner.live_session_key != expected_runtime.live_session_key
                || stamp.owner.pid != expected_runtime.pid
            {
                return freshell_ownership::FenceOutcome::ForeignOperation;
            }
            self.registry.fence_unconfirmed_live(
                self.provider,
                session_id,
                &stamp.operation_id,
                stamp.generation,
                &stamp.owner,
                reason,
            )
        }

        /// Release a confirmed runtime from either `Live` or the typed
        /// `Fenced` state. The latter is the natural-exit recovery path;
        /// `release` alone intentionally no-ops while fenced.
        pub fn release_confirmed(&self, session_id: &str, initiator: &str) {
            if self.release(session_id, initiator) {
                return;
            }
            let Some(expected_runtime) = self.expected_runtime.as_ref() else {
                return;
            };
            let Some(stamp) = peek_retained_stamp(&self.stamps, session_id) else {
                return;
            };
            if stamp.owner.kind != expected_runtime.kind
                || stamp.owner.terminal_id != expected_runtime.terminal_id
                || stamp.owner.live_session_key != expected_runtime.live_session_key
                || stamp.owner.pid != expected_runtime.pid
            {
                return;
            }
            if matches!(
                self.registry.release_fenced(
                    self.provider,
                    session_id,
                    &stamp.operation_id,
                    stamp.generation,
                ),
                CommitOutcome::Committed
            ) {
                let _ = take_retained_stamp_if_matches(&self.stamps, session_id, expected_runtime);
            }
        }
    }

    /// The `(epoch, generation)` wire pair a lifecycle message carried, as
    /// the fence the coordinator consumes. Neither field sent (legacy
    /// unfenced sender) → `Ok(None)` — still cross-kind-checked, just not
    /// stale-fenced. Exactly ONE of the pair sent → the typed
    /// [`WireFenceError`] refusal (b8ke delta review F7): a half-fence is
    /// never silently downgraded to the unfenced legacy path — an
    /// old-generation half-fenced request must not be able to reacquire a
    /// Vacant key as if it had observed nothing.
    pub fn wire_fence(
        epoch: Option<u64>,
        generation: Option<u64>,
    ) -> Result<Option<ObservedFence>, WireFenceError> {
        match (epoch, generation) {
            (Some(epoch), Some(generation)) => Ok(Some(ObservedFence { epoch, generation })),
            (None, None) => Ok(None),
            (Some(_), None) | (None, Some(_)) => Err(WireFenceError),
        }
    }

    /// b8ke focused ep5 r1 F1: the reclaim-less lanes' coordinator-backed
    /// OP GUARD — the opencode compact/fork/rollback lanes' fence, backing
    /// the ext-r29 snapshot consult with the REAL coordinator machinery
    /// (the attach guard, the same discipline the claude rollback's Adopt
    /// arm uses). Pre-ep5-r1 the consult was a bare unlocked snapshot
    /// comparison: it verified neither the record's state nor the owner
    /// kind, held NOTHING through the provider mutation, and let
    /// legacy-unfenced requests pass unconditionally — a handoff could
    /// begin the instant the check passed, then advance the generation
    /// while the old-kind operation mutated history or minted and
    /// committed a child. The guard closes the check-then-act window
    /// structurally: [`LaneOpGuard::Armed`] HOLDS the coordinator's
    /// attach guard (a concurrent `begin_handoff`/`begin_stop` answers
    /// the typed `Blocked` outcome until the guard drops), the record
    /// under it is verified `Live{FreshAgent}`, a supplied pair is
    /// validated atomically at arm time, and a legacy-unfenced request
    /// routes through the SAME guard with the coordinator's current pair
    /// — never an unconditional pass into mutation.
    pub enum LaneOpGuard {
        /// Armed and HELD: concurrent lifecycle begins answer Blocked
        /// until the guard drops. The caller MUST hold it across its
        /// provider mutation (and commit), releasing only after.
        Armed(freshell_ownership::AttachGuard),
        /// No coordinator wired (the legacy no-coordinator lane proceeds
        /// unguarded — there is nothing to serialize).
        Unwired,
        /// The typed refusal (the wire message names the reason): a
        /// lifecycle transition owns the key, the record is not
        /// `Live{FreshAgent}` (a terminal owner or a vacated/crashed
        /// shape), or the supplied observed pair is stale. Every arm
        /// answers the lanes' typed `SESSION_RESERVED` surface.
        Refused { message: String },
    }

    /// Arm the reclaim-less op guard (see [`LaneOpGuard`]). The
    /// `operation_id` names the guard on the coordinator's arm/blocked
    /// events (diagnosability); `observed` is the request's wire-parsed
    /// pair (`None` = legacy-unfenced — against a Live{FreshAgent} key
    /// that is the typed FENCE_REQUIRED refusal (ep5 r4 F2: an unfenced
    /// history mutation can never be told apart from a current one, so it
    /// never arms); every other state still routes through the guard with
    /// the coordinator's CURRENT pair, captured atomically at arm time —
    /// the under-guard verification refuses those states typed anyway).
    pub fn arm_reclaimless_op_guard(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
    ) -> LaneOpGuard {
        let Some(registry) = registry.as_ref() else {
            return LaneOpGuard::Unwired;
        };
        let snap = registry.observe(provider, session_id);
        // The supplied pair's epoch must be THIS boot's — the boot epoch is
        // constant per process, so this pre-check is exact (never a
        // check-then-act): a cross-epoch pair is a pre-restart observation,
        // stale on its face.
        if let Some(fence) = observed {
            if fence.epoch != snap.epoch {
                tracing::warn!(target: "freshell_ownership",
                    operation_id = %operation_id, provider = %provider,
                    session_id = %session_id, initiator,
                    observed_epoch = fence.epoch, observed_generation = fence.generation,
                    current_epoch = snap.epoch, current_generation = snap.generation,
                    event = "ownership.op_guard.refused",
                    outcome = "refused", failure_reason = "STALE_GENERATION",
                    "the op guard refused to arm (the observed pair is from a \
                     pre-restart epoch) — the operation aborts typed");
                return LaneOpGuard::Refused {
                    message: STALE_OP_GUARD_MESSAGE.to_string(),
                };
            }
        }
        // b8ke focused ep5 r4 F2 + ep5 r5 F3: an UNFENCED history mutation
        // (compact/rollback/fork — `observed == None`, the legacy client
        // shape) REFUSES typed — never laundered to the coordinator's
        // CURRENT generation. The round-4 reviewer's hazard: a request
        // queued under generation N, received after the session moved away
        // and returned to Fresh Agent at N+2, was made indistinguishable
        // from a current request (the laundered pair armed the guard, the
        // stale operation mutated newer history or minted a child from
        // it) — the later claim can detect an ownership change occurring
        // AFTER an observation, but nothing can detect that an unfenced
        // request was already stale ON ARRIVAL. The refusal is the
        // actionable contract: the client re-observes the owner record and
        // retries WITH the pair.
        //
        // ep5 r5 F3: the absence decision moved OUT of this pre-arm
        // snapshot INTO the ARMED branch below — the snapshot was a
        // TOCTOU: it could see `Handoff`, the handoff then commit or
        // restore `Live{FreshAgent}` at the SAME generation before the
        // arm call, and the laundered pair armed successfully over the
        // newly established owner. An ARMED attach guard proves the record
        // was `Live{FreshAgent}` AT ARM TIME (the coordinator's own
        // atomic decision), so deciding the absence UNDER the guard is
        // race-free: whichever way the pre-arm snapshot went, an unfenced
        // op that arms is refused, and an op over any non-Live state is
        // refused by the arm itself (the accurate LIFECYCLE/STALE answers
        // for in-flight handoffs and moved-on keys).
        #[cfg(test)]
        OP_GUARD_INTERLOCK.wait_if_targeted(provider, session_id);
        let observed_generation = observed
            .map(|fence| fence.generation)
            .unwrap_or(snap.generation);
        match registry.begin_attach_guard(
            provider,
            session_id,
            operation_id,
            Some(observed_generation),
            initiator,
        ) {
            freshell_ownership::AttachGuardOutcome::Armed(guard) => {
                let guard = *guard;
                // b8ke focused ep5 r5 F3: THE UNFENCED DECISION, UNDER THE
                // GUARD. An armed attach guard proves the record was
                // `Live{FreshAgent}` AT ARM TIME (the coordinator's atomic
                // decision) — so an unfenced history mutation that armed is
                // refused HERE regardless of what the pre-arm snapshot
                // saw: the r4 snapshot-based refusal missed the window
                // where the snapshot saw `Handoff` and the handoff
                // committed `Live{FreshAgent}` at the same generation
                // before the arm — the laundered pair armed over the
                // newly established owner and the stale op mutated it.
                if observed.is_none() {
                    let under = registry.observe(provider, session_id);
                    tracing::warn!(target: "freshell_ownership",
                        operation_id = %operation_id, provider = %provider,
                        session_id = %session_id, initiator,
                        epoch = under.epoch, generation = under.generation,
                        state = ?under.state,
                        event = "ownership.op_guard.refused",
                        outcome = "refused", failure_reason = "FENCE_REQUIRED",
                        "the op guard refused the unfenced history mutation under the \
                         armed guard (the record was Live{{FreshAgent}} at arm time) — \
                         the operation aborts typed; the client re-observes and \
                         retries with the pair"
                    );
                    drop(guard);
                    return LaneOpGuard::Refused {
                        message: FENCE_REQUIRED_OP_GUARD_MESSAGE.to_string(),
                    };
                }
                // Verify `Live{FreshAgent}` UNDER the guard — stable now
                // (lifecycle begins answer Blocked while it is held): a
                // current-generation request over a TERMINAL-owned key (a
                // completed handoff) refuses typed here, never mutating
                // another kind's session.
                let under = registry.observe(provider, session_id);
                match under.state {
                    freshell_ownership::OwnershipState::Live { owner, .. }
                        if owner.kind == RuntimeOwnerKind::FreshAgent =>
                    {
                        LaneOpGuard::Armed(guard)
                    }
                    other => {
                        tracing::warn!(target: "freshell_ownership",
                            operation_id = %operation_id, provider = %provider,
                            session_id = %session_id, initiator,
                            state = ?other, epoch = under.epoch, generation = under.generation,
                            event = "ownership.op_guard.refused",
                            outcome = "refused", failure_reason = "NOT_FRESH_AGENT_LIVE",
                            "the op guard armed over a non-fresh-agent owner — the \
                             operation aborts typed and the guard releases");
                        drop(guard);
                        LaneOpGuard::Refused {
                            message: KIND_OP_GUARD_MESSAGE.to_string(),
                        }
                    }
                }
            }
            freshell_ownership::AttachGuardOutcome::Refused { state, generation } => {
                tracing::warn!(target: "freshell_ownership",
                    operation_id = %operation_id, provider = %provider,
                    session_id = %session_id, initiator,
                    state = ?state, generation,
                    event = "ownership.op_guard.refused",
                    outcome = "refused", failure_reason = "LIFECYCLE_IN_FLIGHT",
                    "the op guard refused to arm (a lifecycle transition owns the \
                     key, or the record is not Live) — the operation aborts typed, \
                     nothing is mutated");
                LaneOpGuard::Refused {
                    message: LIFECYCLE_OP_GUARD_MESSAGE.to_string(),
                }
            }
            freshell_ownership::AttachGuardOutcome::StaleGeneration {
                current_epoch: _,
                current_generation,
            } => {
                tracing::warn!(target: "freshell_ownership",
                    operation_id = %operation_id, provider = %provider,
                    session_id = %session_id, initiator,
                    observed_generation, current_generation,
                    event = "ownership.op_guard.refused",
                    outcome = "refused", failure_reason = "STALE_GENERATION",
                    "the op guard refused to arm (the observed generation is \
                     stale) — the operation aborts typed, nothing is mutated");
                LaneOpGuard::Refused {
                    message: STALE_OP_GUARD_MESSAGE.to_string(),
                }
            }
        }
    }

    /// The typed-stale wire message ([`LaneOpGuard::Refused`]'s stale arms).
    pub const STALE_OP_GUARD_MESSAGE: &str =
        "the session moved to a newer ownership generation; refresh and retry";
    /// The lifecycle-in-flight / non-Live wire message.
    pub const LIFECYCLE_OP_GUARD_MESSAGE: &str =
        "A lifecycle operation owns this session; retry after it settles";
    /// The terminal-owner / non-fresh-agent wire message.
    pub const KIND_OP_GUARD_MESSAGE: &str =
        "The session is owned by another runtime kind; reopen it as that kind instead";
    /// b8ke focused ep5 r4 F2: the unfenced-history-mutation wire message —
    /// the typed fence-required refusal the client can act on (re-observe
    /// the session's owner record, then retry WITH the observed pair).
    pub const FENCE_REQUIRED_OP_GUARD_MESSAGE: &str =
        "the request carried no observed ownership pair; re-observe the session's \
         owner record and retry";

    /// b8ke focused ep5 r5 F3 (test-only): the op guard's deterministic
    /// INTERLOCK — parks the guard's pre-arm sequence for ONE targeted
    /// (provider, session_id) so a test can drive the observe→arm race
    /// window deterministically (the snapshot sees one state; the test moves
    /// the coordinator; the released arm sees another). Targeted by key so
    /// concurrent tests' guard calls pass through untouched.
    #[cfg(test)]
    pub(crate) static OP_GUARD_INTERLOCK: OpGuardInterlock = OpGuardInterlock {
        target: std::sync::Mutex::new(None),
        reached: std::sync::atomic::AtomicBool::new(false),
        gate: std::sync::Mutex::new(false),
        cv: std::sync::Condvar::new(),
    };

    #[cfg(test)]
    pub(crate) struct OpGuardInterlock {
        target: std::sync::Mutex<Option<(String, String)>>,
        reached: std::sync::atomic::AtomicBool,
        gate: std::sync::Mutex<bool>,
        cv: std::sync::Condvar,
    }

    #[cfg(test)]
    impl OpGuardInterlock {
        /// Arm the park for one (provider, session_id) — only that key parks.
        /// Re-arming resets the arrival flag (a fresh park window).
        pub(crate) fn arm(&self, provider: &str, session_id: &str) {
            *self.target.lock().expect("interlock target") =
                Some((provider.to_string(), session_id.to_string()));
            self.reached
                .store(false, std::sync::atomic::Ordering::SeqCst);
        }

        /// Has the targeted guard call reached the park?
        pub(crate) fn reached(&self) -> bool {
            self.reached.load(std::sync::atomic::Ordering::SeqCst)
        }

        /// Release the parked call and disarm the interlock (idempotent).
        pub(crate) fn release(&self) {
            *self.target.lock().expect("interlock target") = None;
            let mut gate = self.gate.lock().expect("interlock gate");
            *gate = true;
            self.cv.notify_all();
        }

        fn wait_if_targeted(&self, provider: &str, session_id: &str) {
            let targeted = self
                .target
                .lock()
                .expect("interlock target")
                .as_ref()
                .is_some_and(|(p, s)| p == provider && s == session_id);
            if !targeted {
                return;
            }
            self.reached
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let mut gate = self.gate.lock().expect("interlock gate");
            while !*gate {
                gate = self.cv.wait(gate).expect("interlock condvar");
            }
        }
    }

    /// Claim; on Granted the caller wraps the result in an `OperationTicket`
    /// (Task 1's RAII guard — drop = typed fail) so a panicked spawn cannot
    /// wedge the session.
    pub fn claim_fresh_agent_ownership(
        registry: &Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        now_ms: u64,
    ) -> BeginOutcome {
        registry.begin_start(
            provider,
            session_id,
            RuntimeOwnerKind::FreshAgent,
            operation_id,
            observed,
            initiator,
            now_ms,
        )
    }

    pub fn commit_fresh_agent_ownership(
        registry: &Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
        owner: OwnerIdentity,
    ) -> CommitOutcome {
        registry.commit_live(provider, session_id, operation_id, generation, owner)
    }

    pub fn fail_fresh_agent_ownership(
        registry: &Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> FailOutcome {
        registry.fail(
            provider,
            session_id,
            operation_id,
            generation,
            /* prior_confirmed_live */ false,
        )
    }

    /// Kill path, FIRST HALF (round-1 review): `Live{fresh-agent}` →
    /// `Stopping` (blocks competing starts). FENCED (round-2 review): the
    /// lane passes its `StopClaim` — the believed runtime identity from its
    /// own live-session entry plus the `(epoch, generation)` its
    /// `commit_live` stamped (retained beside that entry; the wire pair on
    /// `freshAgent.kill` feeds it when present). The CALLER then performs
    /// the kill while `Stopping` and finishes with `commit_fresh_agent_stop`
    /// ONLY after the awaited, confirmed reap — never Vacant before the
    /// reap. `BlockedHandoff`: the caller must NOT kill (an in-flight
    /// handoff owns the transition). `StaleClaim`: the caller must NOT kill
    /// (the current owner does not match the lane's believed runtime/fence —
    /// round-2 review). `NotLive` during another transition: the caller may
    /// still kill its own runtime but skips the commit.
    pub fn begin_fresh_agent_stop(
        registry: &Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        claim: &StopClaim,
        initiator: &str,
        now_ms: u64,
    ) -> StopOutcome {
        registry.begin_stop(provider, session_id, operation_id, claim, initiator, now_ms)
    }

    /// Kill path, SECOND HALF: `Stopping{op}` → `Vacant` after the caller
    /// has confirmed the reap (the awaited sidecar/serve exit).
    pub fn commit_fresh_agent_stop(
        registry: &Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> CommitOutcome {
        registry.commit_stop(provider, session_id, operation_id, generation)
    }

    /// Exit-watcher release (round-1 review: FENCED). The watcher captures
    /// the `ReleaseClaim` (operation id, generation, runtime identity) when
    /// it registers; a delayed event can never erase a newer owner or an
    /// in-flight handoff — the registry no-ops on mismatch.
    pub fn release_fresh_agent_ownership(
        registry: &Arc<RuntimeOwnershipRegistry>,
        provider: &str,
        session_id: &str,
        claim: &ReleaseClaim,
        initiator: &str,
    ) -> bool {
        registry.release(provider, session_id, claim, initiator)
    }

    // ── lane bindings: the per-state plumbing every provider shares ────────

    /// The lane-claim answer for [`begin_lane_claim`]: `Granted` wraps the
    /// RAII ticket (drop without `disarm()` performs the typed fail, so a
    /// panicked spawn cannot wedge the session in `Starting`); `Adopt` means
    /// a same-kind live runtime exists (adopt, never spawn); `Unwired` is
    /// the legacy no-coordinator behavior (every pre-existing test); the
    /// typed `Refused` outcomes (OwnedByOtherKind / Blocked /
    /// StaleGeneration) are mapped by the caller onto its existing
    /// retryable wire answers.
    pub enum LaneClaim {
        Granted(OperationTicket),
        Adopt,
        Unwired,
        Refused(BeginOutcome),
    }

    /// Begin a lane claim on the shared coordinator (kata b8ke Task 3).
    /// The claim happens FIRST — before the provider lease — at every
    /// lifecycle entry point that spawns; the provider lease stays as the
    /// same-kind/TTL backstop.
    pub fn begin_lane_claim(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        now_ms: u64,
    ) -> LaneClaim {
        let Some(registry) = registry.as_ref() else {
            return LaneClaim::Unwired;
        };
        match claim_fresh_agent_ownership(
            registry,
            provider,
            session_id,
            operation_id,
            observed,
            initiator,
            now_ms,
        ) {
            BeginOutcome::Granted { generation } => LaneClaim::Granted(OperationTicket::new(
                Arc::clone(registry),
                provider,
                session_id,
                operation_id,
                RuntimeOwnerKind::FreshAgent,
                generation,
                initiator,
            )),
            BeginOutcome::AdoptLive { .. } => LaneClaim::Adopt,
            outcome => LaneClaim::Refused(outcome),
        }
    }

    /// Register the in-flight spawn's partial-runtime identity (round-2
    /// watchdog cancellation): the lane calls this the moment its child
    /// exists but before `commit_live`, so the watchdog host can kill it
    /// during settle. Fenced to the ticket's operation id + generation;
    /// no-op when there is no ticket.
    pub fn register_partial_fresh_runtime(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        ticket: &Option<OperationTicket>,
        live_session_key: &str,
        pid: Option<u32>,
    ) {
        let Some(registry) = registry.as_ref() else {
            return;
        };
        let Some(ticket) = ticket.as_ref() else {
            return;
        };
        registry.register_partial_runtime(
            provider,
            session_id,
            ticket.operation_id(),
            ticket.generation(),
            OwnerIdentity {
                kind: RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: Some(live_session_key.to_string()),
                pid,
                ownership_id: None,
                unit_id: None,
                hold: freshell_ownership::HoldKind::Main,
            },
        );
    }

    /// b8ke delta round-2 F2: the production start-cancellation settle
    /// guard. Created by [`register_start_cancellation_for_ticket`]; its
    /// Drop fires the start's settle signal — the operation's completion
    /// or unwind (EVERY exit path of the start handler's scope, panic
    /// included). The watchdog's bounded settle await treats the fired
    /// signal as the operation's confirmed death.
    pub struct StartCancellationGuard {
        settle_tx: Option<tokio::sync::oneshot::Sender<()>>,
        /// b8ke focused episode-2 post-cap F4: the sender-side settle
        /// evidence — set on Drop so the stale-start probe can answer
        /// "has this operation concluded?" WITHOUT polling the boxed
        /// future (an un-polled future never runs its body; the flag is
        /// the only honest probe).
        settle_fired: Option<Arc<std::sync::atomic::AtomicBool>>,
    }

    impl Drop for StartCancellationGuard {
        fn drop(&mut self) {
            if let Some(tx) = self.settle_tx.take() {
                let _ = tx.send(());
            }
            if let Some(flag) = &self.settle_fired {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }

    /// The shared sidecar-pid slot behind the fresh lanes' REAL start
    /// cancellation ([`pid_slot_cancellation`]): the start records the
    /// spawned child's RECORDED INCARNATION — (pid, start time) — the
    /// moment its child spawns; the cancellation closure signals only
    /// through the incarnation-verified path (a recycled pid is never
    /// signaled).
    pub type SidecarPidSlot = Arc<std::sync::Mutex<Option<(u32, Option<u64>)>>>;

    /// b8ke delta round-2 F2: register a REAL lifecycle start's
    /// cancellation + settle with the coordinator's watchdog machinery.
    /// `cancel` kills whatever the operation has spawned so far (the
    /// sidecar pid slot / the registry row); the returned guard's Drop
    /// fires the settle when the start handler's scope ends. No-op guard
    /// when the coordinator is unwired or the caller holds no ticket.
    pub fn register_start_cancellation_for_ticket(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        ticket: &Option<OperationTicket>,
        cancel: Arc<dyn Fn() + Send + Sync>,
    ) -> StartCancellationGuard {
        let (Some(registry), Some(ticket)) = (registry.as_ref(), ticket.as_ref()) else {
            return StartCancellationGuard {
                settle_tx: None,
                settle_fired: None,
            };
        };
        // b8ke focused episode-2 post-cap F6: the registration targets the
        // TICKET'S canonical key — the claim path already resolved the
        // alias, so a legitimate resume through a superseded (re-keyed)
        // wire id arms its cancellation on the record the watchdog actually
        // sweeps. The caller's wire id is only a label.
        let canonical_id = ticket.session_id();
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let settle_fired = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let registered = registry.register_start_cancellation(
            provider,
            canonical_id,
            ticket.operation_id(),
            ticket.generation(),
            cancel,
            Box::new(async move {
                let _ = rx.await;
            }),
            Some(Arc::clone(&settle_fired)),
        );
        if !registered {
            // b8ke F6: NEVER a silent decline — the operation runs with no
            // cancellation armed, which the watchdog would otherwise turn
            // into an unkillable fence. Loud, structured, actionable.
            tracing::error!(target: "invariant",
                provider, session_id = %canonical_id,
                wire_session_id = %session_id,
                operation_id = %ticket.operation_id(),
                generation = ticket.generation(),
                event = "freshagent.start_cancellation_registration_declined",
                "the watchdog registration declined — the operation proceeds with NO \
                 cancellation/settle armed (fail-closed fencing risk: a slow start \
                 fences unkillable). Investigate the claim/registration ordering."
            );
        }
        StartCancellationGuard {
            settle_tx: Some(tx),
            settle_fired: Some(settle_fired),
        }
    }

    /// A fresh (empty) sidecar incarnation slot — see [`SidecarPidSlot`].
    pub fn sidecar_pid_cancel_slot() -> SidecarPidSlot {
        Arc::new(std::sync::Mutex::new(None))
    }

    /// Record a spawned child's RECORDED INCARNATION into a cancellation
    /// slot: (pid, start time) — the identity the closure verifies before
    /// signaling (b8ke focused episode-2 round-1 F6: a bare numeric pid
    /// could be recycled within the watchdog's sweep window; the recorded
    /// start time is the reuse guard).
    pub fn arm_sidecar_pid_slot(slot: &SidecarPidSlot, pid: Option<u32>) {
        let armed = pid
            .filter(|p| *p != 0)
            .map(|p| (p, crate::session_lease::recorded_start_time(Some(p))));
        *slot.lock().expect("sidecar pid cancel slot lock") = armed;
    }

    /// The fresh lanes' REAL start cancellation: SIGTERM the spawned
    /// sidecar — ONLY through the incarnation-verified signal path (the
    /// r5 `signal_recorded_incarnation` discipline: the pidfd-pinned
    /// verify-then-send — a recycled pid never receives the signal).
    /// The start's own awaits then fail through its existing teardown
    /// gates and the operation unwinds (its settle fires). A no-op
    /// before the child spawns (nothing to cancel).
    #[cfg(target_os = "linux")]
    pub fn pid_slot_cancellation(slot: &SidecarPidSlot) -> Arc<dyn Fn() + Send + Sync> {
        let slot = Arc::clone(slot);
        Arc::new(move || {
            if let Some((pid, start_time)) = *slot.lock().expect("sidecar pid cancel slot lock") {
                tracing::warn!(target: "freshell_ownership", pid,
                    event = "ownership.start.cancel_signal",
                    "the watchdog's start cancellation signals the recorded sidecar \
                     incarnation (pidfd-pinned, start-time verified)");
                crate::session_lease::signal_recorded_incarnation(pid, start_time, libc::SIGTERM);
            }
        })
    }

    /// Non-Linux (b8ke focused episode-2 round-1 F5): no identity-safe
    /// signal path exists without `/proc` — the cancellation is
    /// unconfirmable by construction and NEVER signals. The fail-closed
    /// watchdog treats the start as unconfirmed (the typed StaleStart
    /// fence), exactly like the rest of this crate's platform-limited
    /// teardown.
    #[cfg(not(target_os = "linux"))]
    pub fn pid_slot_cancellation(_slot: &SidecarPidSlot) -> Arc<dyn Fn() + Send + Sync> {
        Arc::new(|| {
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.start.cancel_signal_platform_limited",
                "this platform cannot verify a sidecar incarnation — the start \
                 cancellation signals nothing (fail-closed)");
        })
    }

    /// The post-spawn variant of [`pid_slot_cancellation`]: the claim was
    /// taken AFTER the child existed, so the cancellation carries the
    /// recorded incarnation (pid + start time) directly (no slot needed).
    /// Signals only through the incarnation-verified path (F6).
    #[cfg(target_os = "linux")]
    pub fn sidecar_pid_cancellation(
        pid: Option<u32>,
        start_time: Option<u64>,
    ) -> Arc<dyn Fn() + Send + Sync> {
        Arc::new(move || {
            if let Some(pid) = pid {
                tracing::warn!(target: "freshell_ownership", pid,
                    event = "ownership.start.cancel_signal",
                    "the watchdog's start cancellation signals the recorded sidecar \
                     incarnation (pidfd-pinned, start-time verified)");
                crate::session_lease::signal_recorded_incarnation(pid, start_time, libc::SIGTERM);
            }
        })
    }

    /// Non-Linux (F5): no identity-safe signal path — never signals; the
    /// fail-closed watchdog owns the recovery.
    #[cfg(not(target_os = "linux"))]
    pub fn sidecar_pid_cancellation(
        pid: Option<u32>,
        _start_time: Option<u64>,
    ) -> Arc<dyn Fn() + Send + Sync> {
        let _ = pid;
        Arc::new(|| {
            tracing::warn!(target: "freshell_ownership",
                event = "ownership.start.cancel_signal_platform_limited",
                "this platform cannot verify a sidecar incarnation — the start \
                 cancellation signals nothing (fail-closed)");
        })
    }

    /// b8ke focused episode-2 round-2 F5: is the recorded partial runtime's
    /// pid CONFIRMED GONE? The watchdog's reap evidence must be
    /// consultable independent of the settle-guard's ordering — a handler
    /// that already reaped its runtime (the lease guard's `fail()` removed
    /// the kill handle BEFORE the settle guard dropped) must never fence.
    /// `true` only when `/proc/<pid>` is ABSENT (no signal is ever sent;
    /// an absent pid is honest evidence the recorded runtime exited —
    /// whatever holds the numeric id now is not our runtime). A PRESENT
    /// pid cannot be confirmed (the partial records no start time), so it
    /// answers `false` — the fence holds (fail closed). Non-Linux: no
    /// `/proc` — never confirmable.
    #[cfg(target_os = "linux")]
    pub fn partial_pid_confirmed_dead(pid: u32) -> bool {
        matches!(
            crate::session_lease::recorded_process_evidence(pid, None),
            crate::session_lease::RecordedProcessEvidence::Gone
        )
    }

    /// Non-Linux (F5): no `/proc` — a partial pid can never be confirmed
    /// gone; the fence holds.
    #[cfg(not(target_os = "linux"))]
    pub fn partial_pid_confirmed_dead(_pid: u32) -> bool {
        false
    }

    /// Commit a lane claim and retain the stamp: builds the fresh-agent
    /// owner identity (the lane's sessions-map key + the sidecar pid),
    /// commits, and inserts the stamp into `stamps` (the kill/exit
    /// `StopClaim`/`ReleaseClaim` source — round-2 review). `Ok(())` when
    /// there is no ticket (unwired, or an adopt that never claimed) or the
    /// commit landed; `Err(outcome)` on `StaleGeneration`/`ForeignOperation`
    /// — the caller must tear its just-registered session down (its
    /// uncommitted child with it) exactly like its existing
    /// claim-refusal paths.
    #[allow(clippy::too_many_arguments)] // the uniform commit field set (b8ke ext r29 F1)
    pub fn commit_lane_claim(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        stamps: &OwnershipStamps,
        broadcast_tx: Option<&Arc<tokio::sync::broadcast::Sender<String>>>,
        provider: &str,
        session_id: &str,
        ticket: &mut Option<OperationTicket>,
        live_session_key: &str,
        pid: Option<u32>,
    ) -> Result<(), CommitOutcome> {
        let Some(registry) = registry.as_ref() else {
            return Ok(());
        };
        let Some(held) = ticket.as_ref() else {
            return Ok(());
        };
        let (operation_id, generation) = (held.operation_id().to_string(), held.generation());
        // The broadcast frame's operation id (operation_id above is moved
        // into the retained stamp).
        let frame_operation_id = operation_id.clone();
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some(live_session_key.to_string()),
            pid,
            ownership_id: Some(operation_id.clone()),
            unit_id: None,
            hold: freshell_ownership::HoldKind::Main,
        };
        // b8ke ext r30 F1: the stamps lock is the ordering point for the
        // WHOLE publication — held across the liveness check, the
        // commit-to-Live, AND the retained-stamp insertion (the terminal
        // registry's normal-commit template). The exit watcher's release
        // consult (`take_retained_stamp`) takes the SAME lock, so the
        // (commit, stamp) pair is ATOMIC to it: a watcher blocked on this
        // critical section finds the stamp and releases; a watcher that
        // consulted before it found nothing (the runtime had not
        // published) and — because the liveness check below runs under
        // the lock AFTER that consult — the publication then REFUSES: a
        // sidecar that already exited never publishes. Pre-r30 the stamp
        // was inserted only AFTER the commit: a target exiting between
        // the two left a dead runtime advertised Live with the stamp
        // arriving too late for the completed watcher to consume — every
        // device converged on a nonexistent owner.
        let mut stamps_guard = stamps.lock().expect("ownership stamps lock");
        if let Some(pid) = owner.pid {
            if crate::ownership_lane::partial_pid_confirmed_dead(pid) {
                tracing::error!(target: "invariant",
                    provider = %provider,
                    session_id = %session_id,
                    operation_id = %operation_id,
                    pid,
                    event = "ownership.publication_refused_dead_runtime",
                    "the target's sidecar exited before the commit-to-Live — a dead \
                     runtime is never published; the caller's teardown owns the \
                     runtime (kata b8ke ext r30 F1)"
                );
                return Err(CommitOutcome::ForeignOperation);
            }
        }
        let outcome = commit_fresh_agent_ownership(
            registry,
            provider,
            session_id,
            &operation_id,
            generation,
            owner.clone(),
        );
        match outcome {
            CommitOutcome::Committed => {
                stamps_guard.insert(
                    session_id.to_string(),
                    OwnershipStamp {
                        epoch: registry.boot_epoch(),
                        generation,
                        operation_id,
                        owner,
                    },
                );
                if let Some(held) = ticket.as_mut() {
                    held.disarm();
                }
                // The publication (commit + stamp) is complete — release
                // the stamps lock before the broadcast (a channel send
                // never needs it; held-lock scope stays minimal).
                drop(stamps_guard);
                // b8ke ext r29 F1: EVERY commit-to-Live broadcasts the
                // authoritative owner record (the 'every ownership
                // transition BROADCAST' invariant). Pre-r29 only the
                // adopt arms and the handoff/rekey lanes emitted the
                // session.runtimeOwner frame — an ordinary codex create
                // or an opencode materialization committed Live with NO
                // broadcast, so cross-device observers (and the creating
                // pane itself) held no observed fence: selectPaneOwnerFence
                // stayed undefined for sessions created during the current
                // connection and the client sent lifecycle controls without
                // the required observed pair until a reconnect or an
                // unrelated owner transition supplied one. The frame is the
                // same record the adopt paths already emit (transition
                // handoff-committed, the ticket's committed generation and
                // operation id) under the COMMIT KEY — the coordinator's
                // authoritative id every device converges on.
                if let Some(broadcast_tx) = broadcast_tx {
                    let frame = freshell_protocol::ServerMessage::SessionRuntimeOwner(
                        freshell_protocol::SessionRuntimeOwner {
                            provider: provider.to_string(),
                            session_id: session_id.to_string(),
                            epoch: registry.boot_epoch(),
                            generation,
                            owner_kind: "fresh-agent".into(),
                            previous_kind: None,
                            terminal_id: None,
                            operation_id: frame_operation_id,
                            transition: "handoff-committed".into(),
                            reason: None,
                            fenced: None,
                            alias_of: None,
                        },
                    );
                    if let Ok(frame) = serde_json::to_string(&frame) {
                        let _ = broadcast_tx.send(frame);
                    }
                }
                Ok(())
            }
            CommitOutcome::StaleGeneration { .. } | CommitOutcome::ForeignOperation => {
                // The commit decision is final either way — disarm so the
                // ticket's drop does not double-report; the caller owns the
                // teardown (the key was never ours to keep).
                if let Some(held) = ticket.as_mut() {
                    held.disarm();
                }
                Err(outcome)
            }
        }
    }

    /// Take the retained stamp for a canonical session id (the explicit-kill
    /// `StopClaim` source). The taker owns the release/commit that follows.
    pub fn take_retained_stamp(
        stamps: &OwnershipStamps,
        session_id: &str,
    ) -> Option<OwnershipStamp> {
        stamps
            .lock()
            .expect("ownership stamps lock")
            .remove(session_id)
    }

    /// Peek (without taking) the retained stamp for a canonical session id.
    pub fn peek_retained_stamp(
        stamps: &OwnershipStamps,
        session_id: &str,
    ) -> Option<OwnershipStamp> {
        stamps
            .lock()
            .expect("ownership stamps lock")
            .get(session_id)
            .cloned()
    }

    pub(crate) fn current_local_snapshot_owner(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        stamps: &OwnershipStamps,
        provider: &str,
        native_id: &str,
        runtime_key: &str,
        pid: Option<u32>,
    ) -> Option<freshell_ownership::OwnershipSnapshot> {
        let Some(registry) = registry else {
            return Some(freshell_ownership::OwnershipSnapshot {
                epoch: 0,
                generation: 0,
                state: freshell_ownership::OwnershipState::Vacant,
            });
        };
        let stamp = peek_retained_stamp(stamps, native_id)?;
        let current = registry.observe(provider, native_id);
        if current.epoch != stamp.epoch
            || current.generation != stamp.generation
            || stamp.owner.kind != RuntimeOwnerKind::FreshAgent
            || stamp.owner.live_session_key.as_deref() != Some(runtime_key)
            || stamp.owner.pid != pid
            || pid.is_some_and(partial_pid_confirmed_dead)
            || !matches!(&current.state, freshell_ownership::OwnershipState::Live { owner, .. } if owner == &stamp.owner)
        {
            return None;
        }
        Some(current)
    }

    /// The fenced stop claim for an explicit kill: the lane's believed
    /// runtime identity plus the `(epoch, generation)` its `commit_live`
    /// stamped — with the wire pair a delayed client carried taking
    /// precedence when present (round-2 review). Both sources converge on
    /// the Live record's generation after a failed-handoff restore: the
    /// restored state holds the record's (handoff) generation and the
    /// lane's retained stamp is repaired to it (whole-branch review M-1),
    /// so a wire-fenced kill from a client that folded the handoff frames
    /// satisfies `begin_stop`'s exact-generation match.
    pub fn stop_claim_from_stamp(
        stamp: &OwnershipStamp,
        observed: Option<ObservedFence>,
    ) -> StopClaim {
        StopClaim {
            expected_kind: RuntimeOwnerKind::FreshAgent,
            expected_runtime: Some(stamp.owner.clone()),
            observed: observed.unwrap_or(ObservedFence {
                epoch: stamp.epoch,
                generation: stamp.generation,
            }),
        }
    }

    /// b8ke e3r1 F2: RESTORE a retained stamp (the abort path's rollback
    /// of a granted kill's consumption). A clean-close failure unwinds the
    /// stop via `abort_stop` — the registry returns to Live, and the
    /// natural-exit watcher needs the stamp back to release ownership on
    /// the runtime's eventual exit/crash (pre-e3r1 the abort restored the
    /// registry but left it release-less: a later crash stayed recorded
    /// live).
    pub fn restore_retained_stamp(
        stamps: &OwnershipStamps,
        session_id: &str,
        stamp: OwnershipStamp,
    ) {
        stamps
            .lock()
            .expect("ownership stamps lock")
            .insert(session_id.to_string(), stamp);
    }

    /// b8ke e3r3 F7: the stop operation's settlement guard — its Drop
    /// fires the sender-side flag the stale-Stopping watchdog consults (a
    /// progressing stop is not stale; the watchdog skips over-aged
    /// Stopping records whose flag has NOT fired). Created at the stop
    /// claim's grant in the kill handlers; the guard lives to the
    /// handler's scope end (completion, unwind, OR panic — the flag fires
    /// on every exit path, so only a handler STILL RUNNING reads as
    /// live).
    pub struct StopSettlementGuard {
        flag: Option<Arc<std::sync::atomic::AtomicBool>>,
    }

    impl Drop for StopSettlementGuard {
        fn drop(&mut self) {
            if let Some(flag) = &self.flag {
                flag.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }

    /// Register the granted stop's settlement flag with the coordinator
    /// (returns the guard; a DECLINED registration — the record moved on —
    /// is a no-op guard, loudly logged).
    pub fn register_stop_settlement_for_claim(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        generation: u64,
    ) -> StopSettlementGuard {
        let Some(registry) = registry.as_ref() else {
            return StopSettlementGuard { flag: None };
        };
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        if !registry.register_stop_settlement(
            provider,
            session_id,
            operation_id,
            generation,
            Arc::clone(&flag),
        ) {
            tracing::warn!(target: "invariant",
                provider, session_id, operation_id, generation,
                event = "freshagent.stop_settlement_registration_declined",
                "the stop-settlement registration declined — the record moved on; \
                 the watchdog will treat the stop as unregistered (age-only fencing)");
            return StopSettlementGuard { flag: None };
        }
        StopSettlementGuard { flag: Some(flag) }
    }

    /// b8ke e3r3 F8: restore a consumed stamp ATOMICALLY with the
    /// liveness re-validation — the recorded incarnation is checked UNDER
    /// the stamps lock at restore time, so a sidecar that exits between
    /// the verdict and the restore can never have its stamp written back
    /// for a dead process (the exit watcher's take observes either the
    /// stamp present [it releases] or absent [it already completed] —
    /// never a restored-after-exit zombie stamp).
    pub fn restore_retained_stamp_if_live(
        stamps: &OwnershipStamps,
        session_id: &str,
        stamp: OwnershipStamp,
        none_pid_means_live: bool,
    ) -> bool {
        let mut guard = stamps.lock().expect("ownership stamps lock");
        // Re-validate the recorded incarnation under the lock: the stamp's
        // pid must still be alive NOW (the exit watcher's release path
        // takes the stamp under this same lock, so this read cannot
        // interleave with it). A None-pid stamp (the opencode shared
        // daemon) defers to the caller's policy.
        let still_live = stamp
            .owner
            .pid
            .map(|pid| !crate::ownership_lane::partial_pid_confirmed_dead(pid))
            .unwrap_or(none_pid_means_live);
        if still_live {
            guard.insert(session_id.to_string(), stamp);
            true
        } else {
            false
        }
    }

    /// Exit-watcher release of a retained stamp: takes the stamp (if any)
    /// and releases with its fenced claim — a delayed watcher can never
    /// erase a newer owner or an in-flight handoff. No-op when unwired or
    /// the stamp is absent (the runtime never committed through the
    /// coordinator).
    pub fn release_retained_stamp(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        stamps: &OwnershipStamps,
        provider: &str,
        session_id: &str,
        initiator: &str,
    ) {
        let Some(registry) = registry.as_ref() else {
            return;
        };
        let Some(stamp) = take_retained_stamp(stamps, session_id) else {
            return;
        };
        let claim = stamp.release_claim();
        release_fresh_agent_ownership(registry, provider, session_id, &claim, initiator);
    }

    /// Identity-scoped exit-watcher release. The stamp remains in place when
    /// the observed runtime no longer matches, allowing the replacement owner
    /// to retain its own release evidence instead of losing it to a stale
    /// watcher.
    pub fn release_retained_stamp_if_matches(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        stamps: &OwnershipStamps,
        provider: &str,
        session_id: &str,
        initiator: &str,
        expected_runtime: Option<&OwnerIdentity>,
    ) -> bool {
        let Some(registry) = registry.as_ref() else {
            return false;
        };
        let Some(expected_runtime) = expected_runtime else {
            tracing::warn!(target: "invariant", provider, session_id,
                event = "freshagent.ownership_release_missing_runtime_identity",
                "the exit watcher had no runtime identity; retaining the stamp");
            return false;
        };
        let Some(stamp) = peek_retained_stamp(stamps, session_id) else {
            return false;
        };
        let owner_matches = stamp.owner.kind == expected_runtime.kind
            && stamp.owner.terminal_id == expected_runtime.terminal_id
            && stamp.owner.live_session_key == expected_runtime.live_session_key
            && stamp.owner.pid == expected_runtime.pid;
        if !owner_matches {
            tracing::warn!(target: "invariant", provider, session_id,
                event = "freshagent.ownership_release_identity_mismatch",
                watched_pid = ?expected_runtime.pid,
                current_pid = ?stamp.owner.pid,
                "the exit watcher is stale; retaining the current ownership stamp");
            return false;
        }
        let claim = stamp.release_claim();
        if release_fresh_agent_ownership(registry, provider, session_id, &claim, initiator) {
            // Remove only after the coordinator accepted the exact release.
            // A concurrent replacement can win between the peek and take;
            // the identity re-check then leaves its stamp intact.
            return take_retained_stamp_if_matches(stamps, session_id, expected_runtime).is_some();
        }
        false
    }

    fn take_retained_stamp_if_matches(
        stamps: &OwnershipStamps,
        session_id: &str,
        expected_runtime: &OwnerIdentity,
    ) -> Option<OwnershipStamp> {
        let mut guard = stamps.lock().expect("ownership stamps lock");
        let matches = guard.get(session_id).is_some_and(|stamp| {
            stamp.owner.kind == expected_runtime.kind
                && stamp.owner.terminal_id == expected_runtime.terminal_id
                && stamp.owner.live_session_key == expected_runtime.live_session_key
                && stamp.owner.pid == expected_runtime.pid
        });
        matches.then(|| guard.remove(session_id).expect("matching stamp exists"))
    }

    // ── terminal lane (kata b8ke Task 4) ────────────────────────────────────
    //
    // The terminal lane's claim/commit twins, shared by the WS create path
    // (`freshell-ws/src/terminal.rs`), the REST spawn rung
    // (`terminal_tabs.rs`), and the auto-resume crash recovery
    // (`freshell-ws/src/auto_resume.rs`). The RELEASE side of the terminal
    // lane lives in `freshell-terminal`'s registry (kill/exit paths) — see
    // `TerminalRegistry::with_ownership`; these helpers only claim and
    // commit.

    /// The terminal lane's claim answer for [`begin_terminal_lane_claim`]:
    /// the same shape as [`LaneClaim`] but for `RuntimeOwnerKind::Terminal`
    /// — `Granted` wraps the RAII ticket (drop without `disarm()` performs
    /// the typed fail), `Adopt` means a same-kind live terminal runtime
    /// exists (the registry-lease/D7 attach-or-refuse paths handle it),
    /// `Unwired` is the legacy no-coordinator behavior, and `Refused` is the
    /// typed cross-kind/stale outcome the caller maps onto its existing
    /// refusal frames.
    pub enum TerminalLaneClaim {
        Granted(OperationTicket),
        Adopt,
        Unwired,
        Refused(BeginOutcome),
    }

    /// Begin the TERMINAL lane's claim on the shared coordinator (kata b8ke
    /// Task 4). The claim happens FIRST — before the registry lease and
    /// before the `paneReconcileV1` gate (round-2 review: EVERY connection,
    /// negotiated or not) — at every terminal create/respawn entry point.
    /// `operation_id` is the caller-minted identity (WS: the create
    /// requestId; REST: the createRequestId; auto-resume: the respawn key).
    pub fn begin_terminal_lane_claim(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        now_ms: u64,
    ) -> TerminalLaneClaim {
        begin_terminal_lane_claim_inner(
            registry,
            provider,
            session_id,
            operation_id,
            observed,
            initiator,
            now_ms,
            None,
        )
    }

    /// b8ke ext r32 F1: the GUARD HOLDER's own terminal-lane claim — the
    /// create/attach flow that armed an attach window on this key (the
    /// Adopt arm's guard) and now claims the death-vacated key inside
    /// its own window at the settle. `window_operation_id` is the armed
    /// guard's id ([`AttachGuard::operation_id`]); the coordinator's
    /// deferred-acquisition block exempts it (the create completes
    /// with continuous authority) while every competitor answers the
    /// typed Blocked outcome.
    #[allow(clippy::too_many_arguments)] // the claim field set + the window id (b8ke ext r32 F1)
    pub fn begin_terminal_lane_claim_under_attach_window(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        now_ms: u64,
        window_operation_id: &str,
    ) -> TerminalLaneClaim {
        begin_terminal_lane_claim_inner(
            registry,
            provider,
            session_id,
            operation_id,
            observed,
            initiator,
            now_ms,
            Some(window_operation_id),
        )
    }

    #[allow(clippy::too_many_arguments)] // the claim field set + the window id (b8ke ext r32 F1)
    fn begin_terminal_lane_claim_inner(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        observed: Option<ObservedFence>,
        initiator: &str,
        now_ms: u64,
        attach_window_operation_id: Option<&str>,
    ) -> TerminalLaneClaim {
        let Some(registry) = registry.as_ref() else {
            return TerminalLaneClaim::Unwired;
        };
        let outcome = match attach_window_operation_id {
            None => registry.begin_start(
                provider,
                session_id,
                RuntimeOwnerKind::Terminal,
                operation_id,
                observed,
                initiator,
                now_ms,
            ),
            Some(window_op) => registry.begin_start_under_attach_window(
                provider,
                session_id,
                RuntimeOwnerKind::Terminal,
                operation_id,
                observed,
                initiator,
                now_ms,
                window_op,
            ),
        };
        match outcome {
            BeginOutcome::Granted { generation } => {
                TerminalLaneClaim::Granted(OperationTicket::new(
                    Arc::clone(registry),
                    provider,
                    session_id,
                    operation_id,
                    RuntimeOwnerKind::Terminal,
                    generation,
                    initiator,
                ))
            }
            BeginOutcome::AdoptLive { .. } => TerminalLaneClaim::Adopt,
            outcome => TerminalLaneClaim::Refused(outcome),
        }
    }

    /// The terminal lane's wire owner fields for a typed refusal frame: the
    /// additive `ownerKind`/`ownerGeneration`(/`ownerEpoch`) triple an
    /// `error` frame or a REST 409 envelope carries when the coordinator
    /// knows (or can name) the owner. `None` keeps the frame byte-identical
    /// to the legacy shape (unwired coordinator).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct TerminalOwnerFields {
        pub owner_kind: &'static str,
        pub owner_generation: u64,
        pub owner_epoch: u64,
    }

    /// Derive the additive owner fields from a `BeginOutcome` refusal (the
    /// owner the coordinator named) — `None` when the outcome carries no
    /// owner identity.
    /// b8ke ext r12 F2: the fresh-agent lanes' attach-guard resolution —
    /// [`LaneAttachGuard::Armed`] holds the REAL claim across the attach's
    /// window (the coordinator covers the attach through completion);
    /// [`LaneAttachGuard::Unwired`] is the legacy no-coordinator lane
    /// (proceed unguarded — there is nothing to serialize); a REFUSED
    /// resolution (logged here) aborts the attach typed — the caller
    /// emits its lane's error surface.
    pub enum LaneAttachGuard {
        Armed(freshell_ownership::AttachGuard),
        Unwired,
        Refused,
    }

    /// b8ke ext r12 F2: arm the existing-runtime attach's REAL claim (the
    /// guard held across the attach's window). See [`LaneAttachGuard`].
    pub fn arm_attach_guard(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        observed_generation: Option<u64>,
        initiator: &str,
    ) -> LaneAttachGuard {
        let Some(registry) = registry.as_ref() else {
            return LaneAttachGuard::Unwired;
        };
        match registry.begin_attach_guard(
            provider,
            session_id,
            operation_id,
            observed_generation,
            initiator,
        ) {
            freshell_ownership::AttachGuardOutcome::Armed(guard) => LaneAttachGuard::Armed(*guard),
            freshell_ownership::AttachGuardOutcome::Refused { state, generation } => {
                tracing::warn!(target: "freshell_ownership",
                    operation_id = %operation_id, provider = %provider,
                    session_id = %session_id, initiator,
                    state = ?state, generation,
                    event = "ownership.attach_guard.refused",
                    outcome = "refused", failure_reason = "LIFECYCLE_IN_FLIGHT",
                    "the attach guard refused to arm (a lifecycle transition owns \
                     the key) — the attach aborts typed, nothing persists");
                LaneAttachGuard::Refused
            }
            freshell_ownership::AttachGuardOutcome::StaleGeneration {
                current_epoch,
                current_generation,
            } => {
                tracing::warn!(target: "freshell_ownership",
                    operation_id = %operation_id, provider = %provider,
                    session_id = %session_id, initiator,
                    observed_generation = ?observed_generation,
                    current_epoch, current_generation,
                    event = "ownership.attach_guard.refused",
                    outcome = "refused", failure_reason = "STALE_GENERATION",
                    "the attach guard refused to arm (the observed generation is \
                     stale) — the attach aborts typed, nothing persists");
                LaneAttachGuard::Refused
            }
        }
    }

    /// b8ke ext r38 F1: the ATOMIC-ADOPT arm — the guard for every path
    /// that starts or restarts a runtime/bridge over an existing owner.
    /// Takes the request's FULL observed fence (epoch + generation) and
    /// the EXPECTED owner (the kind always; the identity fields the
    /// caller knows); the coordinator validates all of it in ONE
    /// lock-held decision. Typed refusals: a stale epoch/generation or
    /// a kind/identity mismatch — the precheck-then-guard laundering
    /// (re-observe whatever's live and arm on it) is gone.
    pub fn arm_adopt_guard(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        expected: &freshell_ownership::OwnerIdentity,
        observed: freshell_ownership::ObservedFence,
        initiator: &str,
    ) -> LaneAttachGuard {
        let Some(registry) = registry.as_ref() else {
            return LaneAttachGuard::Unwired;
        };
        match registry.begin_adopt_guard(
            provider,
            session_id,
            operation_id,
            expected,
            observed,
            initiator,
        ) {
            freshell_ownership::AttachGuardOutcome::Armed(guard) => LaneAttachGuard::Armed(*guard),
            freshell_ownership::AttachGuardOutcome::Refused { state, generation } => {
                tracing::warn!(target: "freshell_ownership",
                    operation_id = %operation_id, provider = %provider,
                    session_id = %session_id, initiator,
                    expected_kind = ?expected.kind,
                    state = ?state, generation,
                    event = "ownership.adopt_guard.refused",
                    outcome = "refused", failure_reason = "ADOPT_MISMATCH",
                    "the atomic adopt refused to arm (the key is not held \
                     by the expected owner at the observed pair) — the \
                     caller aborts typed, nothing is killed or spawned"
                );
                LaneAttachGuard::Refused
            }
            freshell_ownership::AttachGuardOutcome::StaleGeneration {
                current_epoch,
                current_generation,
            } => {
                tracing::warn!(target: "freshell_ownership",
                    operation_id = %operation_id, provider = %provider,
                    session_id = %session_id, initiator,
                    expected_kind = ?expected.kind,
                    observed_epoch = observed.epoch,
                    observed_generation = observed.generation,
                    current_epoch, current_generation,
                    event = "ownership.adopt_guard.refused",
                    outcome = "refused", failure_reason = "STALE_GENERATION",
                    "the atomic adopt refused to arm (the observed fence is \
                     stale or names a different epoch) — the caller aborts \
                     typed; refresh and retry"
                );
                LaneAttachGuard::Refused
            }
        }
    }

    /// b8ke ext r18 F1: the RELEASED owner frame — the vacant owner state
    /// plus the post-stop (epoch, generation) pair a connected client
    /// refreshes its observed fence from. Emitted by every SUCCESSFUL
    /// commit-to-Vacant stop/kill site (the fresh-agent explicit kills and
    /// the terminal stop path): pre-r18 the commit changed the
    /// coordinator to the incremented Vacant generation with NO
    /// broadcast, so connected panes retained the old live owner and
    /// generation — the kill → immediate recreate "Restart sidecar"
    /// sequence carried the stale observed generation, the server
    /// correctly fenced it, and the client neither received nor derived
    /// the new vacant generation (retries repeated the stale request
    /// until reconnection; other devices kept displaying the former
    /// owner). `None` when the coordinator is unwired (nothing to fold).
    /// b8ke ext r32 F2: the frame carries ITS OWN transition's pair —
    /// the (epoch, generation) captured AT `commit_stop`'s commit —
    /// NEVER a re-observed current generation. If a lifecycle operation
    /// on another device starts or completes between the commit and
    /// this broadcast, a re-observed frame would carry the NEWER
    /// operation's generation, and the client (which accepts all
    /// same-generation frames) would fold the vacant frame OVER the
    /// newer `handoff-started`/live-owner state until another event or
    /// a reconnect. The committed pair keeps the frame honestly
    /// labeled: the client's fence discipline orders it as the older
    /// transition it is.
    pub fn released_owner_frame(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        provider: &str,
        session_id: &str,
        operation_id: &str,
        committed_epoch: u64,
        committed_generation: u64,
    ) -> Option<freshell_protocol::ServerMessage> {
        // The unwired check only — the frame's pair comes from the CALLER
        // (the committed transition's own), never an observation.
        registry.as_ref()?;
        Some(freshell_protocol::ServerMessage::SessionRuntimeOwner(
            freshell_protocol::SessionRuntimeOwner {
                provider: provider.to_string(),
                session_id: session_id.to_string(),
                epoch: committed_epoch,
                generation: committed_generation,
                owner_kind: "vacant".into(),
                previous_kind: None,
                terminal_id: None,
                operation_id: operation_id.to_string(),
                transition: "released".into(),
                reason: None,
                fenced: None,
                alias_of: None,
            },
        ))
    }

    pub fn terminal_owner_fields_from_outcome(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        outcome: &BeginOutcome,
    ) -> Option<TerminalOwnerFields> {
        let registry = registry.as_ref()?;
        match outcome {
            BeginOutcome::OwnedByOtherKind { generation, .. } => Some(TerminalOwnerFields {
                owner_kind: "fresh-agent",
                owner_generation: *generation,
                owner_epoch: registry.boot_epoch(),
            }),
            // Blocked carries the in-flight state; a Live blocked state (the
            // same-kind backstop the coordinator still holds) names the
            // terminal owner. Starting/Handoff/Stopping transitions have no
            // committed owner identity to name, and StaleGeneration names
            // only the fence mismatch — both stay field-less.
            BeginOutcome::Blocked {
                state: freshell_ownership::OwnershipState::Live { generation, .. },
                ..
            } => Some(TerminalOwnerFields {
                owner_kind: "terminal",
                owner_generation: *generation,
                owner_epoch: registry.boot_epoch(),
            }),
            _ => None,
        }
    }

    /// The FRESH-AGENT lane's `BeginOutcome` owner-fields derivation
    /// (b8ke ext r26 F5): the same envelope fields
    /// [`terminal_owner_fields_from_outcome`] produces, but
    /// `OwnedByOtherKind` names the ACTUAL owner kind (the fresh lane
    /// observes the cross-kind owner from the opposite direction — a
    /// TERMINAL owner answers `ownerKind: "terminal"`). One derivation
    /// for every fresh-lane REST/MCP ownership-conflict refusal (the
    /// resume path and the materialization path share it so the typed
    /// envelopes can never drift apart).
    pub fn fresh_agent_owner_fields_from_outcome(
        registry: &Option<Arc<RuntimeOwnershipRegistry>>,
        outcome: &BeginOutcome,
    ) -> Option<TerminalOwnerFields> {
        match outcome {
            BeginOutcome::OwnedByOtherKind { owner, generation } => {
                let registry = registry.as_ref()?;
                Some(TerminalOwnerFields {
                    owner_kind: if owner.kind == RuntimeOwnerKind::Terminal {
                        "terminal"
                    } else {
                        "fresh-agent"
                    },
                    owner_generation: *generation,
                    owner_epoch: registry.boot_epoch(),
                })
            }
            _ => terminal_owner_fields_from_outcome(registry, outcome),
        }
    }

    /// Derive the additive owner fields from a live coordinator observation
    /// (`observe`) — `None` when the key is vacant/unwired.
    pub fn terminal_owner_fields_from_snapshot(
        snapshot: &freshell_ownership::OwnershipSnapshot,
    ) -> Option<TerminalOwnerFields> {
        match &snapshot.state {
            freshell_ownership::OwnershipState::Live {
                owner, generation, ..
            } => Some(TerminalOwnerFields {
                owner_kind: match owner.kind {
                    RuntimeOwnerKind::Terminal => "terminal",
                    RuntimeOwnerKind::FreshAgent => "fresh-agent",
                },
                owner_generation: *generation,
                owner_epoch: snapshot.epoch,
            }),
            _ => None,
        }
    }
}

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, patch, post},
    Json, Router,
};
use serde_json::{json, Map, Value};
use uuid::Uuid;

use freshell_opencode::transport::{
    LoopbackPortAllocator, ReqwestEventSource, ReqwestServeHttp, TokioProcessSpawner,
};
use freshell_opencode::{
    build_prompt_body as build_opencode_prompt_body, normalize_opencode_effort,
    normalize_opencode_model, OpencodeServeManager, Route, ServeConfig, ServeDeps, ServeError,
    SessionSignal,
};

use freshell_protocol::{
    FreshAgentEvent, FreshAgentSessionMaterialized, ServerMessage, SessionLocator, SessionsChanged,
    UiCommand, LEGACY_RESUME_IDENTITY_REFUSAL,
};

use crate::summary::{truncate_summary, SUMMARY_KIND_ECHO};

/// kata b8ke Task 6: the atomic handoff runner + its `POST /api/sessions/handoff`
/// router (minted in `freshell-server::main` beside the other REST routers).
pub use session_handoff::{
    handoff_router, HandoffHandle, HandoffRequest, HandoffTestHooks, SessionHandoffRunner,
};

/// The opencode fresh-agent `sessionType` (`AGENT_SESSION_TYPES.opencode`, `router.ts:541`).
const SESSION_TYPE: &str = "freshopencode";
/// The runtime provider (`AGENT_SESSION_TYPES.opencode.provider`).
const PROVIDER: &str = "opencode";

/// b8ke ext r22 F1: the pane-scoped PROVISIONAL identity for the REST/MCP
/// materialization's pre-spawn claim — the pane id the caller already
/// carries, namespaced so it can never collide with a provider-minted
/// session id. The claim under this key owns the whole cold-start window
/// (the shared serve's spawn + the POST /session); at the mint the SAME
/// ticket rekeys to the durable `ses_*` id (rekey_starting). The cancel
/// closure stays a NO-OP — the shared serve daemon is never a kill handle
/// (OpenCode invariant).
const PENDING_CREATE_PREFIX: &str = "pending-create-";

fn rest_agent_mode(agent: &str) -> Option<(&'static str, &'static str)> {
    match agent {
        "claude" => Some(("claude", "freshclaude")),
        "kilroy" => Some(("claude", "kilroy")),
        "codex" => Some(("codex", "freshcodex")),
        "opencode" => Some(("opencode", "freshopencode")),
        _ => None,
    }
}
/// `makePlaceholderSessionId(requestId)`'s prefix (`adapter.ts:75`, mirrored by
/// `create_tab` above and `opencode_ws::handle_create`): this port's ONE placeholder-id
/// format, `format!("freshopencode-{request_id}")`. By construction, an id with this shape
/// is never a real opencode `serve` session id (those are `ses_*`) -- see
/// [`FreshAgentState::get_opencode_snapshot`]'s Fix Task #3 short-circuit.
pub(crate) const OPENCODE_PLACEHOLDER_PREFIX: &str = "freshopencode-";
/// Fallback turn idle budget when `send-keys` carries no `timeout` (matches the harness's
/// generous Kimi budget; the request always supplies one in the oracle path).
const DEFAULT_TURN_TIMEOUT: Duration = Duration::from_secs(180);

/// Serializes every test that mutates the process-global `OPENCODE_CMD`
/// (the shared `opencode serve` command) across this crate's test binary —
/// the session-handoff fake-serve tests and the snapshot cold-GET tests
/// must never interleave their mutations (the session-handoff file's
/// `ENV_LOCK` is an import of this lock).
#[cfg(test)]
pub(crate) static OPENCODE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The resume probe's bounded `get_session` budget resolution, extracted pure
/// (delta-r2 Fix 3 — the state-injection timeout tests prove boundedness; the
/// lib tests pin THE KNOB's parsing/default without ever mutating process
/// env). Layers, in order: `state_override` (the cfg(test) seam) >
/// `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS` (the raw env string, read by the
/// caller) > 10_000ms default — the SAME env-parse semantics the WS resume
/// door applies (`opencode_ws.rs`); both doors resolve through this ONE
/// function so they can never drift. A `u64` parse rejects empty, garbage,
/// negative, overflowing, and whitespace-padded values alike; they all fall
/// to the default.
pub(crate) fn resolve_probe_timeout_ms(state_override: Option<u64>, env_raw: Option<&str>) -> u64 {
    if let Some(ms) = state_override {
        return ms;
    }
    env_raw
        .and_then(|raw| raw.parse::<u64>().ok())
        .unwrap_or(10_000u64)
}

/// The shared opencode serve-manager cell: `None` until the first
/// freshopencode pane's lane runs `ensure_manager`, then the live manager
/// for the rest of the process lifetime. The native naming adapter holds
/// this handle and resolves the current manager per operation (a boot-time
/// snapshot would freeze the `None` and pause every opencode native series
/// forever — the worker outlives the cell's lazy creation).
pub type SharedOpencodeManagerHandle = Arc<tokio::sync::Mutex<Option<OpencodeServeManager>>>;

/// Shared, cheaply-cloneable fresh-agent REST state (mergeable into the server app).
#[derive(Clone)]
pub struct FreshAgentState {
    auth_token: Arc<String>,
    /// The shared WS broadcast bus (pre-serialized frames), fanned out by every
    /// `freshell-ws` connection. `ui.command` / `freshAgent.session.materialized` /
    /// `sessions.changed` are pushed here.
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    /// paneId → pane record (placeholder id, cwd, model/effort, durable id).
    panes: Arc<Mutex<HashMap<String, PaneEntry>>>,
    /// The single lazily-started `opencode serve` client for this server process.
    opencode: SharedOpencodeManagerHandle,
    /// Opt-in durable host gateway. When installed, REST/MCP fresh-agent
    /// requests never touch this web process's legacy provider manager.
    hosted_rest: Arc<std::sync::OnceLock<hosted_rest::SharedHostedFreshAgentRestGateway>>,
    /// Monotonic `sessions.changed` revision.
    sessions_revision: Arc<AtomicI64>,
    /// Slice 1 (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md`): the SAME
    /// terminal registry the WS `terminal.create` path uses, wired in from
    /// `freshell-server`'s `main.rs` via [`Self::with_terminal_registry`].
    /// `None` until wired -- every existing opencode-only test keeps working
    /// unchanged (terminal-mode routes 503 instead of touching a registry
    /// that was never given to them).
    pub(crate) terminal_registry: Option<freshell_terminal::TerminalRegistry>,
    /// Read-only session-identity lookup (in production: the WS-side
    /// TerminalIdentityRegistry behind the freshell-terminal
    /// SessionIdentityLookup seam, wired by freshell-server). Powers the
    /// identity arm of the REST D7 live-session guard. `None` (unwired)
    /// narrows the guard to the registry-row arm.
    pub(crate) session_identity:
        Option<Arc<dyn freshell_terminal::registry::SessionIdentityLookup>>,
    /// Write-side pane-identity seam (kata hbsa): lets the REST spawn
    /// pipeline write TerminalIdentityRegistry rows and PaneLedger bindings
    /// across the freshagent->ws crate boundary. Read-side twin:
    /// `session_identity`. `None` (tests without identity concerns) = the
    /// legacy no-write behavior.
    pub(crate) pane_identity: Option<Arc<dyn freshell_terminal::registry::PaneIdentityBinder>>,
    /// paneId -> terminal pane record (Slice 1 `mode:'shell'` terminals
    /// created via `POST /api/tabs`). Disjoint from `panes` (fresh-agent-only)
    /// and `content_panes` (browser/editor) -- a pane id appears in exactly
    /// one of the three maps.
    pub(crate) terminal_panes: Arc<Mutex<HashMap<String, TerminalPaneEntry>>>,
    /// paneId -> browser/editor `paneContent` JSON (Slice 1's "cheap" content
    /// kinds -- no process, just the content the client folds via
    /// `ui.command{tab.create}`).
    pub(crate) content_panes: Arc<Mutex<HashMap<String, Value>>>,
    /// tabId -> legacy shadow record. `GET /api/tabs` reads the LayoutStore
    /// (AUTO-03), not this map; it remains only as `delete_tab`'s cleanup
    /// gate and `rename_tab`'s title mirror.
    pub(crate) tabs: Arc<Mutex<HashMap<String, TabRecord>>>,
    /// Slice 3b-1 (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md`
    /// \u00a72.2 pane routes): paneId -> owning tabId, the reverse index
    /// `pane_ops`'s split/close/select handlers need to resolve a pane's tab
    /// without a full server-side layout tree (see `rename_pane`'s doc
    /// comment for why this port keeps no such tree). Populated by EVERY
    /// pane-minting call site (fresh-agent `create_tab`, `terminal_tabs`'s
    /// `create_content_tab`/`create_terminal_tab`/`spawn_terminal_pane`, and
    /// `pane_ops::split_pane`), so a pane created by ANY path is resolvable
    /// here -- this is the one piece of bookkeeping this slice adds to the
    /// pre-existing per-kind maps (`terminal_panes`/`content_panes`/`panes`)
    /// rather than duplicating tab-membership tracking inside each of them.
    pub(crate) pane_tabs: Arc<Mutex<HashMap<String, String>>>,
    /// restoreKey -> what a `restoreKey`-tagged create produced (continuity
    /// trio, `tabs_snapshots.rs:632`). The tabs-sync restore path tags every
    /// `POST /api/tabs`-pipeline create it drives with a DETERMINISTIC key so
    /// a retry can reconcile a create whose write-ahead marker promotion never
    /// landed (the crash window between the pre-create marker write and the
    /// post-create terminalId record). In-memory only: after a full process
    /// restart in-process terminals are dead anyway, and the restore path
    /// treats a missing key accordingly (recreate terminals; fail-loud for
    /// browser/editor panes it cannot prove undelivered).
    pub(crate) restore_keys: Arc<Mutex<HashMap<String, RestoreKeyEntry>>>,
    /// Slice 3a (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md): the
    /// registered coding-CLI command specs (claude/codex/opencode/gemini/
    /// kimi/amplifier/...), the SAME list `freshell_ws::WsState::cli_commands`
    /// resolves `terminal.create { mode: <cli> }` against -- wired in from
    /// `freshell-server`'s `main.rs` via [`Self::with_cli_commands`]. Empty
    /// until wired, matching every other Slice-1/3a field's "`None`/empty ==
    /// route degrades honestly instead of touching data it was never given"
    /// convention.
    pub(crate) cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>>,
    /// The SAME opencode session locator the WS `terminal.create` path arms
    /// (`freshell_ws::opencode_association::maybe_arm`), wired in from
    /// `freshell-server`'s main.rs via [`Self::with_opencode_locator`] so a
    /// REST-created fresh opencode pane arms the identical instance the
    /// periodic sweep (spawned once, against `WsState`, at boot) already
    /// polls -- association/broadcast parity falls out of sharing the one
    /// locator rather than standing up a second sweep loop this crate would
    /// have no way to drive (the sweep's `identity.upsert` target,
    /// `freshell_ws::identity::TerminalIdentityRegistry`, is `freshell-ws`-
    /// owned and unreachable here without a circular crate dependency).
    /// `None` when unwired (every pre-existing test).
    pub(crate) opencode_locator: Option<Arc<freshell_sessions::opencode_locator::OpencodeLocator>>,
    /// Sibling to [`Self::opencode_locator`] for the P1.14 / Incident-4
    /// codex hardening -- the SAME shared instance the WS
    /// `codex_association` entry points arm and the B2 sweep polls.
    pub(crate) codex_locator:
        Option<std::sync::Arc<freshell_sessions::codex_locator::CodexLocator>>,
    /// P1.13 identity-event sink (the pane-ledger bridge, [`identity_sink`]).
    /// Clone-shared + set-once: the state is cloned into consumer tasks, so
    /// the `OnceLock` sits behind an `Arc`. Wired post-construction by
    /// `freshell-server` (precedent: `TerminalRegistry::set_activity_observer`).
    identity_sink: Arc<std::sync::OnceLock<SharedPaneIdentitySink>>,
    /// Unified agent names (Task 2): the injected naming authority
    /// ([`naming::SessionNaming`]) — same set-once/shared model as
    /// [`Self::identity_sink`]. Production (`freshell-server::main`) wires
    /// the ONE local store participant via [`Self::set_session_naming`];
    /// tests outside the naming scope omit it and scoped naming fails
    /// unavailable.
    naming: NamingSink,
    /// Unified agent names: placeholder id → the pre-durable naming handle
    /// admitted at create, shared by the REST spawn pipeline and the
    /// freshopencode WS slice (both materialize the same placeholder
    /// `freshopencode-<createRequestId>`), so the bind lane resolves the
    /// handle whichever surface drove the create. Popped by the
    /// materialization bind.
    pub(crate) naming_handles: Arc<Mutex<HashMap<String, String>>>,
    /// Server-wide PTY spawn gate — the SAME instance the WS terminal.create
    /// path uses (ONE global concurrency budget; see
    /// docs/plans/2026-07-27-rest-spawn-gate.md). Clone-shared + set-once,
    /// wired post-construction by freshell-server (same shape as
    /// `identity_sink`). `None` = ungated (unwired unit tests keep legacy
    /// behavior; production always wires it).
    spawn_gate: Arc<std::sync::OnceLock<RestSpawnGate>>,
    /// Door 3 (resume-validation): the disk-existence probe consulted before
    /// a REST create turns a cached resume id into resume argv. Injected as
    /// [`freshell_platform::resume_gate::ResumeProbeFn`] because this crate
    /// must NOT depend on `freshell-ws` (whose probe trait would be circular
    /// -- see this Cargo.toml's freshell-sessions comment). `None` = feature
    /// off = today's behavior (every pre-existing test).
    pub(crate) resume_probe: Option<freshell_platform::resume_gate::ResumeProbeFn>,
    /// Door 3: called with `(provider, stale_session_id)` when the gate
    /// fires. `freshell-server`'s main.rs implements it as pane-ledger
    /// `retire_missing` + `tracing::warn!`. `None` = no-op.
    pub(crate) on_stale_resume: Option<OnStaleResume>,
    /// Door 3: arm 2 of the in-gate liveness precondition (see
    /// [`SidecarLivenessProbe`]). `None` = arm contributes false.
    pub(crate) sidecar_liveness: Option<SidecarLivenessProbe>,
    /// The shared server-side layout snapshot (AUTO-01 spine, Task 13): the
    /// WS `ui.layout.sync` ingestion (`freshell_ws::terminal`'s
    /// `ClientMessage::UiLayoutSync` arm) REPLACES it, and the REST
    /// automation surface (Tasks 14-16) reads/mutates the SAME store.
    /// `freshell-server`'s `main.rs` constructs ONE instance and wires it
    /// into both this state (via [`Self::with_layout`]) and
    /// `freshell_ws::WsState::layout`. A fresh `Default` store (empty, no
    /// snapshot) everywhere it isn't wired, matching the other Slice-1/3a
    /// fields' "unwired == degrades honestly" convention.
    pub layout: layout_store::LayoutStore,
    /// Fix round 1 (Task 23 gap): the injectable post-create seam Node covers
    /// with the registry's `'terminal.created'` EVENT (`server/index.ts:647-655`
    /// -> `seedFromTerminal` for EVERY terminal, REST creates included). The
    /// Rust registry has no such event mechanism, and the meta store
    /// (`freshell_ws::terminal_meta::TerminalMetaRegistry`) is unreachable
    /// from this crate (`freshell-ws` depends on THIS crate, not vice versa
    /// -- the same constraint `spawn_terminal_pane`'s exit hook documents for
    /// `identity.retire`). So `freshell-server`'s `main.rs` -- where both
    /// crates are visible -- wires a closure here (via
    /// [`Self::with_terminal_created_hook`]) that runs the SAME create-time
    /// meta seed -> async git enrich -> `terminal.meta.updated` broadcast the
    /// WS `terminal.create` path gets. Fired by
    /// [`terminal_tabs::spawn_terminal_pane`] after every successful
    /// REST-pipeline create (tab create, pane split, restore). `None` until
    /// wired (the Option-until-wired convention): creates proceed, only the
    /// meta seeding is skipped.
    pub(crate) terminal_created_hook: Option<TerminalCreatedHook>,
    /// The `GET`/`POST /api/fresh-agent/model-capabilities/*` registry
    /// ([`model_capabilities`]): cwd-keyed TTL cache + single-flight coalescing
    /// over the transient opencode catalog probe, plus the static codex/claude
    /// catalogs. Constructed with the REAL transport probe in
    /// [`Self::new`] (there is no wiring ceremony — unlike the Option-until-
    /// wired fields above, production construction is unconditional); tests
    /// install a scripted probe via [`Self::with_model_capability_probe`].
    pub(crate) model_capabilities: Arc<model_capabilities::ModelCapabilityRegistry>,
    /// Task-3 child-session join (freshopencode TUI parity): child session id
    /// → the parent session id whose live watcher exists (Stage-2 ledger
    /// LB-2/LB-8). A watcher self-removes its entry on exit, so every parent
    /// snapshot build re-arms missing watchers — dead watchers never cause
    /// permanent refresh loss. std Mutex, short critical sections.
    child_watchers: Arc<Mutex<HashMap<String, String>>>,
    /// Task 4 test seam: the REST resume probe's `get_session` budget override
    /// (a wedged fake serve must NEVER wait the real 10s). Production
    /// resolution reads the same `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS`
    /// env var the WS resume door parses, default 10_000ms — the override is
    /// consulted BEFORE the env parse by [`Self::resume_probe_budget_ms`].
    /// Configured via [`Self::set_resume_probe_timeout_ms_for_test`].
    #[cfg(test)]
    resume_probe_timeout_ms: Arc<Mutex<Option<u64>>>,
    /// b8ke focused round-4 R4-2 test seam: when set, the REST opencode
    /// drive PARKS at the exact interleaving point under review — after
    /// the gate-held ownership/condemned re-check, BEFORE the prompt POST
    /// — until the Notify fires. Never armed in production. Installed via
    /// [`Self::set_rest_turn_test_pause_for_test`].
    #[cfg(test)]
    rest_turn_test_pause: Arc<Mutex<Option<Arc<tokio::sync::Notify>>>>,
    /// The ONE server-wide runtime-ownership coordinator (kata b8ke Task 3),
    /// wired from freshell-server::main next to `fresh_agent_leases`.
    /// `None` (every pre-existing test) = the lane skips coordinator
    /// bookkeeping and keeps its current probe-based behavior only.
    pub(crate) ownership: Option<Arc<freshell_ownership::RuntimeOwnershipRegistry>>,
    /// The lane's retained coordinator commit stamps (kata b8ke Task 3):
    /// canonical `ses_*` id → the stamp its `commit_live` left — the
    /// kill/exit `StopClaim`/`ReleaseClaim` source. Shared with the WS
    /// opencode slice (this state is the single object both surfaces wrap).
    pub(crate) ownership_stamps: ownership_lane::OwnershipStamps,
    /// b8ke focused round-3 review R3-1: the in-flight REST-driven
    /// opencode turns, keyed by canonical durable `ses_*` id — the REST
    /// send-keys participation registry the WS opencode lane's handoff
    /// stop / kill / fence-recovery paths consult (a REST pane is not
    /// represented in the WebSocket session map). See
    /// [`RestOpencodeTurn`].
    pub(crate) rest_opencode_turns: Arc<Mutex<HashMap<String, Arc<RestOpencodeTurn>>>>,
    /// b8ke focused round-4 review R4-2: the per-canonical-id
    /// DISPATCH/CONDEMN mutual-exclusion gates for REST opencode turns.
    /// The drive holds its session's gate across the [condemned/ownership
    /// re-check + accepted-witness arming + prompt POST] critical section,
    /// and every lifecycle quiesce path holds the SAME gate across its
    /// [witness take + condemn] section — the interleaving is total:
    /// either the POST is issued before the condemnation (the quiesce
    /// sees the armed witness and its abort confirms the daemon-side
    /// turn's death BEFORE the reap is reported), or the condemnation
    /// lands first (the drive's re-check refuses the dispatch typed). The
    /// gate is keyed by session (not carried in the witness Arc) so a
    /// witness REPLACEMENT can never leave the condemner gating a stale
    /// object. See [`FreshAgentState::rest_turn_gate`].
    rest_turn_gates: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
}

/// What [`terminal_tabs::spawn_terminal_pane`] hands the injected
/// terminal-created hook: the create-time identity Node's `seedFromTerminal`
/// reads off the registry record (`terminal-metadata-service.ts:138-146`).
/// `cwd` is the RESOLVED spawn cwd (what the registry record carries), not
/// the raw request field.
#[derive(Clone, Debug)]
pub struct TerminalCreatedEvent {
    pub terminal_id: String,
    pub mode: String,
    pub resume_session_id: Option<String>,
    pub cwd: Option<String>,
    /// Unified agent names (Task 2): the pre-durable naming handle admitted
    /// for a scoped CLI create (the hook in `freshell-server::main` writes it
    /// onto the shared identity registry + terminal registry, where the CLI
    /// locator bind lanes read it).
    pub naming_handle: Option<String>,
    /// Unified agent names: the durable naming target for a resume create
    /// (the pane names through the durable session's own record).
    pub name_ref: Option<freshell_protocol::session_names::SessionNameRef>,
}

/// The injectable post-create hook (see
/// [`FreshAgentState::with_terminal_created_hook`]). Must be cheap and
/// non-blocking on the create path -- the production wiring only builds a
/// meta record and `tokio::spawn`s the git enrichment.
pub type TerminalCreatedHook = Arc<dyn Fn(TerminalCreatedEvent) + Send + Sync>;

/// A fresh-agent pane (the `paneContent` subset the opencode T2 path needs).
#[derive(Clone)]
struct PaneEntry {
    placeholder_id: String,
    provider: String,
    session_type: String,
    cwd: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    /// The durable `ses_*` id after the first turn materializes it.
    durable_id: Option<String>,
}

/// b8ke focused round-3 review R3-1: the in-flight REST-driven opencode
/// turn witness — one per canonical durable `ses_*` id while a REST
/// `send-keys` drive may be mutating the session through the shared
/// serve. The REST pane is NOT represented in the WebSocket session map,
/// so this shared registry (on [`FreshAgentState`], shared with the WS
/// opencode lane by Arc) is what the lane's lifecycle stops see:
///
/// - `daemon_turn_accepted` arms at the prompt POST's DISPATCH boundary
///   (run_turn's accepted witness, the same seam the WS lane's turns
///   use): a handoff/kill that finds it armed must abort the daemon-side
///   turn (`POST /session/:id/abort`) to confirmed settlement before
///   reporting the reap.
/// - `condemned` is set by a lifecycle stop that finds the drive BEFORE
///   its dispatch: the drive checks it right before `run_turn` and
///   refuses to issue the prompt POST (the handoff owns the transition).
///
/// An `IdleTimeout` (or any ambiguous drive error) leaves the witness
/// armed and registered — the daemon-side turn may still run; only the
/// observed idle edge (or a confirmed abort / a lost sidecar) settles it.
pub(crate) struct RestOpencodeTurn {
    pub(crate) daemon_turn_accepted: Arc<AtomicBool>,
    pub(crate) condemned: AtomicBool,
    pub(crate) route: Option<String>,
}

/// A Slice-1 terminal pane's record: just enough to dispatch `send-keys` /
/// `capture` / `wait-for` to the right `terminal_id` in the shared registry.
#[derive(Clone)]
pub(crate) struct TerminalPaneEntry {
    pub(crate) terminal_id: String,
}

/// What a `restoreKey`-tagged create produced (continuity trio,
/// `tabs_snapshots.rs:632`): the minted tab/pane ids plus the spawned
/// terminal id (None for the no-process browser/editor content kinds), the
/// replayable create command, and the connections that received it.
#[derive(Clone, Debug)]
pub struct RestoreKeyEntry {
    pub tab_id: String,
    pub pane_id: String,
    pub terminal_id: Option<String>,
    pub ui_command: ServerMessage,
    pub delivered_to: HashSet<u64>,
}

/// Legacy per-tab shadow record. NOT the `GET /api/tabs` row -- that reads
/// the shared LayoutStore (AUTO-03). Load-bearing only for `pane_ops`:
/// `rename_tab` mirrors the title here, and `delete_tab` gates its legacy
/// shadow-map cleanup on this record's presence.
#[derive(Clone)]
pub(crate) struct TabRecord {
    pub(crate) title: Option<String>,
}

impl FreshAgentState {
    /// Build the state around the shared broadcast bus the WS connections fan out.
    pub fn new(
        auth_token: Arc<String>,
        broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    ) -> Self {
        Self {
            auth_token,
            broadcast_tx,
            panes: Arc::new(Mutex::new(HashMap::new())),
            opencode: Arc::new(tokio::sync::Mutex::new(None)),
            hosted_rest: Arc::new(std::sync::OnceLock::new()),
            sessions_revision: Arc::new(AtomicI64::new(0)),
            terminal_registry: None,
            session_identity: None,
            pane_identity: None,
            terminal_panes: Arc::new(Mutex::new(HashMap::new())),
            content_panes: Arc::new(Mutex::new(HashMap::new())),
            tabs: Arc::new(Mutex::new(HashMap::new())),
            pane_tabs: Arc::new(Mutex::new(HashMap::new())),
            restore_keys: Arc::new(Mutex::new(HashMap::new())),
            cli_commands: Arc::new(Vec::new()),
            opencode_locator: None,
            codex_locator: None,
            identity_sink: Arc::new(std::sync::OnceLock::new()),
            naming: NamingSink::default(),
            naming_handles: Arc::new(Mutex::new(HashMap::new())),
            spawn_gate: Arc::new(std::sync::OnceLock::new()),
            resume_probe: None,
            on_stale_resume: None,
            sidecar_liveness: None,
            layout: layout_store::LayoutStore::default(),
            terminal_created_hook: None,
            model_capabilities: Arc::new(model_capabilities::ModelCapabilityRegistry::new(
                Arc::new(model_capabilities::OpencodeCatalogProbe::default()),
            )),
            child_watchers: Arc::new(Mutex::new(HashMap::new())),
            #[cfg(test)]
            resume_probe_timeout_ms: Arc::new(Mutex::new(None)),
            #[cfg(test)]
            rest_turn_test_pause: Arc::new(Mutex::new(None)),
            ownership: None,
            ownership_stamps: Arc::new(Mutex::new(HashMap::new())),
            rest_opencode_turns: Arc::new(Mutex::new(HashMap::new())),
            rest_turn_gates: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Wire the ONE server-wide runtime-ownership coordinator (kata b8ke
    /// Task 3). Builder form — matches the neighboring `with_*` seams.
    pub fn with_ownership(
        mut self,
        ownership: Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    ) -> Self {
        self.ownership = Some(ownership);
        self
    }

    /// Side-effect-free coordinator read for `(provider, session_id)`
    /// (kata b8ke Task 3): the lane's snapshot of who owns the key.
    /// `Vacant`/0 when the registry is unwired (every pre-existing test).
    pub fn ownership_snapshot(
        &self,
        provider: &str,
        session_id: &str,
    ) -> freshell_ownership::OwnershipSnapshot {
        match &self.ownership {
            Some(registry) => registry.observe(provider, session_id),
            None => freshell_ownership::OwnershipSnapshot {
                epoch: 0,
                generation: 0,
                state: freshell_ownership::OwnershipState::Vacant,
            },
        }
    }

    /// b8ke ext r7 F3: [`Self::ownership_snapshot`] with the coordinator's
    /// ALIAS CHAIN resolved to the canonical key — the pane-recovery
    /// read. A superseded (rekeyed) session id answers with the CANONICAL
    /// record's state (the rekey mirrors the owner state onto the old key,
    /// but the old key is Aliased forever: a consumer that observes the raw
    /// key dead-ends on the alias state instead of following the live
    /// canonical owner).
    pub fn canonical_ownership_snapshot(
        &self,
        provider: &str,
        session_id: &str,
    ) -> freshell_ownership::OwnershipSnapshot {
        match &self.ownership {
            Some(registry) => {
                let canonical = registry.resolve_canonical(provider, session_id);
                registry.observe(provider, &canonical)
            }
            None => freshell_ownership::OwnershipSnapshot {
                epoch: 0,
                generation: 0,
                state: freshell_ownership::OwnershipState::Vacant,
            },
        }
    }

    /// b8ke ext r7 F3: the coordinator's alias-chain fixpoint for
    /// `(provider, session_id)` — pane recovery resolves the caller's raw
    /// id through this before any identity-seam lookup (the canonical key
    /// is the identity the resolvable terminal lives under).
    pub fn resolve_canonical_session(&self, provider: &str, session_id: &str) -> String {
        match &self.ownership {
            Some(registry) => registry.resolve_canonical(provider, session_id),
            None => session_id.to_string(),
        }
    }

    /// The watchdog's raw-teardown hook for opencode (kata b8ke Task 3): the
    /// shared `opencode serve` daemon is NOT the per-session writer and must
    /// NEVER be killed (OpenCode invariant); an uncommitted `Starting`
    /// record holds no bridge/turn of its own yet, so there is genuinely
    /// nothing to reap. Returns `true` (nothing-to-do is success).
    pub async fn opencode_kill_raw_for_watchdog(&self, session_id: &str) -> bool {
        tracing::info!(
            provider = PROVIDER,
            session_id,
            "freshagent.opencode.watchdog_reap_noop: the shared serve is never a kill target"
        );
        true
    }

    pub fn set_hosted_rest_gateway(
        &self,
        gateway: hosted_rest::SharedHostedFreshAgentRestGateway,
    ) -> Result<(), &'static str> {
        self.hosted_rest
            .set(gateway)
            .map_err(|_| "hosted fresh-agent REST gateway is already installed")
    }

    fn hosted_rest_gateway(&self) -> Option<hosted_rest::SharedHostedFreshAgentRestGateway> {
        self.hosted_rest.get().cloned()
    }

    /// Install a scripted model-catalog probe (tests) — the registry's
    /// `opencodeCatalogProvider` injection seam
    /// (`model-capability-registry.ts:196-202`). Rebuilds the registry around
    /// the replacement probe; any prior cache entries are discarded with it.
    pub fn with_model_capability_probe(
        mut self,
        probe: Arc<dyn model_capabilities::ModelCatalogProbe>,
    ) -> Self {
        self.model_capabilities = Arc::new(model_capabilities::ModelCapabilityRegistry::new(probe));
        self
    }

    /// Shared read access to the model-capability registry for the HTTP
    /// routes and server-side consumers (the session-directory context
    /// meter's opencode limit snapshot). The field stays `pub(crate)`;
    /// this accessor is the public seam.
    pub fn model_capabilities(
        &self,
    ) -> std::sync::Arc<model_capabilities::ModelCapabilityRegistry> {
        self.model_capabilities.clone()
    }

    /// Wire the P1.13 identity-event sink (set-once; later calls are no-ops).
    pub fn set_identity_sink(&self, sink: SharedPaneIdentitySink) {
        let _ = self.identity_sink.set(sink);
    }

    /// The wired identity sink, if any. Used by the REST send-keys
    /// materialization site ([`send_keys`]'s cold-start block).
    fn identity_sink(&self) -> Option<SharedPaneIdentitySink> {
        self.identity_sink.get().cloned()
    }

    /// Unified agent names (Task 2): wire the naming authority (set-once;
    /// later calls are no-ops). `freshell-server::main` injects the ONE
    /// local store participant; REST creates/renames in this crate resolve
    /// scoped names through it.
    pub fn set_session_naming(&self, sink: std::sync::Arc<dyn SessionNaming>) -> bool {
        self.naming.set(sink)
    }

    /// Unified agent names: the wired naming authority, if any (`None` =
    /// scoped naming fails unavailable — the out-of-scope test state).
    pub fn naming(&self) -> Option<std::sync::Arc<dyn SessionNaming>> {
        self.naming.get()
    }

    /// Unified agent names: stash a pre-durable handle against a placeholder
    /// id (the create lanes), so the materialization bind resolves it.
    pub(crate) fn stash_naming_handle(&self, placeholder: &str, handle: &str) {
        self.naming_handles
            .lock()
            .expect("naming_handles mutex")
            .insert(placeholder.to_string(), handle.to_string());
    }

    /// Unified agent names: remove and answer a placeholder's stashed
    /// pre-durable handle (the bind lanes).
    pub(crate) fn take_naming_handle(&self, placeholder: &str) -> Option<String> {
        self.naming_handles
            .lock()
            .expect("naming_handles mutex")
            .remove(placeholder)
    }

    /// Unified agent names: a placeholder's stashed handle without removing
    /// it (projection reads).
    pub(crate) fn peek_naming_handle(&self, placeholder: &str) -> Option<String> {
        self.naming_handles
            .lock()
            .expect("naming_handles mutex")
            .get(placeholder)
            .cloned()
    }

    /// Wire the server-wide spawn gate (set-once; later calls are no-ops).
    /// `timeout` bounds PERMIT ACQUISITION only, not spawn duration —
    /// identical semantics to the WS door.
    pub fn set_spawn_gate(&self, gate: Arc<spawn_gate::SpawnGate>, timeout: std::time::Duration) {
        let _ = self.spawn_gate.set(RestSpawnGate { gate, timeout });
    }

    /// The wired spawn gate, if any. `None` = ungated (unwired test states).
    pub(crate) fn spawn_gate(&self) -> Option<RestSpawnGate> {
        self.spawn_gate.get().cloned()
    }

    /// Boot-assertion probe (council enn3 follow-up): the spawn-gate
    /// OnceLock is a fail-OPEN seam — unwired means every REST create runs
    /// ungated. `freshell-server` asserts this at startup so a wiring
    /// regression fails LOUD at boot instead of silently ungating.
    pub fn spawn_gate_wired(&self) -> bool {
        self.spawn_gate.get().is_some()
    }

    /// Record what a `restoreKey`-tagged create produced (continuity trio,
    /// `tabs_snapshots.rs:632`). Called by `terminal_tabs`'s create paths
    /// immediately after the tab/pane maps are populated, so a restore retry
    /// in this SAME process can reconcile a create whose write-ahead marker
    /// promotion never landed (crash window between the pre-create marker
    /// write and the post-create terminalId record).
    pub(crate) fn record_restore_key(&self, key: &str, entry: RestoreKeyEntry) {
        self.restore_keys
            .lock()
            .expect("restore_keys mutex")
            .insert(key.to_string(), entry);
    }

    /// Look up what a prior `restoreKey`-tagged create produced in THIS
    /// process (`None` after a process restart — in-process terminals died
    /// with the process, so the restore path treats absence accordingly).
    pub fn lookup_restore_key(&self, key: &str) -> Option<RestoreKeyEntry> {
        self.restore_keys
            .lock()
            .expect("restore_keys mutex")
            .get(key)
            .cloned()
    }

    /// Record a synchronous targeted send. Restore serializes calls and invokes
    /// this immediately after `send_to_client` returns, before any await point.
    pub fn mark_restore_key_delivered(&self, key: &str, connection_id: u64) {
        if let Some(entry) = self
            .restore_keys
            .lock()
            .expect("restore_keys mutex")
            .get_mut(key)
        {
            entry.delivered_to.insert(connection_id);
        }
    }

    /// Retire a stale no-process content tab before force creates its
    /// replacement. Terminal entries are never retired through this path.
    pub fn retire_restore_key_content(&self, key: &str) -> Option<RestoreKeyEntry> {
        let entry = {
            let mut restore_keys = self.restore_keys.lock().expect("restore_keys mutex");
            let entry = restore_keys
                .get(key)
                .filter(|entry| entry.terminal_id.is_none())?
                .clone();
            restore_keys.remove(key);
            entry
        };
        self.content_panes
            .lock()
            .expect("content_panes mutex")
            .remove(&entry.pane_id);
        self.pane_tabs
            .lock()
            .expect("pane_tabs mutex")
            .remove(&entry.pane_id);
        self.tabs.lock().expect("tabs mutex").remove(&entry.tab_id);
        Some(entry)
    }

    /// Reissue a restore-owned terminal tab while keeping both its live PTY and
    /// its original tab/pane identity. Those ids were injected into the child
    /// as immutable `FRESHELL_TAB_ID`/`FRESHELL_PANE_ID` values at spawn, so a
    /// forced replay must close and recreate the same client identity.
    pub fn reissue_restore_key_terminal(&self, key: &str) -> Option<(String, RestoreKeyEntry)> {
        let mut replacement = self.lookup_restore_key(key)?;
        replacement.terminal_id.as_ref()?;
        let original_tab_id = replacement.tab_id.clone();
        replacement.delivered_to.clear();
        self.restore_keys
            .lock()
            .expect("restore_keys mutex")
            .insert(key.to_string(), replacement.clone());
        Some((original_tab_id, replacement))
    }

    /// Slice 3a: wire in the SAME registered coding-CLI command specs the WS
    /// `terminal.create` path resolves `mode` against
    /// (`freshell_ws::WsState::cli_commands`) -- so `POST /api/tabs` with
    /// `mode:"claude"/"codex"/"gemini"/"kimi"/"opencode"/"amplifier"` accepts
    /// the SAME set of modes the WS create path does, generically (no
    /// hardcoded mode list to drift out of sync). `freshell-server`'s
    /// `main.rs` calls this once at boot with the same `Arc` `WsState` holds.
    pub fn with_cli_commands(
        mut self,
        cli_commands: Arc<Vec<freshell_platform::CliCommandSpec>>,
    ) -> Self {
        self.cli_commands = cli_commands;
        self
    }

    /// Slice 3a (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md`): wire
    /// in the SAME [`freshell_sessions::opencode_locator::OpencodeLocator`]
    /// the WS `terminal.create` path arms, so a REST-created fresh opencode
    /// pane is armed in the identical instance the already-running periodic
    /// sweep polls. `freshell-server`'s `main.rs` calls this once at boot
    /// with the same `Arc` (or `None`) `WsState` holds.
    pub fn with_opencode_locator(
        mut self,
        locator: Option<Arc<freshell_sessions::opencode_locator::OpencodeLocator>>,
    ) -> Self {
        self.opencode_locator = locator;
        self
    }

    /// Sibling to [`Self::with_opencode_locator`] for the P1.14 /
    /// Incident-4 codex hardening's [`freshell_sessions::codex_locator::CodexLocator`].
    pub fn with_codex_locator(
        mut self,
        locator: Option<std::sync::Arc<freshell_sessions::codex_locator::CodexLocator>>,
    ) -> Self {
        self.codex_locator = locator;
        self
    }

    /// AUTO-01 spine (Task 13): wire in the SAME
    /// [`layout_store::LayoutStore`] `freshell_ws::WsState::layout` holds,
    /// so the WS `ui.layout.sync` ingestion and this crate's REST
    /// automation surface (Tasks 14-16) share ONE snapshot.
    /// `freshell-server`'s `main.rs` calls this once at boot. Mirrors the
    /// established `with_terminal_registry` builder pattern.
    pub fn with_layout(mut self, layout: layout_store::LayoutStore) -> Self {
        self.layout = layout;
        self
    }

    /// Fix round 1 (Task 23 gap): wire the post-create hook `freshell-server`
    /// uses to run the WS-parity meta seed -> async git enrich ->
    /// `terminal.meta.updated` broadcast for every REST-pipeline create (see
    /// the field doc for why this seam exists). Unwired == creates proceed,
    /// meta seeding skipped. Mirrors the established `with_*` builder pattern
    /// (e.g. [`Self::with_shared_sessions_revision`]).
    pub fn with_terminal_created_hook(mut self, hook: TerminalCreatedHook) -> Self {
        self.terminal_created_hook = Some(hook);
        self
    }

    /// Slice 1 (`docs/plans/2026-07-18-agent-api-mcp-parity-spec.md` \u00a79 Risk 1):
    /// wire in the SAME [`freshell_terminal::TerminalRegistry`] the WS
    /// `terminal.create` path uses, so Agent-API-created terminals live in ONE
    /// registry -- no orphan PTYs. `freshell-server`'s `main.rs` calls this
    /// once at boot. Mirrors the established `with_shared_sessions_revision`
    /// builder pattern.
    pub fn with_terminal_registry(mut self, registry: freshell_terminal::TerminalRegistry) -> Self {
        self.terminal_registry = Some(registry);
        self
    }

    /// D7 live-session guard (REST rung): wire in the read-only
    /// session-identity lookup (in production the WS-side
    /// `TerminalIdentityRegistry`, injected by `freshell-server`'s `main.rs`)
    /// so `spawn_terminal_pane` can probe the identity arm of
    /// [`freshell_terminal::TerminalRegistry::live_session_owner`]. Unwired
    /// (`None`), the guard degrades to the registry-row arm only.
    pub fn with_session_identity(
        mut self,
        identity: Arc<dyn freshell_terminal::registry::SessionIdentityLookup>,
    ) -> Self {
        self.session_identity = Some(identity);
        self
    }

    /// Write-side twin of [`Self::with_session_identity`] (kata hbsa): wire
    /// in the pane-identity binder so the REST spawn pipeline
    /// (`spawn_terminal_pane` -> `settle_gated_create`) can write identity
    /// rows and durable ledger bindings exactly like the WS create path.
    /// Unwired (`None`), REST creates keep the legacy no-write behavior.
    pub fn with_pane_identity_binder(
        mut self,
        binder: Arc<dyn freshell_terminal::registry::PaneIdentityBinder>,
    ) -> Self {
        self.pane_identity = Some(binder);
        self
    }

    /// Door 3 (resume-validation): wire the disk-existence probe the REST
    /// create pipeline consults before turning a cached resume id into
    /// resume argv. `freshell-server`'s main.rs builds it over the SAME
    /// `SessionExistenceProbe` the WS doors use. Unwired = feature off =
    /// today's behavior.
    pub fn with_resume_probe(
        mut self,
        probe: freshell_platform::resume_gate::ResumeProbeFn,
    ) -> Self {
        self.resume_probe = Some(probe);
        self
    }

    /// Door 3: wire the gate-fired callback (`(provider, stale_session_id)`),
    /// implemented by `freshell-server`'s main.rs as pane-ledger
    /// `retire_missing` + `tracing::warn!`.
    pub fn with_on_stale_resume(mut self, cb: OnStaleResume) -> Self {
        self.on_stale_resume = Some(cb);
        self
    }

    /// Door 3: wire arm 2 of the in-gate liveness precondition (see
    /// [`SidecarLivenessProbe`]). MUST stay a consuming `with_*` builder like
    /// its siblings, NOT a `set_*`/`OnceLock` late-bind: `FreshOpencodeState`
    /// holds a `FreshAgentState` clone by value, so a late-bound handle back
    /// to the sidecars would create a real Arc cycle.
    pub fn with_sidecar_liveness(mut self, probe: SidecarLivenessProbe) -> Self {
        self.sidecar_liveness = Some(probe);
        self
    }

    /// SESSION-09 fix-forward: replace this state's own `sessions_revision`
    /// counter with a SHARED one -- in production, `freshell-server` wires
    /// this to the SAME `Arc<AtomicI64>` as `freshell_ws::WsState::sessions_revision`
    /// (the periodic session-directory sweep's counter), so this crate's
    /// `sessions.changed` emission (`broadcast_sessions_changed`) and that
    /// sweep draw from ONE monotonic sequence instead of two independent
    /// ones. Without this, the client's "accept only if revision increases"
    /// watermark (`src/App.tsx:924-932`) can silently drop a real change from
    /// one producer behind a lower-or-equal revision from the other.
    pub fn with_shared_sessions_revision(mut self, shared: Arc<AtomicI64>) -> Self {
        self.sessions_revision = shared;
        self
    }

    /// Reap the opencode serve sidecar (SIGTERM/SIGKILL + the `/proc` ownership sweep).
    /// Called on server shutdown so the spawned serve leaves no orphan.
    pub async fn shutdown(&self) {
        let manager = self.opencode.lock().await.take();
        if let Some(manager) = manager {
            manager.shutdown().await;
        }
    }

    /// Shared with [`opencode_ws::FreshOpencodeState`] (same crate root), which pushes
    /// `freshAgent.created` / `freshAgent.send.accepted` / `freshAgent.session.materialized`
    /// / `freshAgent.killed` onto the SAME bus this REST slice uses.
    /// SESSION-09 fix-forward: bump the (possibly-shared, see
    /// `with_shared_sessions_revision`) `sessions_revision` counter and
    /// broadcast the resulting `sessions.changed` frame. Extracted from the
    /// durable-session materialization call site so the counter-unification
    /// fix is independently unit-testable without driving a full opencode
    /// `send-keys` turn.
    pub(crate) fn broadcast_sessions_changed(&self) {
        let revision = self.sessions_revision.fetch_add(1, Ordering::SeqCst) + 1;
        self.broadcast(&ServerMessage::SessionsChanged(SessionsChanged {
            revision,
        }));
    }

    pub(crate) fn broadcast(&self, msg: &ServerMessage) {
        if let Ok(frame) = serde_json::to_string(msg) {
            // A send with no live receivers is fine (returns Err) — the capture socket
            // subscribed before the handshake, so it will observe every broadcast.
            let _ = self.broadcast_tx.send(frame);
        }
    }

    /// b8ke focused round-3 review R3-1: register the REST-driven turn
    /// witness for a canonical durable `ses_*` id, replacing any leftover
    /// entry an earlier timed-out drive left (the witness tracks the
    /// session's daemon-side turn, not a specific request). Registered
    /// BEFORE the ownership check and the dispatch so a concurrent
    /// lifecycle stop can see the in-flight drive either way.
    pub(crate) fn register_rest_opencode_turn(
        &self,
        durable_id: &str,
        route: Option<String>,
    ) -> Arc<RestOpencodeTurn> {
        let witness = Arc::new(RestOpencodeTurn {
            daemon_turn_accepted: Arc::new(AtomicBool::new(false)),
            condemned: AtomicBool::new(false),
            route,
        });
        self.rest_opencode_turns
            .lock()
            .expect("rest opencode turns lock")
            .insert(durable_id.to_string(), Arc::clone(&witness));
        witness
    }

    /// b8ke focused round-3 review R3-1: the ownership/claim check a REST
    /// turn dispatch must pass — the canonical key must be
    /// `Live{FreshAgent}` (this pane's materialization committed it; a
    /// concurrent handoff/stop, a fence, or a foreign owner refuses the
    /// dispatch typed). `false` when unwired (the legacy no-coordinator
    /// behavior every pre-existing test keeps).
    pub(crate) fn rest_turn_ownership_granted(&self, durable_id: &str) -> bool {
        let Some(registry) = self.ownership.as_ref() else {
            return true;
        };
        matches!(
            registry.observe(PROVIDER, durable_id).state,
            freshell_ownership::OwnershipState::Live {
                owner,
                ..
            } if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
        )
    }

    /// b8ke focused round-3 review R3-1: settle the REST turn witness
    /// after the drive's own await resolved. A genuinely-settled turn
    /// (the idle edge observed, or the sidecar itself gone — nothing runs
    /// daemon-side) disarms and unregisters; every other outcome
    /// (IdleTimeout, ambiguous errors) keeps the witness ARMED and
    /// REGISTERED — the daemon-side turn may still run, and only a
    /// lifecycle stop's confirmed abort (or a later drive's replacement)
    /// may clear it.
    pub(crate) fn settle_rest_opencode_turn(
        &self,
        durable_id: &str,
        witness: &Arc<RestOpencodeTurn>,
        settled: bool,
    ) {
        if settled {
            witness.daemon_turn_accepted.store(false, Ordering::SeqCst);
            let mut turns = self
                .rest_opencode_turns
                .lock()
                .expect("rest opencode turns lock");
            if let Some(registered) = turns.get(durable_id) {
                if Arc::ptr_eq(registered, witness) {
                    turns.remove(durable_id);
                }
            }
        }
    }

    /// Remove a REST turn witness registration on a refusal path (the
    /// ownership/condemned check failed before any dispatch).
    pub(crate) fn remove_rest_opencode_turn(
        &self,
        durable_id: &str,
        witness: &Arc<RestOpencodeTurn>,
    ) {
        let mut turns = self
            .rest_opencode_turns
            .lock()
            .expect("rest opencode turns lock");
        if let Some(registered) = turns.get(durable_id) {
            if Arc::ptr_eq(registered, witness) {
                turns.remove(durable_id);
            }
        }
    }

    /// b8ke focused round-4 review R4-2: the per-canonical-id
    /// dispatch/condemn gate. Get-or-create (id-keyed, stable across
    /// witness replacements — see [`Self::rest_turn_gates`]). The REST
    /// drive holds this gate across its [re-check + arming + prompt POST]
    /// critical section; the lifecycle quiesce paths hold it across
    /// [witness take + condemn]. Neither side ever acquires another
    /// session's gate while holding one, so no lock ordering exists.
    pub(crate) fn rest_turn_gate(&self, durable_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut gates = self.rest_turn_gates.lock().expect("rest turn gates lock");
        gates
            .entry(durable_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// b8ke focused round-4 review R4-3: settle the RETAINED REST turn
    /// witness for a canonical id BEFORE a new drive replaces it. An
    /// earlier drive that answered `IdleTimeout` (or any ambiguous
    /// error) deliberately leaves its witness ARMED and REGISTERED — its
    /// daemon-side turn may still be mutating the session — so a second
    /// request replacing the registry entry unconditionally would SILENTLY
    /// FORGET that unresolved writer (handoffs could only ever see the
    /// replacement). Settle-then-replace: the retained witness is
    /// CONDEMNED and, when its accepted flag is armed, its daemon-side
    /// turn is aborted to confirmed settlement through the PEEKED manager
    /// (never spawning and never killing the shared daemon — OpenCode
    /// invariant), bounded by the new drive's own turn budget.
    ///
    /// Returns `true` when the retained witness was ABSENT, never
    /// dispatched, or its daemon-side turn is CONFIRMED settled — the
    /// caller may register its own witness. Returns `false` when the
    /// bounded settle could not confirm: the retained witness STAYS
    /// registered and condemned (no orphan writer — the registry keeps it
    /// visible to every lifecycle stop; the next attempt or a handoff
    /// kill retries the settle) and the caller must refuse the new drive
    /// typed.
    pub(crate) async fn settle_retained_rest_opencode_turn(
        &self,
        durable_id: &str,
        budget: std::time::Duration,
    ) -> bool {
        let retained = {
            let turns = self
                .rest_opencode_turns
                .lock()
                .expect("rest opencode turns lock");
            turns.get(durable_id).cloned()
        };
        let Some(retained) = retained else {
            return true;
        };
        retained.condemned.store(true, Ordering::SeqCst);
        if !retained.daemon_turn_accepted.load(Ordering::SeqCst) {
            // Never dispatched — nothing of ours runs daemon-side.
            return true;
        }
        let real = durable_id.to_string();
        let route = retained.route.clone();
        let accepted = Arc::clone(&retained.daemon_turn_accepted);
        let settle =
            crate::opencode_ws::settle_accepted_daemon_turn(self, &real, &route, &accepted);
        match tokio::time::timeout(budget, settle).await {
            Ok(()) => true,
            Err(_elapsed) => {
                tracing::warn!(target: "freshell_freshagent::opencode",
                    session_id = %durable_id,
                    "freshagent.opencode.rest_turn_replacement_settle_unconfirmed: a prior \
                     REST-driven daemon turn could not be quiesced within the drive's budget — \
                     the retained witness stays registered; the new drive is refused"
                );
                false
            }
        }
    }

    /// Get-or-create the single serve client. `ServeConfig::default()` reads `OPENCODE_CMD`
    /// (unset in the cold-start path → the real `opencode` binary). Cheap `Arc` clone.
    ///
    /// `pub(crate)` so [`opencode_ws::FreshOpencodeState`] reuses THIS ONE manager cell
    /// instead of constructing its own — the "never spawn a second `opencode serve`
    /// sidecar" invariant PR-2 depends on.
    pub(crate) async fn ensure_manager(&self) -> OpencodeServeManager {
        let mut guard = self.opencode.lock().await;
        if let Some(manager) = guard.as_ref() {
            return manager.clone();
        }
        let deps = ServeDeps {
            spawner: Arc::new(TokioProcessSpawner),
            http: Arc::new(ReqwestServeHttp::new()),
            ports: Arc::new(LoopbackPortAllocator),
            events: Arc::new(ReqwestEventSource::new()),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        *guard = Some(manager.clone());
        manager
    }

    /// b8ke delta review F1: the shared serve manager ONLY when it already
    /// exists and is started — the cell is peeked without creating it and
    /// its started-ness read without starting it (the F4 discipline). For
    /// the handoff stop path's daemon-side turn abort: a stop path must
    /// never SPAWN a daemon (and a daemon that is not running cannot be
    /// executing a turn, so there is nothing to abort through).
    pub(crate) async fn peek_running_manager(&self) -> Option<OpencodeServeManager> {
        let manager = self.opencode.lock().await.clone();
        match manager {
            Some(manager) if manager.base_url().await.is_some() => Some(manager),
            _ => None,
        }
    }

    /// Test-only: seed the manager cell with a fake-backed [`OpencodeServeManager`] so
    /// [`opencode_ws`]'s unit tests can drive `ensure_manager()` deterministically, with
    /// NO real `opencode` process spawned.
    #[cfg(test)]
    pub(crate) async fn set_manager_for_test(&self, manager: OpencodeServeManager) {
        *self.opencode.lock().await = Some(manager);
    }

    /// Unified agent names (Task 3): the shared serve-manager cell the
    /// native naming adapter holds. `None` before the first `ensure_manager`
    /// (the first freshopencode pane's lane) — the adapter resolves the
    /// CURRENT manager per operation so the lazy creation un-pauses armed
    /// native series; it never spawns a serve just to check a name.
    /// Read-only by contract from the adapter: `ensure_manager` remains the
    /// only spawner.
    pub fn opencode_shared_handle(&self) -> SharedOpencodeManagerHandle {
        Arc::clone(&self.opencode)
    }

    /// Test-only probe: is the shared serve manager cell populated? (The
    /// side-effect-free cold-GET tests assert the cell stays empty across a
    /// GET — the manager is only ever created by the explicit lifecycle
    /// paths.)
    #[cfg(test)]
    pub(crate) async fn opencode_manager_present_for_test(&self) -> bool {
        self.opencode.lock().await.is_some()
    }

    /// Task 4 test seam: bound the REST resume probe's `get_session` budget
    /// WITHOUT touching the process-global `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS`
    /// env var — an existing opencode_ws.rs test already sets/removes that var
    /// unsynchronized, and parallel tokio tests would race it. Consulted BEFORE
    /// the env parse by [`Self::resume_probe_budget_ms`].
    #[cfg(test)]
    pub(crate) fn set_resume_probe_timeout_ms_for_test(&self, ms: u64) {
        *self
            .resume_probe_timeout_ms
            .lock()
            .expect("resume_probe_timeout_ms mutex") = Some(ms);
    }

    /// b8ke focused round-4 R4-2 test seam installer: see
    /// [`Self::rest_turn_test_pause`].
    #[cfg(test)]
    pub(crate) fn set_rest_turn_test_pause_for_test(
        &self,
        pause: Option<Arc<tokio::sync::Notify>>,
    ) {
        *self
            .rest_turn_test_pause
            .lock()
            .expect("rest_turn_test_pause mutex") = pause;
    }

    /// The REST resume probe's bounded `get_session` budget, in milliseconds:
    /// cfg(test) state override > `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS`
    /// env parse > 10_000ms default — resolved purely by
    /// [`resolve_probe_timeout_ms`], the same function the WS resume door
    /// uses (`opencode_ws.rs`), so both doors share one parse semantics.
    fn resume_probe_budget_ms(&self) -> u64 {
        #[cfg(test)]
        let state_override = *self
            .resume_probe_timeout_ms
            .lock()
            .expect("resume_probe_timeout_ms mutex");
        #[cfg(not(test))]
        let state_override = None;
        resolve_probe_timeout_ms(
            state_override,
            std::env::var("FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS")
                .ok()
                .as_deref(),
        )
    }

    // ── GET /api/fresh-agent/threads/freshopencode/opencode/:threadId (Batch D PR-5) ──

    pub(crate) async fn local_snapshot_owner(
        &self,
        native_id: &str,
    ) -> Option<freshell_ownership::OwnershipSnapshot> {
        // A shared daemon alone does not prove this conversation belongs to the local lane.
        self.ownership.as_ref()?;
        let manager = self.opencode.lock().await.clone()?;
        manager.base_url().await?;
        ownership_lane::current_local_snapshot_owner(
            &self.ownership,
            &self.ownership_stamps,
            PROVIDER,
            native_id,
            native_id,
            None,
        )
    }

    /// Build a `FreshAgentSnapshotSchema`-shaped JSON snapshot for an opencode session
    /// (`adapter.ts getSnapshot`, `adapter.ts:574-592` + `normalizeOpencodeSnapshot`,
    /// `normalize.ts:357-405`). `thread_id` is treated as the durable `ses_*` id (the id a
    /// materialized fresh-agent pane's REST/WS surfaces hand the client) -- there is no
    /// placeholder-session snapshot path here (an un-materialized pane has no opencode
    /// session to read yet; the client only calls this endpoint after a `sessionRef`/
    /// `sessionId` exists).
    ///
    /// SIDE-EFFECT-FREE (b8ke delta review F4): the shared `opencode serve`
    /// is consulted ONLY when it is already running — the manager cell is
    /// peeked without creating it, and its started-ness read without
    /// starting it (`base_url` is the read-only `baseUrlOrUndefined`). A
    /// daemon-absent GET never spawns: the coordinator decides (the codex
    /// Task-5 contract) — a Live owner answers the typed 409 refusal, a
    /// lifecycle transition answers the typed 409, and everything else
    /// serves the EMPTY-FROM-DISK snapshot (the durable rollback record +
    /// the additive owner-state fields). Cold resume flows only through
    /// the explicit lifecycle commands (`freshAgent.create`/`attach` with
    /// `sessionRef`, generation-fenced) — the shared daemon starts only
    /// there.
    pub async fn get_opencode_snapshot(
        &self,
        thread_id: &str,
        cwd: Option<&str>,
    ) -> Result<Value, OpencodeSnapshotError> {
        // Fix Task #3 (defect 3): a `freshopencode-*` placeholder id (minted by
        // `create_tab` above and by `opencode_ws::handle_create`, BEFORE the pane's first
        // `send-keys`/`freshAgent.send` materializes a real `ses_*` opencode session) is,
        // by construction, never a live `opencode serve` session -- serve genuinely has no
        // such id and 500s, so the pane shows "Failed to load session" and is unusable
        // forever (there is no send-independent way to materialize it). Legacy
        // (`adapter.ts getSnapshot`, `adapter.ts:574-581`) guards this BEFORE ever touching
        // serve: `if (liveState && !liveState.realSessionId) return
        // normalizeOpencodeSnapshot({...no exported})` -- a schema-valid, EMPTY snapshot.
        // This port has no single in-memory map spanning both the REST `panes` map (this
        // struct) and the WS `opencode_ws::FreshOpencodeState::sessions` map, so mirror the
        // safe, general form of that guard: this port's ONE placeholder-id shape is
        // sufficient on its own (no `ses_*` id is ever the empty string prefixed this way),
        // so short-circuit on it directly, reusing [`build_opencode_snapshot_json`] with an
        // empty info/message page -- WITHOUT ever calling [`Self::ensure_manager`]/serve. A
        // `ses_*` (or any other) id serve genuinely doesn't know about still falls through
        // to the serve path below and surfaces as a real
        // `OpencodeSnapshotError::NotFound` (404).
        if thread_id.starts_with(OPENCODE_PLACEHOLDER_PREFIX) {
            return Ok(build_opencode_snapshot_json(
                thread_id,
                &json!({}),
                &json!([]),
                // A placeholder id never has a rollback record (rollback needs a
                // materialized session).
                None,
            ));
        }

        // b8ke focused review FR2: the daemon capture — ONE observation of
        // the running entry (the manager handle AND its read-only base
        // URL). Everything below uses ONLY this captured pair: no
        // `require_base` re-lookup (which `ensure_started`s a replacement
        // daemon if the running entry disappeared mid-GET) and no
        // `discard_running` (a timeout never kills the shared daemon — the
        // captured-base transport refuses both). Any failure of the
        // captured instance falls to the ownership-gated disk-state answer.
        let captured: Option<(OpencodeServeManager, String)> = {
            let running = self.opencode.lock().await.clone();
            match running {
                Some(manager) => manager.base_url().await.map(|base| (manager, base)),
                None => None,
            }
        };
        let (manager, base) = match captured {
            Some(captured) => captured,
            None => {
                // Daemon absent: NO spawn — the coordinator decides (the
                // codex Task-5 contract).
                return self.opencode_disk_state_response(thread_id);
            }
        };
        let route: freshell_opencode::Route = cwd.map(str::to_string);

        let info = match manager.get_session_at(thread_id, &route, &base).await {
            Ok(value) if value.is_object() => value,
            Ok(_) => return Err(OpencodeSnapshotError::NotFound),
            Err(ServeError::Http { status: 404, .. }) => {
                return Err(OpencodeSnapshotError::NotFound);
            }
            // The captured instance failed (the daemon died or wedged after
            // the capture): degrade to the disk-state/409 shape — never a
            // re-lookup, never a spawn, never a kill.
            Err(_) => return self.opencode_disk_state_response(thread_id),
        };
        let messages = match manager.list_messages_at(thread_id, &route, &base).await {
            Ok(value) => value,
            Err(ServeError::Http { status: 404, .. }) => json!([]),
            Err(_) => return self.opencode_disk_state_response(thread_id),
        };

        // Kata 1wxv Task 5: the DURABLE rollback record (memory-fast sync read
        // over the ledger's write-through index) sources the marker bucket,
        // `canRedo`, `undoneDepth`, and the revision floor — durable even after
        // a native send deletes the reverted tail (decision 6).
        let rollback = self
            .identity_sink()
            .and_then(|s| s.load_rollback(PROVIDER, thread_id));
        let mut snapshot =
            build_opencode_snapshot_json(thread_id, &info, &messages, rollback.as_ref());
        // Server-side child-session join (Stage-2 ledger LB-2): this REST builder
        // is the single client-visible snapshot producer, so the join AND the
        // live-refresh registry live here, on FreshAgentState — reachable for
        // every session (live or sidebar-opened durable), re-armed on every
        // build (LB-8).
        // ORDER (plan-review round 1, Finding 4): watch FIRST, fetch SECOND. The
        // subscribe call creates the broadcast receiver synchronously BEFORE the
        // child-history fetch runs, so a child event racing the fetch is buffered
        // in the channel instead of lost — a tokio broadcast receiver does not
        // replay.
        self.ensure_child_watchers(&manager, thread_id, &snapshot);
        attach_child_activity(&manager, &route, &mut snapshot).await;
        Ok(snapshot)
    }

    /// Ensure a live child→parent watcher exists for every child session this
    /// snapshot's `task_delegation` items reference (the live-refresh half of
    /// the Task-3 child-session join). Subscribe BEFORE spawning
    /// (`spawn_serve_bridge` discipline): the tokio broadcast receiver is
    /// created synchronously here, so child events racing the spawned task's
    /// startup are buffered, not lost. The watcher maps child `message.*`
    /// events to a `freshAgent.session.changed` frame for the PARENT session
    /// (reason `opencode-message`) — the frame that drives the client's
    /// existing snapshot refetch — and self-removes its registry entry on exit
    /// so the next parent build re-arms it (LB-8).
    fn ensure_child_watchers(
        &self,
        manager: &OpencodeServeManager,
        parent_id: &str,
        snapshot: &Value,
    ) {
        for child in opencode_snapshot_child_session_ids(snapshot) {
            let mut watchers = self.child_watchers.lock().expect("child_watchers poisoned");
            if watchers.contains_key(&child) {
                continue;
            }
            watchers.insert(child.clone(), parent_id.to_string());
            drop(watchers);
            // The registry entry is inserted BEFORE subscribe+spawn, so a
            // concurrent build never double-spawns for the same child.
            let rx = manager.subscribe(&child);
            let fresh_agent = self.clone();
            let parent_id = parent_id.to_string();
            tokio::spawn(async move {
                let mut rx = rx;
                loop {
                    match tokio::time::timeout(
                        Duration::from_secs(OPENCODE_CHILD_WATCHER_IDLE_SECS),
                        rx.recv(),
                    )
                    .await
                    {
                        Err(_elapsed) => break,
                        Ok(Ok(SessionSignal::Event(parsed))) => {
                            if !parsed.kind.starts_with("message.") {
                                continue;
                            }
                            fresh_agent.broadcast(&opencode_ws::event_frame(
                                &parent_id,
                                opencode_ws::changed_event(&parent_id, "opencode-message"),
                            ));
                        }
                        // Same tolerance arms as `spawn_serve_bridge`: a lost
                        // sidecar is surfaced by the parent's own serve bridge,
                        // and a Lagged burst must not kill the live refresh
                        // (LB-3).
                        Ok(Ok(SessionSignal::Lost)) => {}
                        Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {}
                        Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
                    }
                }
                // Self-remove: the next parent snapshot build re-arms (LB-8).
                fresh_agent
                    .child_watchers
                    .lock()
                    .expect("child_watchers poisoned")
                    .remove(&child);
            });
        }
    }

    /// b8ke focused review FR2: the ownership-gated answer for a GET that
    /// could not consult a live daemon (absent at capture, or the captured
    /// instance failed). A Live owner answers the typed 409 refusal (never
    /// a spawn on top of an owner, never an empty snapshot pretending
    /// vacancy); a lifecycle transition answers the typed 409; everything
    /// else serves the EMPTY-FROM-DISK snapshot. Cold resume flows only
    /// through the explicit lifecycle commands (`freshAgent.create`/
    /// `attach` with `sessionRef`, generation-fenced) — the shared daemon
    /// starts only there.
    fn opencode_disk_state_response(
        &self,
        thread_id: &str,
    ) -> Result<Value, OpencodeSnapshotError> {
        // b8ke focused review FR7: ONE ownership observation both chooses
        // the branch AND stamps the vacant snapshot's fence pair — a second
        // observation could label a just-claimed active generation
        // "vacant" (the impossible snapshot).
        let ownership = self.ownership_snapshot(PROVIDER, thread_id);
        match ownership.state {
            // An aliased (re-keyed) key has no writer under THIS id — the
            // canonical record lives under the resolved key; the snapshot
            // falls through to the vacant-read-only arm.
            freshell_ownership::OwnershipState::Aliased { .. } => Ok(
                self.opencode_empty_disk_snapshot(thread_id, ownership.epoch, ownership.generation)
            ),
            freshell_ownership::OwnershipState::Live {
                owner, generation, ..
            } => Err(OpencodeSnapshotError::ReservedByOwner {
                owner_kind: owner.kind,
                generation,
            }),
            freshell_ownership::OwnershipState::Handoff { generation, .. }
            | freshell_ownership::OwnershipState::Starting { generation, .. }
            | freshell_ownership::OwnershipState::Stopping { generation, .. }
            | freshell_ownership::OwnershipState::Fenced { generation, .. } => {
                Err(OpencodeSnapshotError::HandoffInProgress { generation })
            }
            freshell_ownership::OwnershipState::Vacant => Ok(self.opencode_empty_disk_snapshot(
                thread_id,
                ownership.epoch,
                ownership.generation,
            )),
        }
    }

    /// b8ke delta review F4: the side-effect-free EMPTY-FROM-DISK snapshot
    /// for a daemon-absent GET — the empty info/message page over the
    /// durable rollback record (the lane's only serve-independent disk
    /// state), plus the additive owner-state fields under
    /// `extensions.opencode` (the strict client schema's permissive
    /// per-provider bag) naming the vacant key with the caller's
    /// SINGLE-OBSERVED epoch/generation (b8ke focused FR7 — threaded from
    /// [`Self::opencode_disk_state_response`]'s one observation, never
    /// re-observed here). No daemon was consulted; no daemon was created.
    fn opencode_empty_disk_snapshot(&self, thread_id: &str, epoch: u64, generation: u64) -> Value {
        let rollback = self
            .identity_sink()
            .and_then(|s| s.load_rollback(PROVIDER, thread_id));
        let mut snapshot =
            build_opencode_snapshot_json(thread_id, &json!({}), &json!([]), rollback.as_ref());
        snapshot["extensions"]["opencode"]["ownerKind"] = json!("vacant");
        snapshot["extensions"]["opencode"]["ownerEpoch"] = json!(epoch);
        snapshot["extensions"]["opencode"]["ownerGeneration"] = json!(generation);
        snapshot
    }
}

/// Why [`FreshAgentState::get_opencode_snapshot`] could not produce a snapshot.
#[derive(Debug)]
pub enum OpencodeSnapshotError {
    /// The serve reported no such session (a 404, or a non-object `/session/:id` body).
    NotFound,
    /// The serve request itself failed (transport, cold-start, etc.).
    Serve(ServeError),
    /// b8ke delta review F4: the key is owned by a runtime this read-only GET
    /// cannot serve (daemon absent) — the typed refusal, never a spawn on top
    /// of an owner.
    ReservedByOwner {
        owner_kind: freshell_ownership::RuntimeOwnerKind,
        generation: u64,
    },
    /// b8ke delta review F4: a lifecycle transition (Starting/Handoff/
    /// Stopping) holds the key — the typed refusal until it settles.
    HandoffInProgress { generation: u64 },
}

impl std::fmt::Display for OpencodeSnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            OpencodeSnapshotError::NotFound => write!(f, "opencode session not found"),
            OpencodeSnapshotError::Serve(err) => write!(f, "{err}"),
            OpencodeSnapshotError::ReservedByOwner { .. } => {
                write!(f, "opencode session reserved by a live runtime owner")
            }
            OpencodeSnapshotError::HandoffInProgress { .. } => write!(
                f,
                "opencode session held by an in-flight lifecycle operation"
            ),
        }
    }
}

/// `modelFromInfo(info)` (`normalize.ts:30-37`): `providerID/modelID`, falling back to a bare
/// `modelID`/`model.id` when no provider is present.
fn opencode_model_from_info(info: &Value) -> Option<String> {
    let provider_id = info
        .get("providerID")
        .and_then(Value::as_str)
        .or_else(|| info.pointer("/model/providerID").and_then(Value::as_str));
    let model_id = info
        .get("modelID")
        .and_then(Value::as_str)
        .or_else(|| info.pointer("/model/modelID").and_then(Value::as_str))
        .or_else(|| info.pointer("/model/id").and_then(Value::as_str));
    match (provider_id, model_id) {
        (Some(provider), Some(model)) => Some(format!("{provider}/{model}")),
        (None, Some(model)) => Some(model.to_string()),
        _ => None,
    }
}

/// The CLI/TUI `errorMessage` rendering (`packages/tui/src/util/error.ts`): a
/// string `data.message` is shown verbatim (the real deadline failure persists
/// its provider payload double-encoded there); every other persisted shape is
/// pretty-printed as the whole error object, matching `errorFormat`'s
/// `JSON.stringify(error, null, 2)`. The workspace serde_json
/// `preserve_order` feature keeps the wire key order (`name`, then `data`).
/// An empty `data.message` falls through to the JSON rendering, exactly like
/// the helper's truthy-string check; the wire contract requires non-empty text.
fn opencode_turn_error_from_info(info: &Value) -> Option<Value> {
    let error = info.get("error")?;
    error.as_object()?;
    let name = error
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("UnknownError");
    let message = error
        .pointer("/data/message")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            serde_json::to_string_pretty(error).unwrap_or_else(|_| "unknown error".to_string())
        });
    Some(json!({ "name": name, "message": message }))
}

/// `tokenUsage(info)` (`normalize.ts:39-52`).
fn opencode_token_usage(info: &Value) -> Value {
    let tokens = info.get("tokens").cloned().unwrap_or_else(|| json!({}));
    let input = tokens.get("input").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let output = tokens.get("output").and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let cached = tokens
        .pointer("/cache/read")
        .and_then(Value::as_f64)
        .map(|v| v as i64);
    let total = tokens
        .get("total")
        .and_then(Value::as_f64)
        .map(|v| v as i64)
        .unwrap_or(input + output + cached.unwrap_or(0));

    let mut usage = Map::new();
    usage.insert("inputTokens".to_string(), json!(input));
    usage.insert("outputTokens".to_string(), json!(output));
    if let Some(cached) = cached {
        usage.insert("cachedTokens".to_string(), json!(cached));
    }
    usage.insert("totalTokens".to_string(), json!(total));
    if let Some(reasoning) = tokens.get("reasoning").and_then(Value::as_f64) {
        usage.insert("contextTokens".to_string(), json!(reasoning as i64));
    }
    if let Some(cost) = info.get("cost").and_then(Value::as_f64) {
        usage.insert("costUsd".to_string(), json!(cost));
    }
    Value::Object(usage)
}

/// `normalizeOpencodeRole(value)` (`normalize.ts:24-28`).
fn opencode_role(value: Option<&str>) -> Option<&'static str> {
    match value {
        Some("user") => Some("user"),
        Some("assistant") => Some("assistant"),
        Some("system") => Some("system"),
        Some("tool") => Some("tool"),
        _ => None,
    }
}

/// `fileAttachmentTarget(part)` (`normalize.ts:54-59`).
fn opencode_file_attachment_target(part: &Value) -> String {
    for key in ["filename", "name", "url", "path"] {
        if let Some(v) = part.get(key).and_then(Value::as_str) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    "unknown file".to_string()
}

/// `normalizePatchChange(value)` (`normalize.ts:61-75`).
fn opencode_normalize_patch_change(value: &Value) -> Option<Value> {
    if let Some(s) = value.as_str() {
        return if s.is_empty() {
            None
        } else {
            Some(json!({ "path": s }))
        };
    }
    if let Some(obj) = value.as_object() {
        let mut change = obj.clone();
        let has_string_path = change.get("path").map(|v| v.is_string()).unwrap_or(false);
        if !has_string_path {
            let path = obj
                .get("file")
                .and_then(Value::as_str)
                .or_else(|| obj.get("name").and_then(Value::as_str));
            if let Some(path) = path {
                change.insert("path".to_string(), json!(path));
            }
        }
        return Some(Value::Object(change));
    }
    None
}

/// `normalizePatchChanges(files)` (`normalize.ts:77-86`).
fn opencode_normalize_patch_changes(files: Option<&Value>) -> Vec<Value> {
    let values: Vec<Value> = match files {
        Some(Value::Array(arr)) => arr.clone(),
        Some(v @ Value::String(_)) => vec![v.clone()],
        Some(v @ Value::Object(_)) => vec![v.clone()],
        _ => vec![],
    };
    values
        .iter()
        .filter_map(opencode_normalize_patch_change)
        .collect()
}

/// `stripOpencodeRunArgumentQuoting(text)` (`normalize.ts:95-98`).
fn opencode_strip_run_argument_quoting(text: &str) -> String {
    if text.len() >= 2 && text.starts_with('"') && text.ends_with('"') {
        text[1..text.len() - 1].to_string()
    } else {
        text.to_string()
    }
}

/// One text segment produced by [`opencode_normalize_balanced_think_tags`]/
/// [`opencode_items_from_assistant_text_part`] -- the Rust analog of `NormalizedTextSegment`
/// (`normalize.ts:100-103`).
struct OpencodeTextSegment {
    kind: &'static str,
    text: String,
}

/// `THINK_TAG_PATTERN` (`normalize.ts:105`): matches any open OR close `<think>`/`<thinking>`
/// tag (optionally carrying attributes), case-insensitively. Used both to detect leakage
/// (`hasThinkTag`) and to strip stray markers (`stripThinkTagMarkers`).
fn opencode_think_tag_pattern() -> &'static fancy_regex::Regex {
    static RE: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)</?thinking\b[^>]*>|</?think\b[^>]*>")
            .expect("static think-tag pattern is valid")
    })
}

/// `BALANCED_THINK_TAG_PATTERN` (`normalize.ts:106`): a `<thinking>...</thinking>` or
/// `<think>...</think>` pair -- the backreference (`</\1>`) is why this needs `fancy-regex`
/// rather than the (backreference-free) `regex` crate: it must NOT match a `<thinking>` open
/// tag against a `</think>` close tag or vice versa.
fn opencode_balanced_think_tag_pattern() -> &'static fancy_regex::Regex {
    static RE: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        fancy_regex::Regex::new(r"(?is)<(thinking|think)\b[^>]*>(.*?)</\1>")
            .expect("static balanced think-tag pattern is valid")
    })
}

/// `LEADING_THINK_CLOSER_PATTERN` (`normalize.ts:107`): one or more stray CLOSING tags at the
/// very start of the text, with only whitespace between/after them.
fn opencode_leading_think_closer_pattern() -> &'static fancy_regex::Regex {
    static RE: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)^\s*(?:(?:</thinking>|</think>)\s*)+")
            .expect("static leading-closer pattern is valid")
    })
}

/// `THINK_OPEN_TAG_PATTERN` (`normalize.ts:108`): the first open tag, unbalanced (no matching
/// close survives the balanced pass).
fn opencode_think_open_tag_pattern() -> &'static fancy_regex::Regex {
    static RE: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)<(thinking|think)\b[^>]*>")
            .expect("static open-tag pattern is valid")
    })
}

/// `THINK_CLOSE_TAG_PATTERN` (`normalize.ts:109`): the first close tag, unbalanced.
fn opencode_think_close_tag_pattern() -> &'static fancy_regex::Regex {
    static RE: std::sync::OnceLock<fancy_regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        fancy_regex::Regex::new(r"(?i)</(?:thinking|think)>")
            .expect("static close-tag pattern is valid")
    })
}

/// `hasThinkTag(text)` (`normalize.ts:112-115`).
fn opencode_has_think_tag(text: &str) -> bool {
    opencode_think_tag_pattern().is_match(text).unwrap_or(false)
}

/// `stripThinkTagMarkers(text)` (`normalize.ts:117-120`).
fn opencode_strip_think_tag_markers(text: &str) -> String {
    opencode_think_tag_pattern()
        .replace_all(text, "")
        .into_owned()
}

/// `normalizeBalancedThinkTags(text)` (`normalize.ts:122-140`): split `text` into alternating
/// `text`/`thinking` segments around every BALANCED `<thinking>...</thinking>`/
/// `<think>...</think>` pair. Returns `None` when there is no balanced pair at all (mirrors the
/// reference's `null` return, `normalize.ts:135`), signaling the caller to fall through to the
/// unbalanced-tag heuristics.
fn opencode_normalize_balanced_think_tags(text: &str) -> Option<Vec<OpencodeTextSegment>> {
    let re = opencode_balanced_think_tag_pattern();
    let mut segments = Vec::new();
    let mut cursor = 0usize;
    let mut matched = false;
    for cap in re.captures_iter(text) {
        let Ok(cap) = cap else { continue };
        let m = cap.get(0).expect("group 0 always matches");
        matched = true;
        if m.start() > cursor {
            segments.push(OpencodeTextSegment {
                kind: "text",
                text: opencode_strip_think_tag_markers(&text[cursor..m.start()]),
            });
        }
        let inner = cap
            .get(2)
            .map(|g| g.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        segments.push(OpencodeTextSegment {
            kind: "thinking",
            text: inner,
        });
        cursor = m.end();
    }
    if !matched {
        return None;
    }
    if cursor < text.len() {
        segments.push(OpencodeTextSegment {
            kind: "text",
            text: opencode_strip_think_tag_markers(&text[cursor..]),
        });
    }
    Some(segments)
}

/// `segmentsToItems(id, segments)` (`normalize.ts:142-150`): drop empty segments; a single
/// surviving segment keeps the plain `id`, multiple surviving segments each get a
/// `"{id}:{kind}-{index}"` id (index over the FILTERED list, matching the reference).
fn opencode_segments_to_items(id: &str, segments: Vec<OpencodeTextSegment>) -> Vec<Value> {
    let visible: Vec<OpencodeTextSegment> = segments
        .into_iter()
        .filter(|s| !s.text.is_empty())
        .collect();
    if visible.is_empty() {
        return vec![];
    }
    if visible.len() == 1 {
        let seg = &visible[0];
        return vec![json!({ "id": id, "kind": seg.kind, "text": seg.text })];
    }
    visible
        .iter()
        .enumerate()
        .map(|(index, seg)| json!({ "id": format!("{id}:{}-{index}", seg.kind), "kind": seg.kind, "text": seg.text }))
        .collect()
}

/// `itemsFromAssistantTextPart(text, id, leadingCloserIsThinking)` (`normalize.ts:155-189`):
/// OpenCode/Kimi can leak internal `<think>`/`<thinking>` reasoning markup into assistant text
/// parts. This normalizes that leakage into separate `{kind:'thinking'}` items rather than
/// rendering the raw tags as visible text, in priority order: no tags at all (passthrough) ->
/// balanced pair(s) (segmented) -> an unbalanced LEADING closer (the `followedByTool` caller
/// hint decides whether the orphaned content itself reads as `thinking` or `text`) -> an
/// unbalanced OPEN tag only (text-before / thinking-after) -> an unbalanced CLOSE tag only
/// (thinking-before / text-after) -> markers stripped with nothing else salvageable.
fn opencode_items_from_assistant_text_part(
    text: &str,
    id: &str,
    leading_closer_is_thinking: bool,
) -> Vec<Value> {
    if !opencode_has_think_tag(text) {
        return vec![json!({ "id": id, "kind": "text", "text": text })];
    }

    if let Some(segments) = opencode_normalize_balanced_think_tags(text) {
        return opencode_segments_to_items(id, segments);
    }

    let without_markers = opencode_strip_think_tag_markers(text);
    if opencode_leading_think_closer_pattern()
        .is_match(text)
        .unwrap_or(false)
    {
        let normalized = without_markers.trim().to_string();
        if normalized.is_empty() {
            return vec![];
        }
        let kind = if leading_closer_is_thinking {
            "thinking"
        } else {
            "text"
        };
        return vec![json!({ "id": id, "kind": kind, "text": normalized })];
    }

    if let Ok(Some(open_match)) = opencode_think_open_tag_pattern().find(text) {
        return opencode_segments_to_items(
            id,
            vec![
                OpencodeTextSegment {
                    kind: "text",
                    text: opencode_strip_think_tag_markers(&text[..open_match.start()]),
                },
                OpencodeTextSegment {
                    kind: "thinking",
                    text: opencode_strip_think_tag_markers(&text[open_match.end()..])
                        .trim()
                        .to_string(),
                },
            ],
        );
    }

    if let Ok(Some(close_match)) = opencode_think_close_tag_pattern().find(text) {
        return opencode_segments_to_items(
            id,
            vec![
                OpencodeTextSegment {
                    kind: "thinking",
                    text: opencode_strip_think_tag_markers(&text[..close_match.start()])
                        .trim()
                        .to_string(),
                },
                OpencodeTextSegment {
                    kind: "text",
                    text: opencode_strip_think_tag_markers(&text[close_match.end()..]),
                },
            ],
        );
    }

    if !without_markers.is_empty() {
        vec![json!({ "id": id, "kind": "text", "text": without_markers })]
    } else {
        vec![]
    }
}

/// `computeToolAfterByPartIndex(parts)` (`normalize.ts:240-248`): for each part index, is there
/// a `tool`-type part strictly AFTER it in the same message? Feeds
/// [`opencode_items_from_assistant_text_part`]'s `leading_closer_is_thinking` hint -- an
/// orphaned leading `</think>` closer immediately before a tool call reads as leaked reasoning,
/// not user-facing prose.
fn opencode_compute_tool_after_by_part_index(parts: &[Value]) -> Vec<bool> {
    let mut tool_after = vec![false; parts.len()];
    let mut has_tool_after = false;
    for index in (0..parts.len()).rev() {
        tool_after[index] = has_tool_after;
        if parts[index].get("type").and_then(Value::as_str) == Some("tool") {
            has_tool_after = true;
        }
    }
    tool_after
}

/// Duration of a wire part from its `time` (ms). Absent/incomplete time yields None.
/// Takes the object CARRYING the `time` key -- the part itself for `reasoning` parts,
/// the `state` sub-object for `tool` parts.
fn opencode_part_duration_ms(holder: &Value) -> Option<u64> {
    let time = holder.get("time")?;
    let start = time.get("start").and_then(Value::as_i64)?;
    let end = time.get("end").and_then(Value::as_i64)?;
    (end >= start).then_some((end - start) as u64)
}

/// Mirror of the opencode TUI's `reasoningSummary` (thinking.ts): a leading bold
/// block `**Title**` followed by a blank line (or end of text -- a title still
/// awaiting its body while streaming) is disclosure metadata; the text after the
/// blank line is the body. The TUI regex is `/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/`.
fn opencode_reasoning_title_and_body(raw: &str) -> (Option<String>, String) {
    let content = raw.trim();
    let Some(rest) = content.strip_prefix("**") else {
        return (None, content.to_string());
    };
    let Some(close) = rest.find("**") else {
        return (None, content.to_string());
    };
    let candidate = &rest[..close];
    if candidate.is_empty() || candidate.contains('\n') || candidate.contains('*') {
        return (None, content.to_string());
    }
    let after = rest[close + 2..].trim_start_matches('\r');
    // Require end-of-text or a blank line (the TUI's `\r?\n\r?\n`), matching \r\n too.
    let body = if after.is_empty() {
        String::new()
    } else if let Some(stripped) = after.strip_prefix('\n') {
        let stripped = stripped.trim_start_matches('\r');
        if stripped.starts_with('\n') {
            stripped.trim().to_string()
        } else {
            return (None, content.to_string());
        }
    } else {
        return (None, content.to_string());
    };
    (Some(candidate.trim().to_string()), body)
}

/// Unwrap the opencode task output envelope -- `state.output` carries
/// `<task …><task_result>BODY</task_result></task>` -- so users see the task-result
/// content, never the internal markup. Any other shape passes through raw.
fn opencode_task_result_text(output: &str) -> String {
    const OPEN: &str = "<task_result>";
    const CLOSE: &str = "</task_result>";
    let Some(open) = output.find(OPEN) else {
        return output.to_string();
    };
    let Some(close) = output.rfind(CLOSE) else {
        return output.to_string();
    };
    if close > open {
        output[open + OPEN.len()..close].trim().to_string()
    } else {
        output.to_string()
    }
}

/// The opencode TUI header: `titlecase(subagent_type ?? "General") + " Task"` (+ " (background)")
/// + " — " + description.
fn opencode_task_delegation_title(subagent: &str, background: bool, description: &str) -> String {
    let mut chars = subagent.chars();
    let titlecased = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    };
    let name = if titlecased.trim().is_empty() {
        "General".to_string()
    } else {
        titlecased
    };
    let marker = if background { " (background)" } else { "" };
    format!("{name} Task{marker} — {description}")
}

/// Wire `state.status` triple shared by every opencode tool-shaped part: the
/// contract's `running | completed | failed` enum.
fn opencode_tool_status(state: &Value) -> &'static str {
    match state.get("status").and_then(Value::as_str) {
        Some("completed") => "completed",
        Some("error") => "failed",
        _ => "running",
    }
}

/// One-line child-activity preview (the client's `getToolPreview` core cases).
/// Unknown tools (or known tools with no preview key) fall back to compact JSON
/// verbatim, braces included.
pub(crate) fn opencode_child_activity_preview(tool: &str, input: &Value) -> String {
    let get = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("");
    let preview = match tool {
        "bash" | "shell" => get("command"),
        "read" | "write" | "edit" => get("filePath"),
        "grep" => get("pattern"),
        "glob" => get("pattern"),
        "task" => get("description"),
        "webfetch" => get("url"),
        _ => "",
    };
    let text = if preview.is_empty() {
        serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string())
    } else {
        preview.to_string()
    };
    text.chars().take(120).collect()
}

/// Task-3 join: the most child-activity rows embedded per delegation. Full
/// detail lives in the child session pane (sidebar + "Open session"); this is a
/// summary strip (recorded residual).
const OPENCODE_CHILD_ACTIVITY_ROW_CAP: usize = 200;

/// Idle retire bound for orphaned watchers (plan review round 1, Finding 5):
/// 2 hours covers realistic long-running delegations and post-"Open session"
/// child resumes; a quieter child than that rearms on the parent's next build.
const OPENCODE_CHILD_WATCHER_IDLE_SECS: u64 = 7200;

/// Compact child-session activity rows for a task delegation (the opencode TUI's
/// nested `↳ <tool> <summary>` lines, joined server-side from the child
/// session's message page): tool parts only, in wire order, each with the
/// contract's `running | completed | failed` status and a one-line preview,
/// capped at [`OPENCODE_CHILD_ACTIVITY_ROW_CAP`].
pub(crate) fn opencode_child_activity_rows(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .flat_map(|message| {
            message
                .get("parts")
                .and_then(Value::as_array)
                .map(|parts| parts.as_slice())
                .unwrap_or(&[])
        })
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("tool"))
        .map(|part| {
            let tool = part.get("tool").and_then(Value::as_str).unwrap_or("tool");
            let state = part.get("state").cloned().unwrap_or_else(|| json!({}));
            let input = state.get("input").cloned().unwrap_or_else(|| json!({}));
            json!({
                "tool": tool,
                "status": opencode_tool_status(&state),
                "preview": opencode_child_activity_preview(tool, &input),
            })
        })
        .take(OPENCODE_CHILD_ACTIVITY_ROW_CAP)
        .collect()
}

/// Background delegations (plan-review round 2, Finding 12): opencode completes
/// the outer task part IMMEDIATELY for a background launch while the child
/// session keeps running. The TUI (session/index.tsx) shows the delegation as
/// running while the child session isn't idle, and derives its duration from
/// the child's messages (first user `info.time.created` → last assistant
/// `info.time.completed`). Mirror that. The AUTHORITATIVE liveness signal is
/// the serve's session-status map entry for the child (`type` busy/retry —
/// `is_running_status_type`, plan-review round 3, Finding 17 — it applies even
/// when the child message page is empty); the message shapes (any tool part
/// still `running`, or an assistant message lacking `info.time.completed`) are
/// the secondary signal covering a serve whose status map lags. Non-background
/// items keep the parent part's authoritative status (a foreground task part
/// completes only when the child finishes), and a parent `running`/`failed`
/// status always stays authoritative.
pub(crate) fn opencode_apply_background_child_status(
    item: &mut Value,
    messages: &[Value],
    child_status: Option<&Value>,
) {
    if item.get("background").and_then(Value::as_bool) != Some(true) {
        return;
    }
    if item.get("status").and_then(Value::as_str) != Some("completed") {
        return;
    }
    // Authoritative signal first: the serve's session-status map entry
    // (`{type:'busy'|'retry'|…}`).
    let status_type = child_status.and_then(|status| status.get("type"));
    let mut child_active = freshell_opencode::events::is_running_status_type(status_type);
    if !child_active {
        for message in messages {
            if let Some(parts) = message.get("parts").and_then(Value::as_array) {
                if parts.iter().any(|part| {
                    part.pointer("/state/status").and_then(Value::as_str) == Some("running")
                }) {
                    child_active = true;
                }
            }
            if message.pointer("/info/role").and_then(Value::as_str) == Some("assistant")
                && message.pointer("/info/time/completed").is_none()
            {
                child_active = true;
            }
        }
    }
    if child_active {
        // Live background work: spinner, no duration (the TUI shows none while
        // running).
        item["status"] = json!("running");
        if let Some(map) = item.as_object_mut() {
            map.remove("durationMs");
        }
        return;
    }
    // Child finished: duration = last assistant completed − first user created.
    let first_user_created = messages
        .iter()
        .find(|message| message.pointer("/info/role").and_then(Value::as_str) == Some("user"))
        .and_then(|message| {
            message
                .pointer("/info/time/created")
                .and_then(Value::as_i64)
        });
    let last_assistant_completed = messages
        .iter()
        .filter(|message| {
            message.pointer("/info/role").and_then(Value::as_str) == Some("assistant")
        })
        .filter_map(|message| {
            message
                .pointer("/info/time/completed")
                .and_then(Value::as_i64)
        })
        .max();
    if let (Some(start), Some(end)) = (first_user_created, last_assistant_completed) {
        if end >= start {
            item["durationMs"] = json!((end - start) as u64);
        }
    }
}

/// Child session ids referenced by this snapshot's `task_delegation` items —
/// the one parent-scan traversal both the watcher registration and the join's
/// fetch gate walk.
fn opencode_snapshot_child_session_ids(snapshot: &Value) -> Vec<String> {
    snapshot
        .get("turns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|turn| turn.get("items").and_then(Value::as_array))
        .flatten()
        .filter(|item| item.get("kind").and_then(Value::as_str) == Some("task_delegation"))
        .filter_map(|item| {
            item.get("childSessionId")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect()
}

/// Server-side child-session join: for every task_delegation item referencing a
/// child session, fetch the child's message page and embed compact activity
/// rows, then apply the child-derived live status for background delegations.
/// Graceful on any child fetch failure (pruned child, sidecar hiccup): the item
/// keeps its own fields and simply gains no `activity` — a 404 maps to an empty
/// page (silent BY DESIGN; `tracing::warn!` fires only on transport errors).
async fn attach_child_activity(
    manager: &OpencodeServeManager,
    route: &Route,
    snapshot: &mut Value,
) {
    // No delegations -> no join: a snapshot without task_delegation items must
    // not pay the status-map round trip (the fetch happens ONCE per join, only
    // when there is a join).
    if opencode_snapshot_child_session_ids(snapshot).is_empty() {
        return;
    }
    // Plan-review round 3, Finding 17: the AUTHORITATIVE child liveness signal
    // is the serve's session-status map (GET /session/status — the same
    // endpoint the TUI uses). Message-shape inference alone misses a
    // freshly-busy child that has only its first user message.
    let status_map = manager
        .get_session_status_map(route)
        .await
        .unwrap_or_default();
    let Some(turns) = snapshot.get_mut("turns").and_then(Value::as_array_mut) else {
        return;
    };
    for turn in turns.iter_mut() {
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else {
            continue;
        };
        for item in items.iter_mut() {
            if item.get("kind").and_then(Value::as_str) != Some("task_delegation") {
                continue;
            }
            let Some(child) = item
                .get("childSessionId")
                .and_then(Value::as_str)
                .map(str::to_string)
            else {
                continue;
            };
            match manager.list_messages(&child, route).await {
                Ok(Value::Array(messages)) => {
                    if !messages.is_empty() {
                        item["activity"] = Value::Array(opencode_child_activity_rows(&messages));
                    }
                    // Background live status applies even for an empty message
                    // page (Finding 17).
                    let child_status = status_map.get(&child);
                    opencode_apply_background_child_status(item, &messages, child_status);
                }
                // A 200 that is not a message array: nothing to embed, nothing
                // to warn about.
                Ok(_) => {}
                Err(err) => {
                    // Structured warn, never a hard failure: a pruned child or
                    // a sidecar hiccup must not break the parent's snapshot.
                    tracing::warn!(
                        child_session = %child,
                        error = %err,
                        "opencode child activity join skipped"
                    );
                }
            }
        }
    }
}

/// `itemFromPart(part, fallbackId, role, followedByTool)` (`normalize.ts:191-238`), covering
/// `text`, `reasoning`, `tool`, `file`, `patch`, and `compaction` part types -- the full set the
/// task scope calls for. Structural parts (`step-start`/`step-finish`) and any other
/// unrecognized part `type` fall through to the reference's `return []` default
/// (`normalize.ts:237`), same as an unrecognized type here.
///
/// Non-`user` text parts are routed through [`opencode_items_from_assistant_text_part`] (the
/// `<think>`/`<thinking>` leakage segmentation) rather than passed through as plain
/// `{kind:'text'}` -- this is the fix for the PR-6 review's "Important" finding: think-tag
/// leakage must become `{kind:'thinking'}` items, matching the reference exactly.
fn opencode_item_from_part(
    part: &Value,
    fallback_id: &str,
    role: Option<&str>,
    followed_by_tool: bool,
) -> Vec<Value> {
    let id = part
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback_id);
    match part.get("type").and_then(Value::as_str) {
        Some("text") => {
            let raw_text = part.get("text").and_then(Value::as_str).unwrap_or("");
            if role == Some("user") {
                let text = opencode_strip_run_argument_quoting(raw_text);
                vec![json!({ "id": id, "kind": "text", "text": text })]
            } else {
                opencode_items_from_assistant_text_part(raw_text, id, followed_by_tool)
            }
        }
        Some("reasoning") => {
            let raw = part.get("text").and_then(Value::as_str).unwrap_or("");
            // The opencode TUI (packages/tui/src/context/thinking.ts reasoningSummary)
            // treats a leading bold block — "**Title**\n\n<body>" — as disclosure
            // metadata, styling the header independently of the markdown body.
            // Mirror that: the title splits off and the body carries the rest.
            let (title, text) = opencode_reasoning_title_and_body(raw);
            let segment = if text.is_empty() {
                vec![]
            } else {
                vec![text.clone()]
            };
            let mut item = json!({ "id": id, "kind": "reasoning", "summary": segment.clone(), "content": segment, "text": text });
            if let Some(duration) = opencode_part_duration_ms(part) {
                item["durationMs"] = json!(duration);
            }
            if let Some(title) = title {
                item["title"] = json!(title);
            }
            vec![item]
        }
        Some("tool") => {
            let state = part
                .get("state")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| json!({}));
            if part.get("tool").and_then(Value::as_str) == Some("task") {
                // The `task` tool is a subagent delegation, not a plain dynamic tool:
                // render it as the first-class task_delegation item the client's
                // activity strip folds into one delegation block.
                let input = state.get("input").cloned().unwrap_or_else(|| json!({}));
                let description = input
                    .get("description")
                    .and_then(Value::as_str)
                    .or_else(|| state.get("title").and_then(Value::as_str))
                    .unwrap_or("");
                let subagent = input
                    .get("subagent_type")
                    .and_then(Value::as_str)
                    .unwrap_or("general");
                let background = state
                    .pointer("/metadata/background")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let status = opencode_tool_status(&state);
                let mut item = json!({
                    "id": id, "kind": "task_delegation", "status": status,
                    "title": opencode_task_delegation_title(subagent, background, description),
                    "subagent": subagent, "background": background,
                });
                if !description.is_empty() {
                    item["description"] = json!(description);
                }
                if let Some(child) = state.pointer("/metadata/sessionId").and_then(Value::as_str) {
                    item["childSessionId"] = json!(child);
                }
                if let Some(start) = state.pointer("/time/start").and_then(Value::as_i64) {
                    item["startedAtMs"] = json!(start);
                }
                if let Some(end) = state.pointer("/time/end").and_then(Value::as_i64) {
                    item["endedAtMs"] = json!(end);
                }
                if let Some(duration) = opencode_part_duration_ms(&state) {
                    item["durationMs"] = json!(duration);
                }
                if let Some(output) = state.get("output").and_then(Value::as_str) {
                    item["result"] = json!(opencode_task_result_text(output));
                }
                vec![item]
            } else {
                let status = opencode_tool_status(&state);
                let arguments = state.get("input").cloned().unwrap_or_else(|| json!({}));
                let content_items = state
                    .get("output")
                    .and_then(Value::as_str)
                    .map(|s| json!([s]));
                let success = if status == "completed" {
                    Some(true)
                } else {
                    None
                };
                // PR #779 (opencode-error-projection): failed dynamic tools carry
                // their persisted wire error text for durable client rendering.
                let error_text = if status == "failed" {
                    state
                        .get("error")
                        .and_then(Value::as_str)
                        .filter(|error| !error.trim().is_empty())
                        .map(str::to_string)
                } else {
                    None
                };
                let mut item = json!({
                    "id": id,
                    "kind": "dynamic_tool",
                    "namespace": "opencode",
                    "tool": part.get("tool").and_then(Value::as_str).unwrap_or("tool"),
                    "status": status,
                    "arguments": arguments,
                    "contentItems": content_items,
                    "success": success,
                });
                if let Some(error_text) = error_text {
                    item["error"] = json!(error_text);
                }
                vec![item]
            }
        }
        Some("file") => vec![json!({
            "id": id,
            "kind": "text",
            "text": format!("Attached file: {}", opencode_file_attachment_target(part)),
        })],
        Some("patch") => vec![json!({
            "id": id,
            "kind": "file_change",
            "status": "completed",
            "changes": opencode_normalize_patch_changes(part.get("files")),
            "extensions": { "opencode": part },
        })],
        Some("compaction") => vec![json!({ "id": id, "kind": "context_compaction" })],
        Some("retry") => {
            let attempt = part
                .get("attempt")
                .and_then(Value::as_i64)
                .unwrap_or(1)
                .max(1);
            // Serialized NamedError shape is {name, data:{message,…}} (retry.ts reads
            // error.data.message); tolerate legacy {message} and bare-string shapes.
            let error = part.get("error").and_then(|err| {
                err.pointer("/data/message")
                    .and_then(Value::as_str)
                    .or_else(|| err.get("message").and_then(Value::as_str))
                    .or_else(|| err.as_str())
                    .or_else(|| err.get("name").and_then(Value::as_str))
            });
            let mut item = json!({ "id": id, "kind": "retry", "attempt": attempt });
            if let Some(error) = error {
                item["error"] = json!(error);
            }
            vec![item]
        }
        Some("subtask") => {
            let mut item = json!({ "id": id, "kind": "delegated_task" });
            if let Some(agent) = part.get("agent").and_then(Value::as_str) {
                item["agent"] = json!(agent);
            }
            if let Some(description) = part.get("description").and_then(Value::as_str) {
                item["description"] = json!(description);
            }
            if let Some(command) = part.get("command").and_then(Value::as_str) {
                item["command"] = json!(command);
            }
            vec![item]
        }
        _ => vec![],
    }
}

/// `textSummaryFromItems` + `normalizeOpencodeTurn`'s summary fallback (`normalize.ts:250-269,341-342`):
/// `SYNTHETIC_TEXT_SEGMENT_ID_SUFFIX_PATTERN` (`normalize.ts:110`): strips a trailing
/// `:text-N`/`:thinking-N` suffix that [`opencode_segments_to_items`] adds when a single part
/// splits into multiple segments, recovering that shared segment's original source id.
fn opencode_strip_synthetic_text_segment_suffix(id: &str) -> String {
    let Some(colon) = id.rfind(':') else {
        return id.to_string();
    };
    let suffix = &id[colon + 1..];
    let digits = suffix
        .strip_prefix("text-")
        .or_else(|| suffix.strip_prefix("thinking-"));
    match digits {
        Some(d) if !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()) => {
            id[..colon].to_string()
        }
        _ => id.to_string(),
    }
}

/// `textSummaryFromItems` + `normalizeOpencodeTurn`'s summary fallback (`normalize.ts:250-269,341-342`):
/// join every `{kind:'text'}` item's text, GROUPING consecutive items that share the same
/// source id (post `:text-N`/`:thinking-N`-suffix-stripping) by direct concatenation --
/// separate source ids join with `"\n\n"`. This grouping is what makes think-tag segmentation
/// safe: when one assistant text part splits into `[text, thinking, text]`, the two `text`
/// halves share the ORIGINAL part's source id and must read as one continuous excerpt, not two
/// paragraphs separated by a blank line they never had. Falls back to the first `reasoning`
/// item's `summary[0]` when there is no `text`-kind item at all.
fn opencode_turn_summary(items: &[Value]) -> (String, &'static str) {
    let text_items: Vec<(&str, &str)> = items
        .iter()
        .filter(|item| item.get("kind").and_then(Value::as_str) == Some("text"))
        .filter_map(|item| {
            let id = item.get("id").and_then(Value::as_str)?;
            let text = item.get("text").and_then(Value::as_str)?;
            Some((id, text))
        })
        .collect();
    if !text_items.is_empty() {
        let mut groups: Vec<String> = Vec::new();
        let mut current_source: Option<String> = None;
        let mut current_text = String::new();
        for (id, text) in text_items {
            let source_id = opencode_strip_synthetic_text_segment_suffix(id);
            match &current_source {
                Some(cs) if *cs == source_id => current_text.push_str(text),
                None => {
                    current_source = Some(source_id);
                    current_text.push_str(text);
                }
                _ => {
                    if !current_text.is_empty() {
                        groups.push(std::mem::take(&mut current_text));
                    }
                    current_source = Some(source_id);
                    current_text.push_str(text);
                }
            }
        }
        if !current_text.is_empty() {
            groups.push(current_text);
        }
        return (truncate_summary(&groups.join("\n\n")), SUMMARY_KIND_ECHO);
    }
    let reasoning_excerpt = items
        .iter()
        .find(|item| item.get("kind").and_then(Value::as_str) == Some("reasoning"))
        .and_then(|item| item.get("summary").and_then(Value::as_array))
        .and_then(|arr| arr.first())
        .and_then(Value::as_str)
        .unwrap_or("");
    (truncate_summary(reasoning_excerpt), SUMMARY_KIND_ECHO)
}

/// A `FreshAgentTurnSchema`-shaped turn from one opencode `{info, parts}` message
/// (`normalizeOpencodeTurn`, `normalize.ts:324-355`). Every part is mapped via
/// [`opencode_item_from_part`] (`itemFromPart`, `normalize.ts:191-238`) -- `text`, `reasoning`,
/// `tool`, `file`, and `patch` parts all become visible transcript items today; only
/// structural (`step-start`/`step-finish`) and truly unrecognized part types are dropped,
/// matching the reference's own `return []` default.
///
/// kata 1wxv Task 3: the projection is factored as the shared per-message turn
/// builder — the rollback record's marker entries and `rolledBackTurns` bucket use the
/// SAME projection as `turns[]`, so markers match the transcript the model saw.
/// `None` for a message the transcript itself drops (an unknown role carrying
/// displayable items) — call sites `filter_map`.
pub(crate) fn opencode_message_turn_json(message: &Value, ordinal: usize) -> Option<Value> {
    let info = message.get("info").cloned().unwrap_or_else(|| json!({}));
    let id = info
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("message-{ordinal}"));
    let role = opencode_role(info.get("role").and_then(Value::as_str));
    let parts = message
        .get("parts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let tool_after_by_part_index = opencode_compute_tool_after_by_part_index(&parts);
    let items: Vec<Value> = parts
        .iter()
        .enumerate()
        .flat_map(|(index, part)| {
            let followed_by_tool = tool_after_by_part_index
                .get(index)
                .copied()
                .unwrap_or(false);
            opencode_item_from_part(part, &format!("{id}:part-{index}"), role, followed_by_tool)
        })
        .collect();

    if role.is_none() && !items.is_empty() {
        return None;
    }

    let mut turn = Map::new();
    turn.insert("id".to_string(), json!(id));
    turn.insert("turnId".to_string(), json!(id));
    turn.insert("messageId".to_string(), json!(id));
    turn.insert("ordinal".to_string(), json!(ordinal));
    turn.insert("source".to_string(), json!("durable"));
    if let Some(role) = role {
        turn.insert("role".to_string(), json!(role));
    }
    if let Some(model) = opencode_model_from_info(&info) {
        turn.insert("model".to_string(), json!(model));
    }
    if let Some(error) = opencode_turn_error_from_info(&info) {
        turn.insert("error".to_string(), error);
    }
    let (summary, summary_kind) = opencode_turn_summary(&items);
    turn.insert("summary".to_string(), json!(summary));
    turn.insert("summaryKind".to_string(), json!(summary_kind));
    turn.insert("items".to_string(), json!(items));
    Some(Value::Object(turn))
}

/// `normalizeOpencodeSnapshot` (`normalize.ts:357-405`): map the session's own info + its
/// message page into the `FreshAgentSnapshotSchema` shape. `status` always reports `idle`
/// here -- this REST read has no live busy/idle bit to consult (that lives in the WS
/// session's in-memory turn task, not the serve's own session record) -- an honest
/// approximation the task report calls out; the client's WS-driven busy chrome already
/// covers the live case, this endpoint's job is the committed transcript.
fn build_opencode_snapshot_json(
    thread_id: &str,
    info: &Value,
    messages: &Value,
    // Kata 1wxv Task 5: the durable rollback record (None when the session never
    // rolled back through this server's ledger).
    rollback: Option<&RollbackRecord>,
) -> Value {
    let messages = messages.as_array().cloned().unwrap_or_default();
    // kata 1wxv Task 3 (VERIFIED wire shape, load-bearing correction item 2): the
    // serve returns the reverted tail rows UNFLAGGED in the message list; the
    // boundary is TOP-LEVEL `session.revert.messageID` (omitted when inactive —
    // there is no `info.revert` anywhere). `turns[]` is EXACTLY what the model sees
    // next (messages strictly before the pointer); a stale/unknown pointer keeps
    // the whole list in `turns[]` (never silently empties the transcript).
    // Task 5 (r3): with a ledger record the marker bucket is the record's
    // entries UNION (frozen prior epochs ++ the recorded current tail) — the
    // provider-tail projection below remains ONLY as the record-less fallback
    // (an out-of-band revert this ledger never observed).
    let boundary = info
        .get("revert")
        .and_then(|r| r.get("messageID"))
        .and_then(Value::as_str)
        .and_then(|pointer| {
            messages
                .iter()
                .position(|m| m.pointer("/info/id").and_then(Value::as_str) == Some(pointer))
        })
        .unwrap_or(messages.len());
    let mut turns: Vec<Value> = Vec::new();
    let mut rolled_back: Vec<Value> = Vec::new();
    for (ordinal, message) in messages.iter().enumerate() {
        let Some(turn) = opencode_message_turn_json(message, ordinal) else {
            continue;
        };
        if ordinal < boundary {
            turns.push(turn);
        } else {
            let mut turn = turn;
            turn["rolledBack"] = json!(true);
            // The record-less fallback covers an out-of-band revert this
            // ledger never observed — never restorable. The new server
            // adjudicates every marker it serves; an ABSENT key stays
            // reserved exclusively for older-server payloads.
            turn["restorable"] = json!(false);
            rolled_back.push(turn);
        }
    }
    let session_id = info
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or(thread_id);
    let revision = info
        .pointer("/time/updated")
        .and_then(Value::as_i64)
        .unwrap_or(turns.len() as i64);
    let latest_turn_id = turns
        .last()
        .and_then(|t| t.get("turnId"))
        .cloned()
        .unwrap_or(Value::Null);
    let summary = info.get("title").and_then(Value::as_str);

    let mut snapshot = Map::new();
    snapshot.insert("sessionType".to_string(), json!(SESSION_TYPE));
    snapshot.insert("provider".to_string(), json!(PROVIDER));
    snapshot.insert("threadId".to_string(), json!(thread_id));
    snapshot.insert("sessionId".to_string(), json!(session_id));
    snapshot.insert("revision".to_string(), json!(revision));
    snapshot.insert("latestTurnId".to_string(), latest_turn_id);
    snapshot.insert("status".to_string(), json!("idle"));
    if let Some(summary) = summary {
        snapshot.insert("summary".to_string(), json!(summary));
    }
    snapshot.insert(
        "capabilities".to_string(),
        json!({
            "send": true,
            "interrupt": true,
            "approvals": false,
            "questions": false,
            "fork": true,
            "worktrees": false,
            "diffs": true,
            "childThreads": false,
            // Kata 1wxv Task 5: static stamps (LBC-2 verified the revert/unrevert
            // routes); an old-CLI runtime failure classifies at OP time to
            // UNSUPPORTED_CAPABILITY (Task 1's pinned copy), never at stamp time.
            "undo": true,
            "redo": true,
            // kata z7j7: model/effort are per-send (merged into the POST
            // /session/:id/prompt_async body); sandbox/permissionMode have no
            // opencode wire concept.
            "settingScopes": {
                "model": "per-send",
                "effort": "per-send",
                "sandbox": "unsupported",
                "permissionMode": "unsupported",
            },
        }),
    );
    snapshot.insert("tokenUsage".to_string(), opencode_token_usage(info));
    snapshot.insert("pendingApprovals".to_string(), json!([]));
    snapshot.insert("pendingQuestions".to_string(), json!([]));
    snapshot.insert("worktrees".to_string(), json!([]));
    snapshot.insert("diffs".to_string(), json!([]));
    snapshot.insert("childThreads".to_string(), json!([]));
    snapshot.insert("turns".to_string(), json!(turns));
    if rollback.is_none() && !rolled_back.is_empty() {
        // Record-less fallback ONLY: the provider-tail projection covers an
        // out-of-band revert this ledger never observed. The strict contract key
        // is optional — a legacy-server payload simply never carries it.
        snapshot.insert("rolledBackTurns".to_string(), json!(rolled_back));
    }
    snapshot.insert("extensions".to_string(), json!({ "opencode": {} }));
    let mut snapshot = Value::Object(snapshot);
    if let Some(record) = rollback {
        // LEDGER-SOURCED bucket (r3): the entries union (frozen prior epochs ++
        // the recorded current tail) — durable even after a native send deletes
        // the reverted tail (decision 6). `canRedo` is the STORED bit (the only
        // source); the record doubles as the revision floor so a stale serve
        // timestamp never lets the client's monotonic watermark drop the
        // post-rollback snapshot.
        let floored = crate::rollback_record::stamp_rollback_snapshot(
            &mut snapshot,
            revision,
            record,
            record.can_redo(),
        );
        snapshot["revision"] = json!(floored);
    }
    snapshot
}

/// The fresh-agent sub-router, pre-bound to its state. Merges in
/// [`pane_ops::router`] (Slice 3b-1's pane/tab lifecycle routes:
/// split/close/select + tab select/rename/delete) so `freshell-server`'s
/// `main.rs` keeps mounting ONE router for this crate, unchanged.
pub fn router(state: FreshAgentState) -> Router {
    Router::new()
        .route("/api/tabs", post(create_tab).get(terminal_tabs::list_tabs))
        .route("/api/panes", get(terminal_tabs::list_panes))
        .route("/api/panes/{id}", patch(rename_pane))
        .route("/api/panes/{id}/send-keys", post(send_keys))
        .route("/api/panes/{id}/capture", get(capture))
        .route("/api/panes/{id}/wait-for", get(terminal_tabs::wait_for))
        .with_state(state.clone())
        .merge(model_capabilities::router(state.clone()))
        .merge(pane_ops::router(state))
}

// ── auth (constant-time, matches auth.ts#httpAuthMiddleware x-auth-token) ────────

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub(crate) fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get("x-auth-token")
        .and_then(|v| v.to_str().ok())
        .map(|provided| constant_time_eq(provided.as_bytes(), token.as_bytes()))
        .unwrap_or(false)
}

// ── response envelopes (server/agent-api/response.ts) ────────────────────────────

/// `ok(data, message)` → `{status:'ok', data, message}` at HTTP 200.
fn ok_json(data: Value, message: &str) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "status": "ok", "data": data, "message": message })),
    )
        .into_response()
}

/// `approx(data, message)` → `{status:'approx', …}` (turn did not reach idle by deadline).
fn approx_json(data: Value, message: &str) -> Response {
    (
        StatusCode::OK,
        Json(json!({ "status": "approx", "data": data, "message": message })),
    )
        .into_response()
}

/// `fail(message)` → `{status:'error', message}` at `status`.
fn fail_json(status: StatusCode, message: String) -> Response {
    (
        status,
        Json(json!({ "status": "error", "message": message })),
    )
        .into_response()
}

/// `fail_json` + a machine-readable code, matching how the WS side keys
/// errors (`error["code"] == "RESTORE_UNAVAILABLE"`). Envelope is additive:
/// `{status:"error", code, message}`.
pub(crate) fn fail_json_code(status: StatusCode, code: &str, message: String) -> Response {
    (
        status,
        Json(json!({ "status": "error", "code": code, "message": message })),
    )
        .into_response()
}

/// [`fail_json_code`] + the typed ownership-conflict additions (kata b8ke
/// Task 10): the additive `ownerKind`/`ownerGeneration` pair when the
/// coordinator knows the owner, plus the reconnect-revive `liveTerminalId`
/// a caller reattaches to instead of dead-ending. ONE shape for every
/// ownership-conflict door (WS error frame, REST 409, MCP-proxied body) —
/// `terminal_tabs::fail_json_restore_unavailable` and `pane_ops`'s
/// attach/respawn conflicts all build on this helper so they can never
/// drift apart.
pub(crate) fn fail_json_conflict_with_owner(
    code: &str,
    message: String,
    live_terminal_id: Option<&str>,
    owner: Option<&crate::ownership_lane::TerminalOwnerFields>,
) -> Response {
    let mut body = json!({
        "status": "error",
        "code": code,
        "message": message,
    });
    if let Some(tid) = live_terminal_id {
        body["liveTerminalId"] = json!(tid);
    }
    if let Some(owner) = owner {
        body["ownerKind"] = json!(owner.owner_kind);
        body["ownerGeneration"] = json!(owner.owner_generation);
    }
    (StatusCode::CONFLICT, Json(body)).into_response()
}

/// [`fail_json_code`] + machine-readable retry guidance for 429-family
/// rejections. The window rides BOTH the HTTP `Retry-After` header (whole
/// seconds, floor 1 — HTTP convention) and a `retryAfterMs` body field
/// (house convention, session-lease SESSION_RESERVED): body-only consumers
/// like the MCP bridge never see headers, HTTP-conventional clients never
/// read bodies. Lives here so the `{status:"error", code, message}` envelope
/// shape stays owned by ONE file.
pub(crate) fn fail_json_code_retry_after(
    status: StatusCode,
    code: &str,
    message: String,
    retry_after: std::time::Duration,
) -> Response {
    let mut response = (
        status,
        Json(json!({
            "status": "error",
            "code": code,
            "message": message,
            "retryAfterMs": retry_after.as_millis() as u64,
        })),
    )
        .into_response();
    response.headers_mut().insert(
        axum::http::header::RETRY_AFTER,
        axum::http::HeaderValue::from(retry_after.as_secs().max(1)),
    );
    response
}

/// The error status the original maps serve failures to (`agentRouteErrorStatus`): a
/// bounded cold-start failure / transport error is a 5xx; everything else 500 here.
fn serve_error_status(err: &ServeError) -> StatusCode {
    match err {
        ServeError::NotHealthy { .. }
        | ServeError::Transport(_)
        | ServeError::Undelivered(_)
        | ServeError::ProcessExited { .. }
        | ServeError::Spawn(_)
        | ServeError::StartupFailed(_) => StatusCode::SERVICE_UNAVAILABLE,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

// ── POST /api/tabs (fresh-agent create) ──────────────────────────────────────────

async fn create_tab(
    State(state): State<FreshAgentState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    // ejh6 (finding 3): door-top presence check. Reject whenever the body
    // CONTAINS the key resumeSessionId with ANY JSON value (string, empty,
    // null, number, object) — BEFORE any agent/browser/editor/terminal
    // branch, including the `terminal_tabs::create_terminal_or_content_tab`
    // delegation (this is the only REST entry to that function).
    if body.get("resumeSessionId").is_some() {
        return fail_json(
            StatusCode::BAD_REQUEST,
            LEGACY_RESUME_IDENTITY_REFUSAL.to_string(),
        );
    }
    let agent = body.get("agent").and_then(Value::as_str).unwrap_or("");
    // Slice 1 (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md \u00a72.1): `agent`
    // absent -> terminal / browser / editor tab creation (router.ts:710-793).
    if agent.is_empty() {
        return terminal_tabs::create_terminal_or_content_tab(state, body).await;
    }
    let Some((provider, session_type)) = rest_agent_mode(agent) else {
        return fail_json(
            StatusCode::BAD_REQUEST,
            format!("unknown agent \"{agent}\""),
        );
    };

    let cwd = body.get("cwd").and_then(Value::as_str).map(str::to_string);
    let model = body
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let effort = body
        .get("effort")
        .and_then(Value::as_str)
        .map(str::to_string);
    let name = body.get("name").and_then(Value::as_str).map(str::to_string);

    if let Some(gateway) = state.hosted_rest_gateway() {
        let provider_inputs = match hosted_rest::provider_inputs(&body) {
            Ok(inputs) => inputs,
            Err(error) => return fail_json(StatusCode::BAD_REQUEST, error),
        };
        let native_session_id = match body.get("sessionRef") {
            None => None,
            Some(value) => match serde_json::from_value::<SessionLocator>(value.clone()) {
                Ok(locator) if locator.provider == provider && !locator.session_id.is_empty() => {
                    Some(locator.session_id)
                }
                _ => {
                    return fail_json(
                        StatusCode::BAD_REQUEST,
                        format!("sessionRef must identify a {provider} session"),
                    )
                }
            },
        };
        return create_hosted_agent_tab(
            &state,
            gateway,
            hosted_rest::HostedRestCreate {
                request_id: Uuid::new_v4().simple().to_string(),
                provider: provider.into(),
                session_type: session_type.into(),
                cwd,
                model,
                effort,
                native_session_id,
                plugins: provider_inputs.plugins,
                model_selection: provider_inputs.model_selection,
                permission_mode: provider_inputs.permission_mode,
                sandbox: provider_inputs.sandbox,
            },
            name,
        )
        .await;
    }

    // The retained in-process implementation is OpenCode-only. Every hosted
    // mode above uses the common supervisor gateway; never silently fall back
    // to a web-owned Claude/Codex provider.
    if agent != "opencode" {
        return fail_json(
            StatusCode::SERVICE_UNAVAILABLE,
            "durable fresh-agent gateway is not installed".to_string(),
        );
    }

    // Task 4 (adopted kata 2, freshagent-sessionref-regression): the `sessionRef`
    // resume branch. Placed AFTER the agent gate — and strictly after the frozen
    // door-top `resumeSessionId` refusal, so a dual carrier (resumeSessionId +
    // sessionRef) hits the frozen 400, never this branch. A body WITHOUT
    // `sessionRef` takes the plain placeholder-create path below unchanged.
    if let Some(session_ref_value) = body.get("sessionRef") {
        return resume_session_ref_tab(&state, session_ref_value, cwd, model, effort, name).await;
    }

    // A1 (naming-sweep ledger deferral): the shared LayoutStore mints
    // {tabId, paneId} -- Node does the same for fresh-agent tabs
    // (`layoutStore.createTab`, router.ts:701) -- so REST/MCP-created
    // fresh-agent tabs are visible to GET /api/tabs + GET /api/panes and
    // renamable via PATCH /api/panes/:id, exactly like the
    // terminal/browser/editor paths (`terminal_tabs::create_content_tab`).
    let (tab_id, pane_id) = state.layout.create_tab(name.as_deref());
    // `makePlaceholderSessionId(requestId)` = `freshopencode-<requestId>` (adapter.ts:75).
    let request_id = Uuid::new_v4().simple().to_string();
    let placeholder = format!("freshopencode-{request_id}");

    // The `paneContent` the original attaches + echoes in the ui.command payload.
    let mut pane_content = json!({
        "kind": "fresh-agent",
        "sessionType": SESSION_TYPE,
        "provider": PROVIDER,
        "sessionId": placeholder,
        "createRequestId": request_id,
        "status": "connected",
    });
    if let Some(cwd) = &cwd {
        pane_content["initialCwd"] = json!(cwd);
    }
    if let Some(model) = &model {
        pane_content["model"] = json!(model);
    }
    if let Some(effort) = &effort {
        pane_content["effort"] = json!(effort);
    }

    register_fresh_agent_tab(
        &state,
        &tab_id,
        &pane_id,
        name.as_deref(),
        &pane_content,
        PaneEntry {
            placeholder_id: placeholder.clone(),
            provider: PROVIDER.into(),
            session_type: SESSION_TYPE.into(),
            cwd: cwd.clone(),
            model,
            effort,
            durable_id: None,
        },
    );

    // P1.13 (Task 3): pending identity marker at REST create (AWAITED before
    // the tab.create broadcast — durable-before-answer), mirroring the WS
    // create path (`opencode_ws.rs` `handle_create`). A failed write surfaces
    // as a user-visible LEDGER_WRITE_FAILED frame, never blocks the create.
    if let Some(sink) = state.identity_sink() {
        if let Err(e) = sink
            .record_pending(&placeholder, SESSION_TYPE, cwd.as_deref())
            .await
        {
            tracing::warn!(error = %e, placeholder = %placeholder, "freshagent.opencode.rest_pending_write_failed");
            state.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
                event: json!({
                    "type": "freshAgent.error",
                    "sessionId": placeholder,
                    "code": "LEDGER_WRITE_FAILED",
                    "message": "Failed to persist this pane's identity marker - identity may not survive a crash.",
                }),
                provider: PROVIDER.to_string(),
                session_id: placeholder.clone(),
                session_type: SESSION_TYPE.to_string(),
            }));
        }
    }

    // Unified agent names (Task 2): admit the pre-durable handle BEFORE the
    // tab.create broadcast acknowledges the pane — the caller-supplied
    // `namingHandle` (CLI/MCP) or a server-minted one. The paneContent
    // carries it so the client's pane state can target pre-identity
    // renames. The body's `name` seeds the record with the SAME intent
    // default (automatic — an agent/API suggestion never acquires a user
    // rename's permanence). Unwired sinks proceed unnamed.
    if naming::is_unified_agent_mode(None, Some(SESSION_TYPE)) {
        let handle = body
            .get("namingHandle")
            .and_then(Value::as_str)
            .filter(|h| !h.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| format!("nh-{}", Uuid::new_v4().simple()));
        if let Some(sink) = state.naming() {
            let pending =
                freshell_protocol::session_names::SessionNameRef::Pending { id: handle.clone() };
            match sink
                .ensure_pending(naming::PendingNameInput {
                    handle: handle.clone(),
                    provider: freshell_protocol::session_names::NamedProvider::Opencode,
                    cwd: cwd.clone(),
                })
                .await
            {
                Ok(update) => {
                    state.stash_naming_handle(&placeholder, &handle);
                    pane_content["namingHandle"] = json!(handle);
                    state
                        .layout
                        .attach_pane_content(&tab_id, &pane_id, pane_content.clone());
                    if let Some(seed) = name.as_deref() {
                        if let Err(error) = sink
                            .rename(naming::RenameNameInput {
                                target: pending,
                                name: seed.to_string(),
                                intent: freshell_protocol::session_names::NameIntent::Automatic,
                                if_revision: None,
                            })
                            .await
                        {
                            naming::log_name_error("rename", &update.record.name_ref, &error);
                        }
                    }
                }
                Err(error) => {
                    naming::log_name_error("ensure_pending", &pending, &error);
                }
            }
        }
    }

    broadcast_tab_create(&state, &tab_id, &pane_id, name.as_deref(), &pane_content);

    ok_json(
        json!({ "tabId": tab_id, "paneId": pane_id, "sessionId": placeholder }),
        "fresh-agent pane created",
    )
}

async fn create_hosted_agent_tab(
    state: &FreshAgentState,
    gateway: hosted_rest::SharedHostedFreshAgentRestGateway,
    request: hosted_rest::HostedRestCreate,
    name: Option<String>,
) -> Response {
    let created = match gateway.create_agent(request.clone()).await {
        Ok(created) => created,
        Err(()) => {
            return fail_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "durable fresh-agent host could not be created".to_string(),
            )
        }
    };
    let hosted_rest::HostedRestCreate {
        request_id,
        provider,
        session_type,
        cwd,
        model,
        effort,
        ..
    } = request;
    let (tab_id, pane_id) = state.layout.create_tab(name.as_deref());
    let mut pane_content = json!({
        "kind": "fresh-agent",
        "sessionType": session_type,
        "provider": provider,
        "sessionId": created.session_id,
        "createRequestId": request_id,
        "status": "connected",
    });
    if let Some(value) = &cwd {
        pane_content["initialCwd"] = json!(value);
    }
    if let Some(value) = &model {
        pane_content["model"] = json!(value);
    }
    if let Some(value) = &effort {
        pane_content["effort"] = json!(value);
    }
    register_fresh_agent_tab(
        state,
        &tab_id,
        &pane_id,
        name.as_deref(),
        &pane_content,
        PaneEntry {
            placeholder_id: created.session_id.clone(),
            provider,
            session_type,
            cwd,
            model,
            effort,
            durable_id: Some(created.session_id.clone()),
        },
    );
    broadcast_tab_create(state, &tab_id, &pane_id, name.as_deref(), &pane_content);
    ok_json(
        json!({"tabId":tab_id,"paneId":pane_id,"sessionId":created.session_id}),
        "fresh-agent pane created",
    )
}

/// The registration every fresh-agent pane-minting path needs: attach the pane
/// content to the shared store, record the legacy shadow `TabRecord` + the
/// [`PaneEntry`], and index pane→tab. Every pane-minting path records its owning
/// tab in the shared `pane_tabs` reverse index so `pane_ops`'s
/// split/close/select handlers can resolve this pane's tab.
fn register_fresh_agent_tab(
    state: &FreshAgentState,
    tab_id: &str,
    pane_id: &str,
    name: Option<&str>,
    pane_content: &Value,
    pane_entry: PaneEntry,
) {
    state
        .layout
        .attach_pane_content(tab_id, pane_id, pane_content.clone());
    state.tabs.lock().expect("tabs mutex").insert(
        tab_id.to_string(),
        TabRecord {
            title: name.map(str::to_string),
        },
    );
    state
        .panes
        .lock()
        .expect("panes mutex")
        .insert(pane_id.to_string(), pane_entry);
    state
        .pane_tabs
        .lock()
        .expect("pane_tabs mutex")
        .insert(pane_id.to_string(), tab_id.to_string());
}

/// A web restart drops the REST pane map while the shared layout and hosted
/// runtime survive. Resolve hosted panes from the persisted layout on a miss;
/// the gateway still checks the session against the supervisor inventory.
fn pane_entry_for_request(state: &FreshAgentState, pane_id: &str) -> Option<PaneEntry> {
    if let Some(pane) = state.panes.lock().expect("panes mutex").get(pane_id) {
        return Some(pane.clone());
    }
    state.hosted_rest_gateway()?;
    let snapshot = state.layout.get_pane_snapshot(pane_id)?;
    let content = snapshot.pane_content?;
    if content.get("kind")?.as_str()? != "fresh-agent" {
        return None;
    }
    let provider = content.get("provider")?.as_str()?;
    let session_type = content.get("sessionType")?.as_str()?;
    if !matches!(
        (provider, session_type),
        ("claude", "freshclaude")
            | ("claude", "kilroy")
            | ("codex", "freshcodex")
            | ("opencode", "freshopencode")
    ) {
        return None;
    }
    let session_id = content.get("sessionId")?.as_str()?.to_string();
    if session_id.is_empty() {
        return None;
    }
    Some(PaneEntry {
        placeholder_id: session_id.clone(),
        provider: provider.to_string(),
        session_type: session_type.to_string(),
        cwd: content
            .get("initialCwd")
            .and_then(Value::as_str)
            .map(str::to_string),
        model: content
            .get("model")
            .and_then(Value::as_str)
            .map(str::to_string),
        effort: content
            .get("effort")
            .and_then(Value::as_str)
            .map(str::to_string),
        durable_id: Some(session_id),
    })
}

/// Broadcast `ui.command{tab.create}` — AFTER registration (Node's order is
/// createTab -> runtime create -> attachPaneContent -> broadcast -> respond,
/// router.ts:546-589, and `create_content_tab` likewise inserts before
/// broadcasting). Shape note (validated): Node OMITS the `title` key when no
/// name was provided (JSON.stringify drops undefined, router.ts:704). Serialize
/// the same shape instead of `"title": null` -- the shared client tolerates
/// both (`payload.title ||`, tabsSlice.ts:306), but keep the broadcast
/// Node-shaped.
fn broadcast_tab_create(
    state: &FreshAgentState,
    tab_id: &str,
    pane_id: &str,
    name: Option<&str>,
    pane_content: &Value,
) {
    let mut create_payload = json!({
        "id": tab_id,
        "paneId": pane_id,
        "paneContent": pane_content,
    });
    if let Some(name) = name {
        create_payload["title"] = json!(name);
    }
    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "tab.create".to_string(),
        payload: Some(create_payload),
    }));
}

/// Task 4 (adopted kata 2, freshagent-sessionref-regression): the `sessionRef`
/// resume branch of [`create_tab`] — `POST /api/tabs {agent:'opencode',
/// sessionRef}` resumes the referenced opencode session instead of minting a
/// fresh placeholder pane.
///
/// DIVERGENCE FROM FROZEN NODE PARITY (deliberate, plan-authorized): the Node
/// REST fresh-agent create (`router.ts:546-589`, `createFreshAgentPane`)
/// ignores `sessionRef` entirely — resume identity on its fresh-agent pane
/// surfaces rides only the WS `freshAgent.create{resumeSessionId}` door. This
/// branch exceeds that parity so a placeholder-keyed pane snapshot can be
/// restored in situ through REST after a restart.
///
/// Loud failures, never a silent placeholder substitution: malformed
/// `sessionRef` / provider mismatch / unknown identity shape → 400; unknown
/// durable id / unresolvable placeholder → 404; bounded-probe timeout → 504;
/// other probe errors → 502.
async fn resume_session_ref_tab(
    state: &FreshAgentState,
    session_ref_value: &Value,
    body_cwd: Option<String>,
    body_model: Option<String>,
    body_effort: Option<String>,
    name: Option<String>,
) -> Response {
    // 1. Parse. Presence-triggered and LOUD: a malformed locator is rejected,
    // never silently treated as "no resume" — the silent-placeholder-
    // substitution bug class this branch exists to close.
    let locator: SessionLocator = match serde_json::from_value(session_ref_value.clone()) {
        Ok(locator) => locator,
        Err(_) => {
            return fail_json(
                StatusCode::BAD_REQUEST,
                format!(
                    "malformed sessionRef: expected {{\"provider\":\"...\",\"sessionId\":\"...\"}}, got {session_ref_value}"
                ),
            );
        }
    };
    // 2. Provider gate: this route resumes opencode panes only.
    if locator.provider != PROVIDER {
        return fail_json(
            StatusCode::BAD_REQUEST,
            format!(
                "sessionRef provider mismatch: this route resumes \"{PROVIDER}\" panes, got \"{}\"",
                locator.provider
            ),
        );
    }
    // 3. Resolve the resume identity: a durable ses_* id resumes directly; a
    // freshopencode-<createRequestId> placeholder resolves through the
    // pane-identity ledger's create-requestId lineage (Task 3). Miss-or-no-sink
    // → 404 naming the placeholder; any other shape → 400.
    let durable_id = if locator.session_id.starts_with("ses_") {
        locator.session_id.clone()
    } else if let Some(create_request_id) =
        locator.session_id.strip_prefix(OPENCODE_PLACEHOLDER_PREFIX)
    {
        let resolved = state
            .identity_sink()
            .and_then(|sink| sink.lookup_by_create_request_id(PROVIDER, create_request_id));
        match resolved {
            Some(id) => id,
            None => {
                return fail_json(
                    StatusCode::NOT_FOUND,
                    format!(
                        "sessionRef {} could not be resolved: no pane with create requestId {create_request_id} was materialized on this server",
                        locator.session_id
                    ),
                );
            }
        }
    } else {
        return fail_json(
            StatusCode::BAD_REQUEST,
            format!(
                "sessionRef sessionId \"{}\" is neither a durable ses_* id nor a {OPENCODE_PLACEHOLDER_PREFIX}<createRequestId> placeholder",
                locator.session_id
            ),
        );
    };

    // b8ke ext r9 F1: the resume CLAIMS THE COORDINATOR before anything
    // else touches the session — the REST turn gate requires
    // Live{FreshAgent}, and pre-r9 this route registered and broadcast its
    // connected pane with NO claim, so a post-restart resume (the
    // coordinator vacant) succeeded on the wire while the pane's very first
    // send-keys was refused SESSION_RESERVED, and a resume against a
    // terminal/handoff-owned session reported success instead of the typed
    // owner response (MCP new-tab resume routes here too). Granted holds
    // the ticket through probe + registration + broadcast and commits at the
    // end (the materialize path's discipline); Adopt (Live{FreshAgent}
    // already — the same-pane re-open) proceeds idempotently; a refusal
    // answers the typed owner response.
    // b8ke ext r13 F4: the resume's observed generation fence — the server
    // deterministically knows the pane's last-committed owner generation
    // (the retained ownership stamp under the canonical id) and threads it
    // into the claim: a DELAYED resume whose recorded generation went
    // stale against the coordinator's advanced generation answers the
    // typed stale refusal (pre-r13 the claim carried None always, so a
    // stale request could claim the canonical session after its
    // generation advanced and later became vacant — recreating ownership
    // the stale-generation requirement says must be rejected).
    let resume_fence = ownership_lane::peek_retained_stamp(&state.ownership_stamps, &durable_id)
        .map(|stamp| freshell_ownership::ObservedFence {
            epoch: stamp.epoch,
            generation: stamp.generation,
        });
    // b8ke ext r13 F5: the operation id is PER-REQUEST (pane id + nonce)
    // — concurrent same-pane resumes are SEPARATE operations, never
    // reentrant parts of one (pre-r13 the shared pane-id-only id let the
    // coordinator's same-operation continuation arm grant both requests,
    // and either ticket's drop released the shared Starting claim while
    // the other ran; the loser's conflict also landed only AFTER it had
    // inserted and broadcast its tab and panes).
    let resume_op = format!("rest-resume-{durable_id}-{}", uuid::Uuid::new_v4().simple());
    // b8ke ext r13 F6: the Adopt arm's held authority — the ext-r12
    // attach guard, held across the probe + registration + broadcast
    // (this function's scope).
    let mut _resume_adopt_guard: Option<freshell_ownership::AttachGuard> = None;
    let mut resume_ticket = match ownership_lane::begin_lane_claim(
        &state.ownership,
        PROVIDER,
        &durable_id,
        &resume_op,
        resume_fence,
        "freshopencode/rest-resume",
        session_lease::now_epoch_ms(),
    ) {
        ownership_lane::LaneClaim::Granted(ticket) => Some(ticket),
        ownership_lane::LaneClaim::Unwired => None,
        // b8ke ext r13 F6: the Adopt arm (a live same-kind owner — the
        // same-pane re-open) proceeds ONLY under HELD authority (pre-r13
        // the arm proceeded with NO claim: a handoff could commit while
        // the stale request installed the pane).
        // b8ke ext r38 F1: the arm is the ATOMIC ADOPT — the retained
        // stamp's pair (the server's own recorded fence for this durable
        // id, observed above) plus the EXPECTED fresh-agent owner,
        // validated in ONE coordinator decision. Pre-r38 the arm passed
        // NO pair (None) — a terminal handoff committing between the
        // claim and the arm let the resume spawn/adopt beside the
        // terminal owner. The absent stamp on a WIRED lane (nothing
        // retained — a foreign-owned live key the lane cannot vouch for)
        // refuses typed: the resume spawns a runtime and must adopt
        // specifically; on an UNWIRED lane there is no coordinator to
        // adopt from (the pre-wiring legacy semantics hold — no guard).
        ownership_lane::LaneClaim::Adopt => {
            let expected_fresh_owner = freshell_ownership::OwnerIdentity {
                kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                terminal_id: None,
                live_session_key: None,
                pid: None,
                ownership_id: None,
                unit_id: None,
                hold: freshell_ownership::HoldKind::Main,
            };
            let adopt_outcome = match resume_fence {
                Some(adopt_fence) => ownership_lane::arm_adopt_guard(
                    &state.ownership,
                    PROVIDER,
                    &durable_id,
                    &format!("{resume_op}-adopt"),
                    &expected_fresh_owner,
                    adopt_fence,
                    "freshopencode/rest-resume-adopt",
                ),
                None if state.ownership.is_some() => {
                    tracing::warn!(target: "freshell_freshagent::opencode",
                        provider = PROVIDER, session_id = %durable_id,
                        "freshagent.opencode.rest_resume_adopt_guard_refused: no \
                         retained ownership stamp for the adopt — the resume spawns \
                         a runtime and must adopt the observed owner specifically; \
                         the request aborts typed, nothing is registered or \
                         broadcast (kata b8ke ext r38 F1)"
                    );
                    return fail_json(
                        StatusCode::CONFLICT,
                        "SESSION_RESERVED: another lifecycle operation owns this session"
                            .to_string(),
                    );
                }
                None => ownership_lane::LaneAttachGuard::Unwired,
            };
            match adopt_outcome {
                ownership_lane::LaneAttachGuard::Armed(guard) => {
                    _resume_adopt_guard = Some(guard);
                    None
                }
                ownership_lane::LaneAttachGuard::Unwired => None,
                ownership_lane::LaneAttachGuard::Refused => {
                    tracing::warn!(target: "freshell_freshagent::opencode",
                        provider = PROVIDER, session_id = %durable_id,
                        "freshagent.opencode.rest_resume_adopt_guard_refused: the \
                         adopt refused to arm (ownership advanced or a foreign owner \
                         holds the key) — the resume aborts typed, nothing is \
                         registered or broadcast"
                    );
                    return fail_json(
                        StatusCode::CONFLICT,
                        "SESSION_RESERVED: another lifecycle operation owns this session"
                            .to_string(),
                    );
                }
            }
        }
        ownership_lane::LaneClaim::Refused(outcome) => {
            // b8ke ext r26 F5: the fresh lane's ONE shared owner-fields
            // derivation (the same helper the materialization path uses).
            let owner_fields =
                ownership_lane::fresh_agent_owner_fields_from_outcome(&state.ownership, &outcome);
            tracing::warn!(target: "freshell_freshagent::opencode",
                provider = PROVIDER, session_id = %durable_id,
                outcome = ?outcome,
                "freshagent.opencode.rest_resume_claim_refused: the coordinator refused \
                 the resume claim — the pane is not resumed"
            );
            return fail_json_conflict_with_owner(
                "SESSION_RESERVED",
                format!(
                    "Session {durable_id} is owned by another lifecycle owner; retry after it settles."
                ),
                None,
                owner_fields.as_ref(),
            );
        }
    };

    // 4. LEDGER BEFORE PROBE (ordering is load-bearing, review-verified):
    // `get_session` applies the route directory as the `?directory=` query
    // param (serve.rs:634 via `with_route`) and a route-sensitive serve can
    // reject a wrong directory — so the probe route carries the ledger's
    // recorded cwd when one exists, else NO directory; NEVER the body cwd
    // (last in precedence) even when it is present.
    let sink = state.identity_sink();
    let recovered = sink
        .as_ref()
        .and_then(|s| s.load_settings(PROVIDER, &durable_id));
    let was_recorded = sink
        .as_ref()
        .is_some_and(|s| s.was_recorded(PROVIDER, &durable_id));
    let probe_route: freshell_opencode::Route = recovered.as_ref().and_then(|rec| rec.cwd.clone());

    // 5. Bounded probe. Budget layers: cfg(test) state override >
    // FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS > 10_000ms — resolved purely by
    // `resolve_probe_timeout_ms`, shared with the WS resume door.
    let manager = state.ensure_manager().await;
    let budget = state.resume_probe_budget_ms();
    let get = tokio::time::timeout(
        Duration::from_millis(budget),
        manager.get_session(&durable_id, &probe_route),
    )
    .await;
    let info = match get {
        Err(_elapsed) => {
            return fail_json(
                StatusCode::GATEWAY_TIMEOUT,
                format!("opencode session {durable_id} did not answer within {budget}ms"),
            );
        }
        Ok(Ok(value)) if value.is_object() => value,
        Ok(Ok(_)) | Ok(Err(ServeError::Http { status: 404, .. })) => {
            return fail_json(
                StatusCode::NOT_FOUND,
                format!("opencode session {durable_id} not found"),
            );
        }
        Ok(Err(err)) => {
            return fail_json(StatusCode::BAD_GATEWAY, err.to_string());
        }
    };

    // 6. SETTINGS_RESET edge (mirror opencode_ws.rs:1506-1541): the alarm arms
    // ONLY for a settings-bearing record that is now unrecoverable — a
    // lineage-only row (`was_recorded == false` under the Task 3 keying) and a
    // never-recorded session both resume silently. The alarm never blocks the
    // resume.
    if was_recorded && recovered.is_none() {
        tracing::warn!(session = %durable_id, "freshagent.opencode.rest_resume_settings_record_unrecoverable");
        state.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: json!({
                "type": "freshAgent.error",
                "sessionId": durable_id,
                "code": "SETTINGS_RESET",
                "message": "Session settings could not be recovered after restart - the agent is running with default model and effort. Reconfirm your settings.",
            }),
            provider: PROVIDER.to_string(),
            session_id: durable_id.clone(),
            session_type: SESSION_TYPE.to_string(),
        }));
    }

    // 7. Merge AFTER probe: explicit request values win model/effort over the
    // ledger; cwd is ledger > serve-directory-from-probe > body.
    let rec = recovered.unwrap_or_default();
    let serve_dir = info
        .get("directory")
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        .map(str::to_string);
    let cwd = rec.cwd.or(serve_dir).or(body_cwd);
    let model = body_model.or(rec.model);
    let effort = body_effort.or(rec.effort);

    // 8. Born-durable pane: `placeholder_id` IS the durable id (no
    // `freshopencode-`-prefixed id is ever minted for a resumed pane — the
    // snapshot/serve path sees a normal `ses_*` id from creation, behaving as
    // any already-materialized durable pane) with a FRESH uuid createRequestId.
    // The ledger's PENDING marker stays create-only and no materialized
    // frame/sessions.changed fires on resume — but the AUTHORITATIVE identity
    // binding below now writes (b8ke ext r27 F5: the pane lineage + the
    // observed ownership generation land before the commit-Live).
    let (tab_id, pane_id) = state.layout.create_tab(name.as_deref());
    let request_id = Uuid::new_v4().simple().to_string();
    let session_ref = json!({ "provider": PROVIDER, "sessionId": durable_id });
    let mut pane_content = json!({
        "kind": "fresh-agent",
        "sessionType": SESSION_TYPE,
        "provider": PROVIDER,
        "sessionId": durable_id,
        "createRequestId": request_id,
        "status": "connected",
        "sessionRef": session_ref,
    });
    if let Some(cwd) = &cwd {
        pane_content["initialCwd"] = json!(cwd);
    }
    if let Some(model) = &model {
        pane_content["model"] = json!(model);
    }
    if let Some(effort) = &effort {
        pane_content["effort"] = json!(effort);
    }
    register_fresh_agent_tab(
        state,
        &tab_id,
        &pane_id,
        name.as_deref(),
        &pane_content,
        PaneEntry {
            placeholder_id: durable_id.clone(),
            provider: PROVIDER.into(),
            session_type: SESSION_TYPE.into(),
            cwd: cwd.clone(),
            model: model.clone(),
            effort: effort.clone(),
            durable_id: Some(durable_id.clone()),
        },
    );
    // b8ke ext r27 F5: the AUTHORITATIVE identity binding — the new
    // pane's lineage + the observed ownership generation — lands BEFORE
    // the resumed session commits live and BEFORE the tab.create
    // broadcast (durable-before-answer). Pre-r27 the ledger stayed
    // READ-ONLY on resume: a never-recorded but provider-discovered
    // session had no authoritative identity binding, and an existing row
    // was never updated with the new pane or the ownership generation.
    // The write carries the resume's granted (epoch, generation) pair
    // (the delayed-write fence baseline) and the headless Clear
    // provenance (the REST materialization lane's policy). On failure
    // the tab is closed and the resume answers the typed conflict —
    // never a live pane over a session with no recoverable registration.
    let (binding_epoch, binding_generation) =
        match (state.ownership.as_ref(), resume_ticket.as_ref()) {
            (Some(registry), Some(ticket)) => {
                (Some(registry.boot_epoch()), Some(ticket.generation()))
            }
            _ => (None, None),
        };
    if let Some(sink) = state.identity_sink() {
        if let Err(e) = sink
            .record_binding(identity_sink::FreshAgentBindingUpsert {
                provider: PROVIDER.into(),
                session_id: durable_id.clone(),
                mode: SESSION_TYPE.into(),
                create_request_id: Some(request_id.clone()),
                resolves_pending: None,
                supersedes: None,
                // The REST resume lane declares no naming fact: the naming
                // seed above targets the durable session's own record
                // directly (the unified-names rename route), not the
                // identity-event fold.
                name_transition: None,
                provenance: identity_sink::ProvenanceUpdate::Clear,
                observed_epoch: binding_epoch,
                observed_generation: binding_generation,
                // b8ke focused ep5 r2 F1: a REST-lane write (never the
                // runner's authoritative target binding — the REST surface
                // carries no handoff continuation context).
                authoritative: false,
                settings: identity_sink::FreshAgentSettings {
                    model: model.clone(),
                    sandbox: None,
                    permission_mode: None,
                    effort: effort.clone(),
                    cwd: cwd.clone(),
                },
            })
            .await
        {
            tracing::error!(target: "invariant",
                provider = PROVIDER, session_id = %durable_id, error = %e,
                "freshagent.opencode.rest_resume_binding_failed_typed: the durable \
                 identity binding could not be persisted — the tab is closed and the \
                 resume answers typed (kata b8ke ext r27 F5)"
            );
            state.layout.close_tab(&tab_id);
            return fail_json_code(
                StatusCode::CONFLICT,
                "SESSION_RESERVED",
                "The session's resume record could not be persisted; the pane is \
                 not resumed"
                    .to_string(),
            );
        }
    }

    // Unified agent names (Task 2): the resumed pane names through the
    // DURABLE session's own record; the body's `name` seeds it with the
    // same intent default (automatic — never a user rename's permanence).
    // Ordered AFTER the authoritative identity binding above: a resume
    // that fails the binding gate answers typed and must not seed a name.
    if let (Some(sink), Some(seed)) = (state.naming(), name.as_deref()) {
        let target = freshell_protocol::session_names::SessionNameRef::Session {
            provider: freshell_protocol::session_names::NamedProvider::Opencode,
            session_id: durable_id.clone(),
        };
        if let Err(error) = sink
            .rename(naming::RenameNameInput {
                target: target.clone(),
                name: seed.to_string(),
                intent: freshell_protocol::session_names::NameIntent::Automatic,
                if_revision: None,
            })
            .await
        {
            naming::log_name_error("rename", &target, &error);
        }
    }
    broadcast_tab_create(state, &tab_id, &pane_id, name.as_deref(), &pane_content);

    // b8ke ext r9 F1: the registration is complete — commit
    // `Live{FreshAgent}` for the resumed durable key (the stamp lands in
    // the shared map: the kill/exit claim source; OpenCode passes
    // `pid: None` — the shared serve daemon is never a kill handle, the
    // OpenCode invariant). A stale/foreign commit means the coordinator
    // moved on mid-resume — answer the typed conflict, never a success
    // over a key this pane does not own. The un-claimed shapes (Unwired
    // — no coordinator; Adopt — an owner already stands) skip the commit
    // by construction (commit_lane_claim's no-ticket arm is a no-op).
    if let Err(outcome) = ownership_lane::commit_lane_claim(
        &state.ownership,
        &state.ownership_stamps,
        Some(&state.broadcast_tx),
        PROVIDER,
        &durable_id,
        &mut resume_ticket,
        &durable_id,
        None,
    ) {
        tracing::error!(target: "invariant",
            provider = PROVIDER, session_id = %durable_id,
            outcome = ?outcome,
            "freshagent.opencode.rest_resume_commit_stale: the coordinator moved on \
             while the resume registered"
        );
        // b8ke ext r13 F5: the stale arm must NOT leave authoritative
        // layout state for an operation reported as failed — the tab the
        // registration created is CLOSED (deterministically; the
        // per-request operation id already makes the loser refuse at the
        // CLAIM before any layout mutation — this is the belt-and-braces
        // for the commit-stale corner).
        state.layout.close_tab(&tab_id);
        return fail_json(
            StatusCode::CONFLICT,
            "SESSION_RESERVED: session ownership changed during resume".to_string(),
        );
    }

    ok_json(
        json!({
            "tabId": tab_id,
            "paneId": pane_id,
            "sessionId": durable_id,
            "sessionRef": session_ref,
        }),
        "fresh-agent pane resumed",
    )
}

// ── PATCH /api/panes/:id (rename pane) ──────────────────────────────────────

/// `MAX_TERMINAL_TITLE_OVERRIDE_LENGTH` (`terminals-router.ts:24`), reused for the
/// pane-name length bound per `router.ts:1400-1402`.
const MAX_PANE_NAME_LEN: usize = 500;

/// `parseRequiredName` (`agent-api/router.ts:603-606`): trim; empty/absent -> `None`.
pub(crate) fn parse_required_name(value: Option<&Value>) -> Option<String> {
    let trimmed = value.and_then(Value::as_str).unwrap_or("").trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// `PATCH /api/panes/:id` (`router.ts:1396-1427`): renames a pane in the
/// SHARED server-side layout store (Task 16 — kills D10's fake acknowledgement,
/// which answered `{paneId, tabRenamed:false}` for ANY id without touching any
/// state). Behavior, clause for clause:
///
/// 1. name validation (blank → 400 `name required`; >500 → 400 length message);
/// 2. `renamePane` outcome — a miss answers 200 `ok({message})`
///    (`'pane not found'` / `'no layout snapshot'`, `router.ts:1411`+`:1423`);
/// 3. `tabRenamed` = the tab has exactly one pane — computed against the
///    client snapshot where the pane resolved (multi-client store; Node reads
///    its single snapshot); broadcast
///    `ui.command{pane.rename,{tabId,paneId,title}}`; respond
///    `ok({tabId, paneId, tabRenamed}, 'pane renamed')`.
///
/// b5fb: the rename is LAYOUT-ONLY. Pane labels never touch the terminal
/// registry title or durable session/terminal title overrides — the
/// syncable-terminal persistence cascade (`persistSyncableTerminalRename`,
/// formerly `rename_persistence::persist_syncable_terminal_rename`) was
/// removed, and `PATCH /api/sessions/:key` is now the sole durable
/// session-rename surface.
/// Unified agent names (Task 2): one pane's naming-scope resolution —
/// `scoped` per the six-mode predicate over its pane content, plus the
/// naming TARGET its saved name resolves through when the content carries
/// one: the content's `nameRef`, its `namingHandle` (the pre-durable
/// handle), a durable `sessionRef` (resume/bound panes), or the create-lane
/// stash keyed by the placeholder/terminal id — the client's canonical
/// rung order, so a captured `expectedNameRef` can never disagree with the
/// server-resolved target. `None` target on a scoped pane means the
/// content predates the naming contract (answered loudly by the routes,
/// never a sticky layout title).
pub(crate) struct PaneNameResolution {
    pub(crate) scoped: bool,
    pub(crate) target: Option<freshell_protocol::session_names::SessionNameRef>,
}

pub(crate) fn resolve_pane_name_target(
    state: &FreshAgentState,
    pane_id: &str,
) -> Option<PaneNameResolution> {
    let snapshot = state.layout.get_pane_snapshot(pane_id)?;
    let content = snapshot.pane_content.as_ref()?;
    let mode = content.get("mode").and_then(Value::as_str);
    let session_type = content.get("sessionType").and_then(Value::as_str);
    let scoped = naming::is_unified_agent_mode(mode, session_type);
    if !scoped {
        return Some(PaneNameResolution {
            scoped: false,
            target: None,
        });
    }
    // Unified agent names (Task 8, the T6-R3 sender-repair consequence): the
    // pane's canonical binding rungs — `nameRef`, then the PRE-DURABLE
    // `namingHandle`, then the durable `sessionRef`, then the create-lane
    // stash — in EXACTLY the client's approved order
    // (`resolvePaneNameRef`, sessionNameSelectors). The pre-durable handle
    // is the pane's identity-of-record until verified persistence: a
    // prospective sessionRef (a fresh claude pane's preallocated id before
    // any transcript exists) must NOT win it, or the client's captured
    // `expectedNameRef` (the same rungs) disagrees with the server-resolved
    // target and every pre-durable rename refuses with a spurious
    // NAME_TARGET_MOVED. Post-bind, a pending ref resolves through the
    // store's redirect to the SAME durable record, so reordering never
    // retargets an established conversation; a switched pane's content
    // carries its updated binding, which rung 1 honors first.
    if let Some(explicit) = content.get("nameRef") {
        if let Ok(target) = serde_json::from_value::<freshell_protocol::session_names::SessionNameRef>(
            explicit.clone(),
        ) {
            if matches!(
                target,
                freshell_protocol::session_names::SessionNameRef::Session { .. }
                    | freshell_protocol::session_names::SessionNameRef::Pending { .. }
            ) {
                return Some(PaneNameResolution {
                    scoped: true,
                    target: Some(target),
                });
            }
        }
    }
    // The content's pre-durable handle.
    if let Some(handle) = content
        .get("namingHandle")
        .and_then(Value::as_str)
        .filter(|h| !h.trim().is_empty())
    {
        return Some(PaneNameResolution {
            scoped: true,
            target: Some(freshell_protocol::session_names::SessionNameRef::Pending {
                id: handle.trim().to_string(),
            }),
        });
    }
    // Durable sessionRef (established identity).
    if let Some(locator) = content.get("sessionRef") {
        if let (Some(provider), Some(session_id)) = (
            locator.get("provider").and_then(Value::as_str),
            locator.get("sessionId").and_then(Value::as_str),
        ) {
            if let Some(named) = naming::named_provider_for(Some(provider), None) {
                return Some(PaneNameResolution {
                    scoped: true,
                    target: Some(freshell_protocol::session_names::SessionNameRef::Session {
                        provider: named,
                        session_id: session_id.to_string(),
                    }),
                });
            }
        }
    }
    // The create-lane stash: fresh panes key it by the placeholder
    // sessionId; terminal panes by the terminal id.
    let stash_key = content
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| content.get("terminalId").and_then(Value::as_str));
    if let Some(key) = stash_key {
        if let Some(handle) = state.peek_naming_handle(key) {
            return Some(PaneNameResolution {
                scoped: true,
                target: Some(freshell_protocol::session_names::SessionNameRef::Pending {
                    id: handle,
                }),
            });
        }
    }
    Some(PaneNameResolution {
        scoped: true,
        target: None,
    })
}

/// Unified agent names (Task 8 acceptance): the pane's own PRE-DURABLE
/// binding — the pending handle a scoped rename falls back to when the
/// pane's prospective sessionRef has no record yet (the fresh-claude
/// prealloc case). Sources, in order: the pane content's `namingHandle`
/// (the REST create lane stamps it), the shared terminal registry row's
/// retained binding (BOTH create doors stamp it via `set_naming` — the WS
/// door's `admit_create_naming` and the REST `terminal_created_hook`), and
/// the create-lane stash keyed by the terminal id. Only a `Pending` ref
/// counts: a durable binding means the primary session-target rename
/// should have resolved and a fallback must not retarget it.
pub(crate) fn resolve_pane_pending_binding(
    state: &FreshAgentState,
    pane_id: &str,
) -> Option<freshell_protocol::session_names::SessionNameRef> {
    let snapshot = state.layout.get_pane_snapshot(pane_id)?;
    let content = snapshot.pane_content.as_ref()?;
    // (1) The content's own pre-durable handle.
    if let Some(handle) = content
        .get("namingHandle")
        .and_then(Value::as_str)
        .filter(|h| !h.trim().is_empty())
    {
        return Some(freshell_protocol::session_names::SessionNameRef::Pending {
            id: handle.trim().to_string(),
        });
    }
    // (2) The shared terminal registry row's binding (both create doors).
    let terminal_id = content.get("terminalId").and_then(Value::as_str)?;
    if let Some(registry) = state.terminal_registry.as_ref() {
        if let Some(freshell_protocol::session_names::SessionNameRef::Pending { id }) =
            registry.name_ref_of(terminal_id)
        {
            return Some(freshell_protocol::session_names::SessionNameRef::Pending { id });
        }
    }
    // (3) The create-lane stash, keyed by the terminal id.
    state
        .peek_naming_handle(terminal_id)
        .map(|handle| freshell_protocol::session_names::SessionNameRef::Pending { id: handle })
}

/// Unified agent names (Task 8 acceptance): the request's captured
/// `expectedNameRef` — the scoped binding the client's editor asserts.
/// Only `Session`/`Pending` refs count as a scoped capture; anything else
/// parses to None and the request keeps the capture-less behavior.
pub(crate) fn scoped_capture_of(
    body: &Value,
) -> Option<freshell_protocol::session_names::SessionNameRef> {
    let parsed = serde_json::from_value::<freshell_protocol::session_names::SessionNameRef>(
        body.get("expectedNameRef")?.clone(),
    )
    .ok()?;
    match parsed {
        // The enum's only variants are the scoped ones; the match stays
        // exhaustive so a future unscoped variant must be classified HERE,
        // never silently accepted as a scoped capture.
        target @ (freshell_protocol::session_names::SessionNameRef::Session { .. }
        | freshell_protocol::session_names::SessionNameRef::Pending { .. }) => Some(target),
    }
}

/// Unified agent names (Task 8 acceptance): the EFFECTIVE scoped target for
/// a pane rename. The layout mirror is a REPLICA that can lag a freshly
/// created agent pane (the ui.layout.sync carrying the picker→agent content
/// switch lands seconds after the editor can open), so the mirror's
/// resolution is authoritative ONLY where it is fresher than the request:
///
/// - a scoped mirror target WINS over the capture (a pane whose
///   conversation really switched then 409s against the editor's stale
///   capture — `rename_scoped_session`'s guard);
/// - a scoped mirror with NO binding rungs falls back to the capture
///   (the mirror adopted the agent pane but predates the sender's
///   handle stamping);
/// - an UNSCOPED mirror (stale pre-selection content) or a pane the
///   mirror never adopted falls back to the capture too — the capture
///   is the client's scoped assertion and must NEVER be silently
///   downgraded to the legacy layout label (the demonstrated harm:
///   a pre-durable pane-header rename lost to the first-message
///   fallback because the route wrote a layout-local title instead of
///   the canonical record);
/// - with no capture and no scoped mirror resolution, the rename keeps
///   its legacy/capture-less behavior unchanged.
pub(crate) fn effective_pane_name_resolution(
    state: &FreshAgentState,
    pane_id: &str,
    body: &Value,
) -> Option<PaneNameResolution> {
    let capture = scoped_capture_of(body);
    match resolve_pane_name_target(state, pane_id) {
        Some(resolution) if resolution.scoped => Some(PaneNameResolution {
            scoped: true,
            target: resolution.target.clone().or(capture),
        }),
        _ => capture.map(|target| PaneNameResolution {
            scoped: true,
            target: Some(target),
        }),
    }
}

/// Unified agent names (Task 2): the scoped rename shared by the pane/tab
/// convenience routes — ONE `rename` call with `nameIntent` (default
/// `automatic`: an agent suggestion never acquires a user rename's
/// permanence) and optional `expectedNameRef`/`ifRevision` guards. Never
/// calls `LayoutStore::rename_pane/rename_tab` for a scoped target; the
/// accepted name update is returned (the store's commit publishes
/// `session.name.updated` through the wired publisher), never a sticky
/// `ui.command` title alias. `pane_id` is the addressed pane for the
/// response envelope (the tab route passes its resolved source pane).
/// The scoped pane route's error response — the same contract
/// `freshell-server`'s `session_name_routes::name_error_response` answers
/// for the canonical/session/terminal routes: a compare-and-set conflict
/// carries the CURRENT record as `sessionName` so the client editor can
/// fold the accepted winner AND refresh its captured revision for the
/// user's resubmit. Without it the pane editor is STUCK: every resubmit
/// re-sends the same stale `ifRevision` and re-conflicts forever (the
/// live-observed "the record moved to revision N while the editor held M"
/// looping across every resubmit of a pre-durable rename racing its own
/// materialization).
fn scoped_name_error_response(error: &naming::NameError, target: &Value) -> Response {
    let status =
        StatusCode::from_u16(error.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let conflict_current = if let naming::NameError::Conflict { current, .. } = error {
        current.clone()
    } else {
        None
    };
    let mut body = json!({
        "error": error.code(),
        "message": error.to_string(),
        "nameRef": target,
    });
    if let Some(current) = conflict_current {
        // The accepted record the editor should surface instead of an
        // invisible overwrite (plan rule 4) — and the refreshed capture
        // its documented resubmit path needs.
        body["sessionName"] = serde_json::to_value(&current).unwrap_or(Value::Null);
        body["nameRef"] = serde_json::to_value(&current.name_ref).unwrap_or(Value::Null);
    }
    (status, Json(body)).into_response()
}

pub(crate) async fn rename_scoped_session(
    state: &FreshAgentState,
    resolution: &PaneNameResolution,
    tab_id: Option<&str>,
    pane_id: Option<&str>,
    body: &Value,
) -> Response {
    let Some(target) = resolution.target.clone() else {
        return fail_json(
            StatusCode::BAD_REQUEST,
            "NAME_TARGET_UNRESOLVED: this agent pane has no naming binding on this \
             server (no sessionRef or namingHandle) — open it from the sidebar so \
             its identity binds, then rename"
                .to_string(),
        );
    };
    // A scoped null/reset request answers the SAME machine-readable refusal
    // as the canonical/session/terminal surfaces: a protected saved name is
    // never cleared through any route.
    if body
        .get("name")
        .and_then(Value::as_str)
        .is_none_or(|name| name.trim().is_empty())
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": naming::NAME_RESET_UNSUPPORTED,
                "message": "a scoped session's saved name is never cleared; rename it instead",
                "nameRef": target,
            })),
        )
            .into_response();
    }
    // `expectedNameRef`: the editor's captured binding — a pane whose
    // conversation switched must never receive the rename (409, visibly).
    if let Some(expected) = body.get("expectedNameRef") {
        let expected_ref: Option<freshell_protocol::session_names::SessionNameRef> =
            serde_json::from_value(expected.clone()).ok();
        if expected_ref.as_ref() != Some(&target) {
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "NAME_TARGET_MOVED",
                    "message": "the pane's naming binding changed since the edit started",
                    "nameRef": target,
                })),
            )
                .into_response();
        }
    }
    // Delta-review round 3, finding 8: an unknown `nameIntent` string is a
    // loud 400 — the same rejection the canonical PATCH route, CLI, and MCP
    // apply — never a silent default to `automatic` behind a typo. Omitted
    // intent still defaults to automatic (the plan's rule 3: agent
    // suggestions are provider_ai rank and never acquire user permanence).
    let intent = match body.get("nameIntent") {
        None | Some(serde_json::Value::Null) => {
            freshell_protocol::session_names::NameIntent::Automatic
        }
        Some(serde_json::Value::String(text)) => match text.as_str() {
            "user" => freshell_protocol::session_names::NameIntent::User,
            "automatic" => freshell_protocol::session_names::NameIntent::Automatic,
            other => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": "Invalid request",
                        "details": format!("nameIntent must be \"user\" or \"automatic\", got {other:?}"),
                    })),
                )
                    .into_response();
            }
        },
        Some(other) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "Invalid request",
                    "details": format!("nameIntent must be \"user\" or \"automatic\", got {other}"),
                })),
            )
                .into_response();
        }
    };
    let if_revision = body
        .get("ifRevision")
        .and_then(Value::as_u64)
        .filter(|r| *r <= freshell_protocol::session_names::MAX_NAME_REVISION);
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let Some(sink) = state.naming() else {
        return fail_json(
            StatusCode::SERVICE_UNAVAILABLE,
            "session naming is unavailable on this server".to_string(),
        );
    };
    match sink
        .rename(naming::RenameNameInput {
            target: target.clone(),
            name: name.clone(),
            intent,
            if_revision,
        })
        .await
    {
        Ok(update) => {
            let mut data = Map::new();
            if let Some(tab_id) = tab_id {
                data.insert("tabId".into(), json!(tab_id));
            }
            if let Some(pane_id) = pane_id {
                data.insert("paneId".into(), json!(pane_id));
            }
            data.insert(
                "nameRef".into(),
                serde_json::to_value(&update.record.name_ref).unwrap_or(Value::Null),
            );
            data.insert(
                "sessionName".into(),
                serde_json::to_value(&update).unwrap_or(Value::Null),
            );
            ok_json(Value::Object(data), "session renamed")
        }
        Err(error) => {
            // Unified agent names (Task 8 acceptance): the pre-bind
            // fallback. A fresh claude pane's content carries the
            // PROSPECTIVE preallocated sessionRef (both create doors put
            // it there before any transcript exists), so the primary
            // session-target rename answers NotFound until the first
            // message materializes the identity. The pane's own naming
            // binding pre-bind is its PENDING handle — resolve that and
            // retry once. The `expectedNameRef` capture guard already
            // passed against the pane's visible binding, and the 404
            // itself proves no established record exists to have switched
            // conversations from, so the retry needs no second guard.
            if matches!(error, naming::NameError::NotFound(_))
                && matches!(
                    target,
                    freshell_protocol::session_names::SessionNameRef::Session { .. }
                )
            {
                if let Some(pane_id) = pane_id {
                    if let Some(pending) = resolve_pane_pending_binding(state, pane_id) {
                        match sink
                            .rename(naming::RenameNameInput {
                                target: pending.clone(),
                                name,
                                intent,
                                if_revision,
                            })
                            .await
                        {
                            Ok(update) => {
                                let mut data = Map::new();
                                if let Some(tab_id) = tab_id {
                                    data.insert("tabId".into(), json!(tab_id));
                                }
                                data.insert("paneId".into(), json!(pane_id));
                                data.insert(
                                    "nameRef".into(),
                                    serde_json::to_value(&update.record.name_ref)
                                        .unwrap_or(Value::Null),
                                );
                                data.insert(
                                    "sessionName".into(),
                                    serde_json::to_value(&update).unwrap_or(Value::Null),
                                );
                                return ok_json(Value::Object(data), "session renamed");
                            }
                            Err(retry_error) => {
                                naming::log_name_error("rename", &pending, &retry_error);
                                let target_value =
                                    serde_json::to_value(&pending).unwrap_or(Value::Null);
                                return scoped_name_error_response(&retry_error, &target_value);
                            }
                        }
                    }
                }
            }
            naming::log_name_error("rename", &target, &error);
            let target_value = serde_json::to_value(&target).unwrap_or(Value::Null);
            scoped_name_error_response(&error, &target_value)
        }
    }
}

async fn rename_pane(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    // Unified agent names (Task 2): a scoped agent pane's rename targets its
    // saved SESSION name (the one name shared by pane/sidebar/terminal/tab);
    // the shared helper owns the scoped blank/reset refusal
    // (`NAME_RESET_UNSUPPORTED`), so this resolution runs BEFORE the legacy
    // `name required` gate — a scoped blank rename must answer the uniform
    // code, not the legacy message. The legacy layout label remains for
    // every out-of-scope pane.
    //
    // Task 8 acceptance: the resolution honors the request's captured
    // binding when the mirror is stale or unmirrored (see
    // `effective_pane_name_resolution`) — a pane-header rename racing its
    // pane's first layout sync still reaches the naming authority.
    if let Some(resolution) = effective_pane_name_resolution(&state, &pane_id, &body) {
        if resolution.scoped {
            let tab_id = state
                .layout
                .get_pane_snapshot(&pane_id)
                .map(|snapshot| snapshot.tab_id);
            return rename_scoped_session(
                &state,
                &resolution,
                tab_id.as_deref(),
                Some(&pane_id),
                &body,
            )
            .await;
        }
    }

    let Some(name) = parse_required_name(body.get("name")) else {
        return fail_json(StatusCode::BAD_REQUEST, "name required".to_string());
    };

    if name.len() > MAX_PANE_NAME_LEN {
        return fail_json(
            StatusCode::BAD_REQUEST,
            format!("name must be {MAX_PANE_NAME_LEN} characters or fewer"),
        );
    }

    let outcome = state.layout.rename_pane(&pane_id, &name);

    let Some(tab_id) = outcome.tab_id else {
        // Node's `{message:'pane not found'|'no layout snapshot'}` at 200
        // (`renamePane` miss, `router.ts:1411`+`:1423`).
        let message = outcome.message.unwrap_or("pane renamed");
        return ok_json(json!({ "message": message }), message);
    };
    // `result.paneId || paneId` (`router.ts:1420`).
    let pane_id = outcome.pane_id.unwrap_or(pane_id);

    // `tabRenamed` = single-pane tab (`router.ts:1414-1415`), computed from
    // the client snapshot where the pane actually RESOLVED (multi-client
    // store) — another client's same-id tab may have a different shape, so
    // Node's `listPanes(tabId)` read would answer from the wrong snapshot.
    let tab_renamed = state.layout.pane_is_sole_in_tab(&pane_id);

    state.broadcast(&ServerMessage::UiCommand(UiCommand {
        command: "pane.rename".to_string(),
        payload: Some(json!({ "tabId": tab_id, "paneId": pane_id, "title": name })),
    }));

    ok_json(
        json!({ "tabId": tab_id, "paneId": pane_id, "tabRenamed": tab_renamed }),
        "pane renamed",
    )
}

// ── POST /api/panes/:id/send-keys (drive one turn) ───────────────────────────────

/// Unified agent names (Task 2): the REST send-keys lane's pending→durable
/// bind — the twin of `opencode_ws`'s materialization bind, over the SHARED
/// `FreshAgentState` handle stash (so a REST-created pane's handle resolves
/// whichever surface drives the materialization). Opencode persistence is
/// verified here (the SQLite row exists from `create_session`), so the
/// transfer commits BEFORE the materialized frame publishes the identity.
/// Never a lane blocker: a failure retains the handle for the main.rs
/// naming tick's retry. Answers the accepted projection for the frame.
async fn bind_rest_naming_handle(
    state: &FreshAgentState,
    placeholder: &str,
    durable_id: &str,
) -> Option<(
    freshell_protocol::session_names::SessionNameRef,
    freshell_protocol::session_names::SessionNameRecord,
)> {
    let handle = state.take_naming_handle(placeholder)?;
    let sink = state.naming()?;
    let pending = freshell_protocol::session_names::SessionNameRef::Pending { id: handle.clone() };
    let target = freshell_protocol::session_names::SessionNameRef::Session {
        provider: freshell_protocol::session_names::NamedProvider::Opencode,
        session_id: durable_id.to_string(),
    };
    let acquisition = freshell_protocol::native_location::NativeAcquisition {
        location: freshell_protocol::native_location::NativeLocation::Opencode {
            database_path: freshell_sessions::parse::default_opencode_data_home()
                .join("opencode.db")
                .display()
                .to_string(),
            native_session_id: Some(durable_id.to_string()),
            original_directory: None,
            owned_local_endpoint: None,
        },
        evidence: freshell_protocol::native_location::NativeEvidenceKind::PersistedMetadata,
        persistence: freshell_protocol::native_location::NativePersistence::Verified,
    };
    let update = match sink
        .bind_pending(naming::BindNameInput {
            pending: pending.clone(),
            target: target.clone(),
            acquisition,
        })
        .await
    {
        Ok(update) => update,
        Err(error) => {
            naming::log_name_error("bind_pending", &pending, &error);
            // A failed bind RETAINS the handle — re-stash it for the tick's
            // visible retry (the plan's "on failed bind retain the handle").
            state.stash_naming_handle(placeholder, &handle);
            return None;
        }
    };
    if update.record.name_ref != target {
        // Not transferred (a read answer): keep the stash entry.
        state.stash_naming_handle(placeholder, &handle);
    }
    Some((update.record.name_ref.clone(), update.record))
}

async fn send_keys(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    // Slice 1 (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md \u00a72.2): terminal
    // panes are a DISJOINT map from the fresh-agent `panes` map below, so this
    // never touches (or is touched by) the opencode/claude/codex send-keys path.
    if let Some(resp) = terminal_tabs::maybe_send_keys(&state, &pane_id, &body) {
        return resp;
    }

    let text = body
        .get("data")
        .or_else(|| body.get("keys"))
        .or_else(|| body.get("text"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if text.is_empty() {
        return fail_json(StatusCode::BAD_REQUEST, "text is required".to_string());
    }

    let pane = match pane_entry_for_request(&state, &pane_id) {
        Some(pane) => pane,
        None => return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string()),
    };

    let turn_timeout = body
        .get("timeout")
        .and_then(value_as_secs)
        .map(Duration::from_secs)
        .unwrap_or(DEFAULT_TURN_TIMEOUT);

    if let Some(gateway) = state.hosted_rest_gateway() {
        let request_id = body
            .get("requestId")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| Uuid::new_v4().simple().to_string());
        let result = gateway
            .send_agent(hosted_rest::HostedRestSend {
                request_id: request_id.clone(),
                session_id: pane.placeholder_id.clone(),
                provider: pane.provider.clone(),
                session_type: pane.session_type.clone(),
                text,
                timeout_ms: u64::try_from(turn_timeout.as_millis()).unwrap_or(u64::MAX),
            })
            .await;
        return match result {
            Ok(result) if result.completed => ok_json(
                json!({
                    "paneId":pane_id,
                    "sessionId":result.session_id,
                    "submittedTurnId":request_id,
                    "sessionRef":{"provider":pane.provider,"sessionId":result.session_id},
                    "status":"idle",
                }),
                "prompt sent",
            ),
            Ok(result) => approx_json(
                json!({
                    "paneId":pane_id,
                    "sessionId":result.session_id,
                    "submittedTurnId":request_id,
                    "sessionRef":{"provider":pane.provider,"sessionId":result.session_id},
                    "status":"approx",
                }),
                "prompt sent; turn did not complete within deadline",
            ),
            Err(()) => fail_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "durable fresh-agent input was not accepted".to_string(),
            ),
        };
    }

    let manager = state.ensure_manager().await;
    let route = pane.cwd.clone();

    // AGENT-08 continuity fix: create the durable session ONLY the FIRST time this pane
    // sends (mirrors `adapter.ts materializeOrSend:349` — `if (!state.realSessionId)`).
    // Before this fix, every call unconditionally ran `create_session`, so a second
    // `send-keys` on the same pane silently started a BRAND NEW opencode session instead
    // of continuing the first — the exact context-loss bug the WS `handle_send`
    // continuity regression test (`opencode_ws.rs`) guards against on the WS path.
    let durable_id = if let Some(durable_id) = pane.durable_id.clone() {
        durable_id
    } else {
        // COLD-START + create the durable session. `create_session` runs `ensure_started`
        // (spawn serve → bounded health wait — the DEV-0001 fix, NO warm-proxy) then
        // `POST /session`. Success here IS the cold-start-clean fingerprint.
        //
        // bccd item 4 (council enn3 D-D evaluate-and-decide) — DELIBERATELY
        // UNGATED. Decision reversed at plan validation: gating this
        // cold-start would hold a spawn permit for a worst-case ~50-70s
        // (health_timeout 20_000ms serve.rs:303 + request_timeout 30_000ms
        // serve.rs:308,546 under the permit; the serialized `running`-mutex
        // queue adds ~20s per failing holder) vs the 10s gate waits at
        // every other door — and k cold first-sends queued on the singleton
        // mutex would hold k permits, starving ALL spawn doors. The
        // double-mutex single-flight already bounds actual sidecar forks
        // to AT MOST ONE server-wide: the gate would add starvation
        // without reducing fork concurrency. Moving the acquire inside
        // the single-flight would invert lock order (cycle hazard).
        // Decision record: docs/plans/2026-07-29-znhn-bccd-followups.md §D-7.
        //
        // b8ke ext r22 F1: the REST/MCP materialization is coordinator-owned
        // from BEFORE the spawn — the pane-scoped provisional claim under the
        // pane id the caller already carries (the pre-spawn-claim discipline
        // of the other fresh lanes). The whole cold-start window (the shared
        // serve's spawn + health wait + the POST /session — worst case
        // ~50-70s) then has a Starting generation and the typed recovery
        // record; the settle witness registers with the ticket so the
        // watchdog's stale-start sweep SKIPS the live slow cold-start (the
        // r20 F1 discipline). The cancel closure is a NO-OP by design: the
        // shared serve daemon is NOT the per-session writer and must never
        // be killed (OpenCode invariant). A duplicate send-keys for this
        // pane while the cold-start runs hits the pane key's Starting
        // record and answers the typed 409 — never a silent double
        // materialization.
        // b8ke ext r26 F2: the operation id is UNIQUE PER REQUEST. The
        // pane-scoped prefix keys the logs to the pane, and the uuid
        // suffix makes a competing drive's begin_start hit the held
        // Starting record under a DIFFERENT operation id — the typed
        // Blocked refusal — instead of `begin_start`'s same-kind +
        // same-op RE-ENTRY grant (pre-r26 both concurrent drives got
        // tickets, both called create_session, and the rekey loser's
        // freshly minted conversation was orphaned outside coordinator
        // ownership).
        let provisional_id = format!("{PENDING_CREATE_PREFIX}{pane_id}");
        let materialize_op = format!("rest-materialize-{pane_id}-{}", Uuid::new_v4());
        let start_pid_slot = ownership_lane::sidecar_pid_cancel_slot();
        let mut _start_cancellation: Option<ownership_lane::StartCancellationGuard> = None;
        let mut own_ticket: Option<freshell_ownership::OperationTicket> = None;
        let claim_key = state
            .ownership
            .as_ref()
            .map(|r| r.resolve_canonical(PROVIDER, &provisional_id))
            .unwrap_or_else(|| provisional_id.clone());
        match ownership_lane::begin_lane_claim(
            &state.ownership,
            PROVIDER,
            &claim_key,
            &materialize_op,
            None,
            "freshopencode/rest-materialize",
            session_lease::now_epoch_ms(),
        ) {
            ownership_lane::LaneClaim::Granted(ticket) => {
                own_ticket = Some(ticket);
                _start_cancellation = Some(ownership_lane::register_start_cancellation_for_ticket(
                    &state.ownership,
                    PROVIDER,
                    &claim_key,
                    &own_ticket,
                    ownership_lane::pid_slot_cancellation(&start_pid_slot),
                ));
            }
            ownership_lane::LaneClaim::Unwired => {}
            ownership_lane::LaneClaim::Adopt => {
                // The pane-scoped key resolves to a LIVE same-kind owner —
                // an earlier materialization for this pane completed (the
                // key is `Aliased{to: the durable id}` after its rekey);
                // the duplicate drive answers the typed conflict.
                tracing::warn!(target: "freshell_freshagent::opencode",
                    provider = PROVIDER, pane_id = %pane_id, resolved_session_id = %claim_key,
                    "freshagent.opencode.materialize_claim_refused: the pane-scoped \
                     materialization key resolves to a live owner; the pane is not \
                     materialized by this drive"
                );
                // b8ke ext r26 F5: the ONE shared typed conflict envelope
                // (machine-readable code + the coordinator's owner fields),
                // never the prose-only fail_json shape.
                let owner_fields = state.ownership.as_ref().and_then(|ownership| {
                    ownership_lane::terminal_owner_fields_from_snapshot(
                        &ownership.observe(PROVIDER, &claim_key),
                    )
                });
                return fail_json_conflict_with_owner(
                    "SESSION_RESERVED",
                    format!(
                        "Session {claim_key} is already materialized by a live owner; \
                         retry after it settles."
                    ),
                    None,
                    owner_fields.as_ref(),
                );
            }
            ownership_lane::LaneClaim::Refused(outcome) => {
                tracing::warn!(target: "freshell_freshagent::opencode",
                    provider = PROVIDER, pane_id = %pane_id, resolved_session_id = %claim_key,
                    outcome = ?outcome,
                    "freshagent.opencode.materialize_claim_refused: the coordinator \
                     refused the pane-scoped pre-spawn claim; the pane is not \
                     materialized (kata b8ke r22 F1)"
                );
                let owner_fields = ownership_lane::fresh_agent_owner_fields_from_outcome(
                    &state.ownership,
                    &outcome,
                );
                return fail_json_conflict_with_owner(
                    "SESSION_RESERVED",
                    format!(
                        "Another lifecycle operation owns session {claim_key}; \
                         retry after it settles."
                    ),
                    None,
                    owner_fields.as_ref(),
                );
            }
        }

        let created = match manager
            .create_session(None, None, pane.cwd.as_deref())
            .await
        {
            Ok(created) => created,
            Err(err) => return fail_json(serve_error_status(&err), err.to_string()),
        };
        let durable_id = created.id;

        // b8ke ext r22 F1: the MINT-TIME REKEY — the SAME ticket's
        // in-flight record moves from the pane-scoped provisional key to
        // the minted durable `ses_*` id in ONE atomic step
        // (`rekey_starting`: the provisional key becomes
        // `Aliased{to: the durable id}` — the rekey family's resolution
        // record — and the durable key holds the SAME operation's
        // `Starting`; the ticket survives via `rekey_session_id`, so the
        // registration tail's `commit_lane_claim` below lands under the
        // CANONICAL key). The durable key is coordinator-owned from the
        // moment the id exists: a competitor that claimed the freshly
        // discoverable session inside the cold-start window left a record
        // under it and the rekey REFUSES typed — the pane is NOT bound
        // (the daemon-side session is abandoned; the shared serve is
        // never killed — OpenCode invariant), never two writers.
        // b8ke ext r22 F2: the binding row's fence pair — the rekeyed
        // ticket's (epoch, generation) at the mint (the delayed-write
        // fence baseline the durable row carries below). None when the
        // coordinator is unwired.
        let (binding_epoch, binding_generation) =
            match (state.ownership.as_ref(), own_ticket.as_ref()) {
                (Some(registry), Some(ticket)) => {
                    (Some(registry.boot_epoch()), Some(ticket.generation()))
                }
                _ => (None, None),
            };
        if let Some(ticket) = own_ticket.as_mut() {
            let Some(registry) = state.ownership.as_ref() else {
                unreachable!("a live ticket implies a wired coordinator");
            };
            match registry.rekey_starting(
                PROVIDER,
                ticket.session_id(),
                &durable_id,
                ticket.operation_id(),
                ticket.generation(),
            ) {
                freshell_ownership::CommitOutcome::Committed => {
                    ticket.rekey_session_id(&durable_id);
                }
                outcome => {
                    tracing::error!(target: "invariant",
                        provider = PROVIDER, pane_id = %pane_id, session_id = %durable_id,
                        outcome = ?outcome,
                        "freshagent.opencode.materialize_rekey_refused: the minted \
                         session id was claimed by another owner during the cold-start \
                         window — the pane is not bound (kata b8ke ext r22 F1)"
                    );
                    return fail_json(
                        StatusCode::CONFLICT,
                        "SESSION_RESERVED: the minted session id was claimed by another owner during the create".to_string(),
                    );
                }
            }
        }
        // The shared `opencode serve` daemon is NOT the per-session writer
        // and must never be killed — pid stays `None` (OpenCode
        // invariant): the watchdog has no partial runtime to reap.
        ownership_lane::register_partial_fresh_runtime(
            &state.ownership,
            PROVIDER,
            &durable_id,
            &own_ticket,
            &durable_id,
            None,
        );

        // Persist the durable id back onto the pane (so /capture and the next
        // `send-keys` on this pane can reuse it instead of re-materializing).
        if let Some(entry) = state.panes.lock().expect("panes mutex").get_mut(&pane_id) {
            entry.durable_id = Some(durable_id.clone());
        }

        // P1.13: binding row at REST materialization (AWAITED BEFORE the materialized
        // broadcast -- durable-before-answer), resolving the pane's placeholder id.
        // Without this site, REST-created sessions (the e2e seeding surface) never get
        // a resume record (V10 A13-N1). Opencode has no sandbox/permission concepts.
        //
        // Task 3: lineage recording is UNCONDITIONAL — even an all-blank settings
        // snapshot writes the row, because its `create_request_id` lineage (derived
        // from the pane's placeholder id) is what lets a placeholder-keyed pane
        // resolve to this durable session via `lookup_by_create_request_id` after a
        // restart. The false-SETTINGS_RESET hazard an all-blank row used to pose
        // (the reason this write was once gated on settings recordability) moved to
        // the `was_recorded` keying (`identity_sink.rs`): lineage-only rows answer
        // was_recorded()==false, so a legitimately-default create can never alarm
        // on a later resume. `create_request_id`: `freshopencode-<createRequestId>`
        // strips to Some(createRequestId); a born-durable placeholder strips to None.
        if let Some(sink) = state.identity_sink() {
            if let Err(e) = sink
                .record_binding(identity_sink::FreshAgentBindingUpsert {
                    provider: PROVIDER.into(),
                    session_id: durable_id.clone(),
                    mode: SESSION_TYPE.into(),
                    create_request_id: pane
                        .placeholder_id
                        .strip_prefix(OPENCODE_PLACEHOLDER_PREFIX)
                        .map(str::to_string),
                    resolves_pending: Some(pane.placeholder_id.clone()),
                    supersedes: None,
                    // Unified agent names: the REST materialization's naming
                    // transfer is committed by the dedicated bind lane below
                    // (BEFORE the materialized frame publishes the identity);
                    // the ledger edge itself carries no naming fact.
                    name_transition: None,
                    // D8 (restore-open-sessions-only): REST/MCP lineage rows
                    // intentionally stamp NO provenance — no browser client
                    // connection exists at bind time, so there is nothing true
                    // to attribute. Delta-r2 Finding 2: `Clear` (not merely
                    // no-stamps) — a headless re-bind of a browser-stamped row
                    // must ERASE the stale browser attribution instead of
                    // inheriting it under a refreshed `updated_at`; rows
                    // without attribution are never offered by the recovery
                    // judgment (`recovery_inventory.rs`).
                    provenance: identity_sink::ProvenanceUpdate::Clear,
                    // b8ke ext r22 F2: the mint-time pair (the fence).
                    observed_epoch: binding_epoch,
                    observed_generation: binding_generation,
                    // b8ke focused ep5 r2 F1: a REST-lane write.
                    authoritative: false,
                    settings: identity_sink::FreshAgentSettings {
                        model: pane.model.clone(),
                        sandbox: None,
                        permission_mode: None,
                        effort: pane.effort.clone(),
                        cwd: pane.cwd.clone(),
                    },
                })
                .await
            {
                // b8ke ext r22 F2: the binding failure PROPAGATES — the
                // materialization REFUSES typed here (the pane is NOT
                // bound; the ticket's RAII drop settles the pane-scoped
                // claim typed), never a LEDGER_WRITE_FAILED notification
                // with the session still materializing and the ownership
                // committing Live.
                tracing::error!(target: "invariant",
                    error = %e, session_id = %durable_id,
                    "freshagent.opencode.rest_binding_write_failed_typed: the durable \
                     row write failed — the materialization is refused (kata b8ke \
                     ext r22 F2)"
                );
                return fail_json(
                    StatusCode::CONFLICT,
                    "SESSION_RESERVED: the session's resume record could not be persisted; \
                     the pane is not materialized"
                        .to_string(),
                );
            }
        }

        let session_ref = SessionLocator {
            provider: PROVIDER.to_string(),
            session_id: durable_id.clone(),
        };

        // Unified agent names (Task 2): commit the REST lane's pending→durable
        // name transfer BEFORE the materialized frame publishes the identity
        // (opencode persistence is verified at materialization — the SQLite
        // row exists). A missing/unwired handle leaves the frame
        // projection-less (a neutral fallback), never blocks the send.
        let naming_projection =
            bind_rest_naming_handle(&state, &pane.placeholder_id, &durable_id).await;
        let name_ref = naming_projection.as_ref().map(|(r, _)| r.clone());
        let session_name = naming_projection.map(|(_, record)| record);

        // Broadcast the placeholder→durable materialization (router.ts:1734, broadcast to
        // ALL) — emitted EXACTLY ONCE per pane, only on the send that actually materializes.
        state.broadcast(&ServerMessage::FreshAgentSessionMaterialized(
            FreshAgentSessionMaterialized {
                previous_session_id: pane.placeholder_id.clone(),
                provider: PROVIDER.to_string(),
                session_id: durable_id.clone(),
                session_type: SESSION_TYPE.to_string(),
                session_ref: Some(session_ref.clone()),
                name_ref,
                session_name,
            },
        ));

        // A durable session was persisted → sessions.changed (the original's
        // session-indexer watcher fires this on the isolated opencode.db write; we
        // surface it directly). Also once-only: subsequent turns on an already-durable
        // session don't create a new session-directory entry. SESSION-09 fix-forward:
        // routes through `broadcast_sessions_changed` so this draws from the SAME
        // shared revision sequence as `freshell-ws`'s sweep when the server wires
        // `with_shared_sessions_revision` (see that method's doc comment).
        state.broadcast_sessions_changed();

        // kata b8ke Task 3: the materialization's registration is complete —
        // commit `Live{FreshAgent}` for the minted `ses_*` key (the stamp
        // lands in the shared map: the kill/exit claim source). OpenCode
        // passes `pid: None` — the shared serve daemon is never a kill
        // handle (OpenCode invariant).
        if let Err(outcome) = ownership_lane::commit_lane_claim(
            &state.ownership,
            &state.ownership_stamps,
            Some(&state.broadcast_tx),
            PROVIDER,
            &durable_id,
            &mut own_ticket,
            &durable_id,
            None,
        ) {
            // A stale/foreign commit means the key was recovered out from
            // under us mid-materialization (watchdog) — the materialized
            // pane state above is pane-local bookkeeping (no sidecar of its
            // own to kill); reopen honestly by failing the turn.
            tracing::error!(target: "invariant",
                provider = PROVIDER, session_id = %durable_id,
                outcome = ?outcome,
                "freshagent.opencode.materialize_commit_stale: the coordinator moved on \
                 while the materialization registered"
            );
            // b8ke ext r26 F5: the typed conflict envelope — the
            // machine-readable code plus the owner the coordinator moved
            // to, when the key landed somewhere live.
            let owner_fields = state.ownership.as_ref().and_then(|ownership| {
                ownership_lane::terminal_owner_fields_from_snapshot(
                    &ownership.observe(PROVIDER, &durable_id),
                )
            });
            return fail_json_conflict_with_owner(
                "SESSION_RESERVED",
                "Session ownership changed during materialization; retry after it \
                 settles."
                    .to_string(),
                None,
                owner_fields.as_ref(),
            );
        }

        // b8ke ext r23 F1: the placeholder→durable COORDINATOR ALIAS —
        // the REST/MCP materialization creates the same resolution alias
        // the WS lane does (the pane's persisted `freshopencode-*`
        // placeholder resolves to the durable `ses_*` key through the
        // canonical chain). Best-effort (a concurrent WS-lane alias is
        // a no-op warn).
        if let Some(ownership) = state.ownership.as_ref() {
            match ownership.alias_vacant_key(
                PROVIDER,
                &pane.placeholder_id,
                &durable_id,
                // b8ke ext r33 F3: the materialization's own operation id
                // (the alias mutation's uniform-schema operation_id).
                &materialize_op,
                "freshopencode/rest-materialize",
            ) {
                freshell_ownership::CommitOutcome::Committed => {}
                other => {
                    tracing::warn!(target: "freshell_freshagent::opencode",
                        provider = PROVIDER,
                        placeholder_id = %pane.placeholder_id,
                        session_id = %durable_id,
                        outcome = ?other,
                        "freshagent.opencode.rest_placeholder_alias_refused: the \
                         placeholder alias could not be created (a concurrent lane \
                         likely already created it)"
                    );
                }
            }
        }

        durable_id
    };

    // Drive the turn: normalize model/effort (adapter.ts:80-83), send, block on the IDLE
    // edge (session.idle / session.status{idle}) surfaced by run_turn.
    let model = normalize_opencode_model(pane.model.as_deref());
    let effort = normalize_opencode_effort(pane.model.as_deref(), pane.effort.as_deref());
    let submitted_turn_id = Uuid::new_v4().to_string();

    // Unified agent names (Task 4): the shared accepted-input callback runs
    // once the provider ACCEPTED the turn (Ok or IdleTimeout — the turn was
    // accepted and drove; a hard failure never feeds). The target is the
    // pane's pre-durable handle while it is still stashed, else the durable
    // `ses_*` identity.
    let naming_target = state
        .peek_naming_handle(&pane.placeholder_id)
        .map(|handle| freshell_protocol::session_names::SessionNameRef::Pending { id: handle })
        .or_else(|| {
            (!durable_id.is_empty()).then(|| {
                freshell_protocol::session_names::SessionNameRef::Session {
                    provider: freshell_protocol::session_names::NamedProvider::Opencode,
                    session_id: durable_id.clone(),
                }
            })
        });
    let naming_mode = SESSION_TYPE.to_string();

    // b8ke focused round-3 review R3-1 + round-4 R4-2/R4-3: the REST pane
    // drive PARTICIPATES in the coordinator exactly like the WS lane's
    // turn. R4-2 makes the participation ATOMIC against lifecycle: the
    // drive holds the session's dispatch/condemn GATE across the whole
    // [retained-witness settle + registration + ownership/condemned
    // re-check + accepted-witness arming + prompt POST] critical section,
    // and every lifecycle quiesce path holds the SAME gate across its
    // [witness take + condemn] section — the interleaving is total: a
    // handoff that condemns the witness either sees the ARMED witness
    // (the POST already went out; its abort confirms the daemon-side
    // turn's death BEFORE the reap is reported) or condemned before the
    // drive's re-check (the drive refuses the dispatch with the typed
    // conflict — the handoff owns the transition). R4-3: a RETAINED
    // witness (an earlier drive's IdleTimeout — its daemon-side turn may
    // still be mutating the session) is condemned and aborted to
    // confirmed settlement BEFORE the new witness replaces it; an
    // unconfirmable settle refuses the new drive typed (the retained
    // witness stays registered — never a silently forgotten writer).
    let gate = state.rest_turn_gate(&durable_id);
    let gate_guard = gate.lock().await;
    if !state
        .settle_retained_rest_opencode_turn(&durable_id, turn_timeout)
        .await
    {
        drop(gate_guard);
        return fail_json(
            StatusCode::CONFLICT,
            "SESSION_RESERVED: a prior REST-driven turn on this session could not be \
             quiesced; retry after it settles"
                .to_string(),
        );
    }
    let turn_witness = state.register_rest_opencode_turn(&durable_id, route.clone());
    if !state.rest_turn_ownership_granted(&durable_id)
        || turn_witness.condemned.load(Ordering::SeqCst)
    {
        tracing::warn!(target: "freshell_freshagent::opencode",
            provider = PROVIDER, session_id = %durable_id,
            condemned = turn_witness.condemned.load(Ordering::SeqCst),
            "freshagent.opencode.rest_turn_dispatch_refused: the coordinator owns \
             this session's transition — the REST turn is not dispatched"
        );
        state.remove_rest_opencode_turn(&durable_id, &turn_witness);
        drop(gate_guard);
        return fail_json(
            StatusCode::CONFLICT,
            "SESSION_RESERVED: another lifecycle operation owns this session".to_string(),
        );
    }

    // Subscribe BEFORE prompting so the idle edge cannot be missed
    // (run_turn's own ordering), then issue the prompt POST UNDER the
    // gate: the accepted-turn witness arms at the POST's DISPATCH
    // boundary (the same seam the WS lane's turns use), so a handoff
    // finding it armed aborts the daemon-side turn before reporting the
    // reap.
    #[cfg(test)]
    {
        // R4-2's test seam: park at the exact interleaving point under
        // review (after the gate-held re-check, before the POST). The
        // guard is scoped to the block so no std lock lives across the
        // await (Send).
        let pause = state
            .rest_turn_test_pause
            .lock()
            .expect("rest_turn_test_pause mutex")
            .clone();
        if let Some(pause) = pause {
            pause.notified().await;
        }
    }
    let rx = manager.subscribe(&durable_id);
    let body = build_opencode_prompt_body(&text, model.as_deref(), effort.as_deref());
    let accepted = Arc::clone(&turn_witness.daemon_turn_accepted);
    let prompt = manager
        .prompt_async(&durable_id, body, &route, Some(accepted), None)
        .await;
    // The gate section ends with the POST: from here the witness is
    // either armed-and-registered (the quiesce paths see it) or the
    // prompt failed before dispatch.
    drop(gate_guard);

    let drive_result = match prompt {
        Ok(()) => {
            manager
                .await_idle(&durable_id, rx, turn_timeout, route)
                .await
        }
        Err(err) => Err(err),
    };
    match drive_result {
        Ok(()) => {
            // The idle edge was observed (or the daemon itself is gone —
            // nothing runs daemon-side): the accepted turn is settled.
            state.settle_rest_opencode_turn(&durable_id, &turn_witness, true);
            // Unified agent names (Task 4): the provider accepted the turn —
            // feed the shared accepted-input callback.
            if let Some(target) = naming_target {
                naming::report_accepted_input(
                    &state.naming(),
                    &target,
                    &naming_mode,
                    &submitted_turn_id,
                    &text,
                    pane.cwd.as_deref(),
                )
                .await;
            }
            ok_json(
                json!({
                    "paneId": pane_id,
                    "sessionId": durable_id,
                    "submittedTurnId": submitted_turn_id,
                    "sessionRef": { "provider": PROVIDER, "sessionId": durable_id },
                    "status": "idle",
                }),
                "prompt sent",
            )
        }
        // Idle deadline missed → approx (the turn was accepted; it just did not idle in time).
        // The witness STAYS armed and registered — the daemon-side turn
        // still runs and a lifecycle stop must still abort it.
        Err(ServeError::IdleTimeout { .. }) => {
            state.settle_rest_opencode_turn(&durable_id, &turn_witness, false);
            // Unified agent names (Task 4): the provider accepted the turn —
            // feed the shared accepted-input callback.
            if let Some(target) = naming_target {
                naming::report_accepted_input(
                    &state.naming(),
                    &target,
                    &naming_mode,
                    &submitted_turn_id,
                    &text,
                    pane.cwd.as_deref(),
                )
                .await;
            }
            approx_json(
                json!({
                    "paneId": pane_id,
                    "sessionId": durable_id,
                    "submittedTurnId": submitted_turn_id,
                    "sessionRef": { "provider": PROVIDER, "sessionId": durable_id },
                    "status": "approx",
                }),
                "prompt sent; turn did not complete within deadline",
            )
        }
        // Ambiguous errors keep the witness armed (fail closed: the stop
        // path would rather issue one redundant abort than miss a live
        // daemon-side writer).
        Err(err) => {
            state.settle_rest_opencode_turn(&durable_id, &turn_witness, false);
            fail_json(serve_error_status(&err), err.to_string())
        }
    }
}

/// A `timeout` value in seconds (number or numeric string), clamped ≥ 0.
fn value_as_secs(value: &Value) -> Option<u64> {
    match value {
        Value::Number(n) => n
            .as_f64()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f as u64),
        Value::String(s) => s
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|f| f.is_finite() && *f >= 0.0)
            .map(|f| f as u64),
        _ => None,
    }
}

// ── GET /api/panes/:id/capture (render transcript) ───────────────────────────────

async fn capture(
    State(state): State<FreshAgentState>,
    Path(pane_id): Path<String>,
    headers: HeaderMap,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }

    // Slice 1 (docs/plans/2026-07-18-agent-api-mcp-parity-spec.md \u00a72.2): terminal
    // and content (browser/editor) panes are DISJOINT maps from the fresh-agent
    // `panes` map below -- checked first, falling through unchanged otherwise.
    if let Some(resp) = terminal_tabs::maybe_capture(&state, &pane_id, &params) {
        return resp;
    }

    let pane = match pane_entry_for_request(&state, &pane_id) {
        Some(pane) => pane,
        None => {
            // Layout-only panes (e.g. a legacy `agent-chat` pane normalized to
            // `fresh-agent` by a remote client's layout sync): mirror the Node
            // capture route's pane-kind gate (router.ts:955-959) — every
            // non-terminal layout kind answers the 422 validation wording the
            // `content_panes` branch in terminal_tabs.rs already emits, rather
            // than falling through to an unhandled 500 (Node, pre-fix) or a
            // misleading 404. Runtime-backed fresh-agent panes resolved above;
            // layout-visible terminal kinds and unknown ids keep 404
            // `pane not found`.
            if let Some(snap) = state.layout.get_pane_snapshot(&pane_id) {
                if let Some(kind) = snap.kind.as_deref().filter(|k| *k != "terminal") {
                    return fail_json(
                        StatusCode::UNPROCESSABLE_ENTITY,
                        format!(
                            "pane kind \"{kind}\" does not support capture-pane; use screenshot-pane"
                        ),
                    );
                }
            }
            return fail_json(StatusCode::NOT_FOUND, "pane not found".to_string());
        }
    };
    if let Some(gateway) = state.hosted_rest_gateway() {
        let session_id = pane
            .durable_id
            .clone()
            .unwrap_or_else(|| pane.placeholder_id.clone());
        let max_bytes = params
            .get("maxBytes")
            .and_then(|value| value.parse::<usize>().ok())
            .unwrap_or(256 * 1024)
            .clamp(1, 256 * 1024);
        return match gateway
            .capture(hosted_rest::HostedRestCapture {
                session_id,
                provider: pane.provider.clone(),
                session_type: pane.session_type.clone(),
                max_bytes,
            })
            .await
        {
            Ok(capture) => text_plain(capture.text),
            Err(hosted_rest::HostedRestCaptureError::Unsupported) => fail_json(
                StatusCode::UNPROCESSABLE_ENTITY,
                "hosted fresh-agent provider does not support transcript capture".to_string(),
            ),
            Err(hosted_rest::HostedRestCaptureError::Unavailable) => fail_json(
                StatusCode::SERVICE_UNAVAILABLE,
                "hosted fresh-agent transcript is temporarily unavailable".to_string(),
            ),
        };
    }
    let Some(durable_id) = pane.durable_id else {
        // No turn yet → empty transcript (text/plain), matching a fresh pane.
        return text_plain(String::new());
    };

    let manager = { state.opencode.lock().await.clone() };
    let Some(manager) = manager else {
        return text_plain(String::new());
    };

    match manager.list_messages(&durable_id, &pane.cwd).await {
        Ok(messages) => text_plain(render_transcript(&messages)),
        Err(err) => fail_json(serve_error_status(&err), err.to_string()),
    }
}

fn text_plain(body: String) -> Response {
    (
        StatusCode::OK,
        [("content-type", "text/plain; charset=utf-8")],
        body,
    )
        .into_response()
}

/// Render an opencode message page to plain text: collect every `{type:'text', text}`
/// part's text (the transcript's assistant + user turns), joined by newlines. Robust to
/// the exact message/part envelope (walks the tree). Falls back to the raw JSON so the
/// oracle's `captureNonEmpty` never trips on an unexpected shape.
fn render_transcript(value: &Value) -> String {
    let mut out: Vec<String> = Vec::new();
    collect_text_parts(value, &mut out);
    if out.is_empty() {
        // Non-empty guarantee: a shape we did not recognise still yields the raw body.
        return value.to_string();
    }
    out.join("\n")
}

fn collect_text_parts(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            let is_text_part = map.get("type").and_then(Value::as_str) == Some("text");
            if is_text_part {
                if let Some(text) = map.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        out.push(text.to_string());
                    }
                }
            }
            for child in map.values() {
                collect_text_parts(child, out);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_text_parts(item, out);
            }
        }
        _ => {}
    }
}

// ── freshAgent.create requestId dedup (provider-generic) ───────────────────────────

/// Default bound for [`FreshAgentCreateDedup`]'s completed-create cache. Legacy's
/// `createdFreshAgentByRequestId` (`server/ws-handler.ts:569`) has NO size bound at
/// all -- entries live until `freshAgent.kill` clears them
/// (`clearFreshAgentCreateCachesForSession`, `ws-handler.ts:1044-1050`, called only
/// from `ws-handler.ts:3673`) or the process shuts down (`ws-handler.ts:3907`). This
/// cap is a Rust-port addition BEYOND legacy parity: a long-lived server process that
/// never restarts would otherwise grow this cache forever. 512 is generous relative to
/// any realistic number of concurrently-`creating` panes.
pub const DEFAULT_FRESH_AGENT_CREATE_DEDUP_CAP: usize = 512;

/// Provider-generic single-flight + replay cache for `freshAgent.create`, keyed by
/// `requestId`. A faithful port of legacy's `freshAgentCreateLocks` +
/// `createdFreshAgentByRequestId` (`server/ws-handler.ts:568-569`, `1027-1050`,
/// `3359-3425`) -- reusable across every fresh-agent provider (codex/claude/opencode),
/// since the requestId-dedup problem it solves (the frozen client resends
/// `freshAgent.create` with the SAME `requestId` on every reconnect while a pane is
/// `status==creating`, `FreshAgentView.tsx`) is provider-agnostic.
///
/// Semantics:
/// - **Single-flight**: concurrent `create`s sharing a `requestId` serialize --
///   [`Self::acquire_or_replay`] blocks a second caller on the SAME key until the first
///   finishes (its [`FreshAgentCreateGuard`] drops), then re-checks the cache before
///   letting a genuinely new attempt proceed. Mirrors `withFreshAgentCreateLock`'s
///   promise-chain-per-key (`ws-handler.ts:1027-1042`).
/// - **Replay cache**: a completed create is cached by `requestId`
///   ([`Self::record_success`]), so a REPLAYED `create` reattaches to the SAME session
///   instead of minting a new one -- until [`Self::clear_for_session`] evicts it.
/// - **Failures are never cached**: mirrors legacy (the `catch` branch,
///   `ws-handler.ts:3443-3460`, never populates `createdFreshAgentByRequestId`) -- a
///   later retry with the same `requestId` genuinely re-attempts creation. A caller
///   that receives [`FreshAgentCreateOutcome::Proceed`] and does NOT call
///   `record_success` (i.e. the attempt failed) simply drops the guard; the next
///   attempt for that `requestId` finds no cache entry and proceeds fresh.
/// - **A session that exits on its own is NOT evicted**: legacy calls
///   `clearFreshAgentCreateCachesForSession` ONLY from the `freshAgent.kill` handler
///   (`ws-handler.ts:3673`) -- an UNREQUESTED sidecar exit has no such hook. A replay
///   after a natural/crash exit therefore re-serves the dead session's id, matching
///   legacy behavior exactly rather than "helpfully" recreating. Callers must invoke
///   [`Self::clear_for_session`] explicitly on an EXPLICIT kill, mirroring
///   `ws-handler.ts:3673`, and must NOT invoke it on an unrequested exit.
/// - **Bounded** (oldest-first eviction of entries whose per-key lock is provably
///   unused, i.e. no in-flight creation still holds it): a Rust-port addition beyond
///   legacy parity -- see [`DEFAULT_FRESH_AGENT_CREATE_DEDUP_CAP`].
pub struct FreshAgentCreateDedup<T: Clone + Send + 'static> {
    inner: tokio::sync::Mutex<FreshAgentCreateDedupInner<T>>,
    cap: usize,
}

struct FreshAgentCreateDedupInner<T> {
    /// requestId -> completed create record (the replay cache).
    cache: HashMap<String, T>,
    /// Insertion order of `cache` keys, oldest first, for bounded FIFO eviction.
    cache_order: std::collections::VecDeque<String>,
    /// requestId -> per-key single-flight lock. An entry exists for the lifetime of
    /// every requestId this process has ever seen a `create` for, until opportunistic
    /// eviction (see [`FreshAgentCreateDedupInner::evict_if_over_cap`]) reclaims it.
    inflight: HashMap<String, Arc<tokio::sync::Mutex<()>>>,
}

impl<T> FreshAgentCreateDedupInner<T> {
    /// Reclaim `inflight` entries once the table grows past `cap`, but ONLY entries
    /// whose lock nobody currently holds (`Arc::strong_count(..) <= 1`, i.e. only this
    /// map's own reference remains) -- never evict a lock an in-flight creation (or a
    /// waiting duplicate) still references, which would break single-flight
    /// serialization for that requestId.
    fn evict_if_over_cap(&mut self, cap: usize) {
        if self.inflight.len() <= cap {
            return;
        }
        let stale: Vec<String> = self
            .inflight
            .iter()
            .filter(|(_, lock)| Arc::strong_count(lock) <= 1)
            .map(|(key, _)| key.clone())
            .take(self.inflight.len() - cap)
            .collect();
        for key in stale {
            self.inflight.remove(&key);
        }
    }
}

/// The outcome of [`FreshAgentCreateDedup::acquire_or_replay`].
pub enum FreshAgentCreateOutcome<T> {
    /// A completed create already exists for this `requestId` -- replay it verbatim
    /// (e.g. re-broadcast `freshAgent.created` with the cached sessionId); do NOT spawn
    /// a second session.
    Replay(T),
    /// This caller won the single-flight race for this `requestId`: proceed with the
    /// real creation. Hold the returned guard for the ENTIRE creation attempt
    /// (including any resume/retry sub-calls) so concurrent duplicate `create`s keep
    /// serializing against it; it releases automatically when dropped. On success, call
    /// [`FreshAgentCreateDedup::record_success`] with the same `requestId` before the
    /// guard drops -- the guard itself caches nothing (failures must never be cached).
    Proceed(FreshAgentCreateGuard),
}

/// Holds the per-`requestId` single-flight lock for the duration of one `create`
/// attempt. Dropping it (including via an early `return` on any failure path) releases
/// the lock so a queued duplicate (or a fresh retry) can proceed.
pub struct FreshAgentCreateGuard {
    _permit: tokio::sync::OwnedMutexGuard<()>,
}

/// A clone-shared per-key single-flight registry for one-shot runtime operations
/// (delta-review round 2, D2-F2: `freshAgent.fork` duplicate-click suppression on
/// BOTH the codex and opencode arms). [`Self::try_acquire`] inserts the key and
/// hands back an RAII guard; a second acquisition for the SAME key while the guard
/// is held answers `None` so the caller can refuse loudly. The guard's `Drop`
/// removes the key, so EVERY handler exit path — success, refusal, and the codex
/// post-archive containment alike — releases it: no leg can strand the key.
///
/// [`Self::try_acquire_pair`] (delta-review round 3) inserts up to TWO keys
/// atomically under the same map lock: the codex fork guard must cover the
/// RESOLVED parent id across the mint-new respawn re-key (the materialized
/// broadcast re-keys the pane mid-flight, so the duplicate click arrives addressed
/// to a DIFFERENT id than the one clicked) while still holding the clicked id.
/// Neither key is inserted unless both are free, and the guard releases both in a
/// single lock acquisition — there is no partial state a racing click could slip
/// through.
///
/// The critical sections are tiny `HashSet` ops, never held across `.await`, so a
/// plain std mutex suffices (the crate's existing `Arc<Mutex<…>>`-in-std pattern,
/// e.g. `ClaudeSession.pending`).
#[derive(Clone, Default)]
pub(crate) struct InFlightRegistry {
    keys: Arc<Mutex<HashSet<String>>>,
}

impl InFlightRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Insert `key`; `None` when an operation for this key is already in flight.
    /// The returned guard removes the key on drop.
    pub(crate) fn try_acquire(&self, key: &str) -> Option<InFlightGuard> {
        self.try_acquire_all(&[key])
    }

    /// Insert BOTH keys atomically under one map lock; `None` when an operation for
    /// EITHER key is already in flight (a partial acquisition would leak the
    /// unguarded key space entirely). The returned guard removes both on drop, also
    /// under one lock. `first`-equals-`second` degrades to the single-key shape.
    pub(crate) fn try_acquire_pair(&self, first: &str, second: &str) -> Option<InFlightGuard> {
        self.try_acquire_all(&[first, second])
    }

    fn try_acquire_all(&self, keys: &[&str]) -> Option<InFlightGuard> {
        let mut held: Vec<String> = Vec::with_capacity(keys.len());
        for key in keys {
            if !held.iter().any(|h| h == key) {
                held.push((*key).to_string());
            }
        }
        let mut guard = self.keys.lock().expect("in-flight registry lock");
        if held.iter().any(|key| guard.contains(key)) {
            return None;
        }
        guard.extend(held.iter().cloned());
        Some(InFlightGuard {
            keys: Arc::clone(&self.keys),
            held,
        })
    }

    /// Snapshot membership check — never an acquisition. Claude's `handle_send`
    /// parks while a rollback names this durable id (kata 1wxv task 4 review C1):
    /// a session-map resolve miss inside the rollback's teardown→respawn window
    /// must WAIT for the re-insert, never refuse with SESSION_NOT_FOUND.
    pub(crate) fn contains(&self, key: &str) -> bool {
        self.keys
            .lock()
            .expect("in-flight registry lock")
            .contains(key)
    }
}

/// RAII release for an [`InFlightRegistry`] acquisition: removes its held key(s)
/// when the driving handler returns, on every terminal path.
pub(crate) struct InFlightGuard {
    keys: Arc<Mutex<HashSet<String>>>,
    held: Vec<String>,
}

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        let mut keys = self.keys.lock().expect("in-flight registry lock");
        for key in &self.held {
            keys.remove(key);
        }
    }
}

#[cfg(test)]
mod in_flight_registry_tests {
    use super::*;

    #[test]
    fn contains_tracks_acquire_and_drop_without_acquiring() {
        let registry = InFlightRegistry::new();
        assert!(!registry.contains("dur-1"));
        let guard = registry.try_acquire("dur-1").expect("first acquire");
        assert!(registry.contains("dur-1"));
        // contains is a snapshot, NOT an acquisition: a second try_acquire still
        // refuses (single-flight) while contains never blocks.
        assert!(registry.try_acquire("dur-1").is_none());
        assert!(registry.contains("dur-1"));
        drop(guard);
        assert!(!registry.contains("dur-1"));
    }
}

/// RAII holder for a claimed fresh-agent session lease (Task 12, mirror of
/// `SessionRefLeaseGuard` in `freshell-ws/src/terminal.rs`). `Drop` calls `fail()` ONLY
/// while armed AND no kill handle was recorded: once a live child exists (kill handle
/// set), a panic between `set_kill_handle` and `complete` must never release un-killed —
/// the lease stays held (TTL + tree-kill is the recovery path).
pub struct FreshSessionLeaseGuard {
    leases: Arc<session_lease::FreshAgentSessionLeases>,
    provider: &'static str,
    session_id: String,
    request_id: String,
    armed: bool,
    kill_handle_set: bool,
    kill_handle_ownership_id: Option<String>,
}

impl FreshSessionLeaseGuard {
    /// Wrap a just-acquired claim ([`session_lease::FreshSessionClaim::Acquired`]).
    pub fn armed(
        leases: Arc<session_lease::FreshAgentSessionLeases>,
        provider: &'static str,
        session_id: &str,
        request_id: &str,
    ) -> Self {
        Self {
            leases,
            provider,
            session_id: session_id.to_string(),
            request_id: request_id.to_string(),
            armed: true,
            kill_handle_set: false,
            kill_handle_ownership_id: None,
        }
    }

    /// Record the spawned sidecar's pid + ownership tag on the lease (arms the
    /// TTL tree-kill path).
    pub fn set_kill_handle(&mut self, pid: u32, ownership_id: &str) {
        self.leases.set_kill_handle(
            self.provider,
            &self.session_id,
            &self.request_id,
            pid,
            ownership_id,
        );
        self.kill_handle_set = true;
        self.kill_handle_ownership_id = Some(ownership_id.to_string());
    }

    /// Winner registered its session: bind + release in one lock scope. Returns `false`
    /// when the lease was revoked/foreign — the caller must tear down its own child and
    /// then call [`Self::fail`] (the guard stays armed).
    pub fn complete(&mut self, live_session_key: &str) -> bool {
        let ok = self.leases.complete_with_identity(
            self.provider,
            &self.session_id,
            &self.request_id,
            live_session_key,
            self.kill_handle_ownership_id.as_deref(),
        );
        if ok {
            self.armed = false;
        }
        ok
    }

    /// Spawn/resume failed AND the caller's own tree is (being) torn down: release.
    pub fn fail(&mut self) {
        if self.armed {
            self.leases
                .fail(self.provider, &self.session_id, &self.request_id);
            self.armed = false;
        }
    }
}

impl Drop for FreshSessionLeaseGuard {
    fn drop(&mut self) {
        if self.armed && !self.kill_handle_set {
            self.leases
                .fail(self.provider, &self.session_id, &self.request_id);
        } else if self.armed {
            // A live child may exist (kill handle set) — never blanket-release; the
            // TTL + tree-kill path recovers this lease.
            tracing::warn!(
                provider = self.provider,
                session_id = %self.session_id,
                "fresh_agent_lease_guard_dropped_armed_with_kill_handle: holding for TTL recovery"
            );
        }
    }
}

impl<T: Clone + Send + 'static> Default for FreshAgentCreateDedup<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: Clone + Send + 'static> FreshAgentCreateDedup<T> {
    /// Build a dedup engine with [`DEFAULT_FRESH_AGENT_CREATE_DEDUP_CAP`].
    pub fn new() -> Self {
        Self::with_cap(DEFAULT_FRESH_AGENT_CREATE_DEDUP_CAP)
    }

    /// Build a dedup engine with an explicit cap (tests use a small one).
    pub fn with_cap(cap: usize) -> Self {
        Self {
            inner: tokio::sync::Mutex::new(FreshAgentCreateDedupInner {
                cache: HashMap::new(),
                cache_order: std::collections::VecDeque::new(),
                inflight: HashMap::new(),
            }),
            cap,
        }
    }

    /// Single-flight-acquire (or replay) a `create` for `request_id`. See the type-level
    /// doc for full semantics.
    pub async fn acquire_or_replay(&self, request_id: &str) -> FreshAgentCreateOutcome<T> {
        loop {
            let key_lock = {
                let mut inner = self.inner.lock().await;
                if let Some(hit) = inner.cache.get(request_id) {
                    return FreshAgentCreateOutcome::Replay(hit.clone());
                }
                let lock = inner
                    .inflight
                    .entry(request_id.to_string())
                    .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
                    .clone();
                inner.evict_if_over_cap(self.cap);
                lock
            };

            let permit = key_lock.lock_owned().await;

            // Re-check under the per-key permit: another caller may have completed
            // (and cached) while we were waiting for the lock.
            let inner = self.inner.lock().await;
            if inner.cache.contains_key(request_id) {
                drop(inner);
                drop(permit);
                continue;
            }
            drop(inner);
            return FreshAgentCreateOutcome::Proceed(FreshAgentCreateGuard { _permit: permit });
        }
    }

    /// Cache a completed create's result under `request_id` (bounded FIFO eviction of
    /// the oldest cache entry once over `cap`). Call this ONLY on success -- legacy
    /// never caches a failed create.
    pub async fn record_success(&self, request_id: &str, value: T) {
        let mut inner = self.inner.lock().await;
        if !inner.cache.contains_key(request_id) {
            inner.cache_order.push_back(request_id.to_string());
        }
        inner.cache.insert(request_id.to_string(), value);
        while inner.cache.len() > self.cap {
            match inner.cache_order.pop_front() {
                Some(oldest) => {
                    inner.cache.remove(&oldest);
                }
                None => break,
            }
        }
    }

    /// Evict every cache entry whose value matches `predicate` (e.g. `|r| r.session_id
    /// == killed_id`). Mirrors `clearFreshAgentCreateCachesForSession`
    /// (`ws-handler.ts:1044-1050`) -- call this ONLY from an explicit kill path, never
    /// from an unrequested-exit path (see the type-level doc).
    pub async fn clear_for_session(&self, predicate: impl Fn(&T) -> bool) {
        let mut inner = self.inner.lock().await;
        let stale: Vec<String> = inner
            .cache
            .iter()
            .filter(|(_, value)| predicate(value))
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            inner.cache.remove(&key);
            if let Some(pos) = inner.cache_order.iter().position(|k| k == &key) {
                inner.cache_order.remove(pos);
            }
        }
    }
}

#[cfg(test)]
mod fresh_agent_create_dedup_tests {
    use super::*;

    #[derive(Clone, Debug, PartialEq)]
    struct Rec(String);

    #[tokio::test]
    async fn sequential_duplicate_request_id_replays_the_cached_value() {
        let dedup: FreshAgentCreateDedup<Rec> = FreshAgentCreateDedup::new();

        match dedup.acquire_or_replay("req-1").await {
            FreshAgentCreateOutcome::Proceed(_guard) => {
                dedup
                    .record_success("req-1", Rec("session-a".to_string()))
                    .await;
            }
            FreshAgentCreateOutcome::Replay(_) => panic!("first call must not replay"),
        }

        match dedup.acquire_or_replay("req-1").await {
            FreshAgentCreateOutcome::Replay(rec) => {
                assert_eq!(rec, Rec("session-a".to_string()));
            }
            FreshAgentCreateOutcome::Proceed(_) => {
                panic!("duplicate requestId must replay, not proceed to create again")
            }
        }
    }

    #[tokio::test]
    async fn distinct_request_ids_never_replay_each_other() {
        let dedup: FreshAgentCreateDedup<Rec> = FreshAgentCreateDedup::new();

        for (req, session) in [("req-a", "session-a"), ("req-b", "session-b")] {
            match dedup.acquire_or_replay(req).await {
                FreshAgentCreateOutcome::Proceed(_guard) => {
                    dedup.record_success(req, Rec(session.to_string())).await;
                }
                FreshAgentCreateOutcome::Replay(_) => {
                    panic!("distinct requestId must never replay another's cache entry")
                }
            }
        }
    }

    #[tokio::test]
    async fn concurrent_duplicate_request_id_serializes_and_both_see_the_same_value() {
        let dedup: Arc<FreshAgentCreateDedup<Rec>> = Arc::new(FreshAgentCreateDedup::new());
        let barrier = Arc::new(tokio::sync::Barrier::new(2));

        let run = |dedup: Arc<FreshAgentCreateDedup<Rec>>, barrier: Arc<tokio::sync::Barrier>| async move {
            barrier.wait().await;
            match dedup.acquire_or_replay("req-race").await {
                FreshAgentCreateOutcome::Proceed(_guard) => {
                    // Simulate real creation work, widening the race window so the
                    // second task's `acquire_or_replay` is genuinely blocked on the
                    // first's guard rather than winning outright.
                    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                    dedup
                        .record_success("req-race", Rec("session-race".to_string()))
                        .await;
                    Rec("session-race".to_string())
                }
                FreshAgentCreateOutcome::Replay(rec) => rec,
            }
        };

        let (a, b) = tokio::join!(
            run(dedup.clone(), barrier.clone()),
            run(dedup.clone(), barrier.clone()),
        );

        assert_eq!(a, Rec("session-race".to_string()));
        assert_eq!(b, Rec("session-race".to_string()));
    }

    #[tokio::test]
    async fn clear_for_session_evicts_matching_entries_so_a_later_duplicate_recreates() {
        let dedup: FreshAgentCreateDedup<Rec> = FreshAgentCreateDedup::new();

        match dedup.acquire_or_replay("req-1").await {
            FreshAgentCreateOutcome::Proceed(_guard) => {
                dedup
                    .record_success("req-1", Rec("session-a".to_string()))
                    .await;
            }
            FreshAgentCreateOutcome::Replay(_) => panic!("first call must not replay"),
        }

        dedup.clear_for_session(|rec| rec.0 == "session-a").await;

        match dedup.acquire_or_replay("req-1").await {
            FreshAgentCreateOutcome::Proceed(_guard) => {
                // Expected: the explicit-kill eviction means a later duplicate
                // genuinely re-creates instead of replaying the killed session.
            }
            FreshAgentCreateOutcome::Replay(_) => {
                panic!("cache entry must be gone after clear_for_session matched it")
            }
        }
    }

    #[tokio::test]
    async fn bounded_cache_evicts_the_oldest_entry_past_cap() {
        let dedup: FreshAgentCreateDedup<Rec> = FreshAgentCreateDedup::with_cap(2);

        for req in ["req-1", "req-2", "req-3"] {
            match dedup.acquire_or_replay(req).await {
                FreshAgentCreateOutcome::Proceed(_guard) => {
                    dedup
                        .record_success(req, Rec(format!("session-{req}")))
                        .await;
                }
                FreshAgentCreateOutcome::Replay(_) => panic!("{req} must not replay"),
            }
        }

        // req-1 was the oldest of 3 entries against a cap of 2 -- evicted, so a
        // duplicate for it must now genuinely re-create (Proceed), not replay.
        match dedup.acquire_or_replay("req-1").await {
            FreshAgentCreateOutcome::Proceed(_guard) => {}
            FreshAgentCreateOutcome::Replay(_) => {
                panic!("req-1 should have been evicted past the cap of 2")
            }
        }

        // req-3 (most recent) must still replay.
        match dedup.acquire_or_replay("req-3").await {
            FreshAgentCreateOutcome::Replay(rec) => {
                assert_eq!(rec, Rec("session-req-3".to_string()))
            }
            FreshAgentCreateOutcome::Proceed(_) => {
                panic!("req-3 must still be cached (most recent, within cap)")
            }
        }
    }
}

#[cfg(test)]
mod spawn_gate_seam_tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    fn bare_state() -> FreshAgentState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
    }

    #[test]
    fn unwired_state_has_no_spawn_gate() {
        assert!(bare_state().spawn_gate().is_none());
    }

    /// Boot-assertion seam (council enn3 follow-up): the OnceLock is a
    /// fail-OPEN seam — an unwired gate silently ungates every REST create.
    /// `spawn_gate_wired` is the public probe `freshell-server` asserts at
    /// startup so a wiring regression fails LOUD at boot.
    #[test]
    fn spawn_gate_wired_reflects_oncelock_state() {
        let state = bare_state();
        assert!(!state.spawn_gate_wired(), "bare state must report unwired");
        state.set_spawn_gate(
            Arc::new(crate::spawn_gate::SpawnGate::new(4, 64)),
            Duration::from_millis(100),
        );
        assert!(state.spawn_gate_wired(), "wired state must report wired");
    }

    #[test]
    fn set_spawn_gate_is_visible_to_every_clone_and_set_once() {
        let state = bare_state();
        let clone_taken_before_set = state.clone();
        let gate = Arc::new(crate::spawn_gate::SpawnGate::new(4, 64));
        state.set_spawn_gate(Arc::clone(&gate), Duration::from_millis(1234));

        // Clones share the Arc<OnceLock>, so even a clone taken BEFORE the
        // set observes the wiring (the ledger-injection property).
        let wired = clone_taken_before_set.spawn_gate().expect("wired");
        assert!(Arc::ptr_eq(&wired.gate, &gate), "same gate instance");
        assert_eq!(wired.timeout, Duration::from_millis(1234));

        // Second set is ignored (OnceLock).
        let other = Arc::new(crate::spawn_gate::SpawnGate::new(1, 1));
        state.set_spawn_gate(other, Duration::from_millis(1));
        let still = state.spawn_gate().expect("still wired");
        assert!(Arc::ptr_eq(&still.gate, &gate), "first wiring wins");
    }
}

#[cfg(test)]
mod ownership_watch_tests {
    use super::ownership_lane::{OwnershipStamp, OwnershipWatch};
    use freshell_ownership::{BeginOutcome, CommitOutcome, OwnerIdentity, RuntimeOwnerKind};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    #[test]
    fn stale_watcher_keeps_the_replacement_stamp_and_owner() {
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let stamps = Arc::new(Mutex::new(HashMap::new()));
        let session_id = "codex-watch-replacement";
        let old_owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some(session_id.to_string()),
            pid: Some(101),
            ownership_id: Some("op-old".to_string()),
            unit_id: None,
            hold: freshell_ownership::HoldKind::Main,
        };
        let BeginOutcome::Granted { generation } = registry.begin_start(
            "codex",
            session_id,
            RuntimeOwnerKind::FreshAgent,
            "op-old",
            None,
            "test",
            1,
        ) else {
            panic!("old claim must grant")
        };
        assert_eq!(
            registry.commit_live("codex", session_id, "op-old", generation, old_owner.clone()),
            CommitOutcome::Committed
        );
        stamps.lock().unwrap().insert(
            session_id.to_string(),
            OwnershipStamp {
                epoch: registry.boot_epoch(),
                generation,
                operation_id: "op-old".to_string(),
                owner: old_owner.clone(),
            },
        );

        let BeginOutcome::AdoptLive { .. } = registry.begin_start(
            "codex",
            session_id,
            RuntimeOwnerKind::FreshAgent,
            "op-adopt-check",
            None,
            "test",
            2,
        ) else {
            // The old owner is deliberately transitioned through the normal
            // stop path below; this arm only documents that a live owner
            // cannot be replaced without first settling it.
            panic!("the live old owner must be adopt-only")
        };
        let stop_gen = match registry.begin_stop(
            "codex",
            session_id,
            "op-stop",
            &freshell_ownership::StopClaim {
                expected_kind: RuntimeOwnerKind::FreshAgent,
                expected_runtime: Some(old_owner.clone()),
                observed: freshell_ownership::ObservedFence {
                    epoch: registry.boot_epoch(),
                    generation,
                },
            },
            "test",
            3,
        ) {
            freshell_ownership::StopOutcome::Granted { generation } => generation,
            other => panic!("old stop must grant: {other:?}"),
        };
        assert_eq!(
            registry.commit_stop("codex", session_id, "op-stop", stop_gen),
            CommitOutcome::Committed
        );

        let BeginOutcome::Granted {
            generation: new_generation,
        } = registry.begin_start(
            "codex",
            session_id,
            RuntimeOwnerKind::FreshAgent,
            "op-new",
            None,
            "test",
            4,
        )
        else {
            panic!("replacement claim must grant")
        };
        let new_owner = OwnerIdentity {
            pid: Some(202),
            ownership_id: Some("op-new".to_string()),
            ..old_owner.clone()
        };
        assert_eq!(
            registry.commit_live(
                "codex",
                session_id,
                "op-new",
                new_generation,
                new_owner.clone(),
            ),
            CommitOutcome::Committed
        );
        stamps.lock().unwrap().insert(
            session_id.to_string(),
            OwnershipStamp {
                epoch: registry.boot_epoch(),
                generation: new_generation,
                operation_id: "op-new".to_string(),
                owner: new_owner,
            },
        );

        OwnershipWatch::new(Arc::clone(&registry), Arc::clone(&stamps), "codex")
            .for_runtime(session_id, Some(101))
            .release(session_id, "stale-watcher");

        assert_eq!(
            stamps.lock().unwrap().get(session_id).unwrap().operation_id,
            "op-new"
        );
        assert!(matches!(
            registry.observe("codex", session_id).state,
            freshell_ownership::OwnershipState::Live { owner, .. } if owner.pid == Some(202)
        ));
    }

    #[test]
    fn natural_unconfirmed_exit_has_a_typed_fence_and_confirmed_release() {
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let stamps = Arc::new(Mutex::new(HashMap::new()));
        let session_id = "codex-watch-fenced";
        let owner = OwnerIdentity {
            kind: RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some(session_id.to_string()),
            pid: Some(303),
            ownership_id: Some("op-fenced".to_string()),
            unit_id: None,
            hold: freshell_ownership::HoldKind::Main,
        };
        let BeginOutcome::Granted { generation } = registry.begin_start(
            "codex",
            session_id,
            RuntimeOwnerKind::FreshAgent,
            "op-fenced",
            None,
            "test",
            1,
        ) else {
            panic!("claim must grant")
        };
        assert_eq!(
            registry.commit_live("codex", session_id, "op-fenced", generation, owner.clone()),
            CommitOutcome::Committed
        );
        stamps.lock().unwrap().insert(
            session_id.to_string(),
            OwnershipStamp {
                epoch: registry.boot_epoch(),
                generation,
                operation_id: "op-fenced".to_string(),
                owner,
            },
        );
        let watch = OwnershipWatch::new(Arc::clone(&registry), Arc::clone(&stamps), "codex")
            .for_runtime(session_id, Some(303));
        assert_eq!(
            watch.fence_unconfirmed(session_id, freshell_ownership::FenceReason::WatcherFailed,),
            freshell_ownership::FenceOutcome::Fenced
        );
        assert!(matches!(
            registry.observe("codex", session_id).state,
            freshell_ownership::OwnershipState::Fenced { .. }
        ));
        watch.release_confirmed(session_id, "confirmed-recovery");
        assert!(matches!(
            registry.observe("codex", session_id).state,
            freshell_ownership::OwnershipState::Vacant
        ));
        assert!(stamps.lock().unwrap().get(session_id).is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ownership_lane::OwnershipStamps;

    fn state() -> FreshAgentState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
    }

    /// b8ke ext r29 F1: the structural commit-to-Live broadcast invariant —
    /// [`ownership_lane::commit_lane_claim`] emits the authoritative
    /// `session.runtimeOwner` owner record (kind + epoch + generation, the
    /// ticket's committed operation id, transition `handoff-committed`)
    /// whenever a bus is supplied, so EVERY lane that commits Live (codex
    /// create/fork/respawn/resume, opencode mint/materialization/fork/
    /// attach/resume, claude create-resume/attach) broadcasts it —
    /// cross-device observers hold the observed fence from creation
    /// onward and `selectPaneOwnerFence` resolves immediately, never
    /// undefined-until-a-reconnect. A lane with no bus (`None`) still
    /// commits (the broadcast is additive, never load-bearing).
    #[test]
    fn a_committed_lane_claim_broadcasts_the_owner_record() {
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let registry_opt = Some(Arc::clone(&registry));
        let stamps: OwnershipStamps =
            Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let tx = Arc::new(tx);

        let mut ticket = match ownership_lane::begin_lane_claim(
            &registry_opt,
            "codex",
            "ses_r29_f1",
            "op-r29-f1-commit",
            None,
            "test",
            0,
        ) {
            ownership_lane::LaneClaim::Granted(ticket) => Some(ticket),
            _ => panic!("the seed claim must grant"),
        };
        assert!(ownership_lane::commit_lane_claim(
            &registry_opt,
            &stamps,
            Some(&tx),
            "codex",
            "ses_r29_f1",
            &mut ticket,
            "ses_r29_f1",
            None,
        )
        .is_ok());

        let frame: serde_json::Value =
            serde_json::from_str(&rx.try_recv().expect("the owner record frame")).unwrap();
        assert_eq!(frame["type"], "session.runtimeOwner", "{frame}");
        assert_eq!(frame["provider"], "codex");
        assert_eq!(frame["sessionId"], "ses_r29_f1");
        assert_eq!(frame["ownerKind"], "fresh-agent");
        assert_eq!(frame["transition"], "handoff-committed");
        assert_eq!(frame["epoch"], registry.boot_epoch());
        assert_eq!(
            frame["generation"],
            registry.observe("codex", "ses_r29_f1").generation,
            "the frame carries the COMMITTED generation"
        );
        assert_eq!(frame["operationId"], "op-r29-f1-commit");
        assert!(frame["fenced"].is_null(), "no fenced marker: {frame}");
        assert!(frame["aliasOf"].is_null(), "no alias: {frame}");
        assert!(
            frame["terminalId"].is_null(),
            "a fresh-agent owner has no terminal"
        );

        // The retained stamp and the Live record stand exactly as before —
        // the broadcast is purely additive.
        let stamp = stamps.lock().unwrap().get("ses_r29_f1").cloned().unwrap();
        assert_eq!(
            stamp.generation,
            registry.observe("codex", "ses_r29_f1").generation
        );
        assert!(matches!(
            registry.observe("codex", "ses_r29_f1").state,
            freshell_ownership::OwnershipState::Live { .. }
        ));

        // A commit with NO bus still commits (callers without a broadcast
        // channel are not blocked).
        let mut ticket2 = match ownership_lane::begin_lane_claim(
            &registry_opt,
            "opencode",
            "ses_r29_f1_nb",
            "op-r29-f1-nobus",
            None,
            "test",
            0,
        ) {
            ownership_lane::LaneClaim::Granted(ticket) => Some(ticket),
            _ => panic!("the second claim must grant"),
        };
        assert!(ownership_lane::commit_lane_claim(
            &registry_opt,
            &stamps,
            None,
            "opencode",
            "ses_r29_f1_nb",
            &mut ticket2,
            "ses_r29_f1_nb",
            None,
        )
        .is_ok());
        assert!(rx.try_recv().is_err(), "no frame without a bus");
    }

    #[test]
    fn authorized_is_constant_time_and_requires_header() {
        let mut headers = HeaderMap::new();
        assert!(!authorized(&headers, "tok")); // absent
        headers.insert("x-auth-token", "nope".parse().unwrap());
        assert!(!authorized(&headers, "tok"));
        headers.insert("x-auth-token", "tok".parse().unwrap());
        assert!(authorized(&headers, "tok"));
    }

    #[test]
    fn value_as_secs_parses_number_and_string() {
        assert_eq!(value_as_secs(&json!(180)), Some(180));
        assert_eq!(value_as_secs(&json!("90")), Some(90));
        assert_eq!(value_as_secs(&json!(-1)), None);
        assert_eq!(value_as_secs(&json!("nan")), None);
        assert_eq!(value_as_secs(&json!(null)), None);
    }

    /// b8ke delta review F7: a request carrying exactly ONE of the observed
    /// epoch/generation pair is a typed invalid fence — never a silent
    /// downgrade to the unfenced legacy path. Only BOTH-present (a fence)
    /// and BOTH-absent (legacy) are accepted shapes.
    /// b8ke ext r30 F1 (the SHARED create/attach/resume site): a runtime
    /// whose sidecar pid already exited NEVER publishes —
    /// `commit_lane_claim`'s liveness check runs under the stamps lock
    /// (the same lock the exit watcher's release consult takes), so the
    /// dead runtime refuses typed (ForeignOperation → the caller's
    /// teardown), no retained stamp leaks, and the coordinator never
    /// records Live. Pre-r30 the commit ran first and the stamp was
    /// inserted only after it — a runtime exiting between the two was
    /// published Live with release evidence arriving too late for the
    /// completed watcher.
    #[test]
    fn commit_lane_claim_refuses_a_runtime_that_already_exited() {
        use crate::ownership_lane::{claim_fresh_agent_ownership, commit_lane_claim};
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let stamps: crate::ownership_lane::OwnershipStamps =
            Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));

        // A pid that is CONFIRMED dead: a spawned process we wait on.
        let mut gone = std::process::Command::new("true")
            .spawn()
            .expect("spawn a short-lived process");
        let dead_pid = gone.id();
        let _ = gone.wait();

        // The lane's granted claim (the ticket the create/resume tails
        // hold at their commit).
        let session_id = "ses-r30-f1-shared";
        let freshell_ownership::BeginOutcome::Granted { generation } = claim_fresh_agent_ownership(
            &registry,
            "codex",
            session_id,
            "op-r30-f1-shared",
            None,
            "test",
            1_000,
        ) else {
            panic!("the claim must grant")
        };
        let mut ticket = Some(freshell_ownership::OperationTicket::new(
            Arc::clone(&registry),
            "codex",
            session_id,
            "op-r30-f1-shared",
            freshell_ownership::RuntimeOwnerKind::FreshAgent,
            generation,
            "test",
        ));

        // THE PUBLICATION with a dead runtime: refused typed, nothing
        // published, no stamp.
        let outcome = commit_lane_claim(
            &Some(Arc::clone(&registry)),
            &stamps,
            None,
            "codex",
            session_id,
            &mut ticket,
            "fake-live-key",
            Some(dead_pid),
        );
        assert!(
            matches!(
                outcome,
                Err(freshell_ownership::CommitOutcome::ForeignOperation)
            ),
            "the dead runtime's publication refuses typed: {outcome:?}"
        );
        assert!(
            !matches!(
                registry.observe("codex", session_id).state,
                freshell_ownership::OwnershipState::Live { .. }
            ),
            "the coordinator never recorded Live for the dead runtime"
        );
        assert!(
            stamps
                .lock()
                .expect("stamps lock")
                .get(session_id)
                .is_none(),
            "no retained stamp leaked for an owner that never materialized"
        );

        // The CONTROL: a live pid publishes — the check is the gate, not
        // a blanket refusal.
        let session_id = "ses-r30-f1-live";
        let freshell_ownership::BeginOutcome::Granted { generation } = claim_fresh_agent_ownership(
            &registry,
            "codex",
            session_id,
            "op-r30-f1-live",
            None,
            "test",
            2_000,
        ) else {
            panic!("the control claim must grant")
        };
        let mut ticket = Some(freshell_ownership::OperationTicket::new(
            Arc::clone(&registry),
            "codex",
            session_id,
            "op-r30-f1-live",
            freshell_ownership::RuntimeOwnerKind::FreshAgent,
            generation,
            "test",
        ));
        let alive_pid = std::process::id();
        commit_lane_claim(
            &Some(Arc::clone(&registry)),
            &stamps,
            None,
            "codex",
            session_id,
            &mut ticket,
            "fake-live-key-2",
            Some(alive_pid),
        )
        .expect("a live runtime publishes");
        assert!(matches!(
            registry.observe("codex", session_id).state,
            freshell_ownership::OwnershipState::Live { .. }
        ));
        assert!(stamps
            .lock()
            .expect("stamps lock")
            .get(session_id)
            .is_some());
    }

    /// b8ke ext r32 F2: the released frame carries ITS OWN transition's
    /// pair — the (epoch, generation) captured at the commit — never a
    /// re-observed current generation. A lifecycle operation landing
    /// between the commit_stop and this broadcast (modeled by advancing
    /// the key with a competing start BEFORE the frame is built) must
    /// not leak its newer generation into the vacant frame: the client
    /// accepts all same-generation frames, so a re-observed frame
    /// folds OVER the newer operation's state. Pre-r32 the builder
    /// re-observed and the frame carried the newer generation.
    #[test]
    fn released_owner_frame_carries_the_committed_pair_not_the_current_generation() {
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let sid = "ses-r32-f2-released-frame";
        let owner = freshell_ownership::OwnerIdentity {
            kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
            terminal_id: None,
            live_session_key: Some("live-key-r32-f2".into()),
            pid: Some(111_222),
            ownership_id: Some("op-live-r32-f2".into()),
            unit_id: None,
            hold: freshell_ownership::HoldKind::Main,
        };
        let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
            "codex",
            sid,
            freshell_ownership::RuntimeOwnerKind::FreshAgent,
            "op-live-r32-f2",
            None,
            "test",
            1_000,
        ) else {
            panic!("fixture granted")
        };
        assert_eq!(
            registry.commit_live("codex", sid, "op-live-r32-f2", generation, owner.clone()),
            freshell_ownership::CommitOutcome::Committed
        );
        // The stop commits Vacant — THIS transition's pair is
        // (boot_epoch, stop_gen).
        let freshell_ownership::StopOutcome::Granted {
            generation: stop_gen,
        } = registry.begin_stop(
            "codex",
            sid,
            "op-stop-r32-f2",
            &freshell_ownership::StopClaim {
                expected_kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                expected_runtime: Some(owner.clone()),
                observed: freshell_ownership::ObservedFence {
                    epoch: registry.boot_epoch(),
                    generation,
                },
            },
            "test",
            2_000,
        )
        else {
            panic!("fixture stop granted")
        };
        assert_eq!(
            registry.commit_stop("codex", sid, "op-stop-r32-f2", stop_gen),
            freshell_ownership::CommitOutcome::Committed
        );
        // A lifecycle op lands BETWEEN the commit and the broadcast: a
        // competing start grants and advances the key's generation.
        let freshell_ownership::BeginOutcome::Granted { generation: newer } = registry.begin_start(
            "codex",
            sid,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-competitor-r32-f2",
            None,
            "competitor",
            3_000,
        ) else {
            panic!("fixture competitor granted")
        };
        assert!(newer > stop_gen, "the competitor advanced the generation");

        // THE FRAME, built with the COMMITTED pair: it must carry the
        // stop's own (epoch, stop_gen) — pre-r32 the builder re-observed
        // and carried the competitor's `newer` generation.
        let frame = ownership_lane::released_owner_frame(
            &Some(Arc::clone(&registry)),
            "codex",
            sid,
            "op-stop-r32-f2",
            registry.boot_epoch(),
            stop_gen,
        )
        .expect("the wired registry builds the frame");
        let freshell_protocol::ServerMessage::SessionRuntimeOwner(o) = frame else {
            panic!("the released frame is a SessionRuntimeOwner")
        };
        assert_eq!(
            o.generation, stop_gen,
            "the released frame carries ITS OWN committed pair, never the \
             re-observed current generation ({newer})"
        );
        assert_eq!(o.epoch, registry.boot_epoch());
        assert_eq!(o.owner_kind, "vacant");
    }

    #[test]
    fn wire_fence_rejects_each_half_fenced_combination_typed() {
        use freshell_ownership::ObservedFence;

        // Both present: the fence.
        assert_eq!(
            ownership_lane::wire_fence(Some(3), Some(7)),
            Ok(Some(ObservedFence {
                epoch: 3,
                generation: 7
            }))
        );
        // Both absent: the legacy unfenced path.
        assert_eq!(ownership_lane::wire_fence(None, None), Ok(None));
        // Each half-fenced combination: the typed refusal.
        let epoch_only = ownership_lane::wire_fence(Some(3), None);
        let generation_only = ownership_lane::wire_fence(None, Some(7));
        for err in [epoch_only, generation_only] {
            let err = err.expect_err("a half-fenced pair must be refused");
            assert_eq!(err.code(), "INVALID_FENCE");
            assert!(!err.message().is_empty());
        }
    }

    #[test]
    fn render_transcript_collects_text_parts_and_contains_reply() {
        // A representative opencode /message page: user prompt + assistant reply parts.
        let page = json!([
            { "info": { "role": "user" }, "parts": [{ "type": "text", "text": "Reply with freshell-t2-ok" }] },
            { "info": { "role": "assistant" }, "parts": [
                { "type": "step-start" },
                { "type": "text", "text": "freshell-t2-ok" }
            ] }
        ]);
        let rendered = render_transcript(&page);
        assert!(rendered.contains("freshell-t2-ok"), "{rendered}");
        assert!(!rendered.trim().is_empty());
    }

    #[test]
    fn render_transcript_falls_back_to_raw_for_unknown_shape() {
        let page = json!({ "unexpected": "shape" });
        let rendered = render_transcript(&page);
        assert!(!rendered.trim().is_empty());
    }

    #[test]
    fn materialized_frame_carries_placeholder_and_durable() {
        // The broadcast frame shape the oracle's wire.session-materialized invariant reads.
        let msg = ServerMessage::FreshAgentSessionMaterialized(FreshAgentSessionMaterialized {
            previous_session_id: "freshopencode-abc".to_string(),
            provider: PROVIDER.to_string(),
            session_id: "ses_123".to_string(),
            session_type: SESSION_TYPE.to_string(),
            session_ref: Some(SessionLocator {
                provider: PROVIDER.to_string(),
                session_id: "ses_123".to_string(),
            }),
            name_ref: None,
            session_name: None,
        });
        let wire: Value = serde_json::to_value(&msg).unwrap();
        assert_eq!(wire["type"], "freshAgent.session.materialized");
        assert_eq!(wire["previousSessionId"], "freshopencode-abc");
        assert_eq!(wire["sessionId"], "ses_123");
        assert_eq!(wire["provider"], "opencode");
    }

    #[tokio::test]
    async fn shutdown_is_safe_when_no_serve_started() {
        // No manager was ever created → shutdown is a clean no-op (never panics).
        state().shutdown().await;
    }

    // -- SESSION-09 fix-forward: unify `sessions.changed` revision counters --
    //
    // `freshell-freshagent` previously maintained its OWN `sessions_revision`
    // counter, entirely independent of `freshell-ws`'s `WsState::sessions_revision`
    // (the periodic session-directory sweep's counter). Because the client's
    // dedupe watermark (`src/App.tsx:924-932`) only accepts a `sessions.changed`
    // frame whose `revision` INCREASES over the last one it saw, two
    // independently-incrementing producers of the same message type could, in
    // rare interleavings, cause a real change from one producer to be masked by
    // a lower-or-equal revision from the other. `with_shared_sessions_revision`
    // lets the real server wiring (`freshell-server`'s `main.rs`) point this
    // crate's counter at the SAME `Arc<AtomicI64>` `WsState` uses, so both
    // producers draw from one monotonic sequence.

    #[test]
    fn with_shared_sessions_revision_draws_from_the_injected_counter() {
        let shared = Arc::new(AtomicI64::new(41));
        let st = state().with_shared_sessions_revision(Arc::clone(&shared));

        // The crate's own emission (`broadcast_sessions_changed`, the refactor
        // of the inline fetch_add call at the durable-session materialization
        // site) must bump the INJECTED counter, not a fresh internal one.
        st.broadcast_sessions_changed();

        assert_eq!(
            shared.load(Ordering::SeqCst),
            42,
            "the crate's own sessions.changed emission must bump the shared counter"
        );
    }

    #[test]
    fn sessions_changed_revision_is_unified_across_ws_and_freshagent_producers() {
        // Reproduces the exact `fetch_add(1, SeqCst) + 1` pattern
        // `freshell_ws::terminal::broadcast_sessions_changed` uses, on the SAME
        // shared `Arc<AtomicI64>`, interleaved with THIS crate's own emission --
        // proving both producers now draw from one unified, never-regressing
        // sequence (the two-independent-counters bug this fix closes).
        let shared = Arc::new(AtomicI64::new(0));
        let st = state().with_shared_sessions_revision(Arc::clone(&shared));

        // "ws" producer bumps first.
        let ws_revision_1 = shared.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(ws_revision_1, 1);

        // "freshagent" producer bumps next -- must see revision 1 and produce 2,
        // not restart its own independent sequence at 1.
        st.broadcast_sessions_changed();
        assert_eq!(shared.load(Ordering::SeqCst), 2);

        // "ws" producer bumps again -- must see freshagent's bump reflected.
        let ws_revision_2 = shared.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(
            ws_revision_2, 3,
            "ws and freshagent producers must share ONE strictly-increasing \
             sequence -- a lower-or-equal revision from either side risks the \
             client's \"accept only if revision increases\" watermark silently \
             dropping a real change"
        );
    }

    // ── GET /api/fresh-agent/threads/freshopencode/opencode/:threadId (Batch D PR-5) ──

    use freshell_opencode::{
        Endpoint, EventSource, EventStreamHandle, PortAllocator, ServeDeps, ServeHttp,
        ServeHttpError, ServeHttpRequest, ServeHttpResponse,
    };

    /// Fakes `GET /session/:id` (session info) and `GET /session/:id/message` (the page)
    /// with fixed, scripted bodies; anything else (health, etc.) is a benign `{}`.
    struct FixedSessionHttp {
        session_body: Value,
        messages_body: Value,
    }
    impl ServeHttp for FixedSessionHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            let body = if req.url.contains("/message") {
                serde_json::to_vec(&self.messages_body).unwrap()
            } else if req.url.contains("/session/") {
                serde_json::to_vec(&self.session_body).unwrap()
            } else {
                b"{}".to_vec()
            };
            Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) })
        }
    }

    /// Answers the serve's own `/global/health` probe (so `ensure_started()` succeeds) but
    /// 404s any `/session/:id` GET (unknown session).
    struct NotFoundHttp;
    impl ServeHttp for NotFoundHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                if req.url.contains("/global/health") {
                    return Ok(ServeHttpResponse::new(200, b"{}".to_vec()));
                }
                Ok(ServeHttpResponse::new(404, b"not found".to_vec()))
            })
        }
    }

    struct FakeAllocator;
    impl PortAllocator for FakeAllocator {
        fn allocate(&self) -> Result<Endpoint, String> {
            Ok(Endpoint {
                hostname: "127.0.0.1".into(),
                port: 1,
            })
        }
    }
    struct NoopHandle;
    impl EventStreamHandle for NoopHandle {}
    struct NoopEventSource;
    impl EventSource for NoopEventSource {
        fn connect(
            &self,
            _url: String,
            _sink: freshell_opencode::serve::EventSink,
        ) -> Box<dyn EventStreamHandle> {
            Box::new(NoopHandle)
        }
    }
    struct NoopSpawner;
    impl freshell_opencode::ProcessSpawner for NoopSpawner {
        fn spawn(
            &self,
            _req: freshell_opencode::serve::SpawnRequest,
        ) -> Result<Box<dyn freshell_opencode::ServeProcess>, String> {
            struct NoopProcess;
            impl freshell_opencode::ServeProcess for NoopProcess {
                fn exited(&self) -> Option<i32> {
                    None
                }
                fn take_fatal_startup_error(&self) -> Option<String> {
                    None
                }
                fn kill(&self) {}
            }
            Ok(Box::new(NoopProcess))
        }
    }

    async fn state_with_fixed_session_http(
        session_body: Value,
        messages_body: Value,
    ) -> FreshAgentState {
        let st = state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(FixedSessionHttp {
                session_body,
                messages_body,
            }),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;
        st
    }

    #[tokio::test]
    async fn get_opencode_snapshot_returns_a_schema_shaped_snapshot_with_turn_text() {
        let session_body = json!({
            "id": "ses_1",
            "title": "a session",
            "time": { "created": 1_700_000_000_000i64, "updated": 1_700_000_005_000i64 },
            "tokens": { "input": 10, "output": 20, "total": 30 },
        });
        let messages_body = json!([
            { "info": { "id": "msg-1", "role": "user" }, "parts": [{ "type": "text", "text": "hi" }] },
            { "info": { "id": "msg-2", "role": "assistant" }, "parts": [
                { "type": "step-start" },
                { "type": "text", "text": "hello from opencode" }
            ] },
        ]);
        let st = state_with_fixed_session_http(session_body, messages_body).await;

        let snapshot = st
            .get_opencode_snapshot("ses_1", None)
            .await
            .expect("snapshot builds");

        assert_eq!(snapshot["sessionType"], json!("freshopencode"));
        assert_eq!(snapshot["provider"], json!("opencode"));
        assert_eq!(snapshot["threadId"], json!("ses_1"));
        assert_eq!(snapshot["sessionId"], json!("ses_1"));
        assert_eq!(snapshot["revision"], json!(1_700_000_005_000i64));
        assert_eq!(snapshot["status"], json!("idle"));
        assert_eq!(snapshot["summary"], json!("a session"));
        assert_eq!(snapshot["tokenUsage"]["inputTokens"], json!(10));
        assert_eq!(snapshot["tokenUsage"]["outputTokens"], json!(20));
        assert_eq!(snapshot["tokenUsage"]["totalTokens"], json!(30));
        assert_eq!(snapshot["pendingApprovals"], json!([]));
        assert_eq!(snapshot["extensions"]["opencode"], json!({}));

        let turns = snapshot["turns"].as_array().expect("turns array");
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["role"], json!("user"));
        assert_eq!(turns[0]["items"][0]["kind"], json!("text"));
        assert_eq!(turns[0]["items"][0]["text"], json!("hi"));
        assert_eq!(turns[1]["role"], json!("assistant"));
        assert_eq!(turns[1]["summary"], json!("hello from opencode"));
        assert_eq!(turns[1]["summaryKind"], json!("echo"));
        assert_eq!(snapshot["latestTurnId"], turns[1]["turnId"]);
    }

    #[tokio::test]
    async fn local_snapshot_owner_requires_opencode_session_claim_not_shared_daemon() {
        let state = state_with_fixed_session_http(
            json!({"id":"ses_local","time":{"updated":2}}),
            json!([{ "info":{"id":"answer","role":"assistant"}, "parts":[{"type":"text","text":"Owned local answer"}] }]),
        ).await;
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let state = state.with_ownership(registry.clone());
        assert!(state.local_snapshot_owner("ses_local").await.is_none());
        let mut ticket = match ownership_lane::begin_lane_claim(
            &state.ownership,
            "opencode",
            "ses_local",
            "owned-snapshot",
            None,
            "test",
            0,
        ) {
            ownership_lane::LaneClaim::Granted(ticket) => Some(ticket),
            _ => panic!("expected local claim"),
        };
        ownership_lane::commit_lane_claim(
            &state.ownership,
            &state.ownership_stamps,
            None,
            "opencode",
            "ses_local",
            &mut ticket,
            "ses_local",
            None,
        )
        .unwrap();
        assert_eq!(
            state.local_snapshot_owner("ses_local").await,
            Some(registry.observe("opencode", "ses_local"))
        );
        let snapshot = state
            .get_opencode_snapshot("ses_local", None)
            .await
            .unwrap();
        assert_eq!(
            snapshot["turns"][0]["items"][0]["text"],
            "Owned local answer"
        );
        assert!(state
            .local_snapshot_owner("ses_unregistered")
            .await
            .is_none());
        let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_handoff(
            "opencode",
            "ses_local",
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "snapshot-handoff",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        ) else {
            panic!("expected handoff")
        };
        assert!(state.local_snapshot_owner("ses_local").await.is_none());
        assert_eq!(
            registry.commit_live(
                "opencode",
                "ses_local",
                "snapshot-handoff",
                generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some("foreign-terminal".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: freshell_ownership::HoldKind::Main,
                }
            ),
            freshell_ownership::CommitOutcome::Committed
        );
        assert!(state.local_snapshot_owner("ses_local").await.is_none());
    }

    /// Fix Task #3: a session id this process never created/attached to via any WS/REST
    /// pane (a stand-in for a HISTORICAL session opened from the sidebar) still serves a
    /// snapshot -- `get_opencode_snapshot` has no "is this in a live pane map" gate; it
    /// goes straight to the shared serve manager's `GET /session/:id` + `/message`, which
    /// opencode's own sqlite-backed store answers for ANY session id it knows about,
    /// regardless of which process created it or when.
    #[tokio::test]
    async fn get_opencode_snapshot_serves_a_session_never_created_by_this_process() {
        let session_body = json!({
            "id": "ses_historical",
            "title": "a session from a previous server lifetime",
            "time": { "created": 1_700_000_000_000i64, "updated": 1_700_000_005_000i64 },
        });
        let messages_body = json!([
            { "info": { "id": "msg-1", "role": "user" }, "parts": [{ "type": "text", "text": "old message" }] },
        ]);
        let st = state_with_fixed_session_http(session_body, messages_body).await;

        // No `handle_create`/`handle_send` ever ran for this id in this test -- there is no
        // pane, no durable-id map entry, nothing. The snapshot must still build.
        let snapshot = st
            .get_opencode_snapshot("ses_historical", None)
            .await
            .expect("a historical session (never created by this process) still snapshots");
        assert_eq!(snapshot["threadId"], json!("ses_historical"));
        assert_eq!(snapshot["sessionType"], json!("freshopencode"));
    }

    #[tokio::test]
    async fn get_opencode_snapshot_of_unknown_session_is_not_found() {
        let st = state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(NotFoundHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;

        let err = st
            .get_opencode_snapshot("does-not-exist", None)
            .await
            .expect_err("unknown session");
        assert!(matches!(err, OpencodeSnapshotError::NotFound));
    }

    /// b8ke focused review FR2: a snapshot GET whose CAPTURED serve instance
    /// fails (the daemon died after the capture — the transport refuses)
    /// degrades to the disk-state answer and NEVER touches the shared
    /// daemon's lifecycle: no `ensure_started` respawn (the spawner count
    /// stays at the test's own one) and no `discard_running` kill (the
    /// running entry stays). Pre-fix, the GET's `require_base` re-lookup
    /// could respawn a daemon and the failure surfaced as a raw 5xx.
    #[tokio::test]
    async fn get_opencode_snapshot_over_a_failed_captured_serve_degrades_to_disk_state() {
        let st = state();
        let spawner = Arc::new(CountingSpawner::default());
        let deps = ServeDeps {
            spawner: Arc::clone(&spawner) as Arc<dyn freshell_opencode::ProcessSpawner>,
            http: Arc::new(HealthThenUndeliveredHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        let manager_handle = manager.clone();
        st.set_manager_for_test(manager).await;
        assert_eq!(spawner.spawns(), 1, "the test's own setup spawn");

        let snapshot = st
            .get_opencode_snapshot("ses_gone_daemon", None)
            .await
            .expect("a failed captured serve degrades to the disk-state snapshot");

        // The disk-state shape: the empty snapshot with the vacant
        // owner-state fields — never a raw Serve error.
        assert_eq!(snapshot["threadId"], json!("ses_gone_daemon"));
        assert_eq!(snapshot["turns"], json!([]), "empty rows: {snapshot}");
        assert_eq!(
            snapshot["extensions"]["opencode"]["ownerKind"],
            json!("vacant"),
            "the disk-state answer names the vacant key: {snapshot}"
        );
        // The GET never respawned AND never killed: the spawner count is
        // unchanged and the running entry is still there.
        assert_eq!(
            spawner.spawns(),
            1,
            "the GET must never spawn a replacement daemon"
        );
        assert!(
            manager_handle.base_url().await.is_some(),
            "the GET must never discard the shared daemon's running entry"
        );
        assert!(
            !spawner.last_spawn_killed(),
            "the GET must never kill the shared daemon process"
        );
    }

    /// b8ke focused review FR2: a snapshot GET that TIMES OUT against the
    /// captured serve instance keeps the shared daemon HEALTHY — the
    /// reference `discardRunning('request_timeout')` behavior is forbidden
    /// on the GET path. The running entry stays, the process is never
    /// killed, and the caller gets the disk-state answer.
    #[tokio::test]
    async fn get_opencode_snapshot_timeout_never_kills_the_shared_daemon() {
        let st = state();
        let spawner = Arc::new(CountingSpawner::default());
        let deps = ServeDeps {
            spawner: Arc::clone(&spawner) as Arc<dyn freshell_opencode::ProcessSpawner>,
            http: Arc::new(HealthOnlyHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(
            deps,
            ServeConfig {
                request_timeout: std::time::Duration::from_millis(100),
                ..ServeConfig::default()
            },
        );
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        let manager_handle = manager.clone();
        st.set_manager_for_test(manager).await;

        let snapshot = st
            .get_opencode_snapshot("ses_slow_daemon", None)
            .await
            .expect("a timed-out captured serve degrades to the disk-state snapshot");

        assert_eq!(snapshot["threadId"], json!("ses_slow_daemon"));
        assert_eq!(
            snapshot["extensions"]["opencode"]["ownerKind"],
            json!("vacant"),
            "the disk-state answer: {snapshot}"
        );
        // THE OpenCode-health invariant: the timeout did NOT kill the daemon.
        assert!(
            manager_handle.base_url().await.is_some(),
            "a GET timeout must never discard the shared daemon's running entry"
        );
        assert!(
            !spawner.last_spawn_killed(),
            "a GET timeout must never kill the shared daemon process"
        );
        assert_eq!(spawner.spawns(), 1, "no replacement spawn either");
    }

    /// A `ServeHttp` fake whose health probe answers (so the test's own
    /// `ensure_started` succeeds) but whose session reads PROVABLY never
    /// reach a server (connect-phase refusal) — the daemon-died-after-the-
    /// capture shape (b8ke focused FR2).
    struct HealthThenUndeliveredHttp;
    impl ServeHttp for HealthThenUndeliveredHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                if req.url.contains("/global/health") {
                    return Ok(ServeHttpResponse::new(200, b"{}".to_vec()));
                }
                Err(ServeHttpError::Undelivered(
                    "connect refused (daemon gone)".to_string(),
                ))
            })
        }
    }

    /// A `ServeHttp` fake that answers health probes and NEVER resolves any
    /// session request — the wedged-daemon shape that drives the GET's
    /// request timeout (b8ke focused FR2).
    struct HealthOnlyHttp;
    impl ServeHttp for HealthOnlyHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                if req.url.contains("/global/health") {
                    return Ok(ServeHttpResponse::new(200, b"{}".to_vec()));
                }
                std::future::pending().await
            })
        }
    }

    /// A spawner that counts spawns and records whether its (single) child
    /// was ever killed — the GET-path no-spawn/no-kill assertions
    /// (b8ke focused FR2).
    #[derive(Default)]
    struct CountingSpawner {
        spawns: std::sync::atomic::AtomicUsize,
        killed: Arc<std::sync::Mutex<Vec<bool>>>,
    }
    impl CountingSpawner {
        fn spawns(&self) -> usize {
            self.spawns.load(Ordering::SeqCst)
        }
        fn last_spawn_killed(&self) -> bool {
            self.killed.lock().expect("killed lock").last() == Some(&true)
        }
    }
    impl freshell_opencode::ProcessSpawner for CountingSpawner {
        fn spawn(
            &self,
            _req: freshell_opencode::serve::SpawnRequest,
        ) -> Result<Box<dyn freshell_opencode::ServeProcess>, String> {
            self.spawns.fetch_add(1, Ordering::SeqCst);
            self.killed.lock().expect("killed lock").push(false);
            struct CountedProcess {
                killed: Arc<std::sync::Mutex<Vec<bool>>>,
            }
            impl freshell_opencode::ServeProcess for CountedProcess {
                fn exited(&self) -> Option<i32> {
                    None
                }
                fn take_fatal_startup_error(&self) -> Option<String> {
                    None
                }
                fn kill(&self) {
                    let mut killed = self.killed.lock().expect("killed lock");
                    if let Some(last) = killed.last_mut() {
                        *last = true;
                    }
                }
            }
            Ok(Box::new(CountedProcess {
                killed: Arc::clone(&self.killed),
            }))
        }
    }

    // ── Task 3 (freshopencode TUI parity): the server-side child-session join ──

    /// Routed per-session fake serve HTTP: answers `GET /session/:id` and
    /// `GET /session/:id/message` per session id, `GET /session/status` with a
    /// scripted status map, and optionally fails any URL containing
    /// `fail_substring` with a transport error (the join's warn path). Unknown
    /// session paths 404 (the pruned-child case).
    struct RoutedSessionHttp {
        sessions: HashMap<String, Value>,
        messages: HashMap<String, Value>,
        status_map: Value,
        fail_substring: Option<String>,
    }

    impl RoutedSessionHttp {
        fn new(sessions: HashMap<String, Value>, messages: HashMap<String, Value>) -> Self {
            Self {
                sessions,
                messages,
                status_map: json!({}),
                fail_substring: None,
            }
        }
    }

    /// The session id a serve URL addresses: the segment after the LAST
    /// `/session/`, with `suffix` (e.g. `/message`) stripped.
    fn session_id_in_url(url: &str, suffix: &str) -> Option<String> {
        let path = url.split('?').next().unwrap_or(url);
        let rest = path.strip_suffix(suffix)?;
        let (_, id) = rest.rsplit_once("/session/")?;
        (!id.is_empty()).then(|| id.to_string())
    }

    impl ServeHttp for RoutedSessionHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            Box::pin(async move {
                if let Some(sub) = &self.fail_substring {
                    if req.url.contains(sub.as_str()) {
                        return Err(ServeHttpError::Ambiguous(
                            "simulated transport failure".to_string(),
                        ));
                    }
                }
                if req.url.contains("/global/health") {
                    return Ok(ServeHttpResponse::new(200, b"{}".to_vec()));
                }
                // Before the bare `/session/` arm: `/session/status` is the
                // status map, not a session.
                if req.url.contains("/session/status") {
                    return Ok(ServeHttpResponse::new(
                        200,
                        serde_json::to_vec(&self.status_map).unwrap(),
                    ));
                }
                if req.url.contains("/message") {
                    let Some(id) = session_id_in_url(&req.url, "/message") else {
                        return Ok(ServeHttpResponse::new(200, b"{}".to_vec()));
                    };
                    let Some(body) = self.messages.get(&id) else {
                        return Ok(ServeHttpResponse::new(404, b"not found".to_vec()));
                    };
                    return Ok(ServeHttpResponse::new(
                        200,
                        serde_json::to_vec(body).unwrap(),
                    ));
                }
                if let Some(id) = session_id_in_url(&req.url, "") {
                    let Some(body) = self.sessions.get(&id) else {
                        return Ok(ServeHttpResponse::new(404, b"not found".to_vec()));
                    };
                    return Ok(ServeHttpResponse::new(
                        200,
                        serde_json::to_vec(body).unwrap(),
                    ));
                }
                Ok(ServeHttpResponse::new(200, b"{}".to_vec()))
            })
        }
    }

    async fn state_with_routed_http(http: RoutedSessionHttp) -> FreshAgentState {
        let st = state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(http),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;
        st
    }

    /// The parent fixture every join test shares: an assistant turn carrying the
    /// Task-2 task tool part whose `state.metadata.sessionId` is the child
    /// `ses_c`.
    fn join_parent_fixture() -> (HashMap<String, Value>, HashMap<String, Value>) {
        let sessions = HashMap::from([(
            "ses_p".to_string(),
            json!({
                "id": "ses_p", "title": "parent",
                "time": { "created": 1_700_000_000_000i64, "updated": 1_700_000_005_000i64 },
            }),
        )]);
        let messages = HashMap::from([(
            "ses_p".to_string(),
            json!([
                { "info": { "id": "msg-u", "role": "user" }, "parts": [
                    { "type": "text", "text": "delegate this" } ] },
                { "info": { "id": "msg-a", "role": "assistant" }, "parts": [
                    { "type": "tool", "id": "part_task", "tool": "task", "state": {
                        "status": "completed",
                        "input": { "description": "Fix the flaky harness", "subagent_type": "general" },
                        "metadata": { "sessionId": "ses_c", "parentSessionId": "ses_p" },
                        "output": "<task id=\"ses_c\" state=\"completed\"><task_result>ok</task_result></task>",
                        "time": { "start": 1000, "end": 3000 }
                    } } ] },
            ]),
        )]);
        (sessions, messages)
    }

    /// The child fixture: bash completed / grep error / read running — the
    /// exact three-row activity the join must embed.
    fn join_child_messages() -> Value {
        json!([
            { "info": { "id": "m_u", "role": "user" }, "parts": [
                { "type": "subtask", "agent": "general", "description": "Fix the flaky harness" },
                { "type": "text", "text": "go" } ] },
            { "info": { "id": "m_a", "role": "assistant" }, "parts": [
                { "type": "reasoning", "text": "hmm" },
                { "type": "tool", "tool": "bash", "state": { "status": "completed", "input": { "command": "sed -n 92,112p src/store/paneTypes.ts" } } },
                { "type": "tool", "tool": "grep", "state": { "status": "error", "input": { "pattern": "reasoningEffort" } } },
                { "type": "tool", "tool": "read", "state": { "status": "running", "input": { "filePath": "src/index.css" } } } ] },
        ])
    }

    /// The snapshot's single task_delegation item (panics when absent).
    fn snapshot_delegation_item(snapshot: &Value) -> Value {
        snapshot["turns"]
            .as_array()
            .expect("turns array")
            .iter()
            .flat_map(|turn| turn["items"].as_array().cloned().unwrap_or_default())
            .find(|item| item["kind"] == "task_delegation")
            .expect("the snapshot carries the task_delegation item")
    }

    #[tokio::test]
    async fn get_opencode_snapshot_joins_child_activity_rows_into_the_delegation() {
        let (sessions, mut messages) = join_parent_fixture();
        messages.insert("ses_c".to_string(), join_child_messages());
        let st = state_with_routed_http(RoutedSessionHttp::new(sessions, messages)).await;

        let snapshot = st
            .get_opencode_snapshot("ses_p", None)
            .await
            .expect("snapshot builds");
        let delegation = snapshot_delegation_item(&snapshot);
        assert_eq!(delegation["childSessionId"], json!("ses_c"));
        assert_eq!(
            delegation["activity"],
            json!([
                { "tool": "bash", "status": "completed", "preview": "sed -n 92,112p src/store/paneTypes.ts" },
                { "tool": "grep", "status": "failed", "preview": "reasoningEffort" },
                { "tool": "read", "status": "running", "preview": "src/index.css" },
            ])
        );
    }

    /// Graceful degradation: a pruned child (its message page 404s, which
    /// `list_messages` maps to an empty array) contributes no rows — silent BY
    /// DESIGN — and the parent's snapshot still builds, the delegation simply
    /// carrying no `activity` key.
    #[tokio::test]
    async fn get_opencode_snapshot_survives_a_pruned_child_session() {
        let (sessions, messages) = join_parent_fixture();
        let st = state_with_routed_http(RoutedSessionHttp::new(sessions, messages)).await;

        let snapshot = st
            .get_opencode_snapshot("ses_p", None)
            .await
            .expect("snapshot builds");
        let delegation = snapshot_delegation_item(&snapshot);
        assert!(delegation.get("activity").is_none());
    }

    /// Graceful degradation: a child fetch failing on transport logs a warn and
    /// moves on — the parent's snapshot must still build, with no `activity`.
    #[tokio::test]
    async fn get_opencode_snapshot_survives_a_child_transport_error() {
        let (sessions, messages) = join_parent_fixture();
        let mut http = RoutedSessionHttp::new(sessions, messages);
        http.fail_substring = Some("/session/ses_c/message".to_string());
        let st = state_with_routed_http(http).await;

        let snapshot = st
            .get_opencode_snapshot("ses_p", None)
            .await
            .expect("snapshot builds");
        let delegation = snapshot_delegation_item(&snapshot);
        assert!(delegation.get("activity").is_none());
    }

    /// Collect bus frames (in arrival order) until `pred` matches one of them,
    /// returning everything seen INCLUDING the matching frame. Bounded: panics
    /// after 5s with no match, so a missing frame fails loudly instead of
    /// hanging the suite (same shape as `opencode_ws`'s tests helper).
    async fn frames_until(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        pred: impl Fn(&Value) -> bool,
    ) -> Vec<Value> {
        let mut out = Vec::new();
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let raw = rx.recv().await.expect("the bus stays open");
                let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                let hit = pred(&v);
                out.push(v);
                if hit {
                    break;
                }
            }
        })
        .await
        .expect("a matching frame arrives within the budget");
        out
    }

    /// Live refresh (LB-4 ordering): the child watcher's broadcast receiver is
    /// created synchronously BEFORE the join fetch, so a `message.*` serve event
    /// for the CHILD dispatched after the build returns must surface as a
    /// `freshAgent.session.changed` frame for the PARENT (reason
    /// `opencode-message`) — the frame that drives the client's snapshot
    /// refetch.
    #[tokio::test]
    async fn child_message_events_refresh_the_parent_session_changed_frame() {
        let (sessions, mut messages) = join_parent_fixture();
        messages.insert("ses_c".to_string(), join_child_messages());
        let st = state_with_routed_http(RoutedSessionHttp::new(sessions, messages)).await;
        let mut rx = st.broadcast_tx.subscribe();

        // The build RETURNS with the watcher armed: dispatch only after this
        // await, so the test is deterministic (the receiver pre-existed the
        // fetch).
        let snapshot = st
            .get_opencode_snapshot("ses_p", None)
            .await
            .expect("snapshot builds");
        assert_eq!(
            snapshot_delegation_item(&snapshot)["childSessionId"],
            json!("ses_c")
        );

        let event = freshell_opencode::parse_serve_event(&json!({
            "type": "message.updated",
            "properties": { "info": { "sessionID": "ses_c" } }
        }))
        .expect("a well-formed message.updated event");
        st.ensure_manager().await.dispatch_event(event);

        frames_until(&mut rx, |frame| {
            frame["type"] == "freshAgent.event"
                && frame["event"]["type"] == "freshAgent.session.changed"
                && frame["event"]["sessionId"] == "ses_p"
                && frame["event"]["reason"] == "opencode-message"
        })
        .await;
    }

    // -- P1.13 Task 7: REST send-keys materialization writes a binding row --

    #[derive(Default)]
    struct RecordingHostedRestGateway {
        sends: Mutex<Vec<hosted_rest::HostedRestSend>>,
        captures: Mutex<Vec<hosted_rest::HostedRestCapture>>,
    }

    #[async_trait::async_trait]
    impl hosted_rest::HostedFreshAgentRestGateway for RecordingHostedRestGateway {
        async fn create_agent(
            self: Arc<Self>,
            _request: hosted_rest::HostedRestCreate,
        ) -> Result<hosted_rest::HostedRestCreated, ()> {
            Ok(hosted_rest::HostedRestCreated {
                session_id: "managed-kilroy-recovered".into(),
            })
        }

        async fn send_agent(
            &self,
            request: hosted_rest::HostedRestSend,
        ) -> Result<hosted_rest::HostedRestSendResult, ()> {
            self.sends.lock().expect("sends mutex").push(request);
            Ok(hosted_rest::HostedRestSendResult {
                session_id: "managed-kilroy-recovered".into(),
                completed: true,
            })
        }

        async fn capture(
            &self,
            request: hosted_rest::HostedRestCapture,
        ) -> Result<hosted_rest::HostedRestCaptureResult, hosted_rest::HostedRestCaptureError>
        {
            self.captures.lock().expect("captures mutex").push(request);
            Ok(hosted_rest::HostedRestCaptureResult {
                session_id: "managed-kilroy-recovered".into(),
                native_session_id: "kilroy-native".into(),
                text: "recovered transcript".into(),
                truncated: false,
            })
        }
    }

    #[tokio::test]
    async fn hosted_rest_send_and_capture_recover_pane_from_persisted_layout_after_web_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("layout.json");
        let gateway = Arc::new(RecordingHostedRestGateway::default());
        let first = state().with_layout(layout_store::LayoutStore::with_persistence(path.clone()));
        first.set_hosted_rest_gateway(gateway.clone()).unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let created = create_tab(
            State(first),
            headers.clone(),
            Json(json!({ "agent": "kilroy", "cwd": "/tmp" })),
        )
        .await;
        assert_eq!(created.status(), StatusCode::OK);
        let created_body: Value = serde_json::from_slice(
            &axum::body::to_bytes(created.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
        .unwrap();
        let pane_id = created_body["data"]["paneId"].as_str().unwrap().to_string();

        let restarted = state().with_layout(layout_store::LayoutStore::with_persistence(path));
        restarted.set_hosted_rest_gateway(gateway.clone()).unwrap();
        let sent = send_keys(
            State(restarted.clone()),
            Path(pane_id.clone()),
            headers.clone(),
            Json(json!({ "data": "after restart" })),
        )
        .await;
        assert_eq!(sent.status(), StatusCode::OK);
        {
            let sends = gateway.sends.lock().expect("sends mutex");
            assert_eq!(sends.len(), 1);
            assert_eq!(sends[0].session_id, "managed-kilroy-recovered");
            assert_eq!(sends[0].text, "after restart");
        }

        let captured = capture(
            State(restarted),
            Path(pane_id),
            headers,
            Query(std::collections::HashMap::new()),
        )
        .await;
        assert_eq!(captured.status(), StatusCode::OK);
        let text = axum::body::to_bytes(captured.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&text[..], b"recovered transcript");
        let captures = gateway.captures.lock().expect("captures mutex");
        assert_eq!(captures.len(), 1);
        assert_eq!(captures[0].session_id, "managed-kilroy-recovered");
    }

    /// Like `opencode_ws::tests::FakeHttp`: `POST /session` mints `ses_1`; everything
    /// else (health, prompt, status) answers a benign `{}`.
    struct CreateCapableHttp;
    impl ServeHttp for CreateCapableHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            let is_create = matches!(req.method, freshell_opencode::serve::HttpMethod::Post)
                && (req.url.ends_with("/session") || req.url.contains("/session?"));
            let body = if is_create {
                serde_json::to_vec(&json!({ "id": "ses_1", "directory": null })).unwrap()
            } else {
                b"{}".to_vec()
            };
            Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) })
        }
    }

    /// The REST half of the Task 7 identity-event coverage (V10 A13-N1): a REST-created
    /// pane (POST /api/tabs seeds model/effort) whose first `send-keys` cold-start
    /// materializes the durable `ses_*` id must record a binding through the pane
    /// ledger sink -- without this site, REST-created sessions never get a resume record.
    #[tokio::test]
    async fn rest_send_keys_materialization_records_binding() {
        let st = state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateCapableHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;

        let fake = Arc::new(identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        // A REST-created pane carrying model/effort (what POST /api/tabs records).
        st.panes.lock().expect("panes mutex").insert(
            "pane-1".to_string(),
            PaneEntry {
                placeholder_id: "freshopencode-r1".to_string(),
                provider: PROVIDER.into(),
                session_type: SESSION_TYPE.into(),
                cwd: Some("/w".to_string()),
                model: Some("big-model".to_string()),
                effort: Some("high".to_string()),
                durable_id: None,
            },
        );

        // Drive the REST send-keys cold-start materialization. `timeout: 0` bounds the
        // inline `run_turn` idle-wait (the fake never reports activity); the
        // materialization + binding write happen BEFORE the turn is driven.
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let _resp = send_keys(
            State(st.clone()),
            Path("pane-1".to_string()),
            headers,
            Json(json!({ "text": "hello", "timeout": 0 })),
        )
        .await;

        let bindings = fake.bindings.lock().unwrap();
        let b = bindings
            .iter()
            .find(|b| b.session_id == "ses_1")
            .expect("binding recorded at REST send-keys materialization");
        assert_eq!(b.provider, "opencode");
        assert_eq!(b.mode, "freshopencode");
        assert_eq!(b.resolves_pending.as_deref(), Some("freshopencode-r1"));
        assert_eq!(b.settings.model.as_deref(), Some("big-model"));
        assert_eq!(b.settings.effort.as_deref(), Some("high"));
        assert_eq!(b.settings.cwd.as_deref(), Some("/w"));
        // Task 3 (corrected semantics): `create_request_id` is the CREATE's
        // requestId, derived from the pane's placeholder id
        // (`freshopencode-r1` → `r1`) — the WS path previously stamped the
        // SEND's requestId and the REST path stamped `None`; the placeholder
        // is the lineage source of truth on both paths now.
        assert_eq!(b.create_request_id.as_deref(), Some("r1"));
        // Delta-r2 Finding 2 pin: the REST/MCP materialization lane is
        // EXPLICITLY headless — its write must CLEAR any prior browser stamps
        // on the row, never inherit them (a kept stamp under the refreshed
        // `updated_at` would launder the row into the D8 recovery offer).
        assert_eq!(
            b.provenance,
            identity_sink::ProvenanceUpdate::Clear,
            "the REST lineage write is a provenance Clear"
        );
        // A settings-bearing row keeps "recorded" status under the new keying.
        drop(bindings);
        assert!(fake.was_recorded("opencode", "ses_1"));
    }

    /// b8ke focused round-3 review R3-1: the REST turn dispatch performs
    /// the ownership/claim check — the canonical key must be
    /// `Live{FreshAgent}`. A key whose Live owner is a TERMINAL (a
    /// completed handoff moved the session to the terminal lane) refuses
    /// the REST drive typed (409 SESSION_RESERVED), never dispatching a
    /// prompt POST over a session this pane no longer owns. Pre-fix, the
    /// REST path dispatched `run_turn` with no ownership check at all.
    #[tokio::test]
    async fn rest_send_keys_refuses_a_foreign_owned_session_typed() {
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let st = state().with_ownership(Arc::clone(&registry));
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateCapableHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;

        // First send: materializes ses_1 and commits Live{FreshAgent}
        // (timeout 0 bounds the drive's own idle wait to an immediate
        // approx).
        st.panes.lock().expect("panes mutex").insert(
            "pane-foreign".to_string(),
            PaneEntry {
                placeholder_id: "freshopencode-foreign".to_string(),
                provider: PROVIDER.into(),
                session_type: SESSION_TYPE.into(),
                cwd: Some("/w".to_string()),
                model: None,
                effort: None,
                durable_id: None,
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let first = send_keys(
            State(st.clone()),
            Path("pane-foreign".to_string()),
            headers.clone(),
            Json(json!({ "text": "hello", "timeout": 0 })),
        )
        .await;
        assert_eq!(first.status(), StatusCode::OK);
        // Fixture: the materialization committed the fresh owner.
        match registry.observe(PROVIDER, "ses_1").state {
            freshell_ownership::OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, freshell_ownership::RuntimeOwnerKind::FreshAgent);
            }
            other => panic!("fixture: expected the committed fresh owner, got {other:?}"),
        }

        // Move the canonical key to a TERMINAL owner (a completed
        // handoff's end state).
        let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_handoff(
            PROVIDER,
            "ses_1",
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "test-terminal-move",
            None,
            "test",
            crate::session_lease::now_epoch_ms(),
        ) else {
            panic!("fixture: the handoff begins from the committed Live state")
        };
        let terminal_owner = freshell_ownership::OwnerIdentity {
            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
            terminal_id: Some("term-1".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
            unit_id: None,
            hold: freshell_ownership::HoldKind::Main,
        };
        assert_eq!(
            registry.commit_live(
                PROVIDER,
                "ses_1",
                "test-terminal-move",
                generation,
                terminal_owner,
            ),
            freshell_ownership::CommitOutcome::Committed
        );

        // THE R3-1 regression: the second REST drive on the SAME pane is
        // refused typed — the pane's session is owned by a terminal now.
        let second = send_keys(
            State(st.clone()),
            Path("pane-foreign".to_string()),
            headers,
            Json(json!({ "text": "another turn", "timeout": 5 })),
        )
        .await;
        assert_eq!(
            second.status(),
            StatusCode::CONFLICT,
            "a foreign-owned session must refuse the REST turn dispatch: {second:?}"
        );
        let body = axum::body::to_bytes(second.into_body(), usize::MAX)
            .await
            .expect("read the refusal body");
        let body: Value = serde_json::from_slice(&body).expect("the refusal body parses");
        assert_eq!(
            body["message"], "SESSION_RESERVED: another lifecycle operation owns this session",
            "the typed refusal: {body}"
        );
        // The refused drive leaves no witness registered.
        assert!(
            st.rest_opencode_turns
                .lock()
                .expect("rest opencode turns lock")
                .is_empty(),
            "the refused dispatch must not leave a REST turn witness behind"
        );
    }

    // ── b8ke ext r22 F1: the REST/MCP materialization is coordinator-owned from BEFORE spawn ──

    /// b8ke ext r22 F1: the create-HOLDING http — POST /session answers
    /// after a bounded delay (the deterministic cold-start window the
    /// provisional-record tests poll inside), then either the healthy
    /// `ses_1` body or a 500 (the spawn-time provider rejection shape).
    struct CreateHoldingHttp {
        delay_ms: u64,
        fail: bool,
    }
    impl ServeHttp for CreateHoldingHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            let is_create = matches!(req.method, freshell_opencode::serve::HttpMethod::Post)
                && (req.url.ends_with("/session") || req.url.contains("/session?"));
            let delay_ms = self.delay_ms;
            let fail = self.fail;
            Box::pin(async move {
                if is_create {
                    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
                    if fail {
                        return Ok(ServeHttpResponse::new(500, b"{}".to_vec()));
                    }
                    return Ok(ServeHttpResponse::new(
                        200,
                        serde_json::to_vec(&json!({ "id": "ses_1", "directory": null })).unwrap(),
                    ));
                }
                Ok(ServeHttpResponse::new(200, b"{}".to_vec()))
            })
        }
    }

    /// b8ke ext r22 F1 (a+c): during the REST cold-start window (the
    /// holding http keeps the POST /session open) the coordinator shows a
    /// Starting record under the pane-scoped provisional identity — a
    /// competing claim on that key is refused typed — and at the mint the
    /// SAME ticket rekeys, so the materialization commits Live at the
    /// minted `ses_1` with the provisional key left as the resolution
    /// alias.
    #[tokio::test(flavor = "multi_thread")]
    async fn rest_send_keys_window_holds_a_coordinator_starting_record() {
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let st = state().with_ownership(Arc::clone(&registry));
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateHoldingHttp {
                delay_ms: 1_500,
                fail: false,
            }),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;
        st.panes.lock().expect("panes mutex").insert(
            "pane-r22-window".to_string(),
            PaneEntry {
                placeholder_id: "freshopencode-r22-window".to_string(),
                provider: PROVIDER.into(),
                session_type: SESSION_TYPE.into(),
                cwd: Some("/w".to_string()),
                model: None,
                effort: None,
                durable_id: None,
            },
        );
        let provisional = "pending-create-pane-r22-window";

        let st2 = st.clone();
        let drive = tokio::spawn(async move {
            let mut headers = HeaderMap::new();
            headers.insert("x-auth-token", "tok".parse().unwrap());
            send_keys(
                State(st2),
                Path("pane-r22-window".to_string()),
                headers,
                Json(json!({ "text": "hello", "timeout": 0 })),
            )
            .await
        });

        // THE WINDOW: the pane-scoped provisional record is
        // Starting{FreshAgent} while the cold-start is held open (red
        // pre-r22: no record at all — the poll starves).
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe(PROVIDER, provisional).state,
                freshell_ownership::OwnershipState::Starting { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the REST cold-start window never showed the provisional \
                 Starting record (r22 F1)"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        // A competing claim on the pane-scoped key is refused typed.
        assert!(matches!(
            registry.begin_start(
                PROVIDER,
                provisional,
                freshell_ownership::RuntimeOwnerKind::Terminal,
                "op-r22-rest-compete",
                None,
                "test",
                crate::session_lease::now_epoch_ms(),
            ),
            freshell_ownership::BeginOutcome::Blocked { .. }
        ));

        // Let the drive finish: the mint rekey lands, the materialization
        // commits Live at the minted `ses_1`, and the provisional key is
        // the resolution alias.
        let resp = drive.await.expect("the drive joins");
        assert_eq!(resp.status(), StatusCode::OK);
        assert!(
            matches!(
                registry.observe(PROVIDER, "ses_1").state,
                freshell_ownership::OwnershipState::Live {
                    owner,
                    ..
                } if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent,
            ),
            "the materialization commits Live at the minted key — got {:?}",
            registry.observe(PROVIDER, "ses_1").state
        );
        assert!(
            matches!(
                registry.observe(PROVIDER, provisional).state,
                freshell_ownership::OwnershipState::Aliased { to, .. } if to == "ses_1",
            ),
            "the provisional key is the rekey family's resolution alias — got {:?}",
            registry.observe(PROVIDER, provisional).state
        );
    }

    /// b8ke ext r22 F1 (b): a spawn-time create failure during the window
    /// settles the provisional record typed through the ticket — the
    /// record is never left wedged in Starting and the drive answers the
    /// typed failure.
    #[tokio::test(flavor = "multi_thread")]
    async fn rest_send_keys_create_failure_settles_the_provisional_record() {
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let st = state().with_ownership(Arc::clone(&registry));
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateHoldingHttp {
                delay_ms: 800,
                fail: true,
            }),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;
        st.panes.lock().expect("panes mutex").insert(
            "pane-r22-fail".to_string(),
            PaneEntry {
                placeholder_id: "freshopencode-r22-fail".to_string(),
                provider: PROVIDER.into(),
                session_type: SESSION_TYPE.into(),
                cwd: Some("/w".to_string()),
                model: None,
                effort: None,
                durable_id: None,
            },
        );
        let provisional = "pending-create-pane-r22-fail";

        let st2 = st.clone();
        let drive = tokio::spawn(async move {
            let mut headers = HeaderMap::new();
            headers.insert("x-auth-token", "tok".parse().unwrap());
            send_keys(
                State(st2),
                Path("pane-r22-fail".to_string()),
                headers,
                Json(json!({ "text": "hello", "timeout": 0 })),
            )
            .await
        });

        // The window's record exists before the failure lands.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe(PROVIDER, provisional).state,
                freshell_ownership::OwnershipState::Starting { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the spawn-failure drive never showed the provisional record"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // The failure lands: the ticket's RAII typed fail settles the
        // provisional record — never a wedged Starting.
        let resp = drive.await.expect("the drive joins");
        assert!(
            !resp.status().is_success(),
            "the create failure answers the typed error"
        );
        assert!(
            matches!(
                registry.observe(PROVIDER, provisional).state,
                freshell_ownership::OwnershipState::Vacant
            ),
            "the provisional record settles typed (Vacant) — got {:?}",
            registry.observe(PROVIDER, provisional).state
        );
    }

    /// b8ke ext r22 F1 (d): the minted-key-lost race — a competitor (a
    /// terminal) owns the id the fixture will mint (`ses_1`); the
    /// mint-time rekey REFUSES typed (409), the pane is NOT bound, and
    /// the competitor's record is untouched (never two writers).
    #[tokio::test(flavor = "multi_thread")]
    async fn rest_send_keys_refuses_typed_when_the_minted_key_was_lost() {
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let st = state().with_ownership(Arc::clone(&registry));
        // The competitor: a terminal owns the minted id from before the drive.
        let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
            PROVIDER,
            "ses_1",
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-r22-terminal",
            None,
            "test",
            crate::session_lease::now_epoch_ms(),
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            registry.commit_live(
                PROVIDER,
                "ses_1",
                "op-r22-terminal",
                generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-r22".to_string()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: freshell_ownership::HoldKind::Main,
                }
            ),
            freshell_ownership::CommitOutcome::Committed
        ));

        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateHoldingHttp {
                delay_ms: 0,
                fail: false,
            }),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;
        st.panes.lock().expect("panes mutex").insert(
            "pane-r22-lost".to_string(),
            PaneEntry {
                placeholder_id: "freshopencode-r22-lost".to_string(),
                provider: PROVIDER.into(),
                session_type: SESSION_TYPE.into(),
                cwd: Some("/w".to_string()),
                model: None,
                effort: None,
                durable_id: None,
            },
        );

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let resp = send_keys(
            State(st.clone()),
            Path("pane-r22-lost".to_string()),
            headers,
            Json(json!({ "text": "hello", "timeout": 0 })),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::CONFLICT,
            "the minted-key-lost race answers the typed conflict"
        );
        // The pane is NOT bound to the minted session (the daemon-side
        // session is abandoned; the shared serve is never killed —
        // OpenCode invariant).
        assert!(
            st.panes
                .lock()
                .expect("panes mutex")
                .get("pane-r22-lost")
                .unwrap()
                .durable_id
                .is_none(),
            "the refused rekey never binds the pane"
        );
        // The competitor's record is untouched.
        assert!(matches!(
            registry.observe(PROVIDER, "ses_1").state,
            freshell_ownership::OwnershipState::Live {
                owner,
                ..
            } if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal,
        ));
        // The provisional record settles typed (the ticket's RAII drop —
        // the rekey never rekeyed it).
        assert!(matches!(
            registry
                .observe(PROVIDER, "pending-create-pane-r22-lost")
                .state,
            freshell_ownership::OwnershipState::Vacant
        ));
    }

    /// b8ke ext r26 F2: the create-GATING http — every POST /session
    /// signals its arrival and then parks until the test's release, so a
    /// concurrent REST materialization sits deterministically inside its
    /// cold-start window (the exact interleaving where the pre-r26
    /// shared operation id granted re-entry to a second drive).
    struct GatedCreateHttp {
        creates: std::sync::atomic::AtomicUsize,
        arrived_tx: tokio::sync::mpsc::UnboundedSender<()>,
        release: Arc<tokio::sync::Notify>,
    }
    impl GatedCreateHttp {
        fn creates(&self) -> usize {
            self.creates.load(Ordering::SeqCst)
        }
    }
    impl ServeHttp for GatedCreateHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                    + Send
                    + 'a,
            >,
        > {
            let is_create = matches!(req.method, freshell_opencode::serve::HttpMethod::Post)
                && (req.url.ends_with("/session") || req.url.contains("/session?"));
            if is_create {
                self.creates.fetch_add(1, Ordering::SeqCst);
                let _ = self.arrived_tx.send(());
                let release = Arc::clone(&self.release);
                return Box::pin(async move {
                    release.notified().await;
                    Ok(ServeHttpResponse::new(
                        200,
                        serde_json::to_vec(&json!({ "id": "ses_1", "directory": null })).unwrap(),
                    ))
                });
            }
            Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) })
        }
    }

    /// b8ke ext r26 F2: two CONCURRENT REST/MCP first-sends for the same
    /// unmaterialized pane materialize EXACTLY ONE durable session — the
    /// competing drive is refused typed BEFORE any provider mutation.
    /// Pre-r26 every drive shared the `rest-materialize-{paneId}`
    /// operation id and `begin_start`'s re-entry arm grants same-kind +
    /// same-op claims, so the second drive ALSO received a ticket and
    /// ALSO called `create_session` (the panes mutex is released after
    /// the pane clone, so nothing serialized them); only one drive
    /// could rekey the provisional record, leaving the other freshly
    /// minted OpenCode conversation orphaned outside coordinator
    /// ownership and typed recovery.
    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_rest_materializations_yield_exactly_one_provider_mutation() {
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let st = state().with_ownership(Arc::clone(&registry));
        let (arrived_tx, mut arrived_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let http = Arc::new(GatedCreateHttp {
            creates: std::sync::atomic::AtomicUsize::new(0),
            arrived_tx,
            release: Arc::new(tokio::sync::Notify::new()),
        });
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::clone(&http) as Arc<dyn freshell_opencode::ServeHttp>,
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;
        st.panes.lock().expect("panes mutex").insert(
            "pane-r26-race".to_string(),
            PaneEntry {
                placeholder_id: "freshopencode-r26-race".to_string(),
                provider: PROVIDER.into(),
                session_type: SESSION_TYPE.into(),
                cwd: Some("/w".to_string()),
                model: None,
                effort: None,
                durable_id: None,
            },
        );

        // Drive A: parks inside its cold-start create.
        let st_a = st.clone();
        let drive_a = tokio::spawn(async move {
            let mut headers = HeaderMap::new();
            headers.insert("x-auth-token", "tok".parse().unwrap());
            send_keys(
                State(st_a),
                Path("pane-r26-race".to_string()),
                headers,
                Json(json!({ "text": "hello", "timeout": 0 })),
            )
            .await
        });
        arrived_rx
            .recv()
            .await
            .expect("drive A reaches its provider mutation");

        // Drive B: the same pane, cloned before A's durable write-back —
        // the exact competing-request window. Post-r26 it must answer the
        // typed conflict WITHOUT any provider mutation; pre-r26 the
        // shared operation id granted it re-entry and it issued a SECOND
        // create (the test observes that as B never answering before the
        // release + a create count of 2).
        let st_b = st.clone();
        let drive_b = tokio::spawn(async move {
            let mut headers = HeaderMap::new();
            headers.insert("x-auth-token", "tok".parse().unwrap());
            send_keys(
                State(st_b),
                Path("pane-r26-race".to_string()),
                headers,
                Json(json!({ "text": "hello", "timeout": 0 })),
            )
            .await
        });
        let b_resp = tokio::time::timeout(std::time::Duration::from_secs(3), drive_b)
            .await
            .expect("the competing drive answers before any provider mutation")
            .expect("the competing drive joins");
        assert_eq!(
            b_resp.status(),
            StatusCode::CONFLICT,
            "the competing materialization is refused typed"
        );
        assert_eq!(
            http.creates(),
            1,
            "exactly ONE provider mutation — the competing drive never reached create_session"
        );

        // Release A's parked create: the materialization completes and
        // commits Live at the minted `ses_1` with the provisional alias.
        // `notify_one` stores its permit even if the waiter has not yet
        // re-registered after recording its arrival (deterministic wake).
        http.release.notify_one();
        let a_resp = tokio::time::timeout(std::time::Duration::from_secs(10), drive_a)
            .await
            .expect("drive A completes after the release")
            .expect("drive A joins");
        assert_eq!(a_resp.status(), StatusCode::OK);
        assert_eq!(http.creates(), 1, "still exactly one provider mutation");
        assert!(matches!(
            registry.observe(PROVIDER, "ses_1").state,
            freshell_ownership::OwnershipState::Live { owner, .. }
                if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
        ));
        assert!(matches!(
            registry
                .observe(PROVIDER, "pending-create-pane-r26-race")
                .state,
            freshell_ownership::OwnershipState::Aliased { to, .. } if to == "ses_1"
        ));
        assert_eq!(
            st.panes
                .lock()
                .expect("panes mutex")
                .get("pane-r26-race")
                .unwrap()
                .durable_id
                .as_deref(),
            Some("ses_1"),
            "the winning drive binds the pane"
        );
    }

    /// b8ke ext r26 F5: the REST/MCP materialization's ownership
    /// conflicts answer the ONE shared typed conflict envelope — a
    /// machine-readable `code` plus the additive `ownerKind`/
    /// `ownerGeneration` pair the coordinator knows (pre-r26 both the
    /// Adopt and Refused arms used the prose-only `fail_json` shape, so
    /// MCP and REST callers could not distinguish a live owner from an
    /// in-progress transition).
    async fn send_keys_and_read_body(st: &FreshAgentState, pane_id: &str) -> (StatusCode, Value) {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let resp = send_keys(
            State(st.clone()),
            Path(pane_id.to_string()),
            headers,
            Json(json!({ "text": "hello", "timeout": 0 })),
        )
        .await;
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn insert_unmaterialized_pane(st: &FreshAgentState, pane_id: &str) {
        st.panes.lock().expect("panes mutex").insert(
            pane_id.to_string(),
            PaneEntry {
                placeholder_id: format!("freshopencode-{pane_id}"),
                provider: PROVIDER.into(),
                session_type: SESSION_TYPE.into(),
                cwd: Some("/w".to_string()),
                model: None,
                effort: None,
                durable_id: None,
            },
        );
    }

    async fn rest_materialization_state() -> (
        FreshAgentState,
        Arc<freshell_ownership::RuntimeOwnershipRegistry>,
    ) {
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let st = state().with_ownership(Arc::clone(&registry));
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateCapableHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;
        (st, registry)
    }

    /// The Adopt conflict: the pane-scoped key resolves through its
    /// alias to a LIVE same-kind owner (an earlier materialization
    /// completed) — the duplicate drive answers the typed envelope with
    /// the owner's kind + generation, never prose.
    #[tokio::test(flavor = "multi_thread")]
    async fn rest_materialization_adopt_conflict_answers_the_typed_owner_envelope() {
        let (st, registry) = rest_materialization_state().await;
        insert_unmaterialized_pane(&st, "pane-r26-adopt");
        // The earlier materialization's end state: Live{FreshAgent} under
        // the durable id, and the pane's provisional key aliased to it
        // (the REST lane's own placeholder-alias step).
        let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
            PROVIDER,
            "ses_r26_adopt",
            freshell_ownership::RuntimeOwnerKind::FreshAgent,
            "op-r26-earlier",
            None,
            "test",
            crate::session_lease::now_epoch_ms(),
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            registry.commit_live(
                PROVIDER,
                "ses_r26_adopt",
                "op-r26-earlier",
                generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("ses_r26_adopt".to_string()),
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: freshell_ownership::HoldKind::Main,
                }
            ),
            freshell_ownership::CommitOutcome::Committed
        ));
        assert!(matches!(
            registry.alias_vacant_key(
                PROVIDER,
                "pending-create-pane-r26-adopt",
                "ses_r26_adopt",
                "op-r33-alias-adopt",
                "test"
            ),
            freshell_ownership::CommitOutcome::Committed
        ));

        let (status, body) = send_keys_and_read_body(&st, "pane-r26-adopt").await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["status"], json!("error"));
        assert_eq!(
            body["code"],
            json!("SESSION_RESERVED"),
            "the Adopt conflict carries the machine-readable code"
        );
        assert_eq!(
            body["ownerKind"],
            json!("fresh-agent"),
            "the envelope names the live owner's kind"
        );
        assert_eq!(
            body["ownerGeneration"],
            json!(generation),
            "the envelope names the live owner's generation"
        );
    }

    /// The Refused conflict: a lifecycle transition holds the pane-scoped
    /// key (another materialization's in-flight Starting) — the competing
    /// drive answers the typed envelope before any provider mutation.
    #[tokio::test(flavor = "multi_thread")]
    async fn rest_materialization_refused_conflict_answers_the_typed_envelope() {
        let (st, registry) = rest_materialization_state().await;
        insert_unmaterialized_pane(&st, "pane-r26-refused");
        // A competing drive's in-flight start under the pane-scoped key.
        assert!(matches!(
            registry.begin_start(
                PROVIDER,
                "pending-create-pane-r26-refused",
                freshell_ownership::RuntimeOwnerKind::FreshAgent,
                "op-r26-holder",
                None,
                "test",
                crate::session_lease::now_epoch_ms(),
            ),
            freshell_ownership::BeginOutcome::Granted { .. }
        ));

        let (status, body) = send_keys_and_read_body(&st, "pane-r26-refused").await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["status"], json!("error"));
        assert_eq!(
            body["code"],
            json!("SESSION_RESERVED"),
            "the refused claim carries the machine-readable code"
        );
    }

    /// The stale-commit conflict: the coordinator moved on while the
    /// materialization registered (here: the record failed out from
    /// under the parked binding-row write) — the drive answers the typed
    /// envelope, never prose.
    #[tokio::test(flavor = "multi_thread")]
    async fn rest_materialization_commit_stale_answers_the_typed_envelope() {
        let (st, registry) = rest_materialization_state().await;
        let fake = Arc::new(identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        insert_unmaterialized_pane(&st, "pane-r26-stale");
        // Park the materialization inside its durable binding-row write
        // (post-mint, pre-commit — the registration window).
        let stall = fake.arm_binding_stall(PROVIDER, "ses_1");
        let st_drive = st.clone();
        let drive =
            tokio::spawn(async move { send_keys_and_read_body(&st_drive, "pane-r26-stale").await });

        // The materialization parks: the rekeyed canonical record is
        // Starting under ses_1. Move the coordinator on (the watchdog's
        // own recovery shape for a concluded start) and release the park.
        stall
            .entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the materialization parks at its binding write");
        let (held_op, held_generation) = match registry.observe(PROVIDER, "ses_1").state {
            freshell_ownership::OwnershipState::Starting {
                operation_id,
                generation,
                ..
            } => (operation_id, generation),
            other => panic!("expected the rekeyed Starting record, got {other:?}"),
        };
        assert!(matches!(
            registry.fail(PROVIDER, "ses_1", &held_op, held_generation, false),
            freshell_ownership::FailOutcome::Released
        ));
        stall.release.send(()).expect("release the stalled write");

        let (status, body) = drive.await.expect("the drive completes after the release");
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(body["status"], json!("error"));
        assert_eq!(
            body["code"],
            json!("SESSION_RESERVED"),
            "the stale commit carries the machine-readable code"
        );
        assert!(
            body.get("ownerKind").is_none() || body["ownerKind"].is_null(),
            "a vacated key honestly reports no live owner"
        );
    }

    /// Task 3 (corrected semantics — this test previously asserted the WAVE-B
    /// no-laundering SKIP): lineage recording is UNCONDITIONAL. A REST-created
    /// pane with NO model/effort/cwd (the all-blank shape) still records its
    /// materialization binding — the row's `create_request_id` lineage is what
    /// lets a placeholder-keyed pane resolve to its durable `ses_*` session via
    /// `lookup_by_create_request_id` after a restart. The false-SETTINGS_RESET
    /// hazard the skip was built against moved to the `was_recorded` keying:
    /// a lineage-only row answers `was_recorded == false` and
    /// `load_settings == None`, so no alarm arms on a later resume.
    #[tokio::test]
    async fn rest_send_keys_materialization_records_lineage_for_all_blank_settings() {
        let st = state();
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateCapableHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;

        let fake = Arc::new(identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        // A REST-created pane with NO model/effort/cwd -- the all-blank shape.
        st.panes.lock().expect("panes mutex").insert(
            "pane-blank".to_string(),
            PaneEntry {
                placeholder_id: "freshopencode-b1".to_string(),
                provider: PROVIDER.into(),
                session_type: SESSION_TYPE.into(),
                cwd: None,
                model: None,
                effort: None,
                durable_id: None,
            },
        );

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let _resp = send_keys(
            State(st.clone()),
            Path("pane-blank".to_string()),
            headers,
            Json(json!({ "text": "hello", "timeout": 0 })),
        )
        .await;

        // The lineage row EXISTS: unconditional recording, placeholder-derived
        // create_request_id, blank settings payload.
        let b = {
            let bindings = fake.bindings.lock().unwrap();
            bindings
                .iter()
                .find(|b| b.session_id == "ses_1")
                .expect("lineage binding recorded even for an all-blank settings snapshot")
                .clone()
        };
        assert_eq!(b.provider, "opencode");
        assert_eq!(b.mode, "freshopencode");
        assert_eq!(
            b.create_request_id.as_deref(),
            Some("b1"),
            "lineage key derived from the pane's placeholder id"
        );
        assert_eq!(b.resolves_pending.as_deref(), Some("freshopencode-b1"));
        assert_eq!(
            b.settings,
            identity_sink::FreshAgentSettings::default(),
            "blank settings payload is recorded verbatim"
        );

        // ...but a lineage-only row is NOT a settings-bearing record: the
        // `was_recorded` keying (Task 3 semantics) keeps a later resume from
        // arming a FALSE SETTINGS_RESET for this legitimately-default create.
        assert!(
            fake.load_settings("opencode", "ses_1").is_none(),
            "lineage-only row answers no settings snapshot"
        );
        assert!(
            !fake.was_recorded("opencode", "ses_1"),
            "lineage-only row must not count as recorded (false SETTINGS_RESET)"
        );
    }

    // -- Unified agent names (Task 8): the REST opencode feed + T2-I3 composition --

    /// The T2-M3/T4-M3 REST feed lane pin: the REST opencode send lane
    /// (`POST /api/panes/:id/send-keys`, the headless automation surface
    /// with no browser composer) feeds the naming authority ONE
    /// accepted-input activity targeting the pane's DURABLE `ses_*`
    /// identity — the materialization bind consumed the stashed handle
    /// before the feed, so the durable fallback must win (a wrong stash key
    /// or missed fallback would redden this pin).
    #[tokio::test]
    async fn rest_opencode_send_feeds_the_naming_authority_once() {
        let st = state();
        let sink = crate::naming::test_support::RecordingSink::new();
        st.set_session_naming(sink.clone());
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateCapableHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;

        st.panes.lock().expect("panes mutex").insert(
            "pane-rest-feed".to_string(),
            PaneEntry {
                placeholder_id: "freshopencode-feed1".to_string(),
                provider: PROVIDER.into(),
                session_type: SESSION_TYPE.into(),
                cwd: Some("/w".to_string()),
                model: None,
                effort: None,
                durable_id: None,
            },
        );
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let _resp = send_keys(
            State(st.clone()),
            Path("pane-rest-feed".to_string()),
            headers,
            Json(json!({ "text": "hello from REST", "timeout": 0 })),
        )
        .await;

        let activities = sink.activities.lock().unwrap();
        assert_eq!(activities.len(), 1, "{activities:?}");
        assert_eq!(
            activities[0].target,
            freshell_protocol::session_names::SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Opencode,
                session_id: "ses_1".to_string(),
            }
        );
        assert_eq!(activities[0].mode, "freshopencode");
        assert_eq!(
            activities[0].first_user_message.as_deref(),
            Some("hello from REST")
        );
        assert_eq!(
            activities[0].reason,
            crate::naming::NameActivityReason::AcceptedUserMessage
        );
    }

    /// The T2-I3 REST-create+send composition pin (Task 8): a REST create
    /// with `name` seeds the pending record through EXACTLY ONE automatic
    /// rename (an agent/API suggestion never acquires a user rename's
    /// permanence), and the send's accepted-input activity then arms on the
    /// SAME identity — the bind transfers the seeded record onto the durable
    /// id and the activity targets that durable id exactly once. No double
    /// feed, no suppressed seed: the two lanes compose on one record.
    #[tokio::test]
    async fn rest_create_with_name_and_send_compose_on_one_naming_identity() {
        let st = state();
        let sink = crate::naming::test_support::RecordingSink::new();
        st.set_session_naming(sink.clone());
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateCapableHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;

        // REST create with a name — the seeded record path (T2-I3).
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let resp = create_tab(
            State(st.clone()),
            headers,
            Json(json!({ "agent": "opencode", "cwd": "/w/compose", "name": "Seeded REST name" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let (pane_key, pane_entry) = {
            let panes = st.panes.lock().expect("panes mutex");
            let (key, entry) = panes.iter().next().expect("the pane was created");
            (key.clone(), entry.clone())
        };
        let handle = st
            .peek_naming_handle(&pane_entry.placeholder_id)
            .expect("the create stashed the pre-durable handle");

        // The seed: EXACTLY ONE automatic rename onto the pending handle.
        {
            let renames = sink.renames.lock().unwrap();
            assert_eq!(renames.len(), 1, "{renames:?}");
            assert_eq!(
                renames[0].target,
                freshell_protocol::session_names::SessionNameRef::Pending { id: handle.clone() }
            );
            assert_eq!(renames[0].name, "Seeded REST name");
            assert_eq!(
                renames[0].intent,
                freshell_protocol::session_names::NameIntent::Automatic
            );
        }

        // The send: ONE activity on the DURABLE identity (the bind consumed
        // the stash first), and the seeded record TRANSFERRED onto it —
        // compose, never suppress.
        let mut send_headers = HeaderMap::new();
        send_headers.insert("x-auth-token", "tok".parse().unwrap());
        let _resp = send_keys(
            State(st.clone()),
            Path(pane_key),
            send_headers,
            Json(json!({ "text": "compose probe", "timeout": 0 })),
        )
        .await;
        {
            let activities = sink.activities.lock().unwrap();
            assert_eq!(
                activities.len(),
                1,
                "the send feeds exactly one activity (no double-eligibility feed): {activities:?}"
            );
            assert_eq!(
                activities[0].target,
                freshell_protocol::session_names::SessionNameRef::Session {
                    provider: freshell_protocol::session_names::NamedProvider::Opencode,
                    session_id: "ses_1".to_string(),
                }
            );
            assert_eq!(
                activities[0].first_user_message.as_deref(),
                Some("compose probe")
            );
        }
        let durable_ref = freshell_protocol::session_names::SessionNameRef::Session {
            provider: freshell_protocol::session_names::NamedProvider::Opencode,
            session_id: "ses_1".to_string(),
        };
        let transferred = sink
            .get(vec![durable_ref])
            .await
            .expect("get resolves")
            .into_iter()
            .next()
            .expect("the durable record exists after the bind");
        assert_eq!(
            transferred.record.name, "Seeded REST name",
            "the seeded record transferred onto the durable identity (composed, not suppressed)"
        );
    }

    // -- Task 3: REST create_tab records the pending identity marker --

    /// Mirrors the WS create path (`opencode_ws.rs` `handle_create`): POST
    /// /api/tabs for a fresh-agent pane must write a pending marker under the
    /// pane's placeholder id (`freshopencode-<createRequestId>`), AWAITED
    /// before the tab.create broadcast (durable-before-answer). Without the
    /// marker, a crash between create and materialization leaves no evidence
    /// identity establishment was in flight.
    #[tokio::test]
    async fn create_tab_records_pending_marker() {
        let st = state();
        let fake = Arc::new(identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let resp = create_tab(
            State(st.clone()),
            headers,
            Json(json!({ "agent": "opencode", "cwd": "/w" })),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let placeholder = st
            .panes
            .lock()
            .expect("panes mutex")
            .values()
            .next()
            .expect("the pane was created")
            .placeholder_id
            .clone();
        assert!(placeholder.starts_with("freshopencode-"));
        let pendings = fake.pendings.lock().unwrap();
        assert!(
            pendings.iter().any(|(id, mode, cwd)| id == &placeholder
                && mode == "freshopencode"
                && cwd.as_deref() == Some("/w")),
            "pending marker recorded at REST create under the placeholder id: {pendings:?}"
        );
    }

    /// The pending write must never block the create (failure policy parity
    /// with the WS path): a failed write surfaces as a user-visible
    /// `LEDGER_WRITE_FAILED` `freshAgent.error` broadcast AND the pane is
    /// still created.
    #[tokio::test]
    async fn create_tab_pending_write_failure_broadcasts_ledger_write_failed_and_still_creates() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let fake = Arc::new(identity_sink::FakeIdentitySink::default());
        fake.fail_writes
            .store(true, std::sync::atomic::Ordering::SeqCst);
        st.set_identity_sink(fake.clone());

        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let resp = create_tab(
            State(st.clone()),
            headers,
            Json(json!({ "agent": "opencode", "cwd": "/w" })),
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::OK,
            "a failed marker write never blocks the create"
        );

        let placeholder = st
            .panes
            .lock()
            .expect("panes mutex")
            .values()
            .next()
            .expect("the pane was created despite the write failure")
            .placeholder_id
            .clone();

        let mut saw_ledger_write_failed = false;
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await
        {
            let Ok(text) = frame else { break };
            if text.contains("LEDGER_WRITE_FAILED") {
                let v: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(v["provider"], "opencode");
                assert_eq!(v["sessionType"], "freshopencode");
                assert_eq!(v["sessionId"], placeholder);
                saw_ledger_write_failed = true;
            }
        }
        assert!(
            saw_ledger_write_failed,
            "a failed pending write must surface a user-visible LEDGER_WRITE_FAILED frame"
        );
    }

    // -- Batch D PR-6: rich transcript items for the opencode snapshot endpoint --

    #[test]
    fn opencode_item_from_part_tool_part_renders_dynamic_tool_kind_with_exact_schema_keys() {
        let part = json!({
            "type": "tool", "id": "part-1", "tool": "bash",
            "state": { "status": "completed", "input": { "command": "ls" }, "output": "a.txt\n" },
        });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(
            items[0],
            json!({
                "id": "part-1", "kind": "dynamic_tool", "namespace": "opencode", "tool": "bash",
                "status": "completed", "arguments": { "command": "ls" }, "contentItems": ["a.txt\n"], "success": true,
            })
        );
    }

    #[test]
    fn opencode_item_from_part_running_tool_has_no_content_items_or_success() {
        let part = json!({ "type": "tool", "id": "part-2", "tool": "bash", "state": { "status": "running", "input": {} } });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(items[0]["status"], json!("running"));
        assert_eq!(items[0]["contentItems"], Value::Null);
        assert_eq!(items[0]["success"], Value::Null);
    }

    #[test]
    fn opencode_item_from_part_error_tool_carries_the_persisted_state_error_text() {
        // LB-3: a persisted failed tool part has non-empty `state.error` and no
        // `state.output`; the TUI renders that text as the failure body. The
        // projection must carry it on the item.
        let part = json!({
            "type": "tool", "id": "part-err", "tool": "bash",
            "state": {
                "status": "error",
                "input": { "command": "false" },
                "error": "The user has specified a rule which prevents you from using this specific tool call.",
            },
        });

        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);

        assert_eq!(items[0]["status"], json!("failed"));
        assert_eq!(
            items[0]["contentItems"],
            Value::Null,
            "failed persisted parts carry no state.output"
        );
        assert_eq!(
            items[0]["error"],
            json!("The user has specified a rule which prevents you from using this specific tool call.")
        );
    }

    #[test]
    fn opencode_item_from_part_blank_tool_error_is_dropped() {
        let part = json!({
            "type": "tool", "id": "part-err-blank", "tool": "bash",
            "state": { "status": "error", "input": {}, "error": "   " },
        });

        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);

        assert!(
            items[0].get("error").is_none(),
            "a blank persisted error carries no text"
        );
    }

    #[test]
    fn opencode_item_from_part_completed_and_running_tool_with_lingering_error_omit_the_key() {
        // The brief's item interface: the `error` key is present exactly when the
        // part is `state.status:"error"`. A completed/running part that lingers
        // with a non-blank `state.error` (a future fixture or malformed serve
        // response) must stay byte-identical to a part carrying no error at all.
        for status in ["completed", "running"] {
            let part = json!({
                "type": "tool", "id": "part-lingering-err", "tool": "bash",
                "state": {
                    "status": status,
                    "input": { "command": "ls" },
                    "output": "a.txt\n",
                    "error": "stale text from a previous attempt",
                },
            });

            let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);

            assert_eq!(items[0]["status"], json!(status));
            assert!(
                items[0].get("error").is_none(),
                "the error key is present only for state.status:\"error\" parts, got {status}"
            );
        }
    }

    #[test]
    fn opencode_message_turn_json_projects_the_persisted_unknown_error_verbatim() {
        // The exact persisted shape of the real provider request-deadline failure:
        // `fromError` JSON.stringify's the plain `{message,type}` stream error into
        // `UnknownError.data.message` (request_deadline_exceeded is embedded text,
        // never a structured field). The TUI helper emits a string `data.message`
        // verbatim, so the projection must too.
        let raw = r#"{"message":"request deadline exceeded after 1195s before the response completed","type":"request_deadline_exceeded"}"#;
        let message = json!({
            "info": {
                "id": "msg-deadline",
                "role": "assistant",
                "error": { "name": "UnknownError", "data": { "message": raw } },
            },
            "parts": [{ "type": "step-start" }],
        });

        let turn = opencode_message_turn_json(&message, 0).expect("error-only turn builds");

        assert_eq!(
            turn["items"],
            json!([]),
            "the real deadline message has no displayable parts"
        );
        assert_eq!(turn["error"]["name"], json!("UnknownError"));
        assert_eq!(
            turn["error"]["message"],
            Value::String(raw.to_string()),
            "the raw persisted string is surfaced as-is, matching the CLI"
        );
    }

    #[test]
    fn opencode_message_turn_json_renders_a_messageless_error_as_cli_pretty_json() {
        // LB-4: MessageOutputLengthError persists `data: {}`; the TUI helper
        // falls through to `errorFormat`'s `JSON.stringify(error, null, 2)`.
        // With the workspace serde_json `preserve_order` feature the key order
        // follows the wire (`name` then `data`), byte-identical to the CLI.
        let message = json!({
            "info": {
                "id": "msg-len",
                "role": "assistant",
                "error": { "name": "MessageOutputLengthError", "data": {} },
            },
            "parts": [{ "type": "step-start" }],
        });

        let turn = opencode_message_turn_json(&message, 0).expect("turn builds");

        assert_eq!(turn["error"]["name"], json!("MessageOutputLengthError"));
        assert_eq!(
            turn["error"]["message"],
            json!("{\n  \"name\": \"MessageOutputLengthError\",\n  \"data\": {}\n}")
        );
    }

    #[test]
    fn opencode_message_turn_json_projects_message_aborted_error() {
        let message = json!({
            "info": {
                "id": "msg-abort",
                "role": "assistant",
                "error": { "name": "MessageAbortedError", "data": { "message": "Aborted" } },
            },
            "parts": [],
        });

        let turn = opencode_message_turn_json(&message, 0).expect("turn builds");

        assert_eq!(
            turn["error"],
            json!({ "name": "MessageAbortedError", "message": "Aborted" })
        );
        assert_eq!(turn["items"], json!([]));
    }

    #[test]
    fn opencode_message_turn_json_omits_error_for_a_normal_assistant_turn() {
        let message = json!({
            "info": { "id": "msg-ok", "role": "assistant" },
            "parts": [{ "type": "text", "text": "all good" }],
        });

        let turn = opencode_message_turn_json(&message, 0).expect("turn builds");

        assert!(
            turn.get("error").is_none(),
            "a turn without info.error stays byte-identical"
        );
    }

    #[test]
    fn opencode_message_turn_json_ignores_a_malformed_error_payload() {
        let message = json!({
            "info": { "id": "msg-bad", "role": "assistant", "error": "boom" },
            "parts": [{ "type": "text", "text": "still renders" }],
        });

        let turn = opencode_message_turn_json(&message, 0).expect("turn builds");

        assert!(
            turn.get("error").is_none(),
            "a non-object error is never fatal"
        );
        assert_eq!(turn["items"][0]["text"], json!("still renders"));
    }

    #[test]
    fn opencode_item_from_part_patch_renders_file_change_kind_with_exact_schema_keys() {
        let part = json!({ "type": "patch", "id": "part-3", "files": ["src/main.rs"] });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(
            items[0],
            json!({
                "id": "part-3", "kind": "file_change", "status": "completed",
                "changes": [{ "path": "src/main.rs" }], "extensions": { "opencode": part },
            })
        );
    }

    #[test]
    fn opencode_item_from_part_reasoning_renders_reasoning_kind() {
        let part = json!({ "type": "reasoning", "id": "part-4", "text": "considering options" });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(
            items[0],
            json!({
                "id": "part-4", "kind": "reasoning",
                "summary": ["considering options"], "content": ["considering options"], "text": "considering options",
            })
        );
    }

    #[test]
    fn opencode_item_from_part_structural_step_start_is_skipped_matching_reference_default() {
        let part = json!({ "type": "step-start", "id": "part-5" });
        assert_eq!(
            opencode_item_from_part(&part, "fallback", Some("assistant"), false),
            Vec::<Value>::new()
        );
    }

    // -- Fix task: opencode <think>/<thinking> leakage segmentation --

    #[test]
    fn opencode_item_from_part_balanced_think_tag_splits_into_thinking_and_text_items() {
        let part = json!({
            "type": "text", "id": "part-6",
            "text": "Before.<thinking>reasoning here</thinking>After.",
        });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        // Text-before + thinking + text-after: 3 segments around the one balanced pair.
        assert_eq!(
            items.len(),
            3,
            "text-before + thinking + text-after: {items:?}"
        );
        assert_eq!(items[0]["kind"], json!("text"));
        assert_eq!(items[0]["text"], json!("Before."));
        assert_eq!(items[1]["kind"], json!("thinking"));
        assert_eq!(items[1]["text"], json!("reasoning here"));
        assert_eq!(items[2]["kind"], json!("text"));
        assert_eq!(items[2]["text"], json!("After."));
        // Multi-segment ids are suffixed by kind + index (over the visible/filtered list).
        assert_eq!(items[0]["id"], json!("part-6:text-0"));
        assert_eq!(items[1]["id"], json!("part-6:thinking-1"));
        assert_eq!(items[2]["id"], json!("part-6:text-2"));
    }

    #[test]
    fn opencode_item_from_part_balanced_think_short_tag_alias_also_segments() {
        // `<think>`/`</think>` is an accepted alias for `<thinking>`/`</thinking>`
        // (`THINK_OPEN_TAG_PATTERN`/`BALANCED_THINK_TAG_PATTERN`, normalize.ts:106-108).
        let part =
            json!({ "type": "text", "id": "part-7", "text": "<think>quiet plan</think>Ready." });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["kind"], json!("thinking"));
        assert_eq!(items[0]["text"], json!("quiet plan"));
        assert_eq!(items[1]["kind"], json!("text"));
        assert_eq!(items[1]["text"], json!("Ready."));
    }

    #[test]
    fn opencode_item_from_part_text_without_any_think_tag_is_unchanged() {
        let part = json!({ "type": "text", "id": "part-8", "text": "Ran the command." });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(
            items,
            vec![json!({ "id": "part-8", "kind": "text", "text": "Ran the command." })]
        );
    }

    #[test]
    fn opencode_item_from_part_unbalanced_open_tag_only_splits_text_before_and_thinking_after() {
        // No closing tag at all -- an unbalanced OPEN-only leak. Everything after the open tag
        // is orphaned reasoning content; everything before is ordinary text.
        let part = json!({ "type": "text", "id": "part-9", "text": "Plan:<thinking>still going" });
        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["kind"], json!("text"));
        assert_eq!(items[0]["text"], json!("Plan:"));
        assert_eq!(items[1]["kind"], json!("thinking"));
        assert_eq!(items[1]["text"], json!("still going"));
    }

    #[test]
    fn opencode_item_from_part_user_text_is_never_segmented_even_with_think_tags() {
        // Segmentation is an assistant-text-leakage workaround; user-authored text passes
        // through the run-argument-quote-stripping path only, tags and all.
        let part = json!({ "type": "text", "id": "part-10", "text": "<thinking>not reasoning</thinking>" });
        let items = opencode_item_from_part(&part, "fallback", Some("user"), false);
        assert_eq!(
            items,
            vec![
                json!({ "id": "part-10", "kind": "text", "text": "<thinking>not reasoning</thinking>" })
            ]
        );
    }

    // -- freshopencode TUI parity: reasoning duration/title, task delegations, retries, subtasks --

    #[test]
    fn opencode_item_from_part_reasoning_part_carries_duration_without_title() {
        let items = opencode_item_from_part(
            &json!({
                "type": "reasoning", "id": "part_r1", "text": "weighing options",
                "time": { "start": 1789417896153i64, "end": 1789417897984i64 },
                "metadata": { "anthropic": { "signature": "sig" } }
            }),
            "fallback",
            Some("assistant"),
            false,
        );
        assert_eq!(
            items,
            vec![json!({
                "id": "part_r1", "kind": "reasoning",
                "summary": ["weighing options"], "content": ["weighing options"],
                "text": "weighing options", "durationMs": 1831u64
            })]
        );
    }

    #[test]
    fn opencode_item_from_part_reasoning_without_time_has_no_duration() {
        let items = opencode_item_from_part(
            &json!({ "type": "reasoning", "id": "part_r2", "text": "hmm" }),
            "fallback",
            Some("assistant"),
            false,
        );
        assert_eq!(items[0].get("durationMs"), None);
        assert_eq!(items[0].get("title"), None);
    }

    #[test]
    fn opencode_item_from_part_reasoning_leading_bold_block_becomes_title() {
        // Mirrors the opencode TUI's reasoningSummary (thinking.ts): a leading bold
        // block "**Title**" followed by a blank line is disclosure metadata.
        let items = opencode_item_from_part(
            &json!({
                "type": "reasoning", "id": "part_r3",
                "text": "**Planning the fix**\n\nweighing options",
                "time": { "start": 1000, "end": 4200 }
            }),
            "fallback",
            Some("assistant"),
            false,
        );
        assert_eq!(items[0]["durationMs"], json!(3200u64));
        assert_eq!(items[0]["title"], json!("Planning the fix"));
        assert_eq!(items[0]["text"], json!("weighing options"));
        assert_eq!(items[0]["summary"], json!(["weighing options"]));
    }

    #[test]
    fn opencode_item_from_part_reasoning_bold_title_awaiting_body_is_title_only() {
        // The TUI also treats a complete title still awaiting its body (streaming)
        // as disclosure metadata: "**Title**" with nothing after it.
        let items = opencode_item_from_part(
            &json!({ "type": "reasoning", "id": "part_r4", "text": "**Planning**" }),
            "fallback",
            Some("assistant"),
            false,
        );
        assert_eq!(items[0]["title"], json!("Planning"));
        assert_eq!(items[0]["summary"], json!([]));
    }

    #[test]
    fn opencode_item_from_part_reasoning_bold_without_blank_line_is_not_a_title() {
        // No blank line after the bold block => the TUI regex does not match; the
        // text stays whole and no title is emitted.
        let items = opencode_item_from_part(
            &json!({ "type": "reasoning", "id": "part_r5", "text": "**bold intro** still the same paragraph" }),
            "fallback",
            Some("assistant"),
            false,
        );
        assert_eq!(items[0].get("title"), None);
        assert_eq!(
            items[0]["text"],
            json!("**bold intro** still the same paragraph")
        );
    }

    #[test]
    fn opencode_item_from_part_task_tool_part_becomes_task_delegation() {
        let items = opencode_item_from_part(
            &json!({
                "type": "tool", "tool": "task", "id": "part_t1",
                "state": {
                    "status": "completed",
                    "input": { "description": "Fix the flaky harness", "prompt": "…", "subagent_type": "general" },
                    "metadata": { "parentSessionId": "ses_p", "sessionId": "ses_c", "model": { "modelID": "m", "providerID": "p" } },
                    "output": "<task id=\"ses_c\" state=\"completed\"><task_result>ok</task_result></task>",
                    "title": "Fix the flaky harness",
                    "time": { "start": 1000, "end": 3000 }
                }
            }),
            "fallback",
            Some("assistant"),
            false,
        );
        // The <task …><task_result>…</task_result></task> envelope is unwrapped:
        // users see the task-result content, never the internal markup.
        assert_eq!(
            items,
            vec![json!({
                "id": "part_t1", "kind": "task_delegation", "status": "completed",
                "title": "General Task — Fix the flaky harness",
                "description": "Fix the flaky harness", "subagent": "general", "background": false,
                "childSessionId": "ses_c", "startedAtMs": 1000i64, "endedAtMs": 3000i64,
                "durationMs": 2000u64,
                "result": "ok"
            })]
        );
    }

    #[test]
    fn opencode_task_result_text_unwraps_envelope_and_passes_raw_through() {
        assert_eq!(
            opencode_task_result_text("<task id=\"x\" state=\"completed\"><task_result>\n  all green  \n</task_result></task>"),
            "all green"
        );
        assert_eq!(opencode_task_result_text("plain output"), "plain output");
        assert_eq!(opencode_task_result_text(""), "");
    }

    #[test]
    fn opencode_item_from_part_task_tool_part_minimal_has_title_and_no_child() {
        let items = opencode_item_from_part(
            &json!({ "type": "tool", "tool": "task", "id": "part_t2",
                "state": { "status": "running", "input": { "description": "Do things" } } }),
            "fallback",
            Some("assistant"),
            false,
        );
        assert_eq!(items[0]["kind"], json!("task_delegation"));
        assert_eq!(items[0]["title"], json!("General Task — Do things"));
        assert_eq!(items[0].get("childSessionId"), None);
        assert_eq!(items[0].get("result"), None);
    }

    #[test]
    fn opencode_item_from_part_task_tool_part_background_and_custom_subagent() {
        let items = opencode_item_from_part(
            &json!({ "type": "tool", "tool": "task", "id": "part_t3",
                "state": { "status": "error", "input": { "description": "side quest", "subagent_type": "fixer" },
                           "metadata": { "background": true, "sessionId": "ses_bg" } } }),
            "fallback",
            Some("assistant"),
            false,
        );
        assert_eq!(
            items[0]["title"],
            json!("Fixer Task (background) — side quest")
        );
        assert_eq!(items[0]["status"], json!("failed"));
        assert_eq!(items[0]["background"], json!(true));
        assert_eq!(items[0]["childSessionId"], json!("ses_bg"));
    }

    #[test]
    fn opencode_item_from_part_retry_part_becomes_retry_item() {
        // Authoritative serialized shape: NamedError.toObject() => {name, data:{message,…}}
        // (retry.ts reads error.data.message).
        let items = opencode_item_from_part(
            &json!({ "type": "retry", "id": "part_rr1", "attempt": 2,
                     "error": { "name": "APIError", "data": { "message": "stream disconnected" } } }),
            "fallback",
            Some("assistant"),
            false,
        );
        assert_eq!(
            items,
            vec![json!({
                "id": "part_rr1", "kind": "retry", "attempt": 2i64, "error": "stream disconnected"
            })]
        );
    }

    #[test]
    fn opencode_item_from_part_retry_part_defaults_attempt_and_string_error() {
        let items = opencode_item_from_part(
            &json!({ "type": "retry", "id": "part_rr2", "error": "boom" }),
            "fallback",
            Some("assistant"),
            false,
        );
        assert_eq!(items[0]["attempt"], json!(1i64));
        assert_eq!(items[0]["error"], json!("boom"));
    }

    #[test]
    fn opencode_item_from_part_subtask_part_becomes_delegated_task() {
        let items = opencode_item_from_part(
            &json!({ "type": "subtask", "id": "part_s1", "agent": "general",
                     "description": "Fix the flaky harness", "command": "/fix" }),
            "fallback",
            Some("user"),
            false,
        );
        assert_eq!(
            items,
            vec![json!({
                "id": "part_s1", "kind": "delegated_task", "agent": "general",
                "description": "Fix the flaky harness", "command": "/fix"
            })]
        );
    }

    #[test]
    fn opencode_child_activity_preview_formats_common_tools() {
        assert_eq!(
            opencode_child_activity_preview(
                "bash",
                &json!({ "command": "sed -n 92,112p src/store/paneTypes.ts" })
            ),
            "sed -n 92,112p src/store/paneTypes.ts"
        );
        assert_eq!(
            opencode_child_activity_preview("read", &json!({ "filePath": "src/index.css" })),
            "src/index.css"
        );
        assert_eq!(
            opencode_child_activity_preview("grep", &json!({ "pattern": "reasoningEffort" })),
            "reasoningEffort"
        );
        assert_eq!(
            opencode_child_activity_preview("glob", &json!({ "pattern": "*.rs" })),
            "*.rs"
        );
        assert_eq!(
            opencode_child_activity_preview("task", &json!({ "description": "inner task" })),
            "inner task"
        );
        assert_eq!(
            opencode_child_activity_preview(
                "webfetch",
                &json!({ "url": "https://example.test/x" })
            ),
            "https://example.test/x"
        );
        assert_eq!(
            opencode_child_activity_preview("unknown", &json!({ "a": "b" })),
            r#"{"a":"b"}"#
        );
    }

    #[test]
    fn opencode_child_activity_rows_collects_tool_parts_from_child_messages() {
        let messages = json!([
            { "info": { "id": "m_u", "role": "user" }, "parts": [
                { "type": "subtask", "agent": "general", "description": "Fix the flaky harness" },
                { "type": "text", "text": "go" } ] },
            { "info": { "id": "m_a", "role": "assistant" }, "parts": [
                { "type": "reasoning", "text": "hmm" },
                { "type": "tool", "tool": "bash", "state": { "status": "completed", "input": { "command": "sed -n 92,112p src/store/paneTypes.ts" } } },
                { "type": "tool", "tool": "grep", "state": { "status": "error", "input": { "pattern": "reasoningEffort" } } },
                { "type": "tool", "tool": "read", "state": { "status": "running", "input": { "filePath": "src/index.css" } } } ] },
        ]);
        let rows = opencode_child_activity_rows(messages.as_array().unwrap());
        assert_eq!(
            rows,
            vec![
                json!({ "tool": "bash", "status": "completed", "preview": "sed -n 92,112p src/store/paneTypes.ts" }),
                json!({ "tool": "grep", "status": "failed", "preview": "reasoningEffort" }),
                json!({ "tool": "read", "status": "running", "preview": "src/index.css" }),
            ]
        );
    }

    #[test]
    fn opencode_child_activity_rows_cap_at_200() {
        let parts: Vec<Value> = (0..250)
            .map(|i| json!({ "type": "tool", "tool": "bash", "state": { "status": "completed", "input": { "command": format!("echo {i}") } } }))
            .collect();
        let messages = vec![json!({ "info": { "id": "m", "role": "assistant" }, "parts": parts })];
        assert_eq!(opencode_child_activity_rows(&messages).len(), 200);
    }

    #[test]
    fn background_delegation_stays_running_while_child_is_active() {
        // opencode completes the outer task part immediately for background
        // launches (plan-review round 2, Finding 12); the child's live state
        // must win.
        let mut item = json!({ "kind": "task_delegation", "status": "completed", "background": true, "durationMs": 200u64 });
        let messages = vec![
            json!({ "info": { "id": "u", "role": "user", "time": { "created": 1000 } }, "parts": [] }),
            json!({ "info": { "id": "a", "role": "assistant", "time": { "created": 1100 } }, "parts": [
                json!({ "type": "tool", "tool": "bash", "state": { "status": "running", "input": {} } })
            ] }),
        ];
        opencode_apply_background_child_status(&mut item, &messages, None);
        assert_eq!(item["status"], json!("running"));
        assert!(item.get("durationMs").is_none());
    }

    #[test]
    fn background_delegation_with_busy_status_map_and_only_user_message_stays_running() {
        // Plan-review round 3, Finding 17: a freshly-busy child with only its
        // first user message (or an empty message page) is running per the
        // AUTHORITATIVE serve session-status map — message-shape inference
        // alone would miss it.
        let mut item = json!({ "kind": "task_delegation", "status": "completed", "background": true, "durationMs": 200u64 });
        let messages = vec![
            json!({ "info": { "id": "u", "role": "user", "time": { "created": 1000 } }, "parts": [] }),
        ];
        opencode_apply_background_child_status(
            &mut item,
            &messages,
            Some(&json!({ "type": "busy" })),
        );
        assert_eq!(item["status"], json!("running"));
        assert!(item.get("durationMs").is_none());

        // Even an empty child message page honors the status map.
        let mut item =
            json!({ "kind": "task_delegation", "status": "completed", "background": true });
        opencode_apply_background_child_status(&mut item, &[], Some(&json!({ "type": "busy" })));
        assert_eq!(item["status"], json!("running"));
    }

    #[test]
    fn background_delegation_completes_with_child_span_duration() {
        let mut item = json!({ "kind": "task_delegation", "status": "completed", "background": true, "durationMs": 5u64 });
        let messages = vec![
            json!({ "info": { "id": "u", "role": "user", "time": { "created": 1000 } }, "parts": [] }),
            json!({ "info": { "id": "a", "role": "assistant", "time": { "created": 1100, "completed": 61000 } }, "parts": [
                json!({ "type": "tool", "tool": "bash", "state": { "status": "completed", "input": {} } })
            ] }),
        ];
        opencode_apply_background_child_status(
            &mut item,
            &messages,
            Some(&json!({ "type": "idle" })),
        );
        assert_eq!(item["status"], json!("completed"));
        assert_eq!(item["durationMs"], json!(60000u64));
    }

    #[test]
    fn non_background_and_errored_delegations_keep_parent_status() {
        let mut item = json!({ "kind": "task_delegation", "status": "completed", "background": false, "durationMs": 7u64 });
        opencode_apply_background_child_status(
            &mut item,
            &[json!({ "info": { "role": "assistant" }, "parts": [] })],
            Some(&json!({ "type": "busy" })),
        );
        assert_eq!(item["durationMs"], json!(7u64));
        let mut item = json!({ "kind": "task_delegation", "status": "failed", "background": true });
        opencode_apply_background_child_status(&mut item, &[], Some(&json!({ "type": "busy" })));
        assert_eq!(item["status"], json!("failed"));
    }

    #[test]
    fn opencode_message_turn_json_renders_both_tool_and_text_parts_in_one_message() {
        let message = json!({
            "info": { "id": "msg-1", "role": "assistant" },
            "parts": [
                { "type": "tool", "id": "t-1", "tool": "bash", "state": { "status": "completed", "input": {}, "output": "done" } },
                { "type": "text", "id": "x-1", "text": "Ran the command." },
            ],
        });
        let turn = opencode_message_turn_json(&message, 0).expect("turn builds");
        let items = turn["items"].as_array().expect("items array");
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["kind"], json!("dynamic_tool"));
        assert_eq!(items[0]["tool"], json!("bash"));
        assert_eq!(items[1]["kind"], json!("text"));
        assert_eq!(items[1]["text"], json!("Ran the command."));
        // Summary joins the (single) text item's text.
        assert_eq!(turn["summary"], json!("Ran the command."));
        assert_eq!(turn["summaryKind"], json!("echo"));
    }

    #[test]
    fn opencode_turn_summary_truncates_the_text_join_and_tags_echo() {
        let long = "y".repeat(200);
        let items = vec![json!({ "id": "p-0", "kind": "text", "text": long })];
        let (summary, kind) = opencode_turn_summary(&items);
        assert_eq!(summary.chars().count(), 140);
        assert_eq!(kind, SUMMARY_KIND_ECHO);

        // The reasoning fallback is the adapter's own projection of full reasoning
        // text — echo, NOT authored (see the plan's deviation note).
        let reasoning_only = vec![
            json!({ "id": "p-1", "kind": "reasoning", "summary": ["full reasoning text"], "content": [], "text": "full reasoning text" }),
        ];
        assert_eq!(
            opencode_turn_summary(&reasoning_only),
            ("full reasoning text".to_string(), SUMMARY_KIND_ECHO)
        );
    }

    // ── resolve_probe_timeout_ms (Task 4 knob, pinned purely) ────────────────
    // The resume probe's budget layers: state override >
    // `FRESHELL_OPENCODE_GET_SESSION_TIMEOUT_MS` parse > 10_000ms default —
    // the SAME env-parse semantics the WS resume door applies
    // (`opencode_ws.rs`). The state-injection timeout tests prove boundedness;
    // these pin the KNOB's parsing/default. Pure: NO process env is mutated
    // (the caller reads `std::env::var` and hands the raw Option<&str> in).

    #[test]
    fn resolve_probe_timeout_ms_state_override_beats_env() {
        assert_eq!(resolve_probe_timeout_ms(Some(250), Some("5000")), 250);
        assert_eq!(resolve_probe_timeout_ms(Some(250), None), 250);
    }

    #[test]
    fn resolve_probe_timeout_ms_env_parse_wins_over_default() {
        assert_eq!(resolve_probe_timeout_ms(None, Some("7500")), 7500);
        // "0" parses: an explicit zero budget is the operator's choice.
        assert_eq!(resolve_probe_timeout_ms(None, Some("0")), 0);
    }

    #[test]
    fn resolve_probe_timeout_ms_garbage_env_falls_to_default() {
        assert_eq!(resolve_probe_timeout_ms(None, Some("not-a-number")), 10_000);
        assert_eq!(resolve_probe_timeout_ms(None, Some("")), 10_000);
        // Negative and overflowing values fail the u64 parse, same as garbage.
        assert_eq!(resolve_probe_timeout_ms(None, Some("-50")), 10_000);
        assert_eq!(
            resolve_probe_timeout_ms(None, Some("99999999999999999999999999")),
            10_000
        );
        // Whitespace is NOT trimmed (the parse semantics the WS door has
        // always had — no silent behavior drift).
        assert_eq!(resolve_probe_timeout_ms(None, Some(" 7500")), 10_000);
    }

    #[test]
    fn resolve_probe_timeout_ms_missing_env_is_default() {
        assert_eq!(resolve_probe_timeout_ms(None, None), 10_000);
    }

    // ── kata 1wxv Task 3: the FUNCTIONAL active-prefix / tail-marker filter ──────
    //
    // The serve returns the reverted tail rows UNFLAGGED in the message list; the
    // VERIFIED wire shape puts the boundary at TOP-LEVEL `session.revert.messageID`
    // (no `info.revert` exists anywhere). `turns[]` is EXACTLY what the model sees
    // next (messages strictly before the pointer); the tail becomes
    // `rolledBackTurns` markers in conversation order, each stamped rolledBack:true.

    fn three_turn_opencode_messages() -> Value {
        json!([
            { "info": { "id": "msg_u1", "role": "user" }, "parts": [{ "type": "text", "text": "prompt one" }] },
            { "info": { "id": "msg_a1", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer one" }] },
            { "info": { "id": "msg_u2", "role": "user" }, "parts": [{ "type": "text", "text": "prompt two" }] },
            { "info": { "id": "msg_a2", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer two" }] },
            { "info": { "id": "msg_u3", "role": "user" }, "parts": [{ "type": "text", "text": "prompt three" }] },
            { "info": { "id": "msg_a3", "role": "assistant" }, "parts": [{ "type": "text", "text": "answer three" }] },
        ])
    }

    #[test]
    fn opencode_snapshot_filters_turns_to_the_active_prefix_and_marks_the_tail() {
        // Top-LEVEL session.revert.messageID = the middle USER message; the message
        // list is served in FULL (tail unflagged, exactly like the real provider).
        let info = json!({ "id": "ses_x", "title": "t", "revert": { "messageID": "msg_u2" } });
        // No ledger record (kata 1wxv Task 5): the provider tail is the marker
        // projection source ONLY in the record-less (out-of-band revert) case.
        let snap =
            build_opencode_snapshot_json("ses_x", &info, &three_turn_opencode_messages(), None);

        let turns = snap["turns"].as_array().expect("turns array");
        let ids: Vec<&str> = turns.iter().filter_map(|t| t["turnId"].as_str()).collect();
        assert_eq!(
            ids,
            vec!["msg_u1", "msg_a1"],
            "turns[] == the active prefix ONLY (strictly before the pointer) — a \
             regression to mapping every served message into turns[] fails here"
        );

        let markers = snap["rolledBackTurns"]
            .as_array()
            .expect("the marker bucket is present while a tail is rolled back");
        let marker_ids: Vec<&str> = markers
            .iter()
            .filter_map(|t| t["turnId"].as_str())
            .collect();
        assert_eq!(
            marker_ids,
            vec!["msg_u2", "msg_a2", "msg_u3", "msg_a3"],
            "the tail rows in their ORIGINAL conversation order"
        );
        assert!(
            markers.iter().all(|t| t["rolledBack"] == json!(true)),
            "every marker is stamped rolledBack:true (decision 6)"
        );
        assert!(
            markers.iter().all(|t| t["restorable"] == json!(false)),
            "the record-LESS fallback bucket stamps an explicit restorable:false — an \
             out-of-band revert is never restorable, and an absent key stays reserved \
             for older-server payloads"
        );
    }

    #[test]
    fn opencode_snapshot_marker_order_is_stable_across_repeated_undos() {
        // Revert the LAST user message, build; then revert the MIDDLE user message,
        // build: the second snapshot's rolledBackTurns order equals the surviving
        // tail's conversation order — never wire/undo order ([u3,a3,u2,a2]).
        let first = build_opencode_snapshot_json(
            "ses_x",
            &json!({ "id": "ses_x", "revert": { "messageID": "msg_u3" } }),
            &three_turn_opencode_messages(),
            None,
        );
        let first_ids: Vec<&str> = first["rolledBackTurns"]
            .as_array()
            .expect("markers after the first undo")
            .iter()
            .filter_map(|t| t["turnId"].as_str())
            .collect();
        assert_eq!(first_ids, vec!["msg_u3", "msg_a3"]);

        let second = build_opencode_snapshot_json(
            "ses_x",
            &json!({ "id": "ses_x", "revert": { "messageID": "msg_u2" } }),
            &three_turn_opencode_messages(),
            None,
        );
        let second_ids: Vec<&str> = second["rolledBackTurns"]
            .as_array()
            .expect("markers after the second undo")
            .iter()
            .filter_map(|t| t["turnId"].as_str())
            .collect();
        assert_eq!(
            second_ids,
            vec!["msg_u2", "msg_a2", "msg_u3", "msg_a3"],
            "markers follow the surviving tail's conversation order across repeated undos"
        );
        // No revert pointer (legacy behavior): everything stays in turns[], no bucket.
        let plain = build_opencode_snapshot_json(
            "ses_x",
            &json!({ "id": "ses_x" }),
            &three_turn_opencode_messages(),
            None,
        );
        assert_eq!(
            plain["turns"].as_array().expect("turns").len(),
            6,
            "no pointer ⇒ no filtering (legacy-server parity)"
        );
        assert!(
            plain.get("rolledBackTurns").is_none(),
            "the marker bucket is omitted entirely when nothing is rolled back"
        );
    }

    // ── kata 1wxv Task 5: snapshot rollback surfacing (opencode) ──────────────
    //
    // Stamps are static `{undo:true, redo:true}` (LBC-2 verified the
    // revert/unrevert routes). The marker bucket IS the ledger record's
    // entries union (r3 — frozen prior epochs ++ the current serve-revert
    // tail, recorded at write time); `turns[]` still comes from the
    // provider's active prefix. `canRedo` is the STORED bit (the only source);
    // `undoneDepth` is the USER-role step count of the bucket (r3 finding 5 —
    // the same step count the client's `Rolled back (N)` label shows), never
    // `entries.len()`.

    /// Build a ledger entry's removed-turns from fixture messages (the verbatim
    /// FreshAgentTurn JSON the Task 3 handler records at write time).
    fn opencode_record_entry(
        msgs: &[Value],
        prompt: &str,
    ) -> crate::rollback_record::RollbackEntry {
        let removed_turns = msgs
            .iter()
            .enumerate()
            .map(|(i, m)| opencode_message_turn_json(m, i).expect("marker turn"))
            .collect();
        crate::rollback_record::RollbackEntry {
            removed_turns,
            prompt_text: prompt.into(),
            at_ms: 90,
            epoch: 0,
        }
    }

    #[test]
    fn opencode_snapshot_stamps_capabilities_and_the_ledger_marker_bucket() {
        let msgs = three_turn_opencode_messages();
        let mut record = crate::rollback_record::RollbackRecord::empty(50);
        record.push_entry(opencode_record_entry(&[msgs[2].clone()], "prompt two"), 100);
        record.set_can_redo(true, 100);
        // The serve carries NO revert pointer: the bucket is PROVABLY
        // ledger-sourced (a provider-tail projection would show nothing).
        let info = json!({ "id": "ses_x", "title": "t", "time": { "updated": 5 } });
        let snap = build_opencode_snapshot_json("ses_x", &info, &msgs, Some(&record));
        assert_eq!(snap["capabilities"]["undo"], json!(true));
        // kata z7j7: opencode advertises per-send model/effort; sandbox and
        // permissionMode have no opencode wire contract.
        assert_eq!(
            snap["capabilities"]["settingScopes"],
            json!({
                "model": "per-send",
                "effort": "per-send",
                "sandbox": "unsupported",
                "permissionMode": "unsupported",
            })
        );
        assert_eq!(snap["capabilities"]["redo"], json!(true));
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["msg_u2"] })
        );
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        assert_eq!(bucket.len(), 1);
        assert_eq!(bucket[0]["turnId"], json!("msg_u2"));
        assert!(
            bucket.iter().all(|t| t["rolledBack"] == json!(true)),
            "every marker is stamped rolledBack:true (decision 6)"
        );
        assert!(
            bucket.iter().all(|t| t["restorable"] == json!(true)),
            "the ledger-sourced bucket carries restorable:true (current chain, redo available)"
        );
        assert_eq!(
            snap["turns"].as_array().expect("turns").len(),
            6,
            "turns[] still comes from the provider state (no pointer ⇒ the full list)"
        );
        assert_eq!(
            snap["revision"],
            json!(100),
            "the record's lastOpAtMs is the revision floor (basis 5 loses)"
        );
    }

    #[test]
    fn opencode_snapshot_undone_depth_counts_user_steps_not_entries() {
        // r3 finding 5: a REBUILT single entry carrying the two-step tail
        // ([u2, a2, u3, a3] — Task 3's union rebuild over a two-step undo).
        let msgs = three_turn_opencode_messages();
        let mut record = crate::rollback_record::RollbackRecord::empty(50);
        record.push_entry(
            opencode_record_entry(
                &[
                    msgs[2].clone(),
                    msgs[3].clone(),
                    msgs[4].clone(),
                    msgs[5].clone(),
                ],
                "prompt two",
            ),
            100,
        );
        record.set_can_redo(true, 100);
        let info = json!({ "id": "ses_x", "time": { "updated": 5 } });
        let snap = build_opencode_snapshot_json("ses_x", &info, &msgs, Some(&record));
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": true, "undoneDepth": 2, "redoableTurnIds": ["msg_u2", "msg_u3"] }),
            "two undone USER steps — never entries.len(); every current-epoch user row is redoable"
        );
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        assert_eq!(bucket.len(), 4);
        assert!(
            bucket.iter().all(|t| t["restorable"] == json!(true)),
            "every current-epoch marker row is restorable (canRedo:true, current epoch) — \
             ALL roles, matching the redoable rule"
        );
    }

    #[test]
    fn opencode_snapshot_destroyed_redo_keeps_the_marked_bucket_alive() {
        let msgs = three_turn_opencode_messages();
        let mut record = crate::rollback_record::RollbackRecord::empty(50);
        record.push_entry(opencode_record_entry(&[msgs[2].clone()], "prompt two"), 100);
        record.set_can_redo(true, 100);
        record.destroy_redo(120); // decision 5: kills redo, NEVER the markers (decision 6)
        let info = json!({ "id": "ses_x", "time": { "updated": 5 } });
        let snap = build_opencode_snapshot_json("ses_x", &info, &msgs, Some(&record));
        assert_eq!(
            snap["rollback"],
            json!({ "canRedo": false, "undoneDepth": 1, "redoableTurnIds": [] }),
            "the stored bit cleared; the bucket's user-step count is untouched; no marker is redoable"
        );
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        assert_eq!(bucket.len(), 1);
        assert_eq!(
            bucket[0]["restorable"],
            json!(false),
            "destroyed redo ⇒ the marker is collapsed history (the server truth), never restorable"
        );
        assert_eq!(
            snap["revision"],
            json!(120),
            "the destroy also lifts the floor"
        );
    }

    #[tokio::test]
    async fn get_opencode_snapshot_surfaces_the_durable_rollback_record() {
        let session_body = json!({
            "id": "ses_rb",
            "title": "rolled back session",
            "time": { "created": 1_700_000_000_000i64, "updated": 1_700_000_005_000i64 },
        });
        // The serve knows NOTHING about a revert pointer — the marker bucket
        // must still surface from the ledger.
        let messages_body = json!([
            { "info": { "id": "msg-1", "role": "user" }, "parts": [{ "type": "text", "text": "hi" }] },
            { "info": { "id": "msg-2", "role": "assistant" }, "parts": [{ "type": "text", "text": "hello" }] },
        ]);
        let st = state_with_fixed_session_http(session_body, messages_body).await;
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let marker_source = json!({ "info": { "id": "msg-9", "role": "user" }, "parts": [{ "type": "text", "text": "later" }] });
        let mut record = crate::rollback_record::RollbackRecord::empty(50);
        record.push_entry(
            opencode_record_entry(&[marker_source], "later"),
            1_702_000_000_000,
        );
        record.set_can_redo(true, 1_702_000_000_000);
        crate::identity_sink::PaneIdentitySink::record_rollback(
            fake.as_ref(),
            "opencode",
            "ses_rb",
            record,
        )
        .await
        .expect("record write");

        let snapshot = st
            .get_opencode_snapshot("ses_rb", None)
            .await
            .expect("snapshot builds");
        assert_eq!(snapshot["capabilities"]["undo"], json!(true));
        assert_eq!(snapshot["capabilities"]["redo"], json!(true));
        assert_eq!(
            snapshot["rollback"],
            json!({ "canRedo": true, "undoneDepth": 1, "redoableTurnIds": ["msg-9"] })
        );
        assert_eq!(snapshot["rolledBackTurns"][0]["turnId"], json!("msg-9"));
        assert_eq!(snapshot["rolledBackTurns"][0]["rolledBack"], json!(true));
        assert_eq!(
            snapshot["rolledBackTurns"][0]["restorable"],
            json!(true),
            "the live REST route surfaces the same restorable:true stamp (current chain, redo available)"
        );
        assert_eq!(
            snapshot["revision"],
            json!(1_702_000_000_000i64),
            "a stale serve timestamp never beats the record floor"
        );
    }

    // ── b8ke ext r9 F1: the resume claims/commits the coordinator ──────────

    /// The resume test fixture: a state with a wired coordinator, a healthy
    /// fake serve (get_session answers), and an identity sink that has
    /// recorded the durable session (the post-restart shape).
    async fn rest_resume_state() -> (
        FreshAgentState,
        Arc<freshell_ownership::RuntimeOwnershipRegistry>,
        Arc<identity_sink::FakeIdentitySink>,
    ) {
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        let st = state().with_ownership(Arc::clone(&registry));
        let deps = ServeDeps {
            spawner: Arc::new(NoopSpawner),
            http: Arc::new(CreateCapableHttp),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let manager = OpencodeServeManager::new(deps, ServeConfig::default());
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        st.set_manager_for_test(manager).await;
        let fake = Arc::new(identity_sink::FakeIdentitySink::default());
        fake.settings.lock().unwrap().insert(
            ("opencode".to_string(), "ses_resume_durable".to_string()),
            identity_sink::FreshAgentSettings {
                model: Some("m".to_string()),
                effort: Some("high".to_string()),
                cwd: Some("/w".to_string()),
                ..Default::default()
            },
        );
        fake.recorded
            .lock()
            .unwrap()
            .insert(("opencode".to_string(), "ses_resume_durable".to_string()));
        st.set_identity_sink(fake.clone());
        (st, registry, fake)
    }

    // ── b8ke ext r13 F4/F5/F6: the REST/MCP resume's authority ──────────────

    /// The F4/F5/F6 fixture: a resumed durable session whose FIRST resume
    /// committed Live{FreshAgent} and parked the retained ownership stamp
    /// (the pane's recorded owner generation).
    async fn resumed_live_state() -> (
        FreshAgentState,
        Arc<freshell_ownership::RuntimeOwnershipRegistry>,
        String,
    ) {
        let (st, registry, _fake) = rest_resume_state().await;
        let durable_id = "ses_resume_durable".to_string();
        let resp = resume_session_ref_tab(
            &st,
            &json!({ "provider": "opencode", "sessionId": durable_id }),
            None,
            None,
            None,
            None,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK, "the fixture resume succeeds");
        assert!(matches!(
            registry.observe(PROVIDER, &durable_id).state,
            freshell_ownership::OwnershipState::Live { owner, .. }
                if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
        ));
        (st, registry, durable_id)
    }

    /// b8ke ext r13 F4: the resume threads the pane's RECORDED owner
    /// generation (the retained stamp) as the claim's observed fence — a
    /// delayed resume whose recorded generation is stale against the
    /// coordinator's ADVANCED generation answers the typed stale refusal
    /// (pre-r13 the claim carried None always, so the stale request
    /// re-adopted the moved-on session and installed its pane).
    #[tokio::test]
    async fn a_stale_recorded_generation_resume_is_refused_typed() {
        let (st, registry, durable_id) = resumed_live_state().await;
        assert!(
            ownership_lane::peek_retained_stamp(&st.ownership_stamps, &durable_id).is_some(),
            "fixture: the first resume parked the retained stamp"
        );

        // The generation ADVANCES past the recorded stamp: a handoff begin
        // bumps the record and the fail-restore keeps the advanced
        // generation in the restored Live state.
        let freshell_ownership::BeginOutcome::Granted { .. } = registry.begin_handoff(
            PROVIDER,
            &durable_id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-r13-f4-bump",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        ) else {
            panic!("the generation-bump handoff must grant")
        };
        let _ = registry.fail(PROVIDER, &durable_id, "op-r13-f4-bump", 2, true);

        // THE STALE RESUME: the stamp's fence is older than the advanced
        // generation → the typed stale refusal, nothing registered.
        let panes_before = st.panes.lock().expect("panes mutex").len();
        let resp = resume_session_ref_tab(
            &st,
            &json!({ "provider": "opencode", "sessionId": durable_id }),
            None,
            None,
            None,
            None,
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::CONFLICT,
            "the stale-generation resume answers the typed refusal"
        );
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(value["status"], json!("error"));
        assert_eq!(value["code"], json!("SESSION_RESERVED"));
        assert_eq!(
            st.panes.lock().expect("panes mutex").len(),
            panes_before,
            "the refused resume registered no pane"
        );
    }

    /// b8ke ext r13 F5: concurrent same-pane resumes are SEPARATE
    /// operations. With the first resume in flight (parked in its probe),
    /// the second's claim answers Blocked — it refuses BEFORE any layout
    /// mutation or broadcast (pre-r13 the SHARED pane-id-only operation id
    /// made the second a reentrant part of the first: the continuation arm
    /// granted it, both registered tabs, and the loser's conflict landed
    /// only after it had inserted and broadcast its layout).
    #[tokio::test(flavor = "multi_thread")]
    async fn concurrent_same_session_resumes_are_separate_operations() {
        let (st, registry, durable_id) = resumed_live_state().await;
        // Reset the key to Vacant so BOTH requests claim from scratch
        // (the concurrent in-flight shape the shared id broke).
        match registry.observe(PROVIDER, &durable_id).state {
            freshell_ownership::OwnershipState::Live {
                owner, generation, ..
            } => {
                registry.release(
                    PROVIDER,
                    &durable_id,
                    &freshell_ownership::ReleaseClaim {
                        operation_id: owner.ownership_id.clone().unwrap_or_default(),
                        generation,
                        runtime: Some(owner.clone()),
                    },
                    "test",
                );
            }
            other => panic!("fixture: expected the committed live owner, got {other:?}"),
        }
        // A parking probe: the FIRST resume's get_session parks until
        // released (the deterministic in-flight window).
        let park = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let park_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let release = Arc::clone(&release);
            let park_count = Arc::clone(&park_count);
            struct ParkingGetSessionHttp {
                release: Arc<tokio::sync::Notify>,
                park_count: Arc<std::sync::atomic::AtomicUsize>,
            }
            impl ServeHttp for ParkingGetSessionHttp {
                fn request<'a>(
                    &'a self,
                    _req: ServeHttpRequest,
                ) -> std::pin::Pin<
                    Box<
                        dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                            + Send
                            + 'a,
                    >,
                > {
                    let release = Arc::clone(&self.release);
                    let park_count = Arc::clone(&self.park_count);
                    let release = Arc::clone(&release);
                    let park_count = Arc::clone(&park_count);
                    Box::pin(async move {
                        // Park ONLY the session probe (the resume's
                        // get_session); the serve's health checks answer
                        // instantly.
                        let is_session_probe = _req.url.contains("/session")
                            && matches!(_req.method, freshell_opencode::serve::HttpMethod::Get);
                        if is_session_probe {
                            park_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            release.notified().await;
                        }
                        Ok(ServeHttpResponse::new(
                            200,
                            serde_json::to_vec(&serde_json::json!({ "id": "ses_resume_durable" }))
                                .unwrap(),
                        ))
                    })
                }
            }
            let deps = ServeDeps {
                spawner: Arc::new(NoopSpawner),
                http: Arc::new(ParkingGetSessionHttp {
                    release,
                    park_count,
                }),
                ports: Arc::new(FakeAllocator),
                events: Arc::new(NoopEventSource),
            };
            let manager = OpencodeServeManager::new(deps, ServeConfig::default());
            manager
                .ensure_started()
                .await
                .expect("healthy fake serve starts");
            st.set_manager_for_test(manager).await;
        }

        let st1 = st.clone();
        let durable1 = durable_id.clone();
        let first = tokio::spawn(async move {
            resume_session_ref_tab(
                &st1,
                &json!({ "provider": "opencode", "sessionId": durable1 }),
                None,
                None,
                None,
                None,
            )
            .await
        });
        // Park proof: the first resume's probe parked.
        {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            while park_count.load(std::sync::atomic::Ordering::SeqCst) < 1 {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the first resume never parked"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }

        // THE SECOND RESUME (in flight against the first): a SEPARATE
        // operation — the claim answers Blocked and it refuses BEFORE any
        // layout mutation (no second tab/pane registered).
        let panes_before = st.panes.lock().expect("panes mutex").len();
        let second = resume_session_ref_tab(
            &st,
            &json!({ "provider": "opencode", "sessionId": durable_id }),
            None,
            None,
            None,
            None,
        )
        .await;
        assert_eq!(
            second.status(),
            StatusCode::CONFLICT,
            "the concurrent same-session resume refuses typed"
        );
        assert_eq!(
            st.panes.lock().expect("panes mutex").len(),
            panes_before,
            "the loser refused BEFORE any layout mutation"
        );

        // Release + complete: the FIRST resume succeeds (its tab is the
        // only one).
        release.notify_one();
        let first_resp = first.await.expect("the first resume completes");
        assert_eq!(first_resp.status(), StatusCode::OK);
        assert_eq!(
            st.panes.lock().expect("panes mutex").len(),
            panes_before + 1,
            "exactly the winner's pane registered"
        );
        let _ = park;
    }

    /// b8ke ext r13 F6: the Adopt arm (a live same-kind owner — the
    /// same-pane re-open) proceeds ONLY under the ext-r12 attach guard:
    /// a handoff BEGIN during the resume's registration window answers
    /// the typed Blocked outcome (pre-r13 the arm proceeded with NO
    /// claim, so the handoff committed while the stale request installed
    /// its pane).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_handoff_during_the_resume_adopt_window_is_blocked_typed() {
        let (st, registry, durable_id) = resumed_live_state().await;
        // A parking probe: the Adopt-path resume parks inside its window.
        let release = Arc::new(tokio::sync::Notify::new());
        let park_count = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        {
            let release = Arc::clone(&release);
            let park_count = Arc::clone(&park_count);
            struct ParkingGetSessionHttp {
                release: Arc<tokio::sync::Notify>,
                park_count: Arc<std::sync::atomic::AtomicUsize>,
            }
            impl ServeHttp for ParkingGetSessionHttp {
                fn request<'a>(
                    &'a self,
                    _req: ServeHttpRequest,
                ) -> std::pin::Pin<
                    Box<
                        dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>>
                            + Send
                            + 'a,
                    >,
                > {
                    let release = Arc::clone(&self.release);
                    let park_count = Arc::clone(&self.park_count);
                    let release = Arc::clone(&release);
                    let park_count = Arc::clone(&park_count);
                    Box::pin(async move {
                        let is_session_probe = _req.url.contains("/session")
                            && matches!(_req.method, freshell_opencode::serve::HttpMethod::Get);
                        if is_session_probe {
                            park_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                            release.notified().await;
                        }
                        Ok(ServeHttpResponse::new(
                            200,
                            serde_json::to_vec(&serde_json::json!({ "id": "ses_resume_durable" }))
                                .unwrap(),
                        ))
                    })
                }
            }
            let deps = ServeDeps {
                spawner: Arc::new(NoopSpawner),
                http: Arc::new(ParkingGetSessionHttp {
                    release,
                    park_count,
                }),
                ports: Arc::new(FakeAllocator),
                events: Arc::new(NoopEventSource),
            };
            let manager = OpencodeServeManager::new(deps, ServeConfig::default());
            manager
                .ensure_started()
                .await
                .expect("healthy fake serve starts");
            st.set_manager_for_test(manager).await;
        }

        // The Adopt-path resume (the key holds Live{FreshAgent}).
        let st1 = st.clone();
        let durable1 = durable_id.clone();
        let resume = tokio::spawn(async move {
            resume_session_ref_tab(
                &st1,
                &json!({ "provider": "opencode", "sessionId": durable1 }),
                None,
                None,
                None,
                None,
            )
            .await
        });
        {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            while park_count.load(std::sync::atomic::Ordering::SeqCst) < 1 {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the adopt-path resume never parked in its window"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }

        // THE CONTRACT: a handoff BEGIN inside the resume's window answers
        // Blocked typed.
        match registry.begin_handoff(
            PROVIDER,
            &durable_id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-r13-f6-racing-handoff",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        ) {
            freshell_ownership::BeginOutcome::Blocked { retry_after_ms, .. } => {
                assert!(retry_after_ms > 0);
            }
            other => panic!(
                "a handoff begin inside the resume's Adopt window must answer Blocked — got {other:?}"
            ),
        }
        // No terminal ever started beside the incumbent.
        release.notify_one();
        let resp = resume.await.expect("the resume completes");
        assert_eq!(resp.status(), StatusCode::OK);
    }

    /// b8ke ext r9 F1: a post-restart resume (the coordinator VACANT — the
    /// pre-restart record is gone) claims and commits Live{FreshAgent}, so
    /// the pane's FIRST send-keys succeeds (pre-r9 the resume registered
    /// and broadcast with no claim: the first send-keys was refused
    /// SESSION_RESERVED).
    #[tokio::test]
    async fn a_post_restart_resume_commits_live_and_send_keys_succeeds() {
        let (st, registry, _fake) = rest_resume_state().await;
        let resp = resume_session_ref_tab(
            &st,
            &json!({ "provider": "opencode", "sessionId": "ses_resume_durable" }),
            None,
            None,
            None,
            None,
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK, "the resume succeeds");
        // THE COMMIT: the coordinator holds Live{FreshAgent}.
        match registry.observe(PROVIDER, "ses_resume_durable").state {
            freshell_ownership::OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, freshell_ownership::RuntimeOwnerKind::FreshAgent);
            }
            other => panic!("the resume must commit Live{{FreshAgent}}, got {other:?}"),
        }

        // THE POST-RESUME TURN: the pane's first send-keys succeeds (the
        // reviewer-noted lifecycle break: pre-r9 this was 409
        // SESSION_RESERVED).
        let pane_id = {
            let panes = st.panes.lock().expect("panes mutex");
            panes
                .keys()
                .next()
                .cloned()
                .expect("the resume registered a pane")
        };
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", "tok".parse().unwrap());
        let turn = send_keys(
            State(st.clone()),
            Path(pane_id),
            headers,
            Json(json!({ "text": "hello", "timeout": 0 })),
        )
        .await;
        assert_eq!(
            turn.status(),
            StatusCode::OK,
            "the post-resume send-keys succeeds (the turn gate sees the committed owner)"
        );
    }

    /// b8ke ext r9 F1: a resume against a TERMINAL-owned session answers
    /// the typed owner response (409 SESSION_RESERVED + ownerKind
    /// terminal + ownerGeneration), never a success that would fork a
    /// second writer over the terminal's ownership.
    #[tokio::test]
    async fn a_resume_while_a_terminal_owns_answers_the_typed_owner_response() {
        let (st, registry, _fake) = rest_resume_state().await;
        // Seed the terminal owner directly (a completed handoff's end state).
        let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
            PROVIDER,
            "ses_resume_durable",
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "test-terminal-owner",
            None,
            "test",
            1_000,
        ) else {
            panic!("fixture granted")
        };
        assert_eq!(
            registry.commit_live(
                PROVIDER,
                "ses_resume_durable",
                "test-terminal-owner",
                generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some("term-owned".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                    unit_id: None,
                    hold: freshell_ownership::HoldKind::Main,
                },
            ),
            freshell_ownership::CommitOutcome::Committed
        );

        let resp = resume_session_ref_tab(
            &st,
            &json!({ "provider": "opencode", "sessionId": "ses_resume_durable" }),
            None,
            None,
            None,
            None,
        )
        .await;
        assert_eq!(
            resp.status(),
            StatusCode::CONFLICT,
            "the terminal-owned resume answers 409, never success"
        );
        let body = resp.into_body();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(value["status"], json!("error"));
        assert_eq!(value["code"], json!("SESSION_RESERVED"));
        assert_eq!(
            value["ownerKind"],
            json!("terminal"),
            "the typed owner response names the terminal owner: {value}"
        );
        assert!(
            value["ownerGeneration"].is_u64(),
            "the typed owner response carries the owner generation: {value}"
        );
        // The terminal's record is untouched.
        assert!(matches!(
            registry.observe(PROVIDER, "ses_resume_durable").state,
            freshell_ownership::OwnershipState::Live { .. }
        ));
    }
}

// ── PATCH /api/panes/:id (rename pane) ───────────────────────────────────

#[cfg(test)]
#[path = "rename_route_tests.rs"]
mod rename_route_tests;

#[cfg(test)]
#[path = "ownership_wiring_tests.rs"]
mod ownership_wiring_tests;

#[cfg(test)]
mod rename_pane_tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::util::ServiceExt;

    fn app() -> Router {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        router(FreshAgentState::new(
            Arc::new("tok".to_string()),
            Arc::new(tx),
        ))
    }

    async fn body_json(resp: Response) -> Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    async fn patch_pane(name: Option<&str>, auth: bool) -> (StatusCode, Value) {
        let body = match name {
            Some(n) => json!({ "name": n }).to_string(),
            None => "{}".to_string(),
        };
        let mut req = Request::builder()
            .method("PATCH")
            .uri("/api/panes/pane-123")
            .header("content-type", "application/json");
        if auth {
            req = req.header("x-auth-token", "tok");
        }
        let resp = app()
            .oneshot(req.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        (status, body_json(resp).await)
    }

    /// Task 16 (kills D10's fake ack): with NO layout snapshot ingested yet,
    /// the route answers Node's `renamePane` miss shape at 200 —
    /// `ok({message:'no layout snapshot'})` (`layout-store.ts:559` via
    /// `router.ts:1411`+`:1423`) — never the old unconditional
    /// `{paneId, tabRenamed:false}` acknowledgement.
    #[tokio::test]
    async fn rename_without_layout_snapshot_is_200_with_message() {
        let (status, body) = patch_pane(Some("My New Title"), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], json!("ok"));
        assert_eq!(body["data"], json!({ "message": "no layout snapshot" }));
        assert_eq!(body["message"], json!("no layout snapshot"));
    }

    /// `parseRequiredName(undefined) -> undefined` -> 400 `'name required'`
    /// (`router.ts:1398-1399`).
    #[tokio::test]
    async fn missing_name_is_400_name_required() {
        let (status, body) = patch_pane(None, true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["message"], json!("name required"));
    }

    /// `parseRequiredName` trims and rejects blank-only input the same as absent.
    #[tokio::test]
    async fn blank_name_is_400_name_required() {
        let (status, body) = patch_pane(Some("   "), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["message"], json!("name required"));
    }

    /// `MAX_TERMINAL_TITLE_OVERRIDE_LENGTH` (`terminals-router.ts:24`) = 500,
    /// reused here per the fix spec (`router.ts:1400-1402`).
    #[tokio::test]
    async fn name_over_500_chars_is_400_length_message() {
        let long = "x".repeat(501);
        let (status, body) = patch_pane(Some(&long), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["message"],
            json!("name must be 500 characters or fewer")
        );
    }

    #[tokio::test]
    async fn name_exactly_500_chars_is_ok() {
        let exact = "y".repeat(500);
        let (status, _body) = patch_pane(Some(&exact), true).await;
        assert_eq!(status, StatusCode::OK);
    }

    #[tokio::test]
    async fn missing_auth_is_401() {
        let (status, body) = patch_pane(Some("Title"), false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body["status"], json!("error"));
    }

    /// Confirms the route is actually mounted (as opposed to falling through to
    /// axum's SPA-fallback, which is the exact bug this task fixes): a matched
    /// route always answers with the `ok`/`error` JSON envelope, never a bare
    /// 404 with no body.
    #[tokio::test]
    async fn route_is_matched_not_fallback_404() {
        let (status, body) = patch_pane(Some("Title"), true).await;
        assert_ne!(status, StatusCode::NOT_FOUND);
        assert!(body.get("status").is_some());
    }
}
