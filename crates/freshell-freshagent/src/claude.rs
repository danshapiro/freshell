//! # freshell-freshagent :: claude — the freshclaude WS fresh-agent slice (Phase 3.9)
//!
//! The additive wiring that lets the equivalence oracle drive a live claude/Haiku T2
//! turn THROUGH the Rust server exactly as it drives the original, and prove
//! `original≡rust` at T2. A faithful port of the claude path of `server/ws-handler.ts`
//! (`freshAgent.create` / `freshAgent.send`) + `server/fresh-agent/adapters/claude/adapter.ts`
//! + `server/sdk-bridge.ts` — but the SDK itself (`@anthropic-ai/claude-agent-sdk`, which
//!   has NO Rust equivalent) runs in the ONE sanctioned Node sidecar
//!   (`crates/freshell-claude-sidecar`, ADR Decision 2), spoken over newline-JSON stdio.
//!
//! ## Drive path (WS, not REST) — mirrors the codex slice
//!
//! | Client→server | Behaviour |
//! |---|---|
//! | `freshAgent.create {sessionType:'freshclaude'\|'kilroy',…}` | spawn the Node sidecar (ownership-tagged, isolated HOME inherited) → SDK `query()` → the SDK bridge's **BARE nanoid** placeholder id (NO placeholder→durable materialization — claude's send returns void), broadcast `freshAgent.created`, start the stdout consumer |
//! | `freshAgent.send {sessionId,text}` | push the user turn into the sidecar's SDK input stream, broadcast `freshAgent.send.accepted` (NO `submittedTurnId` — claude) |
//!
//! ## Events + the attention edges
//!
//! The sidecar emits the SAME `sdk.*` shapes `SdkBridge` broadcasts. The stdout consumer
//! normalizes each `sdk.* → freshAgent.*` (a port of `server/fresh-agent/sdk-events.ts`)
//! and wraps it in a `freshAgent.event` envelope: `sdk.session.init` → `freshAgent.session.init`
//! (durable Claude UUID via `cliSessionId`), `sdk.stream`/`sdk.assistant`/`sdk.result`.
//! The `.jsonl` transcript the claude CLI persists under the isolated
//! `<CLAUDE_HOME>/projects/…` corroborates them.
//!
//! The server mints every attention edge itself (design §5, C18; the sidecar mints
//! none): the stdout consumer folds each line into the session's turn ledger
//! (`claude_turns.rs`), whose verdict on each result says whether it rings, and every
//! `freshAgent.turn.complete` / `freshAgent.turn.waiting` leaves through the edge hub
//! (`claude_edges.rs`) on the session's one attention clock. Only the user's own Stop is
//! silent, and only for the turn it targeted (the Stop latch, re-sent when it missed a
//! command the CLI was still starting); a failed result also shows why.
//!
//! ## Sidecar death — an in-flight death rings
//!
//! When the sidecar's output ends unrequested (it reported its SDK stream's end and
//! exited, or the Node process died), the consumer's end-of-output path rings once if
//! the ledger owed the user a turn end, through the same hub and clock. Requested
//! deaths (kill/shutdown/teardown/rollback fork) never reach the death arm (the map
//! entry is removed first) and stay silent, and an IDLE death mints nothing — the
//! no-FALSE-completion property holds.
//!
//! ## Safety
//!
//! The Node sidecar (and the `claude` CLI grandchild the SDK spawns) inherit the server's
//! isolated HOME (so they authenticate from + write ALL transcript data under
//! `<isolatedHOME>/.claude`, never the user's real store) and carry a
//! `FRESHELL_CLAUDE_SIDECAR_ID` ownership tag. Every teardown, and
//! [`FreshClaudeState::shutdown`] for all sessions concurrently, first asks the sidecar to
//! shut down (it aborts its SDK query, which stops the claude CLI), escalates to
//! SIGTERM/SIGKILL only after the grace period ([`crate::claude_spawn`]), and runs the
//! `/proc` ownership sweep; the harness sentinel sweep is the backstop — no orphans.

use std::collections::HashMap;
use std::path::PathBuf;
#[cfg(test)]
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::Mutex as TokioMutex;

use freshell_protocol::{
    ErrorCode, ErrorMsg, FreshAgentApprovalRespond, FreshAgentAttach, FreshAgentCompact,
    FreshAgentConfigure, FreshAgentCreate, FreshAgentCreated, FreshAgentEvent, FreshAgentInterrupt,
    FreshAgentKill, FreshAgentKilled, FreshAgentQuestionRespond, FreshAgentSend,
    FreshAgentSendAccepted, FreshAgentSessionMaterialized, ServerMessage, SessionRuntimeOwner,
    SessionType,
};

use crate::claude_handshake::{read_created, BootContext};
use crate::claude_launch::{ClaudeBoot, ClaudeLaunchSpec};
use crate::{FreshAgentCreateDedup, FreshAgentCreateOutcome, SharedPaneIdentitySink};
use turn_status::LedgerStep;

/// The runtime provider (`AGENT_SESSION_TYPES.claude.provider`).
pub(crate) const PROVIDER: &str = "claude";

/// Build the sidecar-only correlation record for one checkpointed Claude
/// send. The send's UUID is supplied on SDKUserMessage and the attempt is
/// later accepted only when the SDK replays the persisted user row carrying
/// that same UUID.
fn checkpoint_attempt_for_send(msg: &FreshAgentSend) -> Option<Value> {
    let intent = msg.checkpoint_intent.as_ref()?;
    let request_id = msg.request_id.as_deref().filter(|id| !id.is_empty())?;
    // The attempt binds under the send's own uuid (the send line's `uuid`, C16),
    // which is also the turn id the send is accepted with.
    Some(json!({
        "logicalAttemptId": intent.logical_attempt_id,
        "requestId": request_id,
    }))
}

/// The ownership tag env the sidecar + its claude CLI grandchild carry (the codex analog
/// is `FRESHELL_CODEX_SIDECAR_ID`); the `/proc` reaper keys on it.
const CLAUDE_SIDECAR_OWNERSHIP_ENV: &str = crate::claude_spawn::CLAUDE_SIDECAR_OWNERSHIP_ENV;
/// Cold-boot budget for the sidecar to answer the `create` request (`created`).
const SIDECAR_CREATE_BUDGET: Duration = Duration::from_secs(45);

/// Shared, cheaply-cloneable freshclaude WS state (mergeable into the server app + WsState).
#[derive(Clone)]
pub struct FreshClaudeState {
    /// Host-only selection of the fixed Freshell stdio MCP recipe. Its endpoint
    /// and grant remain in the child environment, never in create IPC.
    hosted_mcp: bool,
    /// The ordinary Freshell MCP (G19): the endpoint every sidecar's
    /// environment carries and the recipe provider asked at each launch, both
    /// wired by `freshell-server` ([`Self::set_freshell_endpoint`],
    /// [`Self::set_freshell_mcp_provider`]); unwired in the session host.
    freshell_mcp: crate::claude_freshell_mcp::ClaudeFreshellMcpWiring,
    /// Test seam (`test-support` feature, C04 rigs): the complete environment of
    /// every claude sidecar this state spawns, replacing the inherited one (the
    /// ownership tag is still layered on). `None` in production: the sidecar
    /// inherits the server's environment. Lets a rig point the real sidecar at
    /// the CLI simulator or a local endpoint with an isolated HOME, without
    /// mutating this process's environment.
    sidecar_environment: Option<Arc<[(String, String)]>>,
    /// The shared WS broadcast bus (pre-serialized frames), fanned out by every
    /// `freshell-ws` connection so the oracle's capture socket records
    /// `freshAgent.created` / `freshAgent.send.accepted` / `freshAgent.event`.
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    /// Server-owned durability edge for checkpoint-related provider frames.
    checkpoint_event_sink: crate::CheckpointEventSink,
    /// placeholder-nanoid → live claude session (sidecar stdin + owned child + consumer).
    sessions: Arc<TokioMutex<HashMap<String, ClaudeSession>>>,
    /// durable Claude UUID (`cliSessionId` from `sdk.session.init`) -> sessions-map key.
    /// THE restart-parity index (plan §2.8 item 2): lets attach/snapshot find a live
    /// session by its durable identity instead of the process-ephemeral placeholder.
    /// pub(crate) so in-crate tests (and snapshot wiring) can inspect it.
    pub(crate) cli_index: Arc<TokioMutex<HashMap<String, String>>>,
    /// `freshAgent.create` requestId dedup (parity gap fix -- see the module doc on
    /// [`crate::FreshAgentCreateDedup`]): single-flight + replay cache so a client
    /// resending the SAME `requestId` on every reconnect while a pane is
    /// `status==creating` reattaches to the ONE session it already created instead of
    /// spawning a fresh claude sidecar per resend. Cleared for a session's entries only
    /// on an explicit `freshAgent.kill` ([`Self::handle_kill`]); an unrequested sidecar
    /// exit does NOT evict from THIS dedup cache (mirrors legacy, see the type doc) --
    /// it DOES evict the dead entry from the `sessions` map (consumer-exit eviction).
    create_dedup: Arc<FreshAgentCreateDedup<ClaudeCreateRecord>>,
    /// Single-flight guard for resume-on-attach, keyed by DURABLE id (codex's
    /// `resuming` analog, simplified: contenders return immediately instead of
    /// waiting -- the winner's frames broadcast to every client anyway).
    /// std::sync (not tokio): every scope is a one-statement lock, and the
    /// handoff resume's RAII drop-guard must be able to remove its flag from
    /// a synchronous Drop (an aborted resume future — round-3 review I-1).
    resuming: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    resuming_changed: Arc<tokio::sync::Notify>,
    /// Test seam (Task 6 round-3 review I-1): park `kill_for_handoff` with
    /// the kill ISSUED (retained stamp taken) but nothing else disturbed —
    /// the prior-reap-window abort test's deterministic hold. `None` in
    /// production and every other test.
    handoff_kill_pause: Option<std::sync::Arc<tokio::sync::Notify>>,
    /// Test seam (b8ke ext r38 F1): park `handle_rollback`'s Adopt arm with
    /// the claim ANSWERED (AdoptLive) but the adopt guard NOT yet armed —
    /// the claim-to-arm race test's deterministic hold. The handler
    /// notifies `rollback_adopt_parked` once it reaches the seam, then
    /// waits on `rollback_adopt_release`. `None`/`None` in production and
    /// every other test.
    rollback_adopt_parked: Option<std::sync::Arc<tokio::sync::Notify>>,
    rollback_adopt_release: Option<std::sync::Arc<tokio::sync::Notify>>,
    /// Test seam (b8ke focused FR3): `kill_for_handoff`'s tree-death
    /// confirmation round budget override — `None` in production (the
    /// [`TREE_DEATH_CONFIRM_ROUNDS`] default).
    handoff_confirm_rounds: Option<u8>,
    /// Test seam (b8ke focused round-2 R2-3): make the NEXT
    /// `kill_for_handoff` answer the typed [`StopResult::PlatformLimited`]
    /// unconditionally — the platform-limited red/green on Linux, where the
    /// real arm is `cfg(not(linux))`-only. `None` in production.
    handoff_platform_limited: Option<bool>,
    /// b8ke focused round-2 review R2-1: the CONDEMNED-PRIOR record — the
    /// canonical session id → the (sidecar child pid, `/proc` ownership
    /// tag) pair every `kill_for_handoff` records BEFORE its first
    /// cancellable await. A cancelled/panicked teardown leaves the record
    /// behind (the sessions-map entry is already gone), and the handoff
    /// watcher's replacement probe kill-and-confirms the recorded tree
    /// through exactly this pair — the bounded recorded-identity probe the
    /// fenced key releases on. Cleared by whichever path confirms death.
    condemned_priors:
        Arc<std::sync::Mutex<HashMap<String, crate::session_lease::CondemnedRuntimeIdentity>>>,
    /// Test seam (Task 6 round-3 review I-1): park `resume_for_attach`
    /// right after the target session is REGISTERED — the fresh-arm
    /// target-spawn-window abort test's deterministic hold. `None` in
    /// production and every other test.
    handoff_resume_pause: Option<std::sync::Arc<tokio::sync::Notify>>,
    /// b8ke focused episode-2 round-2 F3 test seam: when set, the
    /// session-init adoption parks BETWEEN its phase-1 read scope and the
    /// claim/publication — the deterministic hold for the
    /// kill-between-read-and-publish window the publication's incarnation
    /// revalidation closes. `None` in production and every other test.
    #[cfg(test)]
    adoption_pause: Option<std::sync::Arc<AdoptionTestPause>>,
    /// b8ke focused episode-2 post-cap F3 test seam: park AFTER the claim
    /// and publication, immediately BEFORE the ownership commit — the
    /// deterministic stale-commit window (the test fences the claimed key
    /// while parked; the released commit must fail, tear down, and
    /// answer Abandoned with NOTHING persisted).
    #[cfg(test)]
    adoption_commit_pause: Option<std::sync::Arc<AdoptionTestPause>>,
    /// b8ke e3r2 F2 test seam: park in the KILL path between the stop
    /// claim and the retained-stamp take — the deterministic
    /// watcher-race window (the test removes the stamp while parked;
    /// the released take must be Option-tolerant, never a panic).
    #[cfg(test)]
    kill_stop_take_pause: Option<std::sync::Arc<AdoptionTestPause>>,
    /// C24 regression seam: park after the kill's first alias resolution,
    /// before the close gate's index+sessions critical section. A concurrent
    /// conversation rekey can then prove the gate recomputes the live map key.
    #[cfg(test)]
    kill_after_resolve_pause: Option<std::sync::Arc<AdoptionTestPause>>,
    /// b8ke e3r3 F8 test seam: park in the KILL path's clean-close
    /// FAILURE arm, after the granted take and immediately BEFORE the
    /// atomic verdict+restore — the deterministic exit-after-verdict
    /// window (the test kills the sidecar while parked; the released
    /// restore must re-validate under the lock and refuse the dead
    /// runtime's stamp).
    #[cfg(test)]
    kill_close_failure_pause: Option<std::sync::Arc<AdoptionTestPause>>,
    /// P1.13 identity-event sink (the pane-ledger bridge,
    /// [`crate::identity_sink`]). Clone-shared + set-once: the state is cloned
    /// into consumer tasks, so the `OnceLock` sits behind an `Arc`. Wired
    /// post-construction by `freshell-server` (precedent:
    /// `TerminalRegistry::set_activity_observer`).
    identity_sink: Arc<std::sync::OnceLock<SharedPaneIdentitySink>>,
    /// The per-sessionRef create/resume lease (D8 for fresh agents, Task 12) —
    /// ALWAYS ON at this runtime seam (never capability-gated: the two-writers JSONL
    /// corruption it prevents is real regardless of client generation). `main.rs`
    /// replaces the default with the ONE server-wide shared map via
    /// [`Self::set_session_leases`]; keys are provider-namespaced either way.
    leases: Arc<crate::session_lease::FreshAgentSessionLeases>,
    /// The ONE server-wide runtime-ownership coordinator (kata b8ke Task 3),
    /// wired from freshell-server::main next to `fresh_agent_leases`.
    /// `None` (every pre-existing test) = the lane skips coordinator
    /// bookkeeping and keeps its current probe-based behavior only.
    ownership: Option<Arc<freshell_ownership::RuntimeOwnershipRegistry>>,
    /// This lane's retained coordinator commit stamps (kata b8ke Task 3):
    /// canonical durable id → the stamp its `commit_live` left — the kill
    /// `StopClaim` / consumer-eviction `ReleaseClaim` source (round-2
    /// review).
    pub(crate) ownership_stamps: crate::ownership_lane::OwnershipStamps,
    /// Task 13b: cross-kind liveness -- true when a live terminal PTY owns
    /// `(provider, session_id)`. Wired by `main.rs`; defaults to always-false.
    terminal_liveness: crate::TerminalLivenessProbe,
    /// Rollback-vs-rollback single-flight (kata 1wxv Task 4), keyed by the
    /// CURRENT durable id. [`Self::handle_rollback`] acquires it BEFORE the
    /// session's `turn_lock` (lock order: rollback_in_flight FIRST, then the
    /// turn lock — never the reverse); nothing else acquires it.
    rollback_in_flight: crate::InFlightRegistry,
    /// Fork-vs-fork single-flight (C14), keyed by the parent's sessions-map
    /// key: a second Fork click on the same pane while the first one boots its
    /// child is refused, never a second child the pane cannot adopt (the
    /// codex `fork_in_flight` rule).
    fork_in_flight: crate::InFlightRegistry,
    /// Focused-ep5-r1 Finding 1 (retire-on-kill round 2): retained ALIAS
    /// tombstones. When a session's `cli_index` aliases are evicted (consumer
    /// exit, kill, a lease-revoked/rollback teardown), the mapping is DEMOTED
    /// here (placeholder map key -> every durable id it answered to), TTL'd,
    /// instead of dropped. Read for RETIRE resolution ONLY by
    /// [`Self::handle_kill`]: the client closes a pane by its ORIGINAL bare
    /// placeholder sessionId, and without this record a kill arriving after
    /// the sidecar's exit-eviction cannot recover the durable id the ledger
    /// row is keyed on — the retire silently missed it (the finding). Round
    /// 3 lifecycle (focused-ep5-r2 Finding 2): a genuine claim (resume/
    /// attach of the durable) CONSUMES its records
    /// ([`AliasTombstones::clear_for_durable`] via `commit_session_claim`),
    /// and `collect_kill_retire_ids` additionally skips any surviving record
    /// whose durable id is live on a DIFFERENT session — a stale alias can
    /// never retire a reopened session. Never consulted by live-resolution
    /// paths (`resolve_session_key`, send/interrupt/attach, snapshots): a
    /// tombstoned session is DEAD, and this record answers ids for retire
    /// writes only — it makes nothing look alive.
    alias_tombstones: Arc<std::sync::Mutex<AliasTombstones>>,
    /// Focused-episode-6 round 4 (Finding F5): the kill's enumeration gate —
    /// map_key -> in-flight close count. A kill INCREMENTS this under the
    /// same one critical section (cli_index → sessions → alias_tombstones →
    /// this map — the only acquire order anywhere) that enumerates the
    /// session's complete durable identity set, so that set is COMPLETE by
    /// construction: any adoption minting a durable id behind the
    /// enumeration reads a nonzero gate under the identical locks and
    /// ABANDONS (never a post-envelope discovery). Decremented only when
    /// the envelope fails Clean (the kill aborts and the session is
    /// genuinely untouched — sends/mints resume); a successful or
    /// persisted-durably close tears the session down and the gate entry
    /// dies with it.
    close_pending: Arc<std::sync::Mutex<HashMap<String, usize>>>,
    /// Unified agent names (Task 2): the injected naming authority — same
    /// set-once/shared model as [`Self::identity_sink`]. Wired by
    /// `freshell-server::main`; unwired = scoped naming fails unavailable.
    naming: crate::naming::NamingSink,
    /// Unified agent names: placeholder session id → the pre-durable naming
    /// handle admitted at create. Popped by [`Self::adopt_session_init`]'s
    /// naming hook, so the handle binds to the durable UUID exactly once
    /// (idempotent in the store) even when blank settings bypass
    /// `record_binding`.
    naming_handles: Arc<TokioMutex<HashMap<String, String>>>,
    /// Sessions whose sidecar ended unrequested (C09, G05): the end-of-output
    /// path records each one here as it evicts it from [`Self::sessions`], so the
    /// pane's ids still resolve to an ended session — its snapshot overlay says
    /// `exited` and a send to it is refused visibly. Resuming or closing the
    /// session forgets the record. See [`crate::claude_dead_sessions`].
    dead_sessions: crate::claude_dead_sessions::SharedDeadSessions,
    /// The one place a claude attention edge leaves the server (design §5.5,
    /// C18): edges, the attention observer and the typed turn events.
    edges: crate::claude_edges::ClaudeEdgeHub,
    /// Test holds on the session lifecycle ([`crate::claude_test_holds`]); none
    /// is set in production.
    test_holds: Arc<crate::claude_test_holds::ClaudeTestHolds>,
}

/// Focused-ep5-r1 Finding 1: retention for demoted alias records. The
/// kill-after-exit window is human-scale (the user notices the crashed pane
/// and closes it) — hours cover it with margin while bounding memory. The
/// CAP is a deliberate second bound for a pathological crash storm (records
/// are tiny; eviction is oldest-freshest-first).
///
/// Retire-on-kill round 5 (focused-ep5-r4 Finding 2): the alias lifetime IS
/// the row lifetime. A long-lived pane (days) whose sidecar exit-demoted its
/// alias is still closed by its bare placeholder, so the placeholder→durable
/// mapping must survive as long as the row it can resolve to. TTL expiry and
/// capacity eviction therefore consult the ROW STATE (via the `row_bound`
/// probe every public method takes): a record whose durable row is still
/// Bound is never expired and never an eviction candidate; only a record
/// whose row is already Retired-or-GC'd may be discarded (its close can no
/// longer miss anything live). A wholly bound set may exceed the cap
/// (logged; correctness outranks the memory bound — the records are tiny).
const ALIAS_TOMBSTONE_TTL_MS: i64 = 6 * 60 * 60 * 1000;
const ALIAS_TOMBSTONE_CAP: usize = 1024;

/// One demoted alias: the durable claude UUID the placeholder map key
/// aliased, and when the demotion happened (the TTL clock).
struct AliasTombstone {
    durable: String,
    at_ms: i64,
}

/// The demoted-alias store (Finding 1). Writes sweep lazily (TTL + cap); the
/// kill path's read sweeps too, so expired records never answer a kill.
#[derive(Default)]
struct AliasTombstones {
    by_placeholder: HashMap<String, Vec<AliasTombstone>>,
}

impl AliasTombstones {
    /// Demote one (placeholder, durable) alias. A repeat demotion refreshes
    /// the record's time (the newest evidence wins the TTL). `row_bound` is
    /// the retention probe (round 5, Finding 2): the durable row's raw Bound
    /// state — see [`Self::sweep`].
    fn record(
        &mut self,
        placeholder: &str,
        durable: &str,
        now_ms: i64,
        row_bound: &dyn Fn(&str) -> bool,
    ) {
        let entries = self
            .by_placeholder
            .entry(placeholder.to_string())
            .or_default();
        if let Some(existing) = entries.iter_mut().find(|e| e.durable == durable) {
            existing.at_ms = now_ms;
        } else {
            entries.push(AliasTombstone {
                durable: durable.to_string(),
                at_ms: now_ms,
            });
        }
        self.sweep(now_ms, row_bound);
    }

    /// Every durable id this placeholder has answered to within the TTL —
    /// the kill path's evicted-alias resolution (retire set material, never
    /// a liveness answer). Round 5 (Finding 2): TTL-discard consults the row
    /// state — a still-Bound row's records never age out (the pane's close
    /// still needs them).
    fn durables_for(
        &mut self,
        placeholder: &str,
        now_ms: i64,
        row_bound: &dyn Fn(&str) -> bool,
    ) -> Vec<String> {
        self.sweep(now_ms, row_bound);
        self.by_placeholder
            .get(placeholder)
            .map(|entries| entries.iter().map(|e| e.durable.clone()).collect())
            .unwrap_or_default()
    }

    /// Round 6 (focused-ep5-r5 Finding 2): fold a DURABLE alias record into
    /// the in-memory store — the kill consult's persisted arm. The persisted
    /// `at_ms` is kept as the TTL truth (never refreshed to now by the fold;
    /// a fresher in-memory demotion keeps its newer stamp). The sweep
    /// follows, so the same row-state retention rule decides.
    fn record_persisted(
        &mut self,
        placeholder: &str,
        durable: &str,
        at_ms: i64,
        now_ms: i64,
        row_bound: &dyn Fn(&str) -> bool,
    ) {
        let entries = self
            .by_placeholder
            .entry(placeholder.to_string())
            .or_default();
        if let Some(existing) = entries.iter_mut().find(|e| e.durable == durable) {
            existing.at_ms = existing.at_ms.max(at_ms);
        } else {
            entries.push(AliasTombstone {
                durable: durable.to_string(),
                at_ms,
            });
        }
        self.sweep(now_ms, row_bound);
    }

    /// Focused-ep5-r2 Finding 2 (retire-on-kill round 3): a genuine claim of
    /// `durable` CONSUMES every demoted alias record pointing to it — the
    /// reopened identity is live again, so a later kill naming one of those
    /// old placeholders must no longer retire the live durable row. Returns
    /// the placeholder keys whose records pointed at `durable` (the claim
    /// clears their LEDGER kill fences too — every known alias of the
    /// reopened identity reopens together). Other durables' records under
    /// the same placeholder (a same-key re-registration answered to several)
    /// are untouched.
    fn clear_for_durable(
        &mut self,
        durable: &str,
        now_ms: i64,
        row_bound: &dyn Fn(&str) -> bool,
    ) -> Vec<String> {
        self.sweep(now_ms, row_bound);
        let mut cleared = Vec::new();
        self.by_placeholder.retain(|placeholder, entries| {
            let before = entries.len();
            entries.retain(|e| e.durable != durable);
            if entries.len() != before {
                cleared.push(placeholder.clone());
            }
            !entries.is_empty()
        });
        cleared
    }

    /// Round 5 (focused-ep5-r4 Finding 2): the sweep's discard rule consults
    /// ROW STATE, never age alone. TTL expiry drops only records whose
    /// durable row is already Retired-or-GC'd (`row_bound` false — the
    /// mapping can no longer miss a live close); a record resolving to a
    /// still-Bound row survives any age because the pane's close (by the
    /// bare placeholder, days after the exit-eviction) still needs it.
    /// Capacity eviction likewise only ever takes an UNBOUND placeholder
    /// (oldest-newest first); if every record is bound, the store runs over
    /// the cap (loudly — records are tiny, and correctness outranks the
    /// memory bound).
    fn sweep(&mut self, now_ms: i64, row_bound: &dyn Fn(&str) -> bool) {
        self.by_placeholder.retain(|_, entries| {
            entries.retain(|e| row_bound(&e.durable) || now_ms - e.at_ms < ALIAS_TOMBSTONE_TTL_MS);
            !entries.is_empty()
        });
        while self.by_placeholder.len() > ALIAS_TOMBSTONE_CAP {
            // Evict the placeholder whose NEWEST record is oldest — but only
            // among placeholders with NO bound-row record (a bound-row record
            // outlives the cap by the finding's rule).
            let oldest = self
                .by_placeholder
                .iter()
                .filter(|(_, entries)| entries.iter().all(|e| !row_bound(&e.durable)))
                .map(|(k, entries)| {
                    (
                        k.clone(),
                        entries.iter().map(|e| e.at_ms).max().unwrap_or(i64::MIN),
                    )
                })
                .min_by_key(|(_, newest)| *newest)
                .map(|(k, _)| k);
            let Some(oldest) = oldest else {
                tracing::warn!(target: "freshell_freshagent::claude",
                    size = self.by_placeholder.len(),
                    cap = ALIAS_TOMBSTONE_CAP,
                    "freshagent.claude.alias_tombstones_over_cap: every record resolves to a \
                     still-Bound row; the alias lifetime is the row lifetime (finding 2)");
                break;
            };
            self.by_placeholder.remove(&oldest);
        }
    }
}

/// The cached result of a completed claude/kilroy `freshAgent.create`, keyed by
/// `requestId` in [`FreshClaudeState::create_dedup`]: what the original
/// `freshAgent.created` said, so the replay branch re-answers identically (a resume
/// create's `sessionRef` included).
#[derive(Clone)]
struct ClaudeCreateRecord {
    session_id: String,
    session_ref: Option<freshell_protocol::SessionLocator>,
}

/// The `sessionRef` of the claude conversation `session_id`.
fn claude_session_ref(session_id: &str) -> freshell_protocol::SessionLocator {
    freshell_protocol::SessionLocator {
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
    }
}

/// The per-session pending approval/question set folded from the sidecar's stdout
/// stream (Task 2). Feeds the respond handlers' membership check and the Task 3
/// snapshot overlay. Lives behind a shared handle (the `broadcast_id` precedent): the
/// detached stdout consumer folds into it while the respond handlers read/mutate it.
/// Session eviction on EOF/exit drops the Arc with the record — no extra handling.
#[derive(Default)]
struct ClaudePending {
    permissions: Vec<PendingApprovalEntry>,
    questions: Vec<PendingQuestionEntry>,
}

/// One pending claude approval (an `sdk.permission.request` not yet answered/cancelled),
/// capturing the contract fields the Task 3 snapshot overlay serializes.
struct PendingApprovalEntry {
    request_id: String,
    tool_name: Option<String>,
    tool_use_id: Option<String>,
    blocked_path: Option<String>,
    decision_reason: Option<String>,
    input: Option<Value>,
    /// The CLI's own suggestions (what "Allow and don't ask again" sends back),
    /// normalized to the strict contract shape on entry
    /// ([`crate::claude_permission_update::normalize_permission_updates`]); `None`
    /// when the request offered none that survive.
    suggestions: Option<Vec<Value>>,
}

impl PendingApprovalEntry {
    /// The `.strict()` contract shape the Task 3 snapshot overlay serializes
    /// (`{requestId, toolName?, toolUseID?, blockedPath?, decisionReason?, input?,
    /// suggestions?}` — keys omitted when absent, never null).
    fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("requestId".to_string(), json!(self.request_id));
        if let Some(tool_name) = &self.tool_name {
            obj.insert("toolName".to_string(), json!(tool_name));
        }
        if let Some(tool_use_id) = &self.tool_use_id {
            obj.insert("toolUseID".to_string(), json!(tool_use_id));
        }
        if let Some(blocked_path) = &self.blocked_path {
            obj.insert("blockedPath".to_string(), json!(blocked_path));
        }
        if let Some(decision_reason) = &self.decision_reason {
            obj.insert("decisionReason".to_string(), json!(decision_reason));
        }
        if let Some(input) = &self.input {
            obj.insert("input".to_string(), input.clone());
        }
        if let Some(suggestions) = &self.suggestions {
            obj.insert("suggestions".to_string(), Value::Array(suggestions.clone()));
        }
        Value::Object(obj)
    }
}

/// One pending provider question (`sdk.question.request`, the AskUserQuestion tool).
/// `questions` is the CONTRACT-NORMALIZED copy ([`normalize_question_definitions`]) —
/// the pending set feeds the `.strict()` snapshot overlay, while the WS broadcast of
/// the same frame stays verbatim.
struct PendingQuestionEntry {
    request_id: String,
    questions: Value,
}

/// Handles a response needs after releasing the shared sessions-map lock.
struct ResponseSession {
    map_key: String,
    ownership_id: String,
    stdin: crate::claude_sidecar_io::SidecarWriter,
    sidecar_session_id: String,
    pending: Arc<std::sync::Mutex<ClaudePending>>,
}

/// One live freshclaude session: the Node sidecar it drives + its stdout consumer.
struct ClaudeSession {
    session_type: String,
    quiet: deadman::QuietWatch,
    configuration: ClaudeConfiguration,
    /// Per-runtime stdin writer; await only after dropping the sessions map lock.
    stdin: crate::claude_sidecar_io::SidecarWriter,
    /// The owned Node sidecar child (SIGKILL backstop; `kill_on_drop`).
    child: Child,
    /// G31: owns the sidecar's whole process tree (node AND the SDK-spawned
    /// claude CLI). Teardown escalates through it; dropping it (any path that
    /// drops this record) kills whatever is left of the tree.
    tree_guard: crate::claude_spawn::SidecarTreeGuard,
    /// The `/proc` reaper tag for this session's sidecar + its claude CLI grandchild.
    ownership_id: String,
    /// The stdout-consumer task (aborted on shutdown).
    consumer: tokio::task::JoinHandle<()>,
    /// The id the SIDECAR keys this session by (`created.sessionId`). Equal to the
    /// sessions-map key for created sessions; DIFFERENT for resumed-on-attach sessions
    /// (Task 6), where the map key is the CLIENT's original id. `handle_send`/
    /// `handle_interrupt` MUST address the sidecar with this id, never the map key.
    sidecar_session_id: String,
    /// Best-effort copy of the durable Claude UUID, recorded from `sdk.session.init`
    /// by the stdout consumer. Attach/eviction resolve durable ids through
    /// [`FreshClaudeState::cli_index`], and the snapshot adapter is disk-only; the
    /// settings paths (a settings apply, the CLI's own permission-mode change) read
    /// it to write the session's binding row once the session has one.
    cli_session_id: Option<String>,
    /// b8ke focused episode-2 round-2 F2: the operation id of the lifecycle
    /// op that OWNS this runtime's coordinator claim — the create-resume
    /// claim's op id, or the handoff runner's op id for an under-ticket
    /// target resume. The session-init adoption's Blocked arm correlates
    /// the blocking coordinator state's operation id against this marker:
    /// only the runtime's OWN operation (which will resolve the key — the
    /// create's commit, the runner's commit) may proceed without a claim;
    /// an UNRELATED blocking operation (another device's handoff on the
    /// still-vacant canonical key, a foreign start) fails CLOSED — the
    /// freshly spawned runtime is torn down, never left running unowned
    /// while the other operation believes there was no prior owner.
    owning_operation: Option<String>,
    /// b8ke ext r27 F2: the GENERATION of the lifecycle op that owns this
    /// runtime's coordinator transition (the handoff runner's under-ticket
    /// target resume) — `owning_operation`'s numeric twin. The session-init
    /// adoption's durable binding write stamps the row with this generation
    /// when the adoption holds no own ticket (the under-ticket shape), so
    /// the target row carries the HANDOFF's generation instead of
    /// preserving the prior one (pre-r27 the under-ticket write carried no
    /// pair and a delayed prior-generation write could pass the ledger's
    /// comparison and replace the new owner's recovery metadata).
    owning_generation: Option<u64>,
    /// The envelope-stamp id the stdout consumer reads PER EVENT (Task 10b). Starts as
    /// the sessions-map key; an attach-by-durable REBIND flips it to the durable id so
    /// the pane keyed on the durable receives events. A shared mutable handle because
    /// the consumer task runs detached from this record.
    broadcast_id: Arc<std::sync::Mutex<String>>,
    /// The folded pending approval/question set (Task 2) — see [`ClaudePending`].
    pending: Arc<std::sync::Mutex<ClaudePending>>,
    /// The session's busy truth (design §5.2, C17): every command the server
    /// sent and the CLI has not ended, the CLI's own turns and its compactions,
    /// and the status last published. The handlers arm it under `turn_lock`
    /// before each write; the stdout consumer folds the sidecar's lines into it
    /// and publishes the status; the rollback, fork and configure gates read
    /// [`crate::claude_turns::ClaudeTurnLedger::busy`]. An undo's replacement
    /// takes it over (the same logical session).
    ledger: crate::claude_turns::SharedLedger,
    /// The session's attention clock (design §5.5, C18): every edge the server
    /// mints for it (a result that rings, a death while a turn was owed, a
    /// waiting edge) takes its strictly increasing `at` from here, so edges
    /// from different sources never collide or regress (G24). An undo's
    /// replacement and a resume after an unrequested death take it over (the
    /// same logical session).
    clock: crate::attention::AttentionClock,
    /// kata 1wxv Task 4 (r2 serialization discipline): ONE per-session async turn
    /// lock. `handle_rollback` holds it across the WHOLE handler (busy-check →
    /// reads → record pre-write → pending-cancel → kill+spawn+adoption → reply);
    /// `handle_send` waits on it, then proceeds and destroys redo — and never
    /// ACQUIRES `rollback_in_flight` (no circular wait exists). The replacement
    /// an undo or redo registers takes this lock over, so a request that waited
    /// on it follows the replacement (`live_key_after_turn_wait`).
    turn_lock: Arc<TokioMutex<()>>,
    /// The genesis this runtime was launched from when it had no transcript yet
    /// (an undo's replacement, a fork's child; design §4.1), stamped with the
    /// launch time. The snapshot serves it when the ledger records none: a lane
    /// with no ledger (the hosted session host) still shows a pending session's
    /// conversation. A transcript on disk always wins over it.
    launch_genesis: Option<crate::identity_sink::RecordedGenesis>,
}

/// What a claude `freshAgent.session.metadata` frame states (see
/// [`FreshClaudeState::stated_settings`]).
#[derive(Debug, Default, PartialEq, Eq)]
struct StatedSettings {
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
}

#[derive(Default)]
struct ClaudeConfiguration {
    settings: crate::identity_sink::FreshAgentSettings,
    pending: Option<(String, tokio::sync::oneshot::Sender<Result<(), String>>)>,
    commands: Option<Vec<Value>>,
    needs_configure: bool,
    runtime_cwd: Option<String>,
    /// The pane this runtime was launched for (G19): an undo's replacement and
    /// a fork's child launch for the same pane.
    freshell_context: Option<crate::claude_freshell_mcp::ClaudeFreshellContext>,
}

impl ClaudeSession {
    /// The session's effective status (design §5.2) — the truth the attach
    /// acknowledgements and the snapshot overlay speak.
    fn current_status(&self) -> String {
        let quiet = self.quiet.state.lock().expect("quiet deadman lock");
        self.ledger
            .lock()
            .expect("turn ledger lock")
            .effective_status(false, quiet.is_stuck())
            .as_str()
            .to_string()
    }
}

/// Round-3 review I-1 (cancellation-safety): RAII removal for the
/// `resuming` single-flight flag inside [`FreshClaudeState::resume_for_handoff`].
/// An aborted handoff runner drops the resume future mid-flight — every
/// manual removal would be skipped, and the leaked flag would refuse every
/// later retry with "another resume is in flight" forever. Dropping this
/// guard removes the flag; the function's manual early-return removals
/// were dropped in its favor (removal is idempotent — every exit path now
/// goes through Drop).
struct ResumingFlagGuard {
    resuming: Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
    changed: Arc<tokio::sync::Notify>,
    session_id: String,
}

impl Drop for ResumingFlagGuard {
    fn drop(&mut self) {
        let removed = self
            .resuming
            .lock()
            .expect("resuming lock")
            .remove(&self.session_id);
        if removed {
            self.changed.notify_waiters();
        }
    }
}

/// b8ke focused episode-2 round-2 F3 + round-3 F10 + post-cap F7 test
/// seam: the deterministic kill-between-read-and-publication hold.
/// `reached` flips BEFORE the park so a test can prove the adoption
/// parked, and the release MUST use `notify_one()` — it retains a permit
/// for a not-yet-registered waiter, so the reached→notify gap cannot
/// lose the wake (`notify_waiters` retains nothing).
#[cfg(test)]
pub struct AdoptionTestPause {
    pub notify: tokio::sync::Notify,
    pub reached: std::sync::atomic::AtomicBool,
}

/// b8ke focused episode-2 round-3 F2: the adoption's tri-state answer.
/// `Published` — the alias publication landed (the session is reachable by
/// its advertised durable id). `Abandoned` — the adoption definitively
/// landed NOTHING (the mint gate, a session that is gone or replaced, a
/// refused claim) — the caller must FAIL, never continue with an
/// unreachable live runtime. `Deferred` — the session is not yet
/// registered; the publication lands post-registration and the completion
/// hook carries the final answer.
enum SessionInitAdoptionOutcome {
    Published,
    Abandoned,
    Deferred,
}

impl FreshClaudeState {
    /// Build the state around the shared broadcast bus.
    pub fn new(broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>) -> Self {
        Self {
            hosted_mcp: false,
            freshell_mcp: Default::default(),
            sidecar_environment: None,
            edges: crate::claude_edges::ClaudeEdgeHub::new(Arc::clone(&broadcast_tx)),
            broadcast_tx,
            checkpoint_event_sink: crate::CheckpointEventSink::default(),
            sessions: Arc::new(TokioMutex::new(HashMap::new())),
            cli_index: Arc::new(TokioMutex::new(HashMap::new())),
            create_dedup: Arc::new(FreshAgentCreateDedup::new()),
            resuming: Arc::new(std::sync::Mutex::new(std::collections::HashSet::new())),
            resuming_changed: Arc::new(tokio::sync::Notify::new()),
            identity_sink: Arc::new(std::sync::OnceLock::new()),
            leases: Arc::new(crate::session_lease::FreshAgentSessionLeases::new()),
            ownership: None,
            ownership_stamps: Arc::new(std::sync::Mutex::new(HashMap::new())),
            terminal_liveness: Arc::new(|_, _| false),
            rollback_in_flight: crate::InFlightRegistry::new(),
            fork_in_flight: crate::InFlightRegistry::new(),
            alias_tombstones: Arc::new(std::sync::Mutex::new(AliasTombstones::default())),
            close_pending: Arc::new(std::sync::Mutex::new(HashMap::new())),
            naming: crate::naming::NamingSink::default(),
            naming_handles: Arc::new(TokioMutex::new(HashMap::new())),
            dead_sessions: Default::default(),
            test_holds: Arc::default(),
            handoff_kill_pause: None,
            rollback_adopt_parked: None,
            rollback_adopt_release: None,
            handoff_confirm_rounds: None,
            handoff_platform_limited: None,
            handoff_resume_pause: None,
            condemned_priors: Arc::new(std::sync::Mutex::new(HashMap::new())),
            #[cfg(test)]
            adoption_pause: None,
            #[cfg(test)]
            adoption_commit_pause: None,
            #[cfg(test)]
            kill_stop_take_pause: None,
            #[cfg(test)]
            kill_after_resolve_pause: None,
            #[cfg(test)]
            kill_close_failure_pause: None,
        }
    }

    pub fn with_hosted_mcp(mut self, selected: bool) -> Self {
        self.hosted_mcp = selected;
        self
    }

    /// Report every claude attention edge, pending drain and session identity
    /// change to `observer` (design §9.2 I-1). Every clone of this state
    /// reports to it.
    pub fn with_attention_observer(
        self,
        observer: Arc<dyn crate::claude_edges::AttentionObserver>,
    ) -> Self {
        self.edges.set_observer(observer);
        self
    }

    /// Every claude turn event from now on (design §9.3 I3): each settled turn
    /// with the requests it retired (a turn the user's Stop silenced too, with
    /// no `at`), each waiting edge and each unrequested session end. A
    /// dedicated low-volume channel: stream traffic never fills it.
    pub fn subscribe_turn_events(
        &self,
    ) -> tokio::sync::broadcast::Receiver<crate::claude_edges::ClaudeTurnEvent> {
        self.edges.subscribe()
    }

    /// Last attention marks retained for negotiated same-page reconnects.
    pub fn attention_marks(&self) -> Vec<freshell_protocol::FreshAgentAttentionMark> {
        self.edges.attention_marks()
    }

    /// Wire where every sidecar's CLI reaches this server (G19): its
    /// environment carries `FRESHELL=1`, `FRESHELL_URL` and `FRESHELL_TOKEN`.
    /// Set-once; `false` when an endpoint was already wired.
    pub fn set_freshell_endpoint(
        &self,
        endpoint: crate::claude_freshell_mcp::FreshellEndpoint,
    ) -> bool {
        self.freshell_mcp.set_endpoint(endpoint)
    }

    /// Wire the Freshell MCP recipe provider (G19), asked at every sidecar
    /// launch of a lane that did not select the hosted recipe. Set-once;
    /// `false` when a provider was already wired.
    pub fn set_freshell_mcp_provider(
        &self,
        provider: crate::claude_freshell_mcp::ClaudeFreshellMcpProvider,
    ) -> bool {
        self.freshell_mcp.set_provider(provider)
    }

    /// Test seam (see [`Self::sidecar_environment`]): every sidecar this state
    /// spawns gets exactly `environment` (plus its ownership tag) instead of
    /// inheriting the server's environment.
    #[cfg(any(test, feature = "test-support"))]
    pub fn with_sidecar_environment(
        mut self,
        environment: impl IntoIterator<Item = (String, String)>,
    ) -> Self {
        self.sidecar_environment = Some(environment.into_iter().collect());
        self
    }

    /// Test seam (see [`crate::claude_test_holds`]): every later session
    /// registration waits `hold` between starting the session's consumer and
    /// inserting its record, the way a production resume create awaits its
    /// identity-sink write there.
    #[cfg(any(test, feature = "test-support"))]
    pub fn hold_session_registration(&self, hold: Duration) {
        self.test_holds.hold_registration(hold);
    }

    /// Test seam (see [`crate::claude_test_holds`]): park every later
    /// end-of-output path after it recorded the dead session, before it reaps the
    /// sidecar and reports the exit, until the returned hold is released.
    #[cfg(any(test, feature = "test-support"))]
    pub fn hold_exit_reports(&self) -> Arc<crate::claude_test_holds::StepHold> {
        self.test_holds.hold_exit_report()
    }

    /// Test seam (see [`crate::claude_test_holds`]): park every later undo or
    /// redo after it wrote its durable record (holding the session's turn
    /// lock), before it boots the replacement runtime, until the returned hold
    /// is released.
    #[cfg(any(test, feature = "test-support"))]
    pub fn hold_rollback_boot(&self) -> Arc<crate::claude_test_holds::StepHold> {
        self.test_holds.hold_rollback_boot()
    }

    /// Test seam: park every later fork once its child runtime is established,
    /// before it records the child's binding row, until the returned hold is
    /// released.
    #[cfg(any(test, feature = "test-support"))]
    pub fn hold_fork_child(&self) -> Arc<crate::claude_test_holds::StepHold> {
        self.test_holds.hold_fork_child()
    }

    /// Spawn one claude sidecar process (create, attach-resume and rollback all
    /// come through here) for a session of `session_type`.
    async fn spawn_sidecar_process(&self, session_type: &str) -> Result<SpawnedSidecar, String> {
        spawn_sidecar(
            self.sidecar_environment.as_deref(),
            self.freshell_mcp.endpoint(),
            session_type,
        )
        .await
    }

    pub fn set_checkpoint_event_persister(
        &self,
        persister: crate::CheckpointEventPersister,
    ) -> Result<(), &'static str> {
        self.checkpoint_event_sink.set_persister(persister)
    }

    /// b8ke focused episode-2 round-3 F3: crate-visible session-key resolver
    /// for in-crate cross-module tests.
    #[cfg(test)]
    pub(crate) async fn test_resolve_session_key(&self, session_id: &str) -> Option<String> {
        self.resolve_session_key(session_id).await
    }

    /// b8ke focused episode-2 round-3 F3: crate-visible adoption driver for
    /// in-crate cross-module tests (the handoff-runner tests drive an
    /// in-stream re-key: an init naming a durable id other than the one the
    /// session already carries).
    #[cfg(test)]
    pub(crate) async fn test_adopt_session_init(
        &self,
        cli_id: &str,
        session_id: &str,
        session_type: &str,
    ) {
        self.adopt_session_init(cli_id, session_id, session_type, None, None, None)
            .await;
    }

    /// b8ke focused episode-2 round-2 F3 test seam installer.
    #[cfg(test)]
    pub fn set_adoption_test_pause(&mut self, pause: Option<std::sync::Arc<AdoptionTestPause>>) {
        self.adoption_pause = pause;
    }

    /// b8ke e3r3 F8 test seam installer (the clean-failure pre-restore park).
    #[cfg(test)]
    pub fn set_kill_close_failure_test_pause(
        &mut self,
        pause: Option<std::sync::Arc<AdoptionTestPause>>,
    ) {
        self.kill_close_failure_pause = pause;
    }

    /// b8ke e3r2 F2 test seam installer (the kill's take-race park).
    #[cfg(test)]
    pub fn set_kill_stop_take_test_pause(
        &mut self,
        pause: Option<std::sync::Arc<AdoptionTestPause>>,
    ) {
        self.kill_stop_take_pause = pause;
    }

    /// C24 regression seam: park after the kill's initial session-key lookup.
    #[cfg(test)]
    pub fn set_kill_after_resolve_test_pause(
        &mut self,
        pause: Option<std::sync::Arc<AdoptionTestPause>>,
    ) {
        self.kill_after_resolve_pause = pause;
    }

    /// b8ke focused episode-2 post-cap F3 test seam installer (the
    /// pre-commit park).
    #[cfg(test)]
    pub fn set_adoption_commit_test_pause(
        &mut self,
        pause: Option<std::sync::Arc<AdoptionTestPause>>,
    ) {
        self.adoption_commit_pause = pause;
    }

    /// b8ke focused episode-2 round-3 F3: resolve a wire session id to
    /// its canonical coordinator key. The COORDINATOR is the single
    /// source of truth: a re-keyed session's old key holds an
    /// `Aliased{to: new}` record there (written atomically by the rekey
    /// commit), and this resolves through the registry's own fixpoint
    /// walk — never a lane-local map, never a bounded link cap. Unwired
    /// (no coordinator): the identity (legacy behavior).
    pub fn resolve_ownership_key(&self, session_id: &str) -> String {
        match self.ownership.as_ref() {
            Some(registry) => registry.resolve_canonical(PROVIDER, session_id),
            None => session_id.to_string(),
        }
    }

    /// Test seam (Task 6 round-3 review I-1): arm the deterministic holds
    /// for the handoff abort-window tests — `kill_for_handoff` parks after
    /// taking the retained stamp, `resume_for_attach` parks after
    /// registering the target session. `None`/`None` in production.
    pub fn set_handoff_test_pauses(
        &mut self,
        kill_pause: Option<std::sync::Arc<tokio::sync::Notify>>,
        resume_pause: Option<std::sync::Arc<tokio::sync::Notify>>,
    ) {
        self.handoff_kill_pause = kill_pause;
        self.handoff_resume_pause = resume_pause;
    }

    /// Test seam (b8ke ext r38 F1): arm the deterministic hold for the
    /// rollback Adopt claim-to-arm race test — `handle_rollback` parks
    /// after the claim answers AdoptLive, BEFORE the atomic adopt arms,
    /// notifying `parked` on arrival and waiting on `release`.
    /// `None`/`None` in production.
    pub fn set_rollback_adopt_park_for_test(
        &mut self,
        parked: Option<std::sync::Arc<tokio::sync::Notify>>,
        release: Option<std::sync::Arc<tokio::sync::Notify>>,
    ) {
        self.rollback_adopt_parked = parked;
        self.rollback_adopt_release = release;
    }

    /// Test seam (b8ke focused FR3): shrink `kill_for_handoff`'s tree-death
    /// confirmation window so a TERM-immune tagged descendant
    /// deterministically outlives it — the not-confirmed red/green. `None`
    /// in production (the [`TREE_DEATH_CONFIRM_ROUNDS`] budget).
    pub fn set_handoff_confirm_rounds_for_test(&mut self, rounds: Option<u8>) {
        self.handoff_confirm_rounds = rounds;
    }

    /// Test seam (b8ke focused round-2 R2-3): make the next
    /// `kill_for_handoff` answer the typed platform-limited stop result —
    /// the Linux red/green for a confirmation gap the real code only
    /// produces on non-Linux builds. `None` in production.
    pub fn set_handoff_platform_limited_for_test(&mut self, armed: Option<bool>) {
        self.handoff_platform_limited = armed;
    }

    /// b8ke focused round-2 review R2-1 (widened round-3 R3-7): record the
    /// condemned prior's identity — the direct child's pid + start time AND
    /// the already-discovered tagged descendant tree, captured NOW (while
    /// the ancestry chain is intact and the tags readable) — for the
    /// canonical `session_id`, BEFORE `kill_for_handoff`'s first
    /// cancellable await. Sync (lock awaits only), never removes anything
    /// from the sessions map. The replacement probe verifies the start
    /// time before signaling (no unrelated-process kills on pid reuse) and
    /// sweeps the recorded tree when reparenting makes the tags unreadable
    /// (no empty-tree false confirmation).
    async fn record_condemned_prior(&self, session_id: &str) {
        let Some(map_key) = self.resolve_session_key(session_id).await else {
            return;
        };
        let identity = {
            let sessions = self.sessions.lock().await;
            sessions.get(&map_key).and_then(|session| {
                session
                    .child
                    .id()
                    .map(|pid| (pid, session.ownership_id.clone()))
            })
        };
        if let Some((pid, tag)) = identity {
            let recorded = crate::session_lease::record_condemned_runtime_identity(
                pid,
                CLAUDE_SIDECAR_OWNERSHIP_ENV,
                &tag,
            );
            self.condemned_priors
                .lock()
                .expect("condemned priors lock")
                .insert(session_id.to_string(), recorded);
        }
    }

    /// b8ke focused round-2 review R2-1: the bounded recorded-identity
    /// death probe for a fenced claude/kilroy prior. A condemned-prior
    /// record means a `kill_for_handoff` was cancelled or panicked between
    /// arming its record and confirming the tree's death — this probe
    /// FINISHES the job (SIGTERM→SIGKILL the recorded child + recorded
    /// tree, confirm dead-by-starttime — R3-7: the pid's start time is
    /// verified before any signal, and the tree captured at kill time
    /// still sweeps descendants whose tags became unreadable after the
    /// child died) and clears the record on success. A still-mapped
    /// session (the cancelled kill never reached the map removal) instead
    /// gets the lane's own full teardown re-run — its `Reaped` answer IS
    /// the confirmed reap. Never confirms on less: `false` keeps the fence
    /// held (fail-closed).
    pub async fn confirm_fenced_prior_dead(&self, session_id: &str) -> bool {
        // Bind before the `if let`: the guard must never live across the
        // kill-and-confirm await.
        let condemned = self
            .condemned_priors
            .lock()
            .expect("condemned priors lock")
            .get(session_id)
            .cloned();
        if let Some(condemned) = condemned {
            let confirmed = crate::session_lease::kill_and_confirm_recorded_tree_dead(
                &condemned,
                CLAUDE_SIDECAR_OWNERSHIP_ENV,
            )
            .await;
            if confirmed {
                self.condemned_priors
                    .lock()
                    .expect("condemned priors lock")
                    .remove(session_id);
            }
            return confirmed;
        }
        // No condemned record: either the cancelled teardown completed its
        // confirmation (the record was cleared) or it never got past the
        // session lookup. A still-live map entry is the latter — the full
        // lane teardown re-run is the confirmation. An absent entry with no
        // record has nothing this lane can positively probe (fail-closed:
        // the caller's fence holds).
        if self.has_live_session(session_id).await {
            match self
                .kill_for_handoff(session_id, "handoff-watcher-replacement")
                .await
            {
                crate::session_handoff::StopResult::Reaped => return true,
                crate::session_handoff::StopResult::NotConfirmed { confirmation } => {
                    return confirmation.await;
                }
                crate::session_handoff::StopResult::AlreadyGone
                | crate::session_handoff::StopResult::PlatformLimited => return false,
            }
        }
        false
    }

    /// Run [`teardown_removed_session`] with the production confirmation
    /// budget and PROPAGATE its typed outcome (b8ke focused round-2 review
    /// R2-2): an unconfirmed tree is never a silent success — the
    /// structured error line lands AND the detached escalation keeps
    /// killing the tree, with the handle handed to the caller. The
    /// kill-family sweeps and uncommitted-orphan unwinds hold no
    /// coordinator fence of their own, so for them the typed log plus the
    /// running escalation IS the discipline; the explicit kill (which
    /// holds `Stopping`) additionally defers its commit on the escalation.
    async fn teardown_removed_session_logged(&self, session: ClaudeSession) -> LoggedTeardown {
        let session_label = session.sidecar_session_id.clone();
        let confirmation = teardown_removed_session(session, self.tree_confirm_rounds()).await;
        escalate_unconfirmed_teardown(confirmation, session_label)
    }

    /// The tree-death confirmation budget every sidecar stop uses (a test can
    /// shorten it).
    fn tree_confirm_rounds(&self) -> u8 {
        self.handoff_confirm_rounds
            .unwrap_or(TREE_DEATH_CONFIRM_ROUNDS)
    }

    /// Wire the cross-kind terminal-liveness probe (Task 13b; called by `main.rs`
    /// before this state is cloned into the router).
    pub fn set_terminal_liveness(&mut self, probe: crate::TerminalLivenessProbe) {
        self.terminal_liveness = probe;
    }

    /// Replace the default lease map with the ONE server-wide shared map (Task 12;
    /// called by `main.rs` before this state is cloned into the router). Keys are
    /// provider-namespaced, so a default per-runtime map is semantically identical —
    /// the shared map exists for observability and Task 13b's cross-kind wiring.
    pub fn set_session_leases(
        &mut self,
        leases: Arc<crate::session_lease::FreshAgentSessionLeases>,
    ) {
        self.leases = leases;
    }

    /// Wire the ONE server-wide runtime-ownership coordinator (kata b8ke
    /// Task 3; called by `main.rs` next to `set_session_leases`).
    pub fn set_ownership(&mut self, registry: Arc<freshell_ownership::RuntimeOwnershipRegistry>) {
        self.ownership = Some(registry);
    }

    /// This lane's sessionRef lease map (kata b8ke Task 6, round-3 review
    /// I-1: the handoff guard's abort cleanup releases the lease a dropped
    /// resume left held after its confirmed tree kill).
    pub fn leases(&self) -> &crate::session_lease::FreshAgentSessionLeases {
        &self.leases
    }

    /// The coordinator key a claude session is owned under. The coordinator
    /// keys a claude session by its durable id (the map key and the pane's wire
    /// id are the lane's own placeholder), so once the CLI has reported the
    /// session (`system/init`, which it emits only once a prompt runs, T1) that
    /// id is the key, as in `handle_attach`. Before the report, or when
    /// `map_key` names no live session, the wire id is. Either resolves through
    /// the coordinator's alias walk. Kill and send both address the owner
    /// through this one rule. C23 (durable id minted at create) makes the
    /// durable id known from the start and removes the wire-id fallback.
    async fn claude_owner_key(&self, map_key: Option<&str>, wire_id: &str) -> ClaudeOwnerKey {
        let durable = match map_key {
            Some(map_key) => self
                .sessions
                .lock()
                .await
                .get(map_key)
                .and_then(|session| session.cli_session_id.clone()),
            None => None,
        };
        match durable {
            Some(durable) => ClaudeOwnerKey {
                key: self.resolve_ownership_key(&durable),
                reported: true,
            },
            None => ClaudeOwnerKey {
                key: self.resolve_ownership_key(wire_id),
                reported: false,
            },
        }
    }

    /// The coordinator key that fences a send to the session behind `map_key`,
    /// or `None` when the send runs unfenced. A reported session is always
    /// fenced on its durable id, and a supplied observed pair is always checked
    /// (against a record the coordinator does not hold, it is stale and the
    /// guard refuses it typed). The one unfenced case is a session the CLI has
    /// not reported, with no record in the coordinator and no pair on the
    /// send: a new pane's first message, which is what makes the CLI report
    /// it. Such a session has no durable id to hand off, reattach or roll back,
    /// and a close removes it from the map.
    async fn send_owner_key(
        &self,
        map_key: &str,
        wire_id: &str,
        fence: Option<freshell_ownership::ObservedFence>,
    ) -> Option<String> {
        let owner = self.claude_owner_key(Some(map_key), wire_id).await;
        if owner.reported || fence.is_some() {
            return Some(owner.key);
        }
        match self.ownership_snapshot(PROVIDER, &owner.key).state {
            freshell_ownership::OwnershipState::Vacant => None,
            _ => Some(owner.key),
        }
    }

    /// Side-effect-free coordinator read for `(provider, session_id)`
    /// (kata b8ke Task 3). `Vacant`/0 when the registry is unwired.
    /// b8ke focused episode-2 round-2 F1: the wire id resolves through the
    /// re-key alias map first — a snapshot/D7 read for a stale pane's
    /// superseded durable id reports the CANONICAL record, never a false
    /// Vacant over a live re-keyed runtime.
    pub fn ownership_snapshot(
        &self,
        provider: &str,
        session_id: &str,
    ) -> freshell_ownership::OwnershipSnapshot {
        let resolved = self.resolve_ownership_key(session_id);
        match &self.ownership {
            Some(registry) => registry.observe(provider, &resolved),
            None => freshell_ownership::OwnershipSnapshot {
                epoch: 0,
                generation: 0,
                state: freshell_ownership::OwnershipState::Vacant,
            },
        }
    }

    /// The watchdog's raw-teardown hook (kata b8ke Task 3): kill the
    /// uncommitted in-flight spawn's sidecar tree for `session_id` — the
    /// `(pid, ownership tag)` pair the spawn's lease armed, killed with the
    /// same confirmed-tree-dead primitive the TTL expiry path uses.
    pub async fn kill_raw_for_watchdog(&self, session_id: &str) -> bool {
        if let Some((pid, ownership_id)) = self.leases.peek_kill_handle(PROVIDER, session_id) {
            return crate::session_lease::kill_and_confirm_tree_dead(
                pid,
                CLAUDE_SIDECAR_OWNERSHIP_ENV,
                &ownership_id,
            )
            .await;
        }
        false
    }

    /// kata b8ke Task 6: the handoff runner's PRIOR-stop entry point. Thin
    /// `handle_kill`-shaped lane teardown for ONE session — NO coordinator
    /// stop (the runner owns the in-flight `Handoff`; `begin_stop` would be
    /// `BlockedHandoff`), NO durable-row retire (the session CONTINUES as
    /// the handoff's target kind), NO `freshAgent.killed` broadcast (the
    /// pane transition is the client-side `session.runtimeOwner` fold,
    /// Task 8). Resolves the canonical durable to its sessions-map key
    /// (alias, never moved), removes the session, aborts the consumer, and
    /// runs the standard teardown (graceful shutdown line + directed tree
    /// kill + ownership reap) — the awaited teardown IS the confirmed reap.
    /// The runner bounds this call with the handoff's reap timeout. Takes
    /// the retained stamp: the runner folds the exit.
    pub(crate) async fn kill_for_handoff(
        &self,
        session_id: &str,
        initiator: &str,
    ) -> crate::session_handoff::StopResult {
        tracing::info!(target: "freshell_freshagent::claude",
            session_id = %session_id, initiator,
            "freshagent.claude.handoff_stop: stopping the prior freshclaude/kilroy runtime for handoff"
        );
        crate::ownership_lane::take_retained_stamp(&self.ownership_stamps, session_id);
        // b8ke focused round-2 review R2-1: record the condemned identity
        // BEFORE the first await a cancellation can land in (the test pause
        // included) — a cancelled/panicked teardown leaves this record as
        // the replacement watcher's bounded kill-and-confirm probe target.
        self.record_condemned_prior(session_id).await;
        // Test seam (Task 6 round-3 review I-1): park with the kill ISSUED
        // (the retained stamp taken) but nothing else disturbed — the
        // prior-reap-window abort test's deterministic hold. None in
        // production and every other test.
        if let Some(pause) = self.handoff_kill_pause.as_ref() {
            let _ = pause.notified().await;
        }
        // Test seam (b8ke focused round-2 R2-3): the platform-limited shape
        // the real code only produces under `cfg(not(linux))`.
        if self.handoff_platform_limited == Some(true) {
            self.condemned_priors
                .lock()
                .expect("condemned priors lock")
                .remove(session_id);
            return crate::session_handoff::StopResult::PlatformLimited;
        }
        let Some(map_key) = self.resolve_session_key(session_id).await else {
            return crate::session_handoff::StopResult::AlreadyGone;
        };
        let removed = self.sessions.lock().await.remove(&map_key);
        self.close_pending
            .lock()
            .expect("close-pending lock")
            .remove(&map_key);
        let Some(session) = removed else {
            return crate::session_handoff::StopResult::AlreadyGone;
        };
        session.consumer.abort();
        // b8ke focused review FR3: the teardown's confirmed-death answer is
        // TYPED and fails closed. A `NotConfirmed` (the bounded window
        // expired with tagged descendants still alive) NEVER answers
        // `Reaped`: the lane returns the typed not-confirmed result
        // carrying a detached continuation that keeps escalating
        // (SIGKILL rounds) until the tree is dead — the runner fences the
        // key (the F3 machinery), broadcasts the failure frame first
        // (FR5), and its watcher releases on the continuation. A
        // `PlatformLimited` answer (non-Linux) is the typed limitation
        // (b8ke focused round-2 R2-3): the child's AWAITED exit is the
        // portable confirmation floor, but the descendant-tree gap must
        // NOT satisfy confirmed-reap — the runner fences the key with the
        // typed PlatformLimited reason (a new writer cannot start; the
        // session remains recoverable — the operator can still kill
        // leftover processes by other means; nothing on that platform can
        // ever confirm the descendant death, so the fence persists for the
        // boot epoch — the documented tradeoff).
        let confirmation = teardown_removed_session(
            session,
            self.handoff_confirm_rounds
                .unwrap_or(TREE_DEATH_CONFIRM_ROUNDS),
        )
        .await;
        self.evict_cli_index_aliases(&map_key).await;
        self.leases.clear_binding(PROVIDER, session_id);
        match confirmation {
            TeardownConfirmation::Confirmed => {
                self.condemned_priors
                    .lock()
                    .expect("condemned priors lock")
                    .remove(session_id);
                crate::session_handoff::StopResult::Reaped
            }
            TeardownConfirmation::PlatformLimited => {
                self.condemned_priors
                    .lock()
                    .expect("condemned priors lock")
                    .remove(session_id);
                crate::session_handoff::StopResult::PlatformLimited
            }
            TeardownConfirmation::NotConfirmed {
                mut tree,
                ownership_id,
            } => {
                tracing::warn!(target: "freshell_freshagent::claude",
                    session_id = %session_id, lingering = tree.len(),
                    "freshagent.claude.handoff_stop_unconfirmed: the bounded tree-death \
                     window expired with tagged descendants still alive — the escalation \
                     continues detached; Reaped is withheld until death is confirmed"
                );
                let escalation_session_id = session_id.to_string();
                let condemned_priors = Arc::clone(&self.condemned_priors);
                crate::session_handoff::StopResult::NotConfirmed {
                    confirmation: Box::pin(async move {
                        while !confirm_captured_claude_tree_dead(
                            &mut tree,
                            &ownership_id,
                            TREE_DEATH_CONFIRM_ROUNDS,
                        )
                        .await
                        {
                            tracing::warn!(target: "freshell_freshagent::claude",
                                session_id = %escalation_session_id, lingering = tree.len(),
                                "freshagent.claude.handoff_stop_escalation_continues: the \
                                 detached tree-death escalation re-armed its bounded window"
                            );
                        }
                        // Death confirmed — the condemned-prior record this
                        // escalation just settled clears with it.
                        condemned_priors
                            .lock()
                            .expect("condemned priors lock")
                            .remove(&escalation_session_id);
                        true
                    }),
                }
            }
        }
    }

    /// kata b8ke Task 6: the handoff runner's TARGET-resume entry point —
    /// the attach-resume path ([`Self::resume_for_attach`]) driven with a
    /// synthetic attach for the CANONICAL durable id, UNDER-TICKET (no lane
    /// claim, no lane commit — the runner performs the ONE `commit_live`)
    /// and with the round-2 flavor param: `session_type` selects freshclaude
    /// vs kilroy, so a kilroy session resumes AS kilroy (the created/snapshot
    /// frames keep the flavor; never map by provider alone). Registers under
    /// the durable id itself and returns the constructed owner identity.
    /// `tab_id`/`pane_id` name the pane that adopts the session (the client
    /// names it on every handoff); the resumed CLI runs for that pane, so its
    /// Freshell MCP defaults to it.
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn resume_for_handoff(
        &self,
        session_type: &str,
        session_id: &str,
        cwd: Option<&str>,
        tab_id: Option<&str>,
        pane_id: Option<&str>,
        operation_id: &str,
        generation: u64,
    ) -> Result<freshell_ownership::OwnerIdentity, (String, String)> {
        let Some(flavor) = session_type_from_flavor(session_type) else {
            return Err((
                "unsupported claude-lane sessionType for handoff".to_string(),
                session_type.to_string(),
            ));
        };
        // Round-3 review I-1 (cancellation-safety): the single-flight flag
        // is RAII — an aborted handoff runner drops this resume mid-flight,
        // and a leaked flag would refuse every later retry with "another
        // resume is in flight" forever. The guard removes it on every exit
        // path, drop included.
        let Some(_resuming_flag) = self.try_resume_flight(session_id) else {
            return Err((
                "another resume is in flight for this session".to_string(),
                session_id.to_string(),
            ));
        };
        // D8 same-kind lease claim (the provider backstop — the coordinator
        // claim is the runner's, under-ticket).
        let resume_request_id = format!("handoff-resume-{}", uuid::Uuid::new_v4());
        let mut lease_guard = match self
            .claim_launch_lease(session_id, &resume_request_id)
            .await
        {
            LaunchLease::Acquired(guard) => Some(guard),
            LaunchLease::BoundLive { .. } | LaunchLease::Held => {
                return Err((
                    "another lifecycle operation holds this session's lease".to_string(),
                    session_id.to_string(),
                ));
            }
            LaunchLease::ExpiredUnconfirmed => {
                return Err((
                    "the prior lease holder expired and could not be confirmed dead".to_string(),
                    session_id.to_string(),
                ));
            }
        };
        let msg = FreshAgentAttach {
            tab_id: tab_id.map(str::to_string),
            pane_id: pane_id.map(str::to_string),
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: flavor,
            cwd: cwd.map(str::to_string),
            observed_epoch: None,
            observed_generation: None,
            resume_session_id: None,
            session_ref: Some(freshell_protocol::SessionLocator {
                provider: PROVIDER.to_string(),
                session_id: session_id.to_string(),
            }),
        };
        // UNDER-TICKET: no lane claim (own_ticket None), so the registration
        // tail's commit is a no-op — the runner performs the one commit_live.
        let mut own_ticket: Option<freshell_ownership::OperationTicket> = None;
        let outcome = self
            .resume_for_attach(
                &msg,
                DurableClaim {
                    durable: session_id.to_string(),
                    dead_state: self.claim_dead_state_snapshot(session_id),
                },
                &mut lease_guard,
                &mut own_ticket,
                // b8ke focused episode-2 round-2 F2: the RUNNER's handoff op
                // owns this target resume's coordinator transition — the
                // session records it for the adoption's Blocked correlation.
                Some(operation_id.to_string()),
                // b8ke ext r27 F2: the SUPPLIED handoff generation — the
                // session-init adoption's binding write stamps the target
                // row with it (the under-ticket shape holds no own ticket).
                Some(generation),
            )
            .await;
        if let Some(mut g) = lease_guard.take() {
            // A leftover armed guard means the resume ended WITHOUT a
            // registration (its own teardown already ran).
            g.fail();
        }
        drop(own_ticket);
        match outcome {
            Ok(()) => {
                let pid = self
                    .sessions
                    .lock()
                    .await
                    .get(session_id)
                    .and_then(|s| s.child.id());
                Ok(freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some(session_id.to_string()),
                    pid,
                    ownership_id: None,
                })
            }
            Err(ResumeClaudeError::NotFound) => Err((
                "claude transcript not found for this session".to_string(),
                session_id.to_string(),
            )),
            Err(ResumeClaudeError::Transient(detail)) => {
                Err(("claude resume failed".to_string(), detail))
            }
        }
    }

    /// kata b8ke Task 3: begin this lane's coordinator claim. See
    /// [`crate::ownership_lane::begin_lane_claim`].
    fn begin_lane_claim_at(
        &self,
        session_id: &str,
        operation_id: &str,
        observed: Option<freshell_ownership::ObservedFence>,
        initiator: &str,
    ) -> crate::ownership_lane::LaneClaim {
        // b8ke focused episode-2 round-3 F3: EVERY claim resolves the wire
        // id to the canonical coordinator key first — a stale pane's
        // create/attach on a superseded (re-keyed) id claims the CANONICAL
        // key (observing the live re-keyed owner), never a fork under the
        // dead alias.
        let resolved = self.resolve_ownership_key(session_id);
        crate::ownership_lane::begin_lane_claim(
            &self.ownership,
            PROVIDER,
            &resolved,
            operation_id,
            observed,
            initiator,
            crate::session_lease::now_epoch_ms(),
        )
    }

    /// kata b8ke Task 3: commit this lane's claim and retain the stamp. See
    /// [`crate::ownership_lane::commit_lane_claim`]. The registry key comes
    /// from the TICKET (the key the claim minted), never the caller's wire
    /// id — b8ke focused episode-2 round-2 F1 keeps claim and commit on
    /// the same key even when a resolved id differs from the wire id.
    fn commit_lane_claim_at(
        &self,
        ticket: &mut Option<freshell_ownership::OperationTicket>,
        live_session_key: &str,
        pid: Option<u32>,
    ) -> Result<(), freshell_ownership::CommitOutcome> {
        let Some(ticket_ref) = ticket.as_ref() else {
            return Ok(());
        };
        let session_id = ticket_ref.session_id().to_string();
        crate::ownership_lane::commit_lane_claim(
            &self.ownership,
            &self.ownership_stamps,
            // b8ke ext r29 F1: every commit-to-Live broadcasts the owner
            // record on the shared bus.
            Some(&self.broadcast_tx),
            PROVIDER,
            &session_id,
            ticket,
            live_session_key,
            pid,
        )
    }

    /// b8ke focused episode-2 round-2 F1: commit the rollback's claim by
    /// RE-KEYING (C13: `expected_live_session_key` is the original runtime's
    /// map key, `live_session_key` the replacement's) — the start's `Starting{op}` record under the OLD durable
    /// id moves to the NEW client-visible durable id in ONE atomic registry
    /// step (`commit_live_rekey`: never both-Live, never both-Vacant), the
    /// stamp is retained under the NEW id (the lane's kill/exit paths key
    /// off it), and the OLD id becomes a resolvable alias
    /// ([`Self::record_durable_rekey`]). One source of truth: the
    /// materialization already replaced the pane's sessionRef with the new
    /// id, so every later lifecycle operation — handoff included — finds
    /// the owner under the id the client actually holds. `Err` (stale /
    /// foreign / occupied target key) is the caller's existing teardown
    /// path — never a partial move.
    #[allow(clippy::too_many_arguments)] // the rekey field set (old id + initiator ride the commit)
    fn commit_lane_claim_rekey_at(
        &self,
        old_durable_id: &str,
        ticket: &mut Option<freshell_ownership::OperationTicket>,
        new_durable_id: &str,
        expected_live_session_key: &str,
        live_session_key: &str,
        pid: Option<u32>,
        initiator: &str,
    ) -> Result<(), freshell_ownership::CommitOutcome> {
        let Some(registry) = self.ownership.as_ref() else {
            // Unwired (no coordinator): nothing to rekey; disarm the ticket
            // so its drop does not fail a nonexistent claim.
            if let Some(ticket) = ticket.as_mut() {
                ticket.disarm();
            }
            return Ok(());
        };
        // b8ke focused episode-2 round-3 F1 + post-cap F1: the NORMAL
        // live-rollback path claims NOTHING — begin_lane_claim_at observes
        // the existing Live{FreshAgent} owner and answers Adopt, so the
        // ticket is None. The rekey MUST move ownership regardless, and it
        // is a REAL coordinator transition: the registry VERIFIES the
        // expected owner (kind + THIS session's map key — a terminal
        // handoff that committed in the window refuses typed), moves the
        // REPLACEMENT identity (the CURRENT pid, ONE minted operation id
        // used by BOTH the owner record and the retained stamp — so
        // exit/crash release matches), and INCREMENTS the generation.
        // The claimed (Starting) shape goes through commit_live_rekey
        // exactly as before. Never a silent no-op, never the dead old pid.
        let rekey_operation_id = format!("claude-rollback-rekey-{}", uuid::Uuid::new_v4());
        let outcome = match ticket.as_ref() {
            Some(ticket_ref) => {
                let owner = freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some(live_session_key.to_string()),
                    pid,
                    ownership_id: Some(ticket_ref.operation_id().to_string()),
                };
                registry.commit_live_rekey(
                    PROVIDER,
                    old_durable_id,
                    new_durable_id,
                    ticket_ref.operation_id(),
                    ticket_ref.generation(),
                    owner,
                )
            }
            None => {
                let replacement_owner = freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some(live_session_key.to_string()),
                    pid,
                    // ONE consistent identity: the owner record AND the
                    // retained stamp share this operation id, so the normal
                    // sidecar exit/crash release (which claims with the
                    // stamp's identity) matches the live owner.
                    ownership_id: Some(rekey_operation_id.clone()),
                };
                registry.rekey_live(
                    PROVIDER,
                    old_durable_id,
                    new_durable_id,
                    expected_live_session_key,
                    replacement_owner,
                    initiator,
                    // b8ke ext r6 F5: the rekey transition's operation id —
                    // the uniform log schema's operation_id.
                    &rekey_operation_id,
                )
            }
        };
        match outcome {
            freshell_ownership::CommitOutcome::Committed => {
                // Retain the stamp under the NEW id with the SAME
                // consistent identity the registry committed (the lane's
                // kill/exit paths resolve the canonical durable through
                // the session's current cli_session_id — the new id — and
                // take the stamp from exactly this key).
                let (stamp_generation, stamp_operation_id) = match ticket.as_ref() {
                    Some(ticket_ref) => (
                        ticket_ref.generation(),
                        ticket_ref.operation_id().to_string(),
                    ),
                    // The Adopt path's stamp mirrors the registry's moved
                    // record: the INCREMENTED generation + the rekey
                    // operation id (identical to the record's
                    // ownership_id — never a fabricated divergence).
                    None => (
                        registry.observe(PROVIDER, new_durable_id).generation,
                        rekey_operation_id,
                    ),
                };
                let stamp = crate::ownership_lane::OwnershipStamp {
                    epoch: registry.boot_epoch(),
                    generation: stamp_generation,
                    operation_id: stamp_operation_id.clone(),
                    owner: freshell_ownership::OwnerIdentity {
                        kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                        terminal_id: None,
                        live_session_key: Some(live_session_key.to_string()),
                        pid,
                        ownership_id: Some(stamp_operation_id),
                    },
                };
                self.ownership_stamps
                    .lock()
                    .expect("ownership stamps lock")
                    .insert(new_durable_id.to_string(), stamp);
                // b8ke post-cap F1: BROADCAST the owner identity under the
                // new key (every device holding the new sessionRef
                // converges) AND under the OLD key with the alias
                // resolution (a cross-device pane still holding the
                // pre-rekey id folds the canonical owner — never a
                // permanent "vacant"; post-cap F5's wire-additive
                // `aliasOf`).
                let epoch = registry.boot_epoch();
                let generation = match ticket.as_ref() {
                    Some(ticket_ref) => ticket_ref.generation(),
                    None => registry.observe(PROVIDER, new_durable_id).generation,
                };
                let broadcast_operation_id = match ticket.as_ref() {
                    Some(ticket_ref) => ticket_ref.operation_id().to_string(),
                    None => match registry.observe(PROVIDER, new_durable_id).state {
                        freshell_ownership::OwnershipState::Live { owner, .. } => {
                            owner.ownership_id.clone().unwrap_or_default()
                        }
                        _ => String::new(),
                    },
                };
                let session_runtime_owner = |session_id: String, alias_of: Option<String>| {
                    ServerMessage::SessionRuntimeOwner(SessionRuntimeOwner {
                        provider: PROVIDER.to_string(),
                        session_id,
                        epoch,
                        generation,
                        owner_kind: "fresh-agent".into(),
                        previous_kind: None,
                        terminal_id: None,
                        operation_id: broadcast_operation_id.clone(),
                        transition: "handoff-committed".into(),
                        reason: None,
                        fenced: None,
                        alias_of,
                    })
                };
                self.broadcast(&session_runtime_owner(new_durable_id.to_string(), None));
                self.broadcast(&session_runtime_owner(
                    old_durable_id.to_string(),
                    Some(new_durable_id.to_string()),
                ));
                // The claim is consumed: disarm so the ticket's Drop does
                // not fail the (now moved) claim.
                if let Some(ticket) = ticket.as_mut() {
                    ticket.disarm();
                }
                Ok(())
            }
            stale => Err(stale),
        }
    }

    /// The initiator label for a coordinator transition event: the
    /// connection's device id when the provenance carries one, else the lane
    /// label (diagnostic, not audit-grade).
    fn initiator_for(provenance: Option<&crate::BindProvenance>, lane: &str) -> String {
        provenance
            .and_then(|p| p.device_id.clone())
            .unwrap_or_else(|| lane.to_string())
    }

    /// Wire the P1.13 identity-event sink (set-once; later calls are no-ops).
    pub fn set_identity_sink(&self, sink: SharedPaneIdentitySink) {
        let _ = self.identity_sink.set(sink);
    }

    /// The wired identity sink, if any.
    pub(crate) fn identity_sink(&self) -> Option<SharedPaneIdentitySink> {
        self.identity_sink.get().cloned()
    }

    /// Unified agent names (Task 2): wire the naming authority (set-once;
    /// later calls are no-ops). `freshell-server::main` injects the ONE local
    /// store participant.
    pub fn set_session_naming(
        &self,
        sink: std::sync::Arc<dyn crate::naming::SessionNaming>,
    ) -> bool {
        self.naming.set(sink)
    }

    /// Unified agent names: the wired naming authority, if any.
    pub(crate) fn naming(&self) -> Option<std::sync::Arc<dyn crate::naming::SessionNaming>> {
        self.naming.get()
    }

    /// Unified agent names (Task 2): admit a freshclaude create's pre-durable
    /// naming handle and stash it against the placeholder session id, so the
    /// `sdk.session.init` adoption binds it to the durable UUID. Kilroy is
    /// out of scope (its `naming_handle` is ignored); a create WITHOUT a
    /// handle simply proceeds unnamed. Returns the frame projection when a
    /// handle was admitted.
    /// Unified agent names (Task 8 acceptance): the pending RECORD for the
    /// create frame's handle, admitted at REQUEST RECEIPT — BEFORE the
    /// sidecar spawn/`created` handshake (seconds) during which the pane
    /// content and the client's rename capture already carry the handle.
    /// A rename committed inside that window must resolve the same record
    /// the server accepted on the wire (the pre-fix shape answered 404
    /// NAME_NOT_FOUND and silently lost the manual pre-durable name).
    /// Idempotent: the post-`created` re-ensure in [`Self::admit_create_handle`]
    /// answers the same record and adds the placeholder-keyed stash.
    async fn admit_create_handle_early(&self, msg: &FreshAgentCreate, session_type: &str) {
        if session_type == "kilroy" {
            return;
        }
        let Some(handle) = msg
            .naming_handle
            .as_deref()
            .map(str::trim)
            .filter(|h| !h.is_empty())
        else {
            return;
        };
        let sink = self.naming();
        let _ = crate::naming::admit_pending_projection(
            &sink,
            handle,
            freshell_protocol::session_names::NamedProvider::Claude,
            msg.cwd.as_deref(),
        )
        .await;
    }

    async fn admit_create_handle(
        &self,
        msg: &FreshAgentCreate,
        session_type: &str,
        placeholder: &str,
    ) -> Option<(
        freshell_protocol::session_names::SessionNameRef,
        freshell_protocol::session_names::SessionNameRecord,
    )> {
        if session_type == "kilroy" {
            return None;
        }
        let handle = msg.naming_handle.as_deref()?.trim().to_string();
        if handle.is_empty() {
            return None;
        }
        let sink = self.naming();
        let projection = crate::naming::admit_pending_projection(
            &sink,
            &handle,
            freshell_protocol::session_names::NamedProvider::Claude,
            msg.cwd.as_deref(),
        )
        .await?;
        self.naming_handles
            .lock()
            .await
            .insert(placeholder.to_string(), handle);
        Some(projection)
    }

    /// Unified agent names: the current frame projection for an ALREADY
    /// created session (the dedup-replay arm) — the stashed handle's
    /// record, resolved through the wired authority (a pending ref and its
    /// redirected durable record answer the same record via `get`).
    async fn created_projection_for(
        &self,
        session_id: &str,
    ) -> Option<(
        freshell_protocol::session_names::SessionNameRef,
        freshell_protocol::session_names::SessionNameRecord,
    )> {
        let handle = self.naming_handles.lock().await.get(session_id).cloned()?;
        let sink = self.naming();
        let target = freshell_protocol::session_names::SessionNameRef::Pending { id: handle };
        let updates = sink?
            .get(vec![target.clone()])
            .await
            .map_err(|error| crate::naming::log_name_error("get", &target, &error))
            .ok()?;
        updates
            .into_iter()
            .next()
            .map(|update| (update.record.name_ref.clone(), update.record))
    }

    /// Broadcast a `freshAgent.error` alarm/degradation frame (P1.13; Task 10
    /// consumes this too). Same envelope contract as codex's helper (`codex.rs`):
    /// top-level `sessionType`/`provider` are REQUIRED (locator resolution) and
    /// `message` is user-facing (the banner shows the message, never the code) —
    /// but unlike codex this one cannot hardcode the session type: provider
    /// `claude` covers BOTH `freshclaude` and `kilroy`, so the flavour is a param.
    fn emit_fresh_agent_error(
        &self,
        session_id: &str,
        session_type: &str,
        code: &str,
        message: &str,
    ) {
        self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
            event: json!({
                "type": "freshAgent.error",
                "sessionId": session_id,
                "code": code,
                "message": message,
            }),
            provider: PROVIDER.to_string(),
            session_id: session_id.to_string(),
            session_type: session_type.to_string(),
        }));
    }

    /// Stop every owned claude sidecar through [`teardown_removed_session`]
    /// (the shutdown request, then escalation only after the grace period,
    /// then the tree reap), all sessions CONCURRENTLY with the server-stop
    /// grace ([`crate::claude_spawn::SERVER_STOP_GRACE`]), so wedged
    /// sidecars cost one short grace period of the server's bounded stop
    /// rather than one session grace per session. Called on server shutdown.
    pub async fn shutdown(&self) {
        use tracing::instrument::WithSubscriber;
        let drained: Vec<ClaudeSession> = {
            let mut guard = self.sessions.lock().await;
            guard.drain().map(|(_, s)| s).collect()
        };
        let confirm_rounds = self.tree_confirm_rounds();
        // One task per session: each teardown's synchronous `/proc` scans run
        // on the runtime's workers in parallel, so no session's shutdown
        // line waits behind another session's scan.
        let teardowns = drained.into_iter().map(|session| {
            tokio::spawn(
                teardown_removed_session_within(
                    session,
                    confirm_rounds,
                    crate::claude_spawn::SERVER_STOP_GRACE,
                )
                .with_current_subscriber(),
            )
        });
        for outcome in futures_util::future::join_all(teardowns).await {
            if let Err(error) = outcome {
                tracing::error!(target: "freshell_freshagent::claude",
                    event = "freshagent.claude.shutdown_teardown_failed",
                    cause = %error,
                    "a claude sidecar teardown failed at server stop; its tree guard's drop \
                     still kills the process tree"
                );
            }
        }
        self.cli_index.lock().await.clear();
    }

    fn broadcast(&self, msg: &ServerMessage) {
        if let Ok(frame) = serde_json::to_string(msg) {
            let _ = self.broadcast_tx.send(frame);
        }
    }

    async fn broadcast_checkpoint_frame(
        &self,
        frame: String,
        require_match: bool,
    ) -> Result<(), String> {
        self.checkpoint_event_sink
            .broadcast(&self.broadcast_tx, frame, require_match)
            .await
    }

    // ── freshAgent.create (WS) ───────────────────────────────────────────────────────

    /// Handle a `freshAgent.create` for claude/kilroy: spawn the Node sidecar, drive the
    /// SDK `create` under a durable UUID assigned before spawn (the sidecar answers
    /// `created` only once the CLI booted; a refused boot is a typed `create.failed`),
    /// register the session + its stdout consumer, and broadcast `freshAgent.created`
    /// (with the same durable `sessionRef`) or `freshAgent.create.failed`.
    /// Long-running (cold sidecar spawn), so the WS loop dispatches this as a detached task.
    /// `provenance` (D8): the WS connection's stamped identity for this create
    /// (`None` on conn-less lanes); threaded to the `sdk.session.init` binding write.
    pub async fn handle_create(
        &self,
        msg: FreshAgentCreate,
        provenance: Option<crate::BindProvenance>,
    ) -> ClaudeCreateOutcome {
        let request_id = msg.request_id.clone();
        let session_type = session_type_str(msg.session_type);

        // Dedup by requestId (parity gap fix -- see [`crate::FreshAgentCreateDedup`]'s
        // doc and [`Self::create_dedup`]'s field doc). Held for the whole creation
        // attempt below, so concurrent duplicate `create`s for the same requestId
        // serialize instead of each spawning their own sidecar.
        let _dedup_guard = match self.create_dedup.acquire_or_replay(&request_id).await {
            FreshAgentCreateOutcome::Replay(cached) => {
                // Unified agent names: the replay re-answers with the SAME
                // naming projection the original create acknowledged (the
                // handle was stashed against this placeholder at admission).
                let projection = self.created_projection_for(&cached.session_id).await;
                let name_ref = projection.as_ref().map(|(r, _)| r.clone());
                let session_name = projection.map(|(_, record)| record);
                self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
                    provider: PROVIDER.to_string(),
                    request_id,
                    runtime_provider: PROVIDER.to_string(),
                    session_id: cached.session_id.clone(),
                    session_type: session_type.to_string(),
                    session_ref: cached.session_ref.clone(),
                    name_ref,
                    session_name,
                }));
                return ClaudeCreateOutcome::Created {
                    session_id: cached.session_id,
                    session_ref: cached.session_ref,
                };
            }
            FreshAgentCreateOutcome::Proceed(guard) => guard,
        };

        // Unified agent names (Task 8 acceptance): the pending record for
        // the frame's handle exists from REQUEST RECEIPT — the pane content
        // and the client's rename capture carry the handle immediately,
        // while the sidecar spawn + `created` handshake below takes seconds.
        // Idempotent with the post-`created` re-ensure
        // (`admit_create_handle`, which also stashes the placeholder key).
        self.admit_create_handle_early(&msg, session_type).await;

        // Task 12 (D8 for fresh agents): a create-with-resume claims the per-sessionRef
        // lease BEFORE any spawn -- exactly one in-flight resume (and one live writer)
        // per durable transcript. ALWAYS ON (never capability-gated).
        //
        // The resume id comes from the legacy `resumeSessionId` first, else the
        // provider-matched `sessionRef` (Node parity: `runtime-manager.ts:106-108`
        // promotes the sessionRef into the adapter's resume input the same way) --
        // the canonical carrier must work standalone so the client can drop the
        // legacy duplicate.
        let resume_sid = msg
            .resume_session_id
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                msg.session_ref
                    .as_ref()
                    .filter(|r| r.provider == PROVIDER)
                    .map(|r| r.session_id.clone())
                    .filter(|s| !s.is_empty())
            })
            .or_else(|| {
                self.identity_sink()
                    .and_then(|sink| sink.lookup_by_create_request_id(PROVIDER, &request_id))
            });
        // The durable id is known before spawning, including for a zero-turn
        // conversation. A re-driven create resolves its persisted lineage.
        let launch_id = resume_sid
            .clone()
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut lease_guard: Option<crate::FreshSessionLeaseGuard>;
        // Every create owns its durable UUID from before spawn. The ticket
        // commits only after the runtime and its binding are established.
        // Hoisted to this scope so the commit at the registration tail can
        // consume it; every failure return drops it (RAII typed fail).
        let mut own_ticket: Option<freshell_ownership::OperationTicket> = None;
        // b8ke delta round-2 F2: the start's REAL watchdog machinery — the
        // sidecar pid slot (the cancellation SIGTERMs the spawned child; the
        // create's own gates then tear down and unwind) and the settle
        // guard (fires when THIS create handler's scope ends — the
        // operation's completion or unwind; the watchdog's bounded settle
        // treats it as the operation's confirmed death). Registered only
        // once the claim Grants below; the guard is held to the handler's
        // end.
        let start_pid_slot = crate::ownership_lane::sidecar_pid_cancel_slot();
        let mut _start_cancellation: Option<crate::ownership_lane::StartCancellationGuard> = None;
        {
            let sid = launch_id.as_str();
            // Task 13b (cross-kind liveness): a live terminal PTY owning
            // `(claude, sid)` is the one writer on that JSONL -- refuse the
            // resume with the retryable loser answer (the terminal may be
            // closing); NO lease claim, NO spawn. kata b8ke Task 6: the
            // refusal carries the coordinator's additive owner fields when it
            // can name the owner (the post-handoff refusal says the terminal
            // owner — an attachable target, never a dead-end).
            if (self.terminal_liveness)(PROVIDER, sid) {
                tracing::warn!(target: "freshell_freshagent::claude", session_id = sid,
                    request_id = %request_id,
                    "fresh_agent_create_refused: a live terminal PTY owns this session (Task 13b cross-kind live-guard)");
                let owner_fields = crate::ownership_lane::terminal_owner_fields_from_snapshot(
                    &self.ownership_snapshot(PROVIDER, sid),
                );
                return self
                    .fail_create_session_reserved_with_owner(&request_id, owner_fields.as_ref());
            }
            // b8ke delta round-3 F2: the existing-session ADOPT is
            // COORDINATED — the coordinator claim decides BEFORE any
            // map-hit fast path (the map-hit adopt now runs INSIDE the
            // claim's Adopt/Unwired/Granted arms below). Pre-d3 a live
            // in-map session adopted and answered created WITHOUT
            // consulting the coordinator: a delayed create during a
            // Handoff (the map entry still exists until the stop lands)
            // slipped past the fence.
            // kata b8ke Task 3: the coordinator claim comes FIRST — before
            // the provider lease — so the cross-kind authority decides
            // atomically. The wire pair on `freshAgent.create` is the
            // delayed-request fence (`None` = legacy unfenced sender, still
            // cross-kind-checked). b8ke delta review F7: a half-sent pair is
            // the typed invalid-fence refusal, never a legacy downgrade.
            let claim_op_id = format!("create-resume-{request_id}");
            let claim_fence =
                crate::ownership_lane::wire_fence(msg.observed_epoch, msg.observed_generation);
            let claim_fence = match claim_fence {
                Ok(fence) => fence,
                Err(err) => {
                    tracing::warn!(target: "freshell_freshagent::claude",
                        session_id = %sid, request_id = %request_id, code = err.code(),
                        "fresh_agent_create_refused: the observed fence is half-sent (invalid)");
                    return self.fail_create(&request_id, err.code(), err.message());
                }
            };
            match self.begin_lane_claim_at(
                sid,
                &claim_op_id,
                claim_fence,
                &Self::initiator_for(provenance.as_ref(), "freshclaude/create-resume"),
            ) {
                crate::ownership_lane::LaneClaim::Granted(ticket) => {
                    // b8ke delta round-3 F2 + e3r1 F3: the unowned-runtime
                    // shape — the key was Vacant but THIS lane's map holds
                    // a live session. Adopt it, spawn nothing, and COMMIT
                    // the adopted runtime as the authoritative Live owner
                    // (pre-e3r1 the ticket's drop restored Vacant while
                    // the runtime kept running — acknowledging a live
                    // writer with an unowned key licensed a SECOND writer).
                    if self.has_live_session(sid).await {
                        // The live runtime's identity: the session's map
                        // key + its sidecar pid.
                        own_ticket = Some(ticket);
                        let map_key = self.resolve_session_key(sid).await;
                        let adopted_pid = match map_key.as_ref() {
                            Some(mk) => self
                                .sessions
                                .lock()
                                .await
                                .get(mk)
                                .and_then(|sess| sess.child.id()),
                            None => None,
                        };
                        let adopted_map_key = map_key.clone().unwrap_or_else(|| sid.to_string());
                        match self.commit_lane_claim_at(
                            &mut own_ticket,
                            &adopted_map_key,
                            adopted_pid,
                        ) {
                            Ok(()) => {
                                self.broadcast(&ServerMessage::SessionRuntimeOwner(
                                    SessionRuntimeOwner {
                                        provider: PROVIDER.to_string(),
                                        session_id: sid.to_string(),
                                        epoch: self
                                            .ownership
                                            .as_ref()
                                            .map(|r| r.boot_epoch())
                                            .unwrap_or(0),
                                        generation: self
                                            .ownership
                                            .as_ref()
                                            .map(|r| r.observe(PROVIDER, sid).generation)
                                            .unwrap_or(0),
                                        owner_kind: "fresh-agent".into(),
                                        previous_kind: None,
                                        terminal_id: None,
                                        operation_id: format!("adopt-{request_id}"),
                                        transition: "handoff-committed".into(),
                                        reason: None,
                                        fenced: None,
                                        alias_of: None,
                                    },
                                ));
                            }
                            Err(outcome) => {
                                tracing::warn!(target: "freshell_freshagent::claude",
                                    session_id = %sid, request_id = %request_id,
                                    outcome = ?outcome,
                                    "fresh_agent_create_adopt_commit_stale: the coordinator \
                                     moved on while the live-runtime adopt committed — the \
                                     create is refused (never a live writer left unowned)"
                                );
                                return self.fail_create(
                                    &request_id,
                                    "STALE_CLAIM",
                                    "ownership moved on while adopting the live session; refresh and retry",
                                );
                            }
                        }
                        return self.adopt_live_create(&request_id, sid, session_type).await;
                    }
                    own_ticket = Some(ticket);
                    // b8ke delta round-2 F2: register the start's
                    // cancellation + settle with the watchdog (the
                    // machinery exists — the sidecar pid slot).
                    _start_cancellation = Some(
                        crate::ownership_lane::register_start_cancellation_for_ticket(
                            &self.ownership,
                            PROVIDER,
                            sid,
                            &own_ticket,
                            crate::ownership_lane::pid_slot_cancellation(&start_pid_slot),
                        ),
                    );
                }
                crate::ownership_lane::LaneClaim::Unwired => {
                    // The unwired lane's map fast path (V1 behavior): a
                    // live session adopts, spawn nothing. With no
                    // coordinator there is no fence to consult.
                    if self.has_live_session(sid).await {
                        return self.adopt_live_create(&request_id, sid, session_type).await;
                    }
                }
                crate::ownership_lane::LaneClaim::Adopt => {
                    // A same-kind live runtime the coordinator names —
                    // adopt it, spawn nothing (the COORDINATED map-hit:
                    // the claim already verified the key's state).
                    return self.adopt_live_create(&request_id, sid, session_type).await;
                }
                crate::ownership_lane::LaneClaim::Refused(outcome) => {
                    tracing::warn!(target: "freshell_freshagent::claude",
                        session_id = %sid, request_id = %request_id,
                        outcome = ?outcome,
                        "fresh_agent_create_refused: the ownership coordinator refused the \
                         claim (kata b8ke cross-kind authority)"
                    );
                    // The additive owner fields ride the refusal when the
                    // coordinator can name the owner (Task 6: the post-handoff
                    // refusal says the terminal owner).
                    let owner_fields = crate::ownership_lane::fresh_agent_owner_fields_from_outcome(
                        &self.ownership,
                        &outcome,
                    );
                    return self.fail_create_session_reserved_with_owner(
                        &request_id,
                        owner_fields.as_ref(),
                    );
                }
            }
            match self.claim_launch_lease(sid, &request_id).await {
                LaunchLease::Acquired(guard) => lease_guard = Some(guard),
                LaunchLease::BoundLive { .. } => {
                    // Under-lock ADOPT: the winner completed between our pre-check
                    // and the claim (the V5 TOCTOU window).
                    return self.adopt_live_create(&request_id, sid, session_type).await;
                }
                LaunchLease::Held | LaunchLease::ExpiredUnconfirmed => {
                    return self.fail_create_session_reserved(&request_id);
                }
            }
        }

        // Retire-on-kill round 2/3 (focused-ep5-r1 Finding 2, -r2 Findings
        // 4+5): an explicit create-with-resume GENUINELY CLAIMS the durable
        // identity — but the claim COMMITS only in `establish_runtime`, once the
        // replacement session is established (sidecar created + `created`
        // answered). Clearing the fence before the spawn (round 2's
        // placement) left a failed create's identity UNFENCED — an older
        // in-flight binding write of the killed epoch could then resurrect
        // Bound. The HAS-LIVE adopt arms above never commit: a live session
        // was never killed, so no tombstone can exist for it.
        //
        // Round 4 (focused-ep5-r3 Finding 1): the claim's dead-state
        // SNAPSHOT is taken here — at claim start, after the lease and
        // before the spawn — so a kill that lands while the resume awaits
        // `created` advances the durable tombstone past it and the commit in
        // `establish_runtime` REFUSES instead of undoing the newer close.
        let claim_dead_state = self.claim_dead_state_snapshot(&launch_id);

        // Which conversation the resume boots (design §4.2, §4.3): a session
        // that has no transcript yet boots from the genesis its binding row
        // records (an undo's replacement or a fork's child whose sidecar died
        // before its first send), never as a resume the CLI refuses (T5).
        let genesis_boot = match resume_sid.as_deref() {
            Some(sid) => match self.decide_create_resume_boot(sid) {
                Ok(decided) => decided,
                Err(ResumeClaudeError::NotFound) => {
                    return self.fail_create(
                        &request_id,
                        "CONVERSATION_NOT_FOUND",
                        &format!("No conversation found with session ID: {sid}"),
                    );
                }
                Err(ResumeClaudeError::Transient(detail)) => {
                    return self.answer_create_failure(
                        &request_id,
                        ClaudeCreateOutcome::Failed {
                            code: crate::claude_handshake::CREATE_FAILED_CODE.to_string(),
                            message: format!(
                                "The Claude transcript store could not be read: {detail}"
                            ),
                            retryable: Some(true),
                            owner: None,
                        },
                    );
                }
            },
            None => None,
        };
        let (boot, boot_cwd, boot_session_id, boot_genesis, recorded_genesis) = match genesis_boot {
            Some(decided) => (
                decided.boot,
                decided.cwd.or_else(|| msg.cwd.clone()),
                decided.session_id,
                decided.genesis,
                Some(decided.recorded),
            ),
            None => (
                ClaudeBoot::resume_or_fresh(resume_sid.as_deref()),
                msg.cwd.clone(),
                Some(launch_id.clone()),
                resume_sid
                    .is_none()
                    .then_some(crate::claude_launch::ClaudeGenesis::Fresh),
                None,
            ),
        };

        // P1.13: the FULL settings snapshot the session records at
        // `sdk.session.init` (claude has no sandbox concept: always `None`), and
        // the launch is built from the same values (G15: the plugins too).
        let settings = crate::identity_sink::FreshAgentSettings {
            model: msg.model.clone(),
            sandbox: None,
            permission_mode: msg.permission_mode.clone(),
            effort: msg.effort.clone(),
            cwd: msg.cwd.clone(),
            plugins: None,
        }
        .with_plugins(msg.plugins.clone());
        let spec = ClaudeLaunchSpec::new(
            request_id.clone(),
            session_type,
            boot,
            boot_cwd,
            &settings,
            self.hosted_mcp,
        )
        .with_session_id(boot_session_id.or_else(|| Some(launch_id.clone())))
        .with_model_selection(serde_json::to_value(&msg.model_selection).ok())
        .with_freshell_context(
            crate::claude_freshell_mcp::ClaudeFreshellContext::from_ids(
                msg.tab_id.as_deref(),
                msg.pane_id.as_deref(),
            ),
        );
        // b8ke focused episode-2 round-2 F2: the create's claim owns this
        // runtime's coordinator transition (the session-init adoption's Blocked
        // arm correlates its own in-flight claim through it).
        let owning_operation = own_ticket.as_ref().map(|t| t.operation_id().to_string());
        let established = match self
            .establish_runtime(
                EstablishPlan {
                    lane: EstablishLane::Create,
                    spec,
                    register_under: RegisterUnder::Adopted(launch_id.clone()),
                    claim: Some(DurableClaim {
                        durable: launch_id.clone(),
                        dead_state: claim_dead_state,
                    }),
                    rekey_provisional_claim: false,
                    recorded_settings: Some(settings),
                    owning_operation,
                    owning_generation: None,
                    provenance,
                    naming: Some(&msg),
                    partial_runtime_key: Some(launch_id.clone()),
                    start_pid_slot: &start_pid_slot,
                    inherit: None,
                    genesis: boot_genesis,
                    retry: resume_sid.clone().map(|durable| BootRetry {
                        durable,
                        genesis: recorded_genesis,
                    }),
                },
                &mut lease_guard,
                &mut own_ticket,
            )
            .await
        {
            Ok(established) => established,
            Err(error) => {
                return self.fail_create(
                    &request_id,
                    error.create_code(),
                    &error.message(EstablishLane::Create),
                );
            }
        };
        let created = established.map_key;
        let naming_projection = established.naming_projection;

        // Cache the completed create for requestId dedup BEFORE responding (mirrors
        // codex/opencode: a duplicate `create` arriving right after this point must see
        // the cache populated, never race past this guard's release and spawn a second
        // sidecar).
        // A resume create names the conversation the CLI booted: `created` comes
        // only after that boot, so the caller learns the native identity here
        // instead of waiting for a turn's init (design §6, §7.3). A fresh create
        // has no durable id until its first turn, so it carries none.
        let session_ref = Some(claude_session_ref(&launch_id));
        self.create_dedup
            .record_success(
                &request_id,
                ClaudeCreateRecord {
                    session_id: created.clone(),
                    session_ref: session_ref.clone(),
                },
            )
            .await;

        // Broadcast freshAgent.created (ws-handler.ts:3378); placeholder == the bare
        // nanoid. Unified agent names: the created frame carries the pane's naming
        // projection (the pending handle's record) when one was admitted.
        let name_ref = naming_projection
            .as_ref()
            .map(|(reference, _)| reference.clone());
        let session_name = naming_projection.map(|(_, record)| record);
        self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: PROVIDER.to_string(),
            request_id,
            runtime_provider: PROVIDER.to_string(),
            session_id: created.clone(),
            session_type: session_type.to_string(),
            session_ref: session_ref.clone(),
            name_ref,
            session_name,
        }));
        // C17: the server says the new session's status itself (no sidecar
        // status reaches a client any more).
        self.announce_claude_status(&created, session_type).await;
        ClaudeCreateOutcome::Created {
            session_id: created,
            session_ref,
        }
    }

    /// Answer the create `request_id` with the failed `outcome` on the bus, and
    /// return the outcome (I1: the frame is built from it).
    fn answer_create_failure(
        &self,
        request_id: &str,
        outcome: ClaudeCreateOutcome,
    ) -> ClaudeCreateOutcome {
        if let Some(frame) = outcome.create_failed_frame(request_id) {
            self.broadcast(&frame);
        }
        outcome
    }

    fn fail_create(&self, request_id: &str, code: &str, message: &str) -> ClaudeCreateOutcome {
        self.answer_create_failure(
            request_id,
            ClaudeCreateOutcome::Failed {
                code: code.to_string(),
                message: message.to_string(),
                retryable: None,
                owner: None,
            },
        )
    }

    /// The D8 loser answer (Task 12): reuses the existing create-failed frame with the
    /// fixed reservation code — NO new protocol fields (deliberate: avoids a C3 wire
    /// change; the client re-drive uses a fixed floor).
    fn fail_create_session_reserved(&self, request_id: &str) -> ClaudeCreateOutcome {
        self.fail_create_session_reserved_with_owner(request_id, None)
    }

    /// [`Self::fail_create_session_reserved`] + the coordinator's additive
    /// owner fields when the refusal can name the owner (kata b8ke Task 6:
    /// the cross-kind refusal after a handoff must say WHO owns the session —
    /// a terminal owner — so the pane can offer the attach instead of a
    /// dead-end).
    fn fail_create_session_reserved_with_owner(
        &self,
        request_id: &str,
        owner: Option<&crate::ownership_lane::TerminalOwnerFields>,
    ) -> ClaudeCreateOutcome {
        self.answer_create_failure(
            request_id,
            ClaudeCreateOutcome::Failed {
                code: "SESSION_RESERVED".to_string(),
                message: "Another resume for this session is in flight".to_string(),
                retryable: Some(true),
                owner: owner.cloned(),
            },
        )
    }

    /// The HAS-LIVE→ADOPT arm (Task 12, V1: new server behavior): answer a loser's
    /// create-with-resume with `freshAgent.created` naming the adopted DURABLE session
    /// (send/attach route to it via Task 10b's `cli_index` resolution) under the
    /// loser's own `requestId` — no spawn, no second writer.
    async fn adopt_live_create(
        &self,
        request_id: &str,
        durable: &str,
        session_type: &str,
    ) -> ClaudeCreateOutcome {
        self.create_dedup
            .record_success(
                request_id,
                ClaudeCreateRecord {
                    session_id: durable.to_string(),
                    session_ref: Some(claude_session_ref(durable)),
                },
            )
            .await;
        // Unified agent names: the adopted pane names through the DURABLE
        // session's own record (a kilroy pane never carries one).
        let projection = if session_type == "kilroy" {
            None
        } else {
            crate::naming::session_projection(
                &self.naming(),
                freshell_protocol::session_names::NamedProvider::Claude,
                durable,
            )
            .await
        };
        let name_ref = projection.as_ref().map(|(r, _)| r.clone());
        let session_name = projection.map(|(_, record)| record);
        self.broadcast(&ServerMessage::FreshAgentCreated(FreshAgentCreated {
            provider: PROVIDER.to_string(),
            request_id: request_id.to_string(),
            runtime_provider: PROVIDER.to_string(),
            session_id: durable.to_string(),
            session_type: session_type.to_string(),
            session_ref: Some(claude_session_ref(durable)),
            name_ref,
            session_name,
        }));
        self.announce_claude_status(durable, session_type).await;
        ClaudeCreateOutcome::Created {
            session_id: durable.to_string(),
            session_ref: Some(claude_session_ref(durable)),
        }
    }

    // ── freshAgent.kill (WS) ─────────────────────────────────────────────────

    /// Handle a `freshAgent.kill` for claude/kilroy: remove the session and tear down
    /// its owned sidecar (graceful `shutdown` request, SIGTERM so the SDK cleanly kills
    /// its own `claude` CLI, `kill_on_drop` backstop, `/proc` ownership sweep), evict this
    /// session's requestId dedup cache entries (mirrors
    /// `clearFreshAgentCreateCachesForSession`, `ws-handler.ts:1044-1050`, called from
    /// `ws-handler.ts:3673`), then broadcast `freshAgent.killed`. Idempotent for an
    /// unknown session id, matching the codex/opencode `success:true` pattern.
    pub async fn handle_kill(&self, msg: FreshAgentKill) {
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);

        // b8ke delta review F7: a half-sent observed pair (exactly one of
        // epoch/generation) is the typed invalid-fence refusal — BEFORE the
        // durable close, the mint gate, or any live-state destruction. The
        // kill never proceeds as a silently downgraded legacy request.
        let stop_fence =
            match crate::ownership_lane::wire_fence(msg.observed_epoch, msg.observed_generation) {
                Ok(fence) => fence,
                Err(err) => {
                    tracing::warn!(target: "freshell_freshagent::claude",
                    session_id = %session_id, code = err.code(),
                    "fresh_agent_kill_refused: the observed fence is half-sent (invalid)");
                    self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
                        provider: PROVIDER.to_string(),
                        session_id: msg.session_id.clone(),
                        session_type: session_type.to_string(),
                        success: false,
                        code: Some(err.code().to_string()),
                        message: Some(err.message().to_string()),
                    }));
                    return;
                }
            };

        // Retire-on-kill (delta-review round 5 + focused-ep5-r1 round 2,
        // restore-open-sessions-only): an explicit kill is an intentional
        // session END — every durable id this kill covers retires its
        // pane-ledger row `Closed`, so the recovery inventory (Bound-only at
        // its `row_is_bound` pre-filter) can never re-offer a pane the user
        // just closed inside the 7s creation-race grace window. The row is
        // keyed on the DURABLE claude UUID while the wire kill names the
        // pane's ORIGINAL bare placeholder (or a durable alias), so the
        // retire set is { the wire id } ∪ { the removed session's
        // cli_session_id } ∪ { every LIVE cli_index alias of the map key } ∪
        // { every EVICTED alias the placeholder ever answered to (the round-2
        // alias tombstones — Finding 1: the client closes the pane by its
        // bare placeholder even after the sidecar's exit-eviction dropped the
        // alias map entry; the round-1 retire set silently missed the row
        // in exactly that case). An UNKNOWN/evicted durable id is still
        // retired by name: the session map is process memory while the row
        // is durable.
        //
        // Finding 2's closing fence rides WITH the retire: the ledger folds a
        // durable KILL TOMBSTONE into `retire_closed`, and the ONE binder
        // choke point (`record_fresh_agent_binding`) consults it under the
        // same index guard as the write — so a binding write already in
        // flight at kill time (an aborted consumer's orphaned spawn_blocking
        // closure, which NO task abort can cancel) suppresses itself instead
        // of restoring Bound after the retire.
        //
        // Delta-r6-r3 (focused-episode-6 round 2, Finding 4) — ONE close
        // envelope, then teardown. The close's identity set is computed
        // FIRST (the Task-10b alias resolution + the pre-destruction
        // collection below — no await ever interleaves per-identity DURABLE
        // writes while live state is being destroyed), then the WHOLE set
        // closes as a single failure-atomic ledger envelope
        // (`retire_closed_batch` → `PaneLedger::close_identities`):
        // tombstones + row retires under ONE guard hold, rolling the
        // envelope's OWN writes back on any failure. The delta-r6/r6-r2
        // two-pass shape could close the wire/alias identities first and — a
        // later authoritative-session close failing — report `success:false`
        // with the live session preserved and standing tombstones still on
        // disk: a tombstone with no matching row reads as CLOSED in the
        // recovery inventory, suppressing a genuinely open session. A FAILED
        // envelope here aborts the kill the same way but leaves NOTHING
        // durable; a retried kill re-attempts idempotently.
        //
        // Task 10b: durable ids resolve through `cli_index` (alias, don't move) --
        // a kill addressed by the durable id must tear down the live aliased session.
        // Unresolvable ids keep today's idempotent success path.
        let mut map_key = self
            .resolve_session_key(&session_id)
            .await
            .unwrap_or_else(|| session_id.clone());
        #[cfg(test)]
        if let Some(pause) = &self.kill_after_resolve_pause {
            pause
                .reached
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = pause.notify.notified().await;
        }
        // Focused-episode-6 round 4 (Finding F5) — discovery completes
        // BEFORE the one envelope and BEFORE teardown. ONE critical section
        // (cli_index → sessions → alias_tombstones → close_pending — the
        // exact acquisition `adopt_session_init` duplicates) arms the mint
        // gate AND enumerates the session's COMPLETE durable identity set:
        // the wire id, the recorded cli id, every live cli_index alias,
        // every evicted/persisted alias record pointing at the map key.
        // From this instant every adoption abandons, so the enumerated set
        // is complete by construction — nothing durable exists yet (the
        // envelope writes next), and a Clean failure simply releases the
        // gate with the session untouched.
        let mut retire_ids = vec![session_id.clone()];
        {
            let index = self.cli_index.lock().await;
            let sessions = self.sessions.lock().await;
            let mut tombstones = self.alias_tombstones.lock().expect("alias tombstones lock");
            // `resolve_session_key` ran before this critical section. A
            // conversation reset can move the same runtime in between and
            // leave the addressed id as an alias to its new map key. Refresh
            // the key against these exact index+map guards so the close gate,
            // retire set, and eventual teardown all name the same runtime.
            let current_map_key = if sessions.contains_key(&map_key) {
                Some(map_key.clone())
            } else {
                index
                    .get(&session_id)
                    .filter(|mapped| sessions.contains_key(*mapped))
                    .cloned()
            };
            if let Some(current_map_key) = current_map_key {
                map_key = current_map_key;
            }
            if sessions.contains_key(&map_key) {
                let mut gates = self.close_pending.lock().expect("close-pending lock");
                *gates.entry(map_key.clone()).or_insert(0) += 1;
            }
            self.collect_kill_retire_ids_under_guards(
                &session_id,
                &map_key,
                &mut retire_ids,
                &index,
                &sessions,
                &mut tombstones,
            );
        }
        // b8ke delta round-3 F1: THE COORDINATOR CLAIM COMES FIRST —
        // BEFORE any durable mutation. Pre-d3 the durable close envelope
        // retired the pane-ledger rows BEFORE this claim, so every typed
        // refusal (BlockedHandoff / StaleClaim / an in-flight transition)
        // returned with the durable row CLOSED although the runtime still
        // ran — cross-device/history restoration misidentified a killed
        // session that is alive. Now: the claim decides first; the durable
        // close runs ONLY after the coordinator licenses the stop, and a
        // Clean-failure close after a GRANTED claim unwinds the claim via
        // `abort_stop` (Stopping → Live at the pre-stop generation) so the
        // coordinator is never stranded by a ledger failure. The claim is
        // built from the lane's OWN retained stamp (its believed runtime
        // identity plus the `(epoch, generation)` its `commit_live`
        // stamped; the wire pair on `freshAgent.kill` feeds the same fence
        // when present) — resolved for the wire id (a durable) or through
        // the live session's recorded cli id (a placeholder-addressed
        // kill). `NotLive{Vacant}`: the kill proceeds (idempotent lane
        // cleanup) and skips the commit. NO retained stamp: the kill
        // still CONSULTS the coordinator through an observed-owner claim
        // (the record the coordinator itself holds for this session) —
        // never a silent lane-local skip; a refusal answers typed. (The
        // fence itself was resolved at entry — a half-sent pair never
        // reaches this point.)
        let mut stop_generation: Option<u64> = None;
        let mut stop_op_id: Option<String> = None;
        let mut stop_key: Option<String> = None;
        // b8ke e3r1 F2: the granted claim's consumed stamp, captured for
        // the abort path's restoration (a clean-close failure must restore
        // EVERYTHING the grant consumed — the registry via abort_stop AND
        // the retained stamp, so the natural-exit watcher can still release
        // ownership on the runtime's eventual exit/crash).
        let mut taken_stop_stamp: Option<(String, crate::ownership_lane::OwnershipStamp)> = None;
        // b8ke e3r3 F7: the granted stop's settlement guard — its Drop
        // fires the flag the stale-Stopping watchdog consults (a
        // progressing stop is not stale; never fenced on age alone).
        let mut _stop_settlement: Option<crate::ownership_lane::StopSettlementGuard> = None;
        if let Some(registry) = self.ownership.as_ref() {
            let stop_stamp = match crate::ownership_lane::peek_retained_stamp(
                &self.ownership_stamps,
                &session_id,
            ) {
                Some(stamp) => Some((session_id.clone(), stamp)),
                None => {
                    let map_key = self.resolve_session_key(&session_id).await;
                    match map_key {
                        Some(map_key) => {
                            let durable = self
                                .sessions
                                .lock()
                                .await
                                .get(&map_key)
                                .and_then(|s| s.cli_session_id.clone());
                            durable.and_then(|d| {
                                crate::ownership_lane::peek_retained_stamp(
                                    &self.ownership_stamps,
                                    &d,
                                )
                                .map(|st| (d, st))
                            })
                        }
                        None => None,
                    }
                }
            };
            if let Some((stop_session_id, stamp)) = stop_stamp {
                let claim = crate::ownership_lane::stop_claim_from_stamp(&stamp, stop_fence);
                let kill_op_id = format!("kill-{}", uuid::Uuid::new_v4());
                let stop_outcome = crate::ownership_lane::begin_fresh_agent_stop(
                    registry,
                    PROVIDER,
                    &stop_session_id,
                    &kill_op_id,
                    &claim,
                    "freshclaude/kill",
                    crate::session_lease::now_epoch_ms(),
                );
                let refused = match stop_outcome {
                    freshell_ownership::StopOutcome::Granted { generation } => {
                        // b8ke e3r2 F2 test seam: the watcher-race park
                        // (never armed in production).
                        #[cfg(test)]
                        if let Some(pause) = &self.kill_stop_take_pause {
                            pause
                                .reached
                                .store(true, std::sync::atomic::Ordering::SeqCst);
                            let _ = pause.notify.notified().await;
                        }
                        // b8ke e3r2 F2: the take is Option-tolerant — a
                        // concurrent consumer-exit watcher can remove the
                        // stamp between the begin_stop and the take (its
                        // registry release no-ops against our Stopping);
                        // that is an EXPECTED race, never a panic. We hold
                        // the stop claim; the commit path needs no stamp,
                        // so the kill proceeds coherently.
                        taken_stop_stamp = crate::ownership_lane::take_retained_stamp(
                            &self.ownership_stamps,
                            &stop_session_id,
                        )
                        .map(|st| (stop_session_id.clone(), st));
                        if taken_stop_stamp.is_none() {
                            tracing::warn!(target: "freshell_freshagent::claude",
                                session_id = %stop_session_id,
                                "fresh_agent_kill_stamp_raced: the exit watcher removed the \
                                 stamp between the stop claim and the take — the kill proceeds \
                                 coherently under the held claim (never a panic)"
                            );
                        }
                        stop_generation = Some(generation);
                        stop_op_id = Some(kill_op_id.clone());
                        stop_key = Some(stop_session_id.clone());
                        _stop_settlement =
                            Some(crate::ownership_lane::register_stop_settlement_for_claim(
                                &self.ownership,
                                PROVIDER,
                                &stop_session_id,
                                &kill_op_id,
                                generation,
                            ));
                        None
                    }
                    freshell_ownership::StopOutcome::NotLive {
                        state: freshell_ownership::OwnershipState::Vacant,
                    } => {
                        crate::ownership_lane::take_retained_stamp(
                            &self.ownership_stamps,
                            &stop_session_id,
                        );
                        None
                    }
                    freshell_ownership::StopOutcome::NotLive { ref state } => Some((
                        "LIFECYCLE_IN_FLIGHT",
                        format!(
                            "a lifecycle operation is in flight ({state:?}); retry after it settles"
                        ),
                    )),
                    freshell_ownership::StopOutcome::BlockedHandoff { .. } => Some((
                        "HANDOFF_IN_FLIGHT",
                        "a handoff owns this session's transition; retry after it settles"
                            .to_string(),
                    )),
                    freshell_ownership::StopOutcome::StaleClaim { .. } => Some((
                        "STALE_CLAIM",
                        "ownership moved to a newer runtime; refresh and retry".to_string(),
                    )),
                };
                if let Some((refusal_code, refusal_message)) = refused {
                    tracing::warn!(target: "freshell_freshagent::claude",
                        session_id = %session_id, outcome = ?stop_outcome,
                        "fresh_agent_kill_refused: the ownership coordinator refused the \
                         stop (kata b8ke) — nothing is killed"
                    );
                    // Task 3 review I-1: the refusal killed NOTHING, so it
                    // must roll the pre-kill mint gate back exactly like
                    // the Clean-failure abort arm above — a held gate makes
                    // `adopt_session_init` abandon forever, suppressing the
                    // still-live session's alias/binding corrector writes,
                    // and the refusal's own "retry after it settles"
                    // message promises a retryable, fully operational
                    // session.
                    {
                        let _index = self.cli_index.lock().await;
                        let _sessions = self.sessions.lock().await;
                        let mut gates = self.close_pending.lock().expect("close-pending lock");
                        if let Some(n) = gates.get_mut(&map_key) {
                            *n -= 1;
                            if *n == 0 {
                                gates.remove(&map_key);
                            }
                        }
                    }
                    self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
                        provider: PROVIDER.to_string(),
                        session_id,
                        session_type: session_type.to_string(),
                        success: false,
                        code: Some(refusal_code.to_string()),
                        message: Some(refusal_message),
                    }));
                    return;
                }
            } else {
                // b8ke delta round-3 F1: NO retained stamp — the kill STILL
                // consults the coordinator (never a silent lane-local
                // skip). An observed-owner claim: the record the
                // coordinator itself holds for this session licenses (or
                // refuses) the stop; the ledger stays bound on refusal.
                // The observed key is the CANONICAL DURABLE id — the same
                // lane resolution the stamp path uses (placeholder wire
                // ids resolve through the live session's recorded cli id;
                // a durable wire id is itself).
                let live_key = self.resolve_session_key(&session_id).await;
                let canonical = self
                    .claude_owner_key(live_key.as_deref(), &session_id)
                    .await
                    .key;
                let snap = registry.observe(PROVIDER, &canonical);
                match snap.state.clone() {
                    freshell_ownership::OwnershipState::Live {
                        owner, generation, ..
                    } => {
                        // b8ke e3r1 F1: the fallback authorizes ONLY THIS
                        // LANE'S runtime — the observed owner must be a
                        // Fresh Agent. A delayed kill that observes a
                        // TERMINAL owner (a completed handoff removed the
                        // stamp and committed the terminal) is refused
                        // typed — NEVER fabricated into a matching claim
                        // that would commit the coordinator to Vacant
                        // while the live terminal is never torn down (the
                        // untracked-PTY second-writer hole).
                        if owner.kind != freshell_ownership::RuntimeOwnerKind::FreshAgent {
                            tracing::warn!(target: "freshell_freshagent::claude",
                                session_id = %session_id, observed_kind = ?owner.kind,
                                "fresh_agent_kill_refused_no_stamp: the coordinator's live \
                                 owner is NOT this lane's Fresh Agent runtime — a delayed \
                                 kill never fabricates a foreign-kind claim"
                            );
                            {
                                let _index = self.cli_index.lock().await;
                                let _sessions = self.sessions.lock().await;
                                let mut gates =
                                    self.close_pending.lock().expect("close-pending lock");
                                if let Some(n) = gates.get_mut(&map_key) {
                                    *n -= 1;
                                    if *n == 0 {
                                        gates.remove(&map_key);
                                    }
                                }
                            }
                            self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
                                provider: PROVIDER.to_string(),
                                session_id,
                                session_type: session_type.to_string(),
                                success: false,
                                code: Some("FOREIGN_OWNER".to_string()),
                                message: Some(
                                    "the session's live owner is not this agent runtime; \
                                     refresh and retry"
                                        .to_string(),
                                ),
                            }));
                            return;
                        }
                        // e3r1 F1: honor the REQUEST'S fence — a delayed
                        // kill carrying a stale observed pair is refused by
                        // the same generation arithmetic the stamp path
                        // uses (a fence-less legacy kill claims against the
                        // CURRENT pair — the snapshot's).
                        let observed_live_generation = generation;
                        let claim = freshell_ownership::StopClaim {
                            expected_kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                            expected_runtime: Some(owner.clone()),
                            observed: stop_fence.unwrap_or(freshell_ownership::ObservedFence {
                                epoch: snap.epoch,
                                generation,
                            }),
                        };
                        let kill_op_id = format!("kill-{}", uuid::Uuid::new_v4());
                        let stop_outcome = crate::ownership_lane::begin_fresh_agent_stop(
                            registry,
                            PROVIDER,
                            &canonical,
                            &kill_op_id,
                            &claim,
                            "freshclaude/kill",
                            crate::session_lease::now_epoch_ms(),
                        );
                        match stop_outcome {
                            freshell_ownership::StopOutcome::Granted { generation } => {
                                stop_generation = Some(generation);
                                stop_op_id = Some(kill_op_id.clone());
                                stop_key = Some(canonical.clone());
                                // b8ke e3r4 F1: the no-stamp Granted path
                                // records the SAME stop bookkeeping as the
                                // stamp-present path — the settlement
                                // guard (so a slow-but-running stop is
                                // never fenced as unregistered) and the
                                // rollback evidence (a synthesized stamp
                                // from the OBSERVED owner, so the unwind
                                // verifies the runtime's liveness directly
                                // — NEVER stamp-absence, which was
                                // converted to "runtime exited" and
                                // committed a LIVE runtime to Vacant on a
                                // clean close failure).
                                // b8ke e3 post-cap F1: the rollback stamp
                                // mirrors EXACTLY what abort_stop restores —
                                // the ORIGINAL owner identity at the PRE-stop
                                // Live generation (the snapshot's), with the
                                // owner's own ownership_id as the stamp's
                                // operation id (release's runtime_matches
                                // requires stamp.operation_id == the live
                                // owner's ownership_id AND stamp.generation ==
                                // the Live record's generation; pre-post-cap
                                // the minted stop generation + kill_op_id
                                // could never satisfy either, so a later
                                // natural exit could never release and an
                                // unfenced retry derived a stale stop claim —
                                // a recovered close failure left the
                                // coordinator falsely Live until restart).
                                taken_stop_stamp = Some((
                                    canonical.clone(),
                                    crate::ownership_lane::OwnershipStamp {
                                        epoch: registry.boot_epoch(),
                                        generation: observed_live_generation,
                                        operation_id: owner
                                            .ownership_id
                                            .clone()
                                            .unwrap_or_default(),
                                        owner: owner.clone(),
                                    },
                                ));
                                _stop_settlement = Some(
                                    crate::ownership_lane::register_stop_settlement_for_claim(
                                        &self.ownership,
                                        PROVIDER,
                                        &canonical,
                                        &kill_op_id,
                                        generation,
                                    ),
                                );
                            }
                            freshell_ownership::StopOutcome::NotLive {
                                state: freshell_ownership::OwnershipState::Vacant,
                            } => {}
                            other => {
                                let (refusal_code, refusal_message) = match &other {
                                    freshell_ownership::StopOutcome::NotLive { state } => (
                                        "LIFECYCLE_IN_FLIGHT",
                                        format!(
                                            "a lifecycle operation is in flight ({state:?}); \
                                             retry after it settles"
                                        ),
                                    ),
                                    freshell_ownership::StopOutcome::BlockedHandoff { .. } => (
                                        "HANDOFF_IN_FLIGHT",
                                        "a handoff owns this session's transition; \
                                         retry after it settles"
                                            .to_string(),
                                    ),
                                    _ => (
                                        "STALE_CLAIM",
                                        "ownership moved to a newer runtime; \
                                         refresh and retry"
                                            .to_string(),
                                    ),
                                };
                                tracing::warn!(target: "freshell_freshagent::claude",
                                    session_id = %session_id, outcome = ?other,
                                    "fresh_agent_kill_refused_no_stamp: the ownership \
                                     coordinator refused the observed-owner stop — nothing \
                                     is killed, nothing durable is touched"
                                );
                                {
                                    let _index = self.cli_index.lock().await;
                                    let _sessions = self.sessions.lock().await;
                                    let mut gates =
                                        self.close_pending.lock().expect("close-pending lock");
                                    if let Some(n) = gates.get_mut(&map_key) {
                                        *n -= 1;
                                        if *n == 0 {
                                            gates.remove(&map_key);
                                        }
                                    }
                                }
                                self.broadcast(&ServerMessage::FreshAgentKilled(
                                    FreshAgentKilled {
                                        provider: PROVIDER.to_string(),
                                        session_id,
                                        session_type: session_type.to_string(),
                                        success: false,
                                        code: Some(refusal_code.to_string()),
                                        message: Some(refusal_message),
                                    },
                                ));
                                return;
                            }
                        }
                    }
                    freshell_ownership::OwnershipState::Handoff { .. } => {
                        // b8ke e3r1... e3r2 F1: a HANDOFF owns the key's
                        // transition (its kill_for_handoff consumed the
                        // stamp while the record stayed Handoff) — a
                        // concurrent/delayed kill answers the TYPED
                        // in-flight refusal, NEVER proceeds with the
                        // durable close + teardown that would race the
                        // handoff's replacement commit (pre-e3r2 the
                        // wildcard arm treated Handoff as "residue" and
                        // proceeded).
                        tracing::warn!(target: "freshell_freshagent::claude",
                            session_id = %session_id,
                            "fresh_agent_kill_refused_no_stamp: a handoff owns this \
                             session's transition — the kill is refused typed"
                        );
                        {
                            let _index = self.cli_index.lock().await;
                            let _sessions = self.sessions.lock().await;
                            let mut gates = self.close_pending.lock().expect("close-pending lock");
                            if let Some(n) = gates.get_mut(&map_key) {
                                *n -= 1;
                                if *n == 0 {
                                    gates.remove(&map_key);
                                }
                            }
                        }
                        self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
                            provider: PROVIDER.to_string(),
                            session_id,
                            session_type: session_type.to_string(),
                            success: false,
                            code: Some("HANDOFF_IN_FLIGHT".to_string()),
                            message: Some(
                                "a handoff owns this session's transition; retry after it settles"
                                    .to_string(),
                            ),
                        }));
                        return;
                    }
                    freshell_ownership::OwnershipState::Starting { .. }
                    | freshell_ownership::OwnershipState::Stopping { .. } => {
                        tracing::warn!(target: "freshell_freshagent::claude",
                            session_id = %session_id, state = ?snap.state,
                            "fresh_agent_kill_refused_no_stamp: a lifecycle operation is \
                             in flight — the kill is refused typed"
                        );
                        {
                            let _index = self.cli_index.lock().await;
                            let _sessions = self.sessions.lock().await;
                            let mut gates = self.close_pending.lock().expect("close-pending lock");
                            if let Some(n) = gates.get_mut(&map_key) {
                                *n -= 1;
                                if *n == 0 {
                                    gates.remove(&map_key);
                                }
                            }
                        }
                        self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
                            provider: PROVIDER.to_string(),
                            session_id,
                            session_type: session_type.to_string(),
                            success: false,
                            code: Some("LIFECYCLE_IN_FLIGHT".to_string()),
                            message: Some(
                                "a lifecycle operation is in flight; retry after it settles"
                                    .to_string(),
                            ),
                        }));
                        return;
                    }
                    freshell_ownership::OwnershipState::Fenced { .. } => {
                        tracing::warn!(target: "freshell_freshagent::claude",
                            session_id = %session_id, state = ?snap.state,
                            "fresh_agent_kill_refused_no_stamp: the key is FENCED — the \
                             kill is refused typed (the fence owns the transition)"
                        );
                        {
                            let _index = self.cli_index.lock().await;
                            let _sessions = self.sessions.lock().await;
                            let mut gates = self.close_pending.lock().expect("close-pending lock");
                            if let Some(n) = gates.get_mut(&map_key) {
                                *n -= 1;
                                if *n == 0 {
                                    gates.remove(&map_key);
                                }
                            }
                        }
                        self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
                            provider: PROVIDER.to_string(),
                            session_id,
                            session_type: session_type.to_string(),
                            success: false,
                            code: Some("SESSION_FENCED".to_string()),
                            message: Some(
                                "the session is fenced pending recovery; retry with the \
                                 acknowledged force-clear or after the fence clears"
                                    .to_string(),
                            ),
                        }));
                        return;
                    }
                    _ => {
                        // Genuinely Vacant (or this-lane rekey residue):
                        // lane-local cleanup proceeds — the coordinator
                        // holds nothing to stop.
                    }
                }
            }
        }

        // THE durable close — ONE envelope over the whole set, BEFORE any
        // live-state destruction (the map removal, the consumer abort). On
        // Clean failure the kill aborts with NOTHING touched and NOTHING
        // durable: the mint gate releases (the session resumes untouched).
        // Delta-r6-r4 (round 3 Finding 3): the PERSISTED class — the close
        // IS durable despite the reported error — proceeds instead (the
        // session ends, consistent with the durable close) while the answer
        // still reports `success:false` (the kill visibly fails).
        let close_answer = self.retire_closed_rows(&retire_ids).await;
        if close_answer == crate::identity_sink::CloseAnswer::Failed {
            // b8ke delta round-3 F1 + e3r1 F2 + e3r2 F4: the clean-close
            // failure unwinds the granted claim BY THE RUNTIME'S ACTUAL
            // LIVENESS — one source of truth (the live session map's child
            // incarnation):
            //   • LIVE  → abort_stop (Stopping → Live at the pre-stop
            //     generation) + restore the consumed stamp, so the session
            //     resumes fully operational AND the natural-exit watcher
            //     can still release ownership later.
            //   • EXITED (e3r2 F4: it died during the awaited close; the
            //     exit watcher already observed the stamp absent and
            //     completed) → commit_stop (Vacant): NEVER resurrect a
            //     dead runtime as Live with no future watcher.
            // b8ke e3r3 F8 test seam: the pre-restore park (never armed
            // in production) — the deterministic exit-after-verdict window.
            #[cfg(test)]
            if let Some(pause) = &self.kill_close_failure_pause {
                pause
                    .reached
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                let _ = pause.notify.notified().await;
            }
            // b8ke e3r3 F2/F8: THE ATOMIC VERDICT PRECEDES the registry
            // mutation — restore_retained_stamp_if_live probes the
            // recorded incarnation UNDER the stamps lock and restores only
            // a LIVE one, in one step atomic w.r.t. the exit watcher. The
            // restore's own verdict then drives the registry: restored
            // (live) → abort_stop (Stopping → Live at the pre-stop
            // generation, and the restored stamp keeps the exit watcher
            // armed for the runtime's eventual natural exit); refused
            // (dead — it exited during the awaited close, after any
            // pre-verdict) → commit_stop (Vacant): never a dead runtime
            // recorded Live, never a stamp restored for a dead process.
            let restored_live_stamp = taken_stop_stamp
                .map(|(stamp_key, stamp)| {
                    crate::ownership_lane::restore_retained_stamp_if_live(
                        &self.ownership_stamps,
                        &stamp_key,
                        stamp,
                        false,
                    )
                })
                .unwrap_or(false);
            if let (Some(key), Some(op_id), Some(generation)) =
                (stop_key.clone(), stop_op_id.clone(), stop_generation)
            {
                if let Some(registry) = self.ownership.as_ref() {
                    if restored_live_stamp {
                        let _ = registry.abort_stop(PROVIDER, &key, &op_id, generation);
                    } else {
                        tracing::warn!(target: "freshell_freshagent::claude",
                            session_id = %session_id,
                            "fresh_agent_kill_abort_runtime_exited: the runtime exited \
                             during the awaited close — NOT restored (never a dead runtime \
                             recorded Live); the key ends Vacant"
                        );
                        let outcome = registry.commit_stop(PROVIDER, &key, &op_id, generation);
                        // b8ke ext r18 F1: the successful commit-to-Vacant
                        // BROADCASTS the release frame (every commit site,
                        // not only the main kill arm).
                        if matches!(outcome, freshell_ownership::CommitOutcome::Committed) {
                            if let Some(frame) = crate::ownership_lane::released_owner_frame(
                                &self.ownership,
                                PROVIDER,
                                &key,
                                &op_id,
                                // b8ke ext r32 F2: the COMMITTED
                                // transition's own pair — never a
                                // re-observed generation.
                                registry.boot_epoch(),
                                generation,
                            ) {
                                self.broadcast(&frame);
                            }
                        }
                    }
                }
            }
            {
                let _index = self.cli_index.lock().await;
                let _sessions = self.sessions.lock().await;
                let mut gates = self.close_pending.lock().expect("close-pending lock");
                if let Some(n) = gates.get_mut(&map_key) {
                    *n -= 1;
                    if *n == 0 {
                        gates.remove(&map_key);
                    }
                }
            }
            self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
                provider: PROVIDER.to_string(),
                session_id,
                session_type: session_type.to_string(),
                success: false,
                code: Some("DURABLE_CLOSE_FAILED".to_string()),
                message: Some(
                    "the pane-ledger close failed; nothing was killed — retry".to_string(),
                ),
            }));
            return;
        }
        let main_close_reported_failure =
            close_answer == crate::identity_sink::CloseAnswer::Persisted;

        // Live-state destruction begins (every durable id the one envelope
        // covers is durably closed by this point). The consumer ABORT stays
        // synchronous (the minter channel closes).
        // C09: a closed session is not an ended one waiting to be resumed.
        self.dead_sessions.forget(&retire_ids, "killed");
        let removed = self.sessions.lock().await.remove(&map_key);
        // The gate entry dies with the session (the map rule was the gate's
        // whole meaning; an aborted session adopts nothing more).
        self.close_pending
            .lock()
            .expect("close-pending lock")
            .remove(&map_key);
        if let Some(session) = &removed {
            session.consumer.abort();
        }
        // DEFENSIVE invariant probe — must never fire by construction (F5):
        // any id surfacing only now would have slipped the close gate, so it
        // is retired under the kill's teardown, loudly, and the kill answers
        // failure (never masquerade a broken gate as success — the brief's
        // visible-with-partial last resort).
        let mut recheck = vec![session_id.clone()];
        self.collect_kill_retire_ids(&session_id, &map_key, &mut recheck)
            .await;
        let strays: Vec<String> = recheck
            .iter()
            .filter(|id| **id != session_id && !retire_ids.contains(*id))
            .cloned()
            .collect();
        let mut invariant_broken = false;
        if !strays.is_empty() {
            invariant_broken = true;
            tracing::error!(target: "freshell_freshagent::claude",
                strays = ?strays,
                session = %map_key,
                "freshagent.claude.kill_post_envelope_discovery_invariant_broken: an identity \
                 surfaced after the one-envelope enumeration DESPITE the close gate; retiring \
                 it under the teardown and answering failure"
            );
            let _ = self.retire_closed_rows(&strays).await;
            retire_ids.extend(strays);
        }
        // b8ke focused round-2 review R2-2: the teardown's typed outcome
        // decides the stop commit AND the broadcast truth — an unconfirmed
        // tree is never a silent success.
        let closed_runtime = removed.as_ref().map(|session| session.ownership_id.clone());
        let teardown = if let Some(session) = removed {
            self.teardown_removed_session_logged(session).await
        } else {
            LoggedTeardown::Confirmed
        };

        let teardown = self.release_leases_after_teardown(
            teardown,
            retire_ids.clone(),
            map_key.clone(),
            closed_runtime,
        );

        // Explicit kill evicts this session's requestId dedup cache entries (mirrors
        // `clearFreshAgentCreateCachesForSession`) -- a later duplicate `create` for the
        // same requestId must genuinely mint a fresh session, not replay the one just
        // killed.
        self.create_dedup
            .clear_for_session(|record| record.session_id == map_key)
            .await;

        // Evict the killed session's durable-id index entries — DEMOTED to
        // the alias tombstones (Finding 1), so a repeat kill naming the bare
        // placeholder still resolves the durable row (the `sdk.session.init`
        // race-in case is covered: the alias collection above ran first).
        self.evict_cli_index_aliases(&map_key).await;

        // Round 5 (focused-ep5-r4 Finding 1), the kill's post-close SWEEP:
        // the durable close and the session-map removal are not one atomic
        // step, and a concurrent claim lane registers through the same edge
        // (it committed before this kill's retire landed and its own
        // post-registration re-check had not observed the fence yet). Any
        // session now registered behind a still-standing close fence is that
        // claim's late orphan — sweep tears it down. The claim's re-check
        // (`claim_dead_state_advanced`) covers the mirror order; a claim
        // that has since COMMITTED (its fence-clearing transition beat this
        // sweep) is a genuine reopen and is spared.
        self.sweep_late_claim_orphans(&retire_ids).await;

        // kata b8ke Task 3 + b8ke focused round-2 review R2-2: the stop
        // commit follows the CONFIRMED reap — `Stopping` → `Vacant` only
        // once the teardown confirmed the tree's death. An UNCONFIRMED
        // tree keeps the key fenced in `Stopping` (blocked for every new
        // writer) while the detached escalation finishes the kill, and only
        // its confirmed death commits the stop; a PLATFORM-LIMITED
        // confirmation (non-Linux) fences the key typed — never a Vacant
        // over an unverifiable descendant tree. NEVER before the reap
        // (round-1 review), never unconfirmed (round-2 review).
        let mut kill_failure: Option<(&'static str, String)> = None;
        if let (Some(registry), Some(generation), Some(op_id), Some(key)) = (
            self.ownership.as_ref(),
            stop_generation,
            stop_op_id.as_deref(),
            stop_key.as_deref(),
        ) {
            match teardown {
                LoggedTeardown::Confirmed => {
                    let outcome = crate::ownership_lane::commit_fresh_agent_stop(
                        registry, PROVIDER, key, op_id, generation,
                    );
                    // b8ke ext r18 F1: a SUCCESSFUL commit-to-Vacant
                    // BROADCASTS the release frame (the vacant owner + the
                    // NEW generation — connected panes and the kill →
                    // immediate recreate sequence converge on the first
                    // try).
                    if matches!(outcome, freshell_ownership::CommitOutcome::Committed) {
                        if let Some(frame) = crate::ownership_lane::released_owner_frame(
                            &self.ownership,
                            PROVIDER,
                            key,
                            op_id,
                            // b8ke ext r32 F2: the COMMITTED transition's
                            // own pair — never a re-observed generation.
                            registry.boot_epoch(),
                            generation,
                        ) {
                            self.broadcast(&frame);
                        }
                    }
                }
                LoggedTeardown::NotConfirmed { escalation } => {
                    // The bounded window expired with tagged descendants
                    // still alive: the key stays fenced in `Stopping` (no
                    // new writer can start) while the escalation kills the
                    // tree — its confirmed death performs the deferred
                    // commit. The kill visibly FAILS (typed, retryable).
                    kill_failure = Some((
                        "TEARDOWN_NOT_CONFIRMED",
                        "the session was killed but its runtime tree's death could not be \
                         confirmed yet; the key stays fenced until the escalation confirms \
                         it — retry after it settles"
                            .to_string(),
                    ));
                    let registry = Arc::clone(registry);
                    let key = key.to_string();
                    let op_id = op_id.to_string();
                    // b8ke ext r18 F1: the deferred commit's release frame
                    // rides the shared broadcast bus (captured by value —
                    // the spawned task outlives this call).
                    let deferred_broadcast_tx = Arc::clone(&self.broadcast_tx);
                    tokio::spawn(async move {
                        if escalation.await.unwrap_or(false) {
                            let outcome = crate::ownership_lane::commit_fresh_agent_stop(
                                &registry, PROVIDER, &key, &op_id, generation,
                            );
                            if matches!(outcome, freshell_ownership::CommitOutcome::Committed) {
                                if let Some(frame) = crate::ownership_lane::released_owner_frame(
                                    &Some(Arc::clone(&registry)),
                                    PROVIDER,
                                    &key,
                                    &op_id,
                                    // b8ke ext r32 F2: the COMMITTED
                                    // transition's own pair — never a
                                    // re-observed generation.
                                    registry.boot_epoch(),
                                    generation,
                                ) {
                                    if let Ok(frame) = serde_json::to_string(&frame) {
                                        let _ = deferred_broadcast_tx.send(frame);
                                    }
                                }
                            }
                            tracing::warn!(target: "freshell_ownership",
                                event = "ownership.stop.deferred_commit",
                                provider = PROVIDER, session_id = %key,
                                operation_id = %op_id, generation,
                                outcome = "committed_after_confirmed_death",
                                failure_reason = "TEARDOWN_NOT_CONFIRMED",
                                "the unconfirmed-kill escalation confirmed the tree's death — \
                                 the deferred stop commit released the fenced key");
                        } else {
                            tracing::error!(target: "freshell_ownership",
                                event = "ownership.stop.deferred_commit",
                                provider = PROVIDER, session_id = %key,
                                operation_id = %op_id, generation,
                                outcome = "escalation_lost",
                                failure_reason = "TEARDOWN_ESCALATION_LOST",
                                "the unconfirmed-kill escalation itself was lost — the key \
                                 stays fenced in Stopping (fail-closed; no new writer)");
                        }
                    });
                }
                LoggedTeardown::PlatformLimited => {
                    // R2-3 discipline on the explicit-kill path: a
                    // platform-limited confirmation is NOT a confirmed
                    // reap — the key fences typed instead of committing
                    // `Stopping` → `Vacant`. Nothing on a non-Linux
                    // platform can confirm the descendant death, so the
                    // fence persists for the boot epoch (the documented
                    // tradeoff; the session stays recoverable and the
                    // operator can kill leftover processes by other means).
                    let _ = registry.fence_unconfirmed_stop(
                        PROVIDER,
                        key,
                        op_id,
                        generation,
                        freshell_ownership::FenceReason::PlatformLimited,
                    );
                    kill_failure = Some((
                        "TEARDOWN_PLATFORM_LIMITED",
                        "the session was killed but this platform cannot verify the runtime \
                         tree's death; the key stays fenced (no new writer can start) and \
                         the session remains recoverable"
                            .to_string(),
                    ));
                }
            }
        }

        self.edges.forgotten(&session_id);
        self.broadcast(&ServerMessage::FreshAgentKilled(FreshAgentKilled {
            provider: PROVIDER.to_string(),
            session_id,
            session_type: session_type.to_string(),
            success: !main_close_reported_failure && !invariant_broken && kill_failure.is_none(),
            code: kill_failure.as_ref().map(|(code, _)| code.to_string()),
            message: kill_failure.as_ref().map(|(_, message)| message.clone()),
        }));
    }

    /// Round 5 (focused-ep5-r4 Finding 1): for every id this kill retired
    /// whose close fence STILL stands, a currently-registered session
    /// resolving to it is a late claim orphan (the claim's commit decision
    /// pre-dated this kill, and its post-registration re-check returned
    /// before this kill's retire landed) — tear it down. A cleared fence
    /// means a newer claim COMMITTED after the close (a genuine reopen): the
    /// sweep never kills that session. Idempotent for ids whose session the
    /// kill's own removal already took.
    ///
    /// Round 6 (focused-ep5-r5 Finding 3) — the check is no longer
    /// check-then-act: the removal and the fence RE-VERIFICATION are ONE
    /// sessions-map critical section (the fence read is the memory-fast sync
    /// sink probe, so no await crosses the hold), with this decision rule:
    ///
    /// * Fence CLEARED at the re-verify ⇒ a claim COMMITTED for this
    ///   identity while the sweep was mid-flight. Claims commit BEFORE they
    ///   register, so a session this sweep just removed can only be that
    ///   claim's genuine post-close reopen — undo the removal (re-insert)
    ///   and leave everything alone: its revived row and its cleared fence
    ///   stay exactly as the commit left them.
    /// * Fence STANDING at the re-verify ⇒ no commit cleared it, so the
    ///   removed session's own claim provably pre-dates this close — the
    ///   late orphan: tear it down, demote (never drop) its alias, and
    ///   RE-RETIRE the row idempotently. The destroyed-claim case (that
    ///   claim's commit had revived the row) and the split-write case (this
    ///   close's row-retire half failed) must never leave a Bound ghost the
    ///   next recovery can offer.
    ///
    /// The commit-vs-sweep interleaving is therefore decided at one instant
    /// (the in-section fence read): claims commit BEFORE they register, so
    /// a session the removal finds was registered — and hence COMMITTED —
    /// before that read, making the verdict authoritative for it. A claim
    /// whose commit lands after the read registers after this removal and
    /// is simply never found here — its own post-registration re-check
    /// (`claim_dead_state_advanced`, keyed to its claim-start snapshot)
    /// tears it down if this close outranks its snapshot (the round-5
    /// two-sided handoff, unchanged).
    async fn sweep_late_claim_orphans(&self, retire_ids: &[String]) {
        let Some(sink) = self.identity_sink() else {
            return;
        };
        for id in retire_ids {
            if sink.kill_tombstone_at_ms(PROVIDER, id).is_none() {
                continue; // a claim re-opened the identity after the close — not ours to kill
            }
            let map_key = self
                .resolve_session_key(id)
                .await
                .unwrap_or_else(|| id.to_string());
            // The ONE critical section the decision rule above lives in:
            // remove + re-verify, no await between the two.
            let removed = {
                let mut sessions = self.sessions.lock().await;
                match sessions.remove(&map_key) {
                    None => None,
                    Some(session) => {
                        if sink.kill_tombstone_at_ms(PROVIDER, id).is_none() {
                            // A claim COMMITTED mid-sweep: the removed session is
                            // that genuine reopen — undo the removal.
                            sessions.insert(map_key.clone(), session);
                            tracing::info!(target: "freshell_freshagent::claude",
                                durable = %id,
                                map_key = %map_key,
                                "freshagent.claude.kill_sweep_spares_mid_sweep_commit: a claim \
                                 committed while the sweep held the removal; the genuine reopen \
                                 is never the sweep's prey"
                            );
                            None
                        } else {
                            Some(session)
                        }
                    }
                }
            };
            if let Some(session) = removed {
                tracing::info!(target: "freshell_freshagent::claude",
                    durable = %id,
                    map_key = %map_key,
                    "freshagent.claude.kill_swept_late_claim_orphan: the session registered \
                     behind a standing close; torn down (kill wins)"
                );
                // The row the destroyed session belongs to must end Retired:
                // idempotent (no-op when this close's retire already landed),
                // so a revive by the destroyed claim — or a close whose
                // row-retire half split — can never leave it Bound.
                if let Err(e) = sink.retire_closed(PROVIDER, id).await {
                    tracing::warn!(error = %e, session = %id, "freshagent.claude.kill_sweep_reretire_failed");
                }
                // R2-2: the typed outcome is propagated; this unwind path holds no
                // coordinator fence, so the helper's typed log + its detached
                // escalation are the whole discipline here.
                let _teardown: LoggedTeardown = self.teardown_removed_session_logged(session).await;
                // Keep the alias bookkeeping consistent with the removal
                // (demote, never drop — a later kill naming this placeholder
                // still resolves the durable row).
                self.evict_cli_index_aliases(&map_key).await;
            }
        }
    }

    /// The kill-side durable close (delta-review round 5; delta-r6-r3 —
    /// focused-episode-6 round 2 — ONE envelope): every id in `ids` closes
    /// through the sink as a SINGLE failure-atomic envelope (`retire_closed_batch`
    /// — tombstones + row retires under the ledger's ONE guard, rolling its
    /// own writes back on any failure), AWAITED before the
    /// `freshAgent.killed` broadcast (durable-before-answer, like the
    /// create-path binding write). Each envelope ALSO folds the durable kill
    /// tombstones in (focused-ep5-r1 Finding 2 — the ledger-side
    /// `retire_closed`), so the passes `handle_kill` runs cannot be undone by
    /// a binding write that was already in flight.
    ///
    /// Delta-r6-r4 failure propagation (focused-episode-6 round 3, Finding
    /// 3): the close's answer is [`CloseAnswer`]. The caller treats the main
    /// envelope's `Failed` as a kill ABORT (nothing durable; no live state
    /// touched, `success:false` — and the enumeration gate releases), a
    /// `Persisted` as the durable-but-erroring close (the kill proceeds —
    /// the session ends consistently — and answers `success:false`), and a
    /// defensive-probe non-`Recorded` as an unacknowledged answer (the close
    /// has already committed durably — the teardown it precedes runs
    /// regardless, so the kill must not claim success).
    async fn retire_closed_rows(&self, ids: &[String]) -> crate::identity_sink::CloseAnswer {
        let Some(sink) = self.identity_sink() else {
            return crate::identity_sink::CloseAnswer::Recorded;
        };
        if ids.is_empty() {
            return crate::identity_sink::CloseAnswer::Recorded;
        }
        match sink.retire_closed_batch(PROVIDER, ids, &[]).await {
            Ok(()) => crate::identity_sink::CloseAnswer::Recorded,
            Err(e) => {
                if e.is_persisted() {
                    tracing::error!(error = %e, sessions = ?ids,
                        "freshagent.claude.retire_on_kill_persisted_despite_error: the close is durable; \
                         the kill ends the session and answers failure");
                } else {
                    tracing::warn!(error = %e, sessions = ?ids, "freshagent.claude.retire_on_kill_failed");
                }
                crate::identity_sink::CloseAnswer::of(Err(e))
            }
        }
    }

    /// Retire-on-kill round 3 (focused-ep5-r2 Findings 2+3): the kill's
    /// retire-set completion — ONE critical section across all three
    /// alias-resolution sources, with the lock order `cli_index` →
    /// `sessions` → `alias_tombstones` held for the whole consult (no awaits
    /// inside). Focused-episode-6 round 4 (Finding F5): the kill calls it
    /// ONCE, under the SAME acquisition that arms the close-pending mint
    /// gate — identity discovery is complete BEFORE the one durable close
    /// envelope is written, so post-envelope discovery is impossible by
    /// construction (the round's "discovery before teardown" rule). A
    /// post-removal re-run (the defensive probe) sees the demoted
    /// tombstones/persisted records where the live copies went (focused-
    /// ep5-r2 Finding 3's exit-eviction gap).
    ///
    /// Finding 2 (the tightened tombstone rule): a TOMBSTONE-sourced
    /// candidate is followed only when live session state does not
    /// contradict it — if the durable id currently resolves to a DIFFERENT
    /// placeholder whose session is live, the identity was genuinely
    /// reopened after the close, and the stale alias record is dead. (The
    /// genuine claim normally CONSUMES those records at reopen —
    /// `commit_session_claim`; this check is the belt to that suspenders,
    /// catching any record that escapes consumption.) Live aliases of THIS
    /// kill's own map key and the session's recorded cli id always retire:
    /// they ARE the identity the kill is closing.
    async fn collect_kill_retire_ids(
        &self,
        wire_session_id: &str,
        map_key: &str,
        retire_ids: &mut Vec<String>,
    ) {
        // Lock order: cli_index -> sessions -> alias_tombstones (-> the
        // kill's close-pending gate). All reads are synchronous once the
        // guards are held (the std Mutexes are never held across an await).
        let index = self.cli_index.lock().await;
        let sessions = self.sessions.lock().await;
        let mut tombstones = self.alias_tombstones.lock().expect("alias tombstones lock");
        self.collect_kill_retire_ids_under_guards(
            wire_session_id,
            map_key,
            retire_ids,
            &index,
            &sessions,
            &mut tombstones,
        );
    }

    /// The consult body, running under the caller's already-held guard trio
    /// (focused-episode-6 round 4, Finding F5): the kill's enumeration and
    /// its close-pending gate increment share ONE critical section — the
    /// exact acquisition `adopt_session_init`'s mint gate duplicates — so
    /// the enumerated set is complete by construction.
    fn collect_kill_retire_ids_under_guards(
        &self,
        wire_session_id: &str,
        map_key: &str,
        retire_ids: &mut Vec<String>,
        index: &HashMap<String, String>,
        sessions: &HashMap<String, ClaudeSession>,
        tombstones: &mut AliasTombstones,
    ) {
        let now = crate::session_lease::now_epoch_ms() as i64;
        // Round 5 (Finding 2): the tombstone consult carries the retention
        // probe — a still-Bound row's alias records never age out, so the
        // kill reaches the durable row however old the demotion is.
        let row_bound = self.alias_row_bound_probe();
        // Round 6 (focused-ep5-r5 Finding 2): fold the DURABLE alias records
        // into the consult — the restart-surviving half of the mapping (the
        // in-memory store dies with the process; the ledger's
        // `alias-tombstones/` subtree does not). The fold preserves the
        // persisted stamps and the same row-state sweep decides retention,
        // so a close naming the bare placeholder reaches the durable row
        // even when the server restarted after every in-memory alias died.
        // The sink read is memory-fast + sync (the ledger's write-through
        // index), permitted inside this no-await section.
        if let Some(sink) = self.identity_sink() {
            for (durable, at_ms) in sink.alias_tombstone_records(PROVIDER, wire_session_id) {
                tombstones.record_persisted(wire_session_id, &durable, at_ms, now, &row_bound);
            }
        }
        // The session's own recorded cli id (the live map holds it: keyed by
        // the placeholder OR the durable, whichever addresses the session) —
        // delta-r6-r2: read HERE inside the consult, since the kills lane
        // calls this both pre-removal (the entry stands) and post-abort (a
        // repurposed consult has nothing newly recorded to add).
        if let Some(cli_id) = sessions
            .get(map_key)
            .and_then(|s| s.cli_session_id.as_deref())
        {
            if cli_id != map_key && !retire_ids.iter().any(|id| id == cli_id) {
                retire_ids.push(cli_id.to_string());
            }
        }
        for (durable, mapped) in index.iter() {
            if mapped == map_key && !retire_ids.iter().any(|id| id == durable) {
                retire_ids.push(durable.clone());
            }
        }
        for durable in tombstones.durables_for(wire_session_id, now, &row_bound) {
            // The live-contradiction check: a stale alias tombstone is
            // followed only when the durable id it names is not now owned by
            // a DIFFERENT live session. `mk == map_key` is this kill's own
            // identity (its session entry is gone — removed above, or the
            // eviction mid-flight took it), so it always retires.
            let contradicted = match index.get(&durable) {
                Some(mk) if mk != map_key => sessions.contains_key(mk),
                _ => false,
            };
            if contradicted {
                tracing::info!(target: "freshell_freshagent::claude",
                    durable = %durable,
                    placeholder = %wire_session_id,
                    "freshagent.claude.stale_alias_tombstone_skipped: the durable is live on \
                     another session; the old placeholder's close cannot reach it");
                continue;
            }
            if !retire_ids.iter().any(|id| id == &durable) {
                retire_ids.push(durable);
            }
        }
    }

    /// Retire-on-kill round 4 (focused-ep5-r3 Finding 1; round 3's Findings
    /// 2+4 stand underneath), the claim lifecycle's COMMIT — CONDITIONAL on
    /// the identity's durable dead-state not having advanced since the claim
    /// started: `expect_killed_at_ms` is the claim-START snapshot
    /// ([`PaneIdentitySink::kill_tombstone_at_ms`], read before the
    /// spawn/resume awaits), and an explicit resume/attach of a durable id
    /// commits ONLY if that state is unchanged. If a kill landed mid-claim
    /// (the user closed the pane while the resume awaited its response), the
    /// commit is REFUSED with no durable side effects — the resumed session
    /// is an orphan of a closed pane, and the CALLER tears it down and
    /// leaves the row Retired. A reviving claim must never undo a newer
    /// close.
    ///
    /// On COMMIT (the round-3 contract, now one durable transition):
    /// invoked ONLY after the replacement session is established (Finding 5:
    /// never before, or a failed create would leave the identity unfenced) —
    ///
    /// 1. the durable kill tombstone is cleared AND the kill-closed row
    ///    returns to Bound as ONE ledger transition
    ///    ([`PaneIdentitySink::commit_claim`]); the durable clear is gone as
    ///    a standalone step, so no mid-way failure can leave "cleared but
    ///    still Closed" or "Bound but still fenced" (Finding 3);
    /// 2. every demoted placeholder→durable ALIAS tombstone pointing at
    ///    `durable_id` is consumed (Finding 2) — in memory AND durably
    ///    (round 6), only AFTER the durable commit accepted, so a refused
    ///    claim consumes nothing;
    /// 3. the ledger kill fence of each consumed placeholder alias is
    ///    cleared too (the reopened identity's every known alias reopens
    ///    with it).
    ///
    /// Round 6 (focused-ep5-r5 Finding 2): `through_placeholders` names the
    /// one-shot pane-seat placeholders the claim's identity resolves through
    /// (the attach lane's attaching seat; the create lane's just-minted id).
    /// The consult rides INSIDE the ledger's conditional transition
    /// ([`PaneIdentitySink::commit_claim_aliased`]): a close fence recorded
    /// under ANY of them blocks the commit exactly like one recorded under
    /// the durable id — this is what makes a phantom post-restart attach
    /// (the pane's close fenced only the placeholder the slow resume never
    /// re-registered) refuse instead of reviving and re-registering a
    /// session for a pane that no longer exists.
    ///
    /// Returns true iff the claim committed. An `Err` from the commit (io
    /// failure deciding or writing) provably left the durable close
    /// untouched (round 5, focused-ep5-r4 Finding 5 — the ledger commit's
    /// crash-atomic shape): warn-loud and report FALSE, consuming nothing —
    /// the caller tears the session down (kill wins; the round-3
    /// proceed-as-committed policy would run a live session over a durably
    /// Closed row). All OTHER binding-write lanes (fork children, crash
    /// respawns, in-stream adoptions) deliberately do NOT commit: none of
    /// them claims an identity a user just closed.
    async fn commit_session_claim(
        &self,
        durable_id: &str,
        expect_killed_at_ms: Option<i64>,
        through_placeholders: &[String],
    ) -> bool {
        let Some(sink) = self.identity_sink() else {
            return true;
        };
        // A create registers directly under its durable UUID. That key's
        // existing close is compared with the captured claim snapshot below;
        // only distinct legacy pane aliases use the unconditional seat fence.
        let through_placeholders: Vec<String> = through_placeholders
            .iter()
            .filter(|id| id.as_str() != durable_id)
            .cloned()
            .collect();
        match sink
            .commit_claim_aliased(
                PROVIDER,
                durable_id,
                expect_killed_at_ms,
                &through_placeholders,
            )
            .await
        {
            Ok(crate::identity_sink::ClaimCommit::Committed) => true,
            Ok(crate::identity_sink::ClaimCommit::RefusedStale) => {
                tracing::info!(target: "freshell_freshagent::claude",
                    durable = %durable_id,
                    "freshagent.claude.claim_refused_stale_dead_state: a close landed while \
                     this resume was in flight (or under the one-shot seat it rides); the \
                     claim commits nothing and the lane tears down"
                );
                return false;
            }
            Err(e) => {
                tracing::warn!(error = %e, session = %durable_id,
                    "freshagent.claude.claim_commit_failed: the durable close left the claim \
                     undecidable; the lane tears down and leaves the close standing");
                return false;
            }
        };
        let now = crate::session_lease::now_epoch_ms() as i64;
        let row_bound = self.alias_row_bound_probe();
        let mut cleared_aliases = self
            .alias_tombstones
            .lock()
            .expect("alias tombstones lock")
            .clear_for_durable(durable_id, now, &row_bound);
        // Round 6: the DURABLE half of the consumption — the accepted claim
        // consumes the persisted alias records too (restart-surviving
        // evidence), before their kill fences clear below.
        match sink
            .clear_alias_tombstones_for_durable(PROVIDER, durable_id)
            .await
        {
            Ok(persisted) => {
                for placeholder in persisted {
                    if !cleared_aliases.contains(&placeholder) {
                        cleared_aliases.push(placeholder);
                    }
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, session = %durable_id,
                    "freshagent.claude.alias_tombstone_consume_failed: persisted alias records \
                     left behind; the next claim re-consumes them");
            }
        }
        if !cleared_aliases.is_empty() {
            tracing::info!(target: "freshell_freshagent::claude",
                durable = %durable_id,
                aliases = ?cleared_aliases,
                "freshagent.claude.claim_consumed_alias_tombstones: the reopened \
                 identity can no longer be retired through the old placeholders"
            );
        }
        for alias in &cleared_aliases {
            if let Err(e) = sink.clear_kill_tombstone(PROVIDER, alias).await {
                tracing::warn!(error = %e, session = %alias, "freshagent.claude.alias_kill_tombstone_clear_failed");
            }
        }
        true
    }

    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 1): the claim's
    /// POST-REGISTRATION dead-state re-check — the same predicate as the
    /// ledger's `commit_claim` refusal. A kill QUEUED behind a successful
    /// commit (its decision pre-dated the kill) lands while this lane is
    /// between commit and registration; registration made the session
    /// kill-visible, and this re-validate is what closes that last edge: an
    /// advanced fence means the row was retired after our commit, so the
    /// registered session is a late orphan — the caller tears it down and
    /// leaves the row Retired. (The kill's own post-close sweep
    /// [`Self::sweep_late_claim_orphans`] covers the mirror order — the
    /// retire landing after this check returns.)
    fn claim_dead_state_advanced(&self, durable_id: &str, claim_dead_state: Option<i64>) -> bool {
        let current = self
            .identity_sink()
            .and_then(|sink| sink.kill_tombstone_at_ms(PROVIDER, durable_id));
        match (current, claim_dead_state) {
            (Some(cur), Some(exp)) => cur > exp,
            (Some(_), None) => true,
            (None, _) => false,
        }
    }

    /// Focused-ep5-r3 Finding 1: the claim attempt's dead-state snapshot,
    /// taken at claim START (before the spawn/resume awaits). Every claude
    /// claim lane reads it once and hands it to [`Self::commit_session_claim`]
    /// at commit time; a kill landing mid-claim advances the durable
    /// tombstone past it, and the commit then commits nothing.
    fn claim_dead_state_snapshot(&self, durable_id: &str) -> Option<i64> {
        self.identity_sink()
            .and_then(|sink| sink.kill_tombstone_at_ms(PROVIDER, durable_id))
    }

    /// The commit's inverse (retire-on-kill round 3, Finding 5's
    /// "re-raise/keep" arm): a claim whose lease was REVOKED at completion
    /// tears its freshly-spawned session back down — the identity is dead
    /// again, so the close's durable record is restored exactly:
    /// `retire_closed` re-raises the durable kill fence AND re-retires the
    /// row the commit revived (idempotent; no bound row re-retires to Ok).
    /// An older in-flight binding write of the prior epoch is fenced again,
    /// never a Bound resurrection.
    async fn rollback_session_claim(&self, durable_id: &str) {
        let Some(sink) = self.identity_sink() else {
            return;
        };
        if let Err(e) = sink.retire_closed(PROVIDER, durable_id).await {
            tracing::warn!(error = %e, session = %durable_id, "freshagent.claude.claim_rollback_failed");
        }
    }

    /// Focused-ep5-r1 Finding 1 (retire-on-kill round 2): evict every live
    /// `cli_index` alias of this map key, DEMOTING each to the retained alias
    /// tombstones (`alias_tombstones`) instead of dropping it — so a later
    /// kill naming the bare placeholder resolves the durable row anyway. The
    /// ONE eviction funnel for the index (consumer exit, kill,
    /// lease-revoked teardown, rollback-fork teardown); the process-wide
    /// `shutdown` reset deliberately drops instead (in-memory state dies
    /// with the process — there is no later kill to serve). Returns the
    /// demoted durable ids (the consumer-exit lane reopens their leases).
    ///
    /// Round 5 (focused-ep5-r4 Finding 2): the alias-tombstone retention
    /// probe — the durable row's raw Bound state through the identity sink
    /// ([`PaneIdentitySink::row_is_bound`]. With no sink wired the probe
    /// answers false and retention falls back to the pre-round-5 TTL/cap
    /// regime (the sink is always wired in server builds; the alias records
    /// are in-memory best-effort there anyway).
    fn alias_row_bound_probe(&self) -> impl Fn(&str) -> bool + 'static {
        let sink = self.identity_sink();
        move |durable: &str| {
            sink.as_ref()
                .is_some_and(|s| s.row_is_bound(PROVIDER, durable))
        }
    }

    /// Focused-ep5-r1 Finding 1 (retire-on-kill round 2): evict every live
    /// `cli_index` alias of this map key, DEMOTING each to the retained alias
    /// tombstones (`alias_tombstones`) instead of dropping it — so a later
    /// kill naming the bare placeholder resolves the durable row anyway. The
    /// ONE eviction funnel for the index (consumer exit, kill,
    /// lease-revoked teardown, rollback-fork teardown); the process-wide
    /// `shutdown` reset deliberately drops instead (in-memory state dies
    /// with the process — there is no later kill to serve). Returns the
    /// demoted durable ids (the consumer-exit lane reopens their leases).
    ///
    /// Focused-ep5-r3 Finding 2 (retire-on-kill round 4): the demote and the
    /// remove are ONE CRITICAL SECTION — `cli_index` is HELD while the
    /// tombstone records land (lock order `cli_index` then
    /// `alias_tombstones`, exactly the order the kill's consult
    /// (`collect_kill_retire_ids`) takes them — no inversion exists:
    /// `alias_tombstones` is never acquired first anywhere). In the round-3
    /// shape (index released between the two map ops) a kill landing in the
    /// gap observed NEITHER the removed live alias NOR the not-yet-recorded
    /// tombstone and retired only the placeholder, leaving the durable Bound
    /// row recovery-eligible. No `await` inside the section (the std Mutex
    /// never crosses one).
    /// Round 6 (focused-ep5-r5 Finding 2): the demotion has a DURABLE half —
    /// the same records are re-stamped into the ledger's `alias-tombstones/`
    /// subtree (post-section: the lock discipline above stays synchronous),
    /// so the mapping outlives the process the way the close that needs it
    /// can outlast a restart. Warn-loud on failure, never a lane blocker
    /// (the in-memory record still answers this process's kills).
    async fn evict_cli_index_aliases(&self, map_key: &str) -> Vec<String> {
        let now = crate::session_lease::now_epoch_ms() as i64;
        let row_bound = self.alias_row_bound_probe();
        let demoted: Vec<String> = {
            // The ONE critical section (lock order cli_index →
            // alias_tombstones, no await inside — the std-mutex guard never
            // crosses an await; the block scopes strictly so).
            let mut index = self.cli_index.lock().await;
            let mut tombstones = self.alias_tombstones.lock().expect("alias tombstones lock");
            let mut demoted: Vec<String> = Vec::new();
            index.retain(|durable, mapped| {
                if mapped == map_key {
                    demoted.push(durable.clone());
                    false
                } else {
                    true
                }
            });
            for durable in demoted.iter().filter(|durable| durable.as_str() != map_key) {
                tombstones.record(map_key, durable, now, &row_bound);
            }
            demoted
        };
        if !demoted.is_empty() {
            if let Some(sink) = self.identity_sink() {
                for durable in demoted.iter().filter(|durable| durable.as_str() != map_key) {
                    if let Err(e) = sink
                        .record_alias_tombstone(PROVIDER, map_key, durable, now)
                        .await
                    {
                        tracing::warn!(error = %e, session = %durable, placeholder = %map_key,
                            "freshagent.claude.alias_tombstone_write_failed");
                    }
                }
            }
        }
        demoted
    }

    // ── freshAgent.interrupt (WS) ────────────────────────────────────────────

    /// Handle a `freshAgent.interrupt` (the user's Stop) for claude/kilroy (design
    /// §5.4, C18). A session with nothing owed has nothing to stop: nothing is
    /// sent (logged `freshagent.claude.stop` outcome `idle`). Otherwise the
    /// session's turn ledger latches the Stop on one target (the running turn,
    /// else the oldest command the CLI has not started, else the turn the CLI
    /// runs by itself; commands queued behind the running turn are not targets)
    /// and the interrupt is written with the latch's `stopId`. The stopped turn's
    /// own result is then silent; every other turn end rings. A Stop that missed
    /// a command the CLI was still starting is sent again by the stdout consumer
    /// ([`Self::reissue_stop`]). Success broadcasts nothing. A dead session
    /// repeats its exited status; an unknown one reports a nested session error.
    pub async fn handle_interrupt(&self, msg: FreshAgentInterrupt) {
        let session_id = msg.session_id.clone();
        if let Some(map_key) = self.resolve_session_key(&session_id).await {
            if self
                .stop_live_session(
                    &map_key,
                    session_type_str(msg.session_type),
                    &msg.request_id,
                )
                .await
            {
                return;
            }
        }
        if self.dead_sessions.find(&session_id).is_some() {
            self.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
                provider: PROVIDER.into(),
                session_id: session_id.clone(),
                session_type: session_type_str(msg.session_type).into(),
                event: crate::claude_dead_sessions::exited_status_event(&session_id),
            }));
        } else {
            self.emit_control_error(
                &session_id,
                msg.session_type,
                &msg.request_id,
                "INVALID_SESSION_ID",
                "The Claude conversation for this session could not be found.",
            );
        }
    }

    // ── freshAgent.send (WS) ─────────────────────────────────────────────────────────

    /// The session `wire_id` names, with what a turn-locked request needs from
    /// it: its map key, turn lock, turn ledger and durable id. `None` when no
    /// live session answers to `wire_id`.
    async fn turn_locked_handles(
        &self,
        wire_id: &str,
    ) -> Option<(
        String,
        Arc<TokioMutex<()>>,
        crate::claude_turns::SharedLedger,
        Option<String>,
        deadman::SharedQuiet,
    )> {
        let key = self.resolve_session_key(wire_id).await?;
        let sessions = self.sessions.lock().await;
        let session = sessions.get(&key)?;
        Some((
            key,
            session.turn_lock.clone(),
            session.ledger.clone(),
            session.cli_session_id.clone(),
            session.quiet.state.clone(),
        ))
    }

    /// The live session a request (`op`) resolved before it waited on
    /// `turn_lock`, after the wait (design §3.3, §4.5 and §4.8): the same map
    /// key while it is still registered; else, when an undo or redo replaced
    /// that runtime while the request waited, the live end of the durable
    /// ledger chain from the session's durable id (`durable`), then the wire
    /// id's own resolution. Only a session that took this very lock over
    /// counts: a request never lands on a runtime it did not serialize behind.
    /// Every request the turn lock serializes (send, configure, compact, fork)
    /// re-resolves through here.
    pub(super) async fn live_key_after_turn_wait(
        &self,
        op: TurnLockedRequest,
        map_key: &str,
        wire_id: &str,
        durable: Option<&str>,
        turn_lock: &Arc<TokioMutex<()>>,
    ) -> Option<String> {
        if self.sessions.lock().await.contains_key(map_key) {
            return Some(map_key.to_string());
        }
        let terminus = durable.and_then(|durable| {
            self.identity_sink()
                .and_then(|sink| sink.chain_terminus(PROVIDER, durable))
        });
        let candidates = terminus.iter().map(String::as_str).chain([wire_id]);
        for candidate in candidates {
            let Some(key) = self.resolve_session_key(candidate).await else {
                continue;
            };
            let same_lock = self
                .sessions
                .lock()
                .await
                .get(&key)
                .is_some_and(|session| Arc::ptr_eq(&session.turn_lock, turn_lock));
            if same_lock {
                tracing::info!(target: "freshell_freshagent::claude",
                    event = op.followed_replacement_event(),
                    session_id = %wire_id,
                    replaced = %map_key,
                    replacement = %key,
                    through_ledger_chain = terminus.as_deref() == Some(candidate),
                    "a request that waited behind a rollback goes to the replacement runtime"
                );
                return Some(key);
            }
        }
        None
    }

    /// Handle a `freshAgent.send` for claude: push the user turn into the sidecar's SDK
    /// input stream, then broadcast `freshAgent.send.accepted`. The stdout consumer rings
    /// the turn's end itself (`freshAgent.turn.complete` for every result except the one
    /// the user's own Stop landed on: the turn ledger's verdict, C18).
    ///
    /// C16: the send carries a uuid minted here. The sidecar puts it on the SDK user
    /// message, so the CLI writes the user line with it: it is the `submittedTurnId` of
    /// `freshAgent.send.accepted` and the `turnId` the snapshot shows for the message
    /// (a send absorbed into a running tool call has no user line of its own, T10).
    /// The answer is also returned ([`ClaudeSendOutcome`], design §9.3 I2): `Accepted`
    /// once the sidecar has the send, `Refused` with the request error's code otherwise.
    /// A send the sidecar refuses later (a bad image) is taken back by the stdout
    /// consumer ([`Self::take_back_rejected_send`]).
    pub async fn handle_send(&self, msg: FreshAgentSend) -> ClaudeSendOutcome {
        let request_id = msg.request_id.clone();
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);

        // The checkpoint barrier can park this send while the captured
        // workspace is saved. Parse and retain the pane's ownership fence so
        // that a close, handoff, or reattach during that wait cannot redirect
        // the delayed prompt to a different owner of the same session id.
        let send_fence =
            match crate::ownership_lane::wire_fence(msg.observed_epoch, msg.observed_generation) {
                Ok(fence) => fence,
                Err(err) => return self.refuse_send(&request_id, err.code(), err.message()),
            };

        let resolved = match self
            .ensure_runtime(
                &session_id,
                msg.session_type,
                msg.cwd.as_deref(),
                send_fence,
            )
            .await
        {
            Ok(key) => key,
            Err(error) => {
                return self.refuse_runtime_resume(
                    &request_id,
                    &session_id,
                    msg.session_type,
                    error,
                )
            }
        };
        let Some((map_key, turn_lock, ledger, durable_before_wait, quiet)) =
            self.turn_locked_handles(&resolved).await
        else {
            return self.refuse_send_after_runtime_stopped(
                &request_id,
                &session_id,
                msg.session_type,
            );
        };
        // r2 serialization discipline: hold the session turn lock across the
        // busy-set AND the sidecar write — the check-then-set window vs
        // `handle_rollback`'s busy gate is closed (a rollback holding this lock
        // observes either no-send or a fully-marked in-flight turn).
        let _turn = turn_lock.lock().await;
        // An undo or redo that held this lock may have replaced the runtime
        // the send resolved (C13: the replacement registers under its own id
        // and takes this same lock over). The send goes to the replacement,
        // found through the durable supersession chain, never to the stopped
        // original and never to a revived one.
        let Some(map_key) = self
            .live_key_after_turn_wait(
                TurnLockedRequest::Send,
                &map_key,
                &session_id,
                durable_before_wait.as_deref(),
                &turn_lock,
            )
            .await
        else {
            return self.refuse_send_after_runtime_stopped(
                &request_id,
                &session_id,
                msg.session_type,
            );
        };
        // Arm the coordinator guard only after the send has waited behind any
        // earlier turn. A lifecycle transition during that wait advances the
        // generation, so the captured fence is checked against the owner that
        // will actually receive this prompt. Checkpointed sends go through the
        // guard when the coordinator is wired, and any supplied fence is
        // honored; ordinary legacy sends keep their existing unfenced
        // behavior. The fence keys on the record that owns the session (its
        // durable id once reported), never on a new pane's placeholder wire id
        // (`send_owner_key`). The one exception is `send_owner_key`'s: an
        // unfenced send to a session the CLI has not reported and the
        // coordinator holds no record for (a new pane's first message) runs
        // unguarded. A lane without a coordinator (the session host's) has
        // nothing to fence.
        let fenced = msg.checkpoint_intent.is_some() || send_fence.is_some();
        let ownership_guard = if fenced && self.ownership.is_some() {
            if let Some(owner_key) = self.send_owner_key(&map_key, &session_id, send_fence).await {
                match crate::ownership_lane::arm_reclaimless_op_guard(
                    &self.ownership,
                    PROVIDER,
                    &owner_key,
                    &format!("send-{}", uuid::Uuid::new_v4()),
                    send_fence,
                    "freshclaude/send",
                ) {
                    crate::ownership_lane::LaneOpGuard::Armed(guard) => Some(guard),
                    crate::ownership_lane::LaneOpGuard::Unwired => None,
                    crate::ownership_lane::LaneOpGuard::Refused { message, owner } => {
                        tracing::warn!(target: "freshell_freshagent::claude",
                        session_id = %session_id, owner_key = %owner_key,
                        request_id = ?request_id,
                        "fresh_agent_send_refused: ownership guard refused");
                        return self.refuse_reserved_send(&request_id, &message, owner);
                    }
                }
            } else {
                // Nothing owns the session in the coordinator yet and the send
                // names no owner: the CLI reports the session only once a
                // prompt runs (T1), and this send is what makes it run.
                // Refusing it would refuse every new pane's first message.
                tracing::debug!(target: "freshell_freshagent::claude",
                    session_id = %session_id, request_id = ?request_id,
                    event = "freshagent.claude.send_before_session_report",
                    "the send runs unfenced: the CLI has not reported the session yet \
                     and the coordinator holds no record for it");
                None
            }
        } else {
            None
        };
        if let Some(settings) = msg.settings.as_ref() {
            // kata z7j7: sandbox has NO claude-side concept — when it arrives on
            // a send, log observably (id + boolean flag only, never the prompt
            // text) instead of silently dropping. The scope advertisement
            // already says `unsupported`; this closes the silent-drop path.
            if settings.sandbox.is_some() {
                tracing::info!(
                    session_id = %session_id,
                    has_sandbox = %true,
                    "freshagent.claude.unsupported-settings-ignored"
                );
            }
            // Convergence (restored from bf9b8d31a, dropped in the ext-r8
            // handle_send rework): capture the pre-configure pair so a send
            // whose settings CHANGED the live session can converge every
            // device's model surfaces — the same frame `handle_configure`
            // emits (a device that missed the configure still lands here).
            let settings_before = self.stated_settings(&map_key).await;
            if let Err(err) = self
                .configure_for_send(&map_key, settings, session_type)
                .await
            {
                return self.refuse_send(&request_id, "CLAUDE_SETTINGS_FAILED", &err);
            }
            let settings_after = self.stated_settings(&map_key).await;
            if settings_before != settings_after {
                self.broadcast_stated_settings(
                    session_type,
                    &session_id,
                    settings_after.unwrap_or_default(),
                );
            }
        }
        // Task 4 review (C1b): the destroy target comes from POST-lock session
        // state — a rollback holding this lock may have RE-KEYED the durable id
        // (the rollback-row MOVE old→new) while we parked. Keying the destroy by
        // the pre-MOVE id would no-op `destroy_redo_on_submit` and leak redo
        // (decision 5): `destroy_redo_on_submit` keys the record by its CURRENT
        // durable id, i.e. the session record's `cli_session_id` after the
        // adoption re-key. A bare pre-init placeholder can have no rollback
        // record — the addressed canonical id is its only possible key then.
        let destroy_target = {
            let guard = self.sessions.lock().await;
            match guard.get(&map_key) {
                Some(s) => s.cli_session_id.clone().or_else(|| {
                    if is_canonical_claude_uuid(&session_id) {
                        Some(session_id.clone())
                    } else {
                        None
                    }
                }),
                None => {
                    drop(guard);
                    return self.refuse_send_after_runtime_stopped(
                        &request_id,
                        &session_id,
                        msg.session_type,
                    );
                }
            }
        };
        if let Some(durable) = destroy_target.as_deref() {
            // Decision 5: any new submission permanently destroys redo (the
            // redo-capable chain state only — the marker union is never touched).
            // AWAITED before the turn goes out; a ledger failure is warn-only
            // (never blocks the send).
            if let Some(err) = crate::rollback_record::destroy_redo_on_submit(
                &self.identity_sink(),
                PROVIDER,
                durable,
                crate::rollback_record::now_ms(),
            )
            .await
            {
                tracing::warn!(error = %err, session = %durable, "freshagent.claude.destroy_redo_on_submit_failed");
            }
        }
        // C17: arm the ledger UNDER the turn lock, BEFORE the sidecar write
        // (the CLI's lifecycle for the send, or the sidecar's refusal, can come
        // back before this handler runs again; a rollback holding this lock
        // observes either no send or an armed one). The session reads
        // `running` from the accept on.
        let submitted_turn_id = crate::claude_turns::mint_send_uuid();
        let stamp = self.envelope_stamp(&map_key).await;
        ledger.lock().expect("turn ledger lock").arm(
            submitted_turn_id.clone(),
            request_id.clone(),
            crate::claude_turns::SendKind::Turn,
        );
        self.arm_claude_quiet(&map_key, &ledger).await;
        self.publish_claude_status(&ledger, &quiet, &stamp, session_type, false);
        let guard = self.sessions.lock().await;
        let Some(session) = guard.get(&map_key) else {
            drop(guard);
            self.take_back_unwritten_send(
                &ledger,
                &quiet,
                &stamp,
                session_type,
                &submitted_turn_id,
            );
            return self.refuse_send_after_runtime_stopped(
                &request_id,
                &session_id,
                msg.session_type,
            );
        };
        // Address the sidecar by ITS id for this session (== the map key for created
        // sessions; differs for resumed-on-attach sessions, Task 6).
        let mut send_req = json!({
            "type": "send",
            "sessionId": session.sidecar_session_id,
            "uuid": submitted_turn_id,
            "text": msg.text,
        });
        let writer = session.stdin.clone();
        let ownership_id = session.ownership_id.clone();
        drop(guard);
        if let Some(attempt) = checkpoint_attempt_for_send(&msg) {
            send_req["checkpointAttempt"] = attempt;
        }
        if let Some(images) = msg.images {
            send_req["images"] = json!(images);
        }
        if let Err(err) = writer.write(&send_req).await {
            // The write never went out: take back exactly this send (whatever
            // else is owed stays).
            self.take_back_unwritten_send(
                &ledger,
                &quiet,
                &stamp,
                session_type,
                &submitted_turn_id,
            );
            return self.refuse_send(&request_id, "CLAUDE_SEND_FAILED", &err);
        }
        drop(ownership_guard);

        // Unified agent names (Task 4): the shared accepted-input callback —
        // the send reached the sidecar, so the user input is ACCEPTED. The
        // naming target is the stashed pre-durable handle when one exists
        // (it redirects to the bound durable record once adopted), else
        // the adopted durable claude session, else — review N1 — the
        // pending ref for the ADDRESSED id itself: a send racing the init
        // adoption (the stash entry just consumed by the bound cleanup,
        // the addressed id still the placeholder) must never silently
        // drop the feed; the store's redirect resolution decides, and
        // the next send addresses the adopted id anyway. Kilroy is out
        // of scope; a failed feed never blocks the turn.
        //
        // Task 8 acceptance: once the init ADOPTION consumed the stash and
        // recorded the session's durable `cli_session_id`, a placeholder-
        // addressed send targets the ADOPTED durable record — the old
        // pending-<placeholder> fallback can never resolve in the real
        // store (no record is keyed by a placeholder id), and the
        // first-message fallback upgrade was silently lost for exactly
        // these sends.
        let naming_target = {
            // Sequential lock reads (never nested): the pre-durable stash,
            // then the session row's adopted durable id.
            let stashed_handle = self.naming_handles.lock().await.get(&session_id).cloned();
            let adopted_cli_id = self
                .sessions
                .lock()
                .await
                .get(&map_key)
                .and_then(|s| s.cli_session_id.clone());
            stashed_handle
                .map(
                    |handle| freshell_protocol::session_names::SessionNameRef::Pending {
                        id: handle,
                    },
                )
                .or_else(|| {
                    adopted_cli_id.map(|cli_id| {
                        freshell_protocol::session_names::SessionNameRef::Session {
                            provider: freshell_protocol::session_names::NamedProvider::Claude,
                            session_id: cli_id,
                        }
                    })
                })
                .or_else(|| {
                    is_canonical_claude_uuid(&session_id).then(|| {
                        freshell_protocol::session_names::SessionNameRef::Session {
                            provider: freshell_protocol::session_names::NamedProvider::Claude,
                            session_id: session_id.clone(),
                        }
                    })
                })
                .or_else(|| {
                    Some(freshell_protocol::session_names::SessionNameRef::Pending {
                        id: session_id.clone(),
                    })
                })
        };
        if session_type != "kilroy" {
            if let Some(target) = naming_target {
                crate::naming::report_accepted_input(
                    &self.naming(),
                    &target,
                    session_type,
                    request_id.as_deref().unwrap_or(""),
                    &msg.text,
                    msg.cwd.as_deref(),
                )
                .await;
            }
        }

        self.broadcast(&ServerMessage::FreshAgentSendAccepted(
            FreshAgentSendAccepted {
                provider: PROVIDER.to_string(),
                request_id: request_id.unwrap_or_default(),
                session_id,
                session_type: session_type.to_string(),
                cwd: msg.cwd,
                submitted_turn_id: Some(submitted_turn_id.clone()),
            },
        ));
        ClaudeSendOutcome::Accepted {
            session_key: map_key,
            submitted_turn_id,
            ownership_id,
        }
    }

    /// The caller owns the session turn lock. Apply changed settings before any
    /// send bookkeeping or text delivery, preserving an unsent prompt on failure.
    async fn configure_for_send(
        &self,
        map_key: &str,
        requested: &freshell_protocol::FreshAgentSendSettings,
        session_type: &str,
    ) -> Result<(), String> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (response, next, writer, frame, ownership_id) = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions
                .get_mut(map_key)
                .ok_or("Claude session is no longer available.")?;
            let next = recovery::updated_settings(
                &session.configuration.settings,
                requested,
                session.configuration.runtime_cwd.as_deref(),
            );
            if next == session.configuration.settings && !session.configuration.needs_configure {
                return Ok(());
            }
            if session.ledger.lock().expect("turn ledger lock").busy() {
                return Err(
                    "Wait for the current turn to finish before changing agent settings.".into(),
                );
            }
            let (tx, rx) = tokio::sync::oneshot::channel();
            session.configuration.pending = Some((request_id.clone(), tx));
            let frame = json!({
                "type": "configure", "sessionId": session.sidecar_session_id,
                "requestId": request_id, "settings": {
                    "model": next.model, "effort": next.effort,
                    "permissionMode": next.permission_mode, "cwd": next.cwd,
                },
            });
            (
                rx,
                next,
                session.stdin.clone(),
                frame,
                session.ownership_id.clone(),
            )
        };
        if let Err(err) = writer.write(&frame).await {
            if let Some(session) = self.sessions.lock().await.get_mut(map_key) {
                if session
                    .configuration
                    .pending
                    .as_ref()
                    .is_some_and(|(id, _)| id == &request_id)
                {
                    session.configuration.pending = None;
                }
            }
            return Err(err);
        }
        let applied = match tokio::time::timeout(SIDECAR_CREATE_BUDGET, response).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => {
                Err("Claude stopped while applying settings. Your message was not sent.".into())
            }
            Err(_) => Err(
                "Claude did not finish applying settings. Your message was not sent; try again."
                    .into(),
            ),
        };
        let (durable, effective) = {
            let mut sessions = self.sessions.lock().await;
            let session = sessions
                .get_mut(map_key)
                .ok_or("Claude session is no longer available.")?;
            if session.ownership_id != ownership_id {
                return Err(
                    "Claude changed while applying settings. Your message was not sent; try again."
                        .into(),
                );
            }
            session.configuration.pending = None;
            session.configuration.needs_configure = applied.is_err();
            if applied.is_ok() {
                session.configuration.settings = next;
            }
            // A setter can succeed before a later setter rejects. The receipt
            // reconciles that partial success; persist the actual runtime state
            // even though the user's prompt must remain unsent.
            (
                session.cli_session_id.clone(),
                session.configuration.settings.clone(),
            )
        };
        if let Some(durable) = durable {
            self.adopt_session_init(
                &durable,
                map_key,
                session_type,
                Some(&effective),
                self.identity_sink(),
                // Settings-apply is conn-less from the pane's perspective: not a
                // browser assertion — the ledger merge keeps the row's prior
                // stamps (ep4 writer rules).
                None,
            )
            .await;
        }
        applied
    }

    pub async fn handle_configure(&self, msg: FreshAgentConfigure) {
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);
        let request_id = msg.request_id.clone();

        // kata z7j7: sandbox has NO claude-side concept — log observably
        // (id + boolean flag only), mirroring the send path's arm.
        if msg.settings.sandbox.is_some() {
            tracing::info!(
                session_id = %session_id,
                has_sandbox = true,
                "freshagent.claude.configure-unsupported-settings-ignored"
            );
        }

        let resolved = match self.configure_without_runtime(&msg).await {
            Ok(recovery::ConfigurationTarget::Stored) => return,
            Ok(recovery::ConfigurationTarget::Live(key)) => key,
            Err(error) => {
                self.emit_resume_control_error(&session_id, msg.session_type, &request_id, error);
                return;
            }
        };
        let Some((map_key, turn_lock, _, durable_before_wait, _)) =
            self.turn_locked_handles(&resolved).await
        else {
            self.emit_control_error(
                &session_id,
                msg.session_type,
                &request_id,
                "CLAUDE_SETTINGS_FAILED",
                "Claude stopped before applying settings. Try again.",
            );
            return;
        };
        let _turn = turn_lock.lock().await;
        // An undo or redo that held this lock may have replaced the runtime
        // (C13): the setting applies to the replacement the pane now shows,
        // never to the retired original.
        let Some(live_key) = self
            .live_key_after_turn_wait(
                TurnLockedRequest::Configure,
                &map_key,
                &session_id,
                durable_before_wait.as_deref(),
                &turn_lock,
            )
            .await
        else {
            self.emit_control_error(
                &session_id,
                msg.session_type,
                &request_id,
                "CLAUDE_SETTINGS_FAILED",
                "Claude stopped before applying settings. Try again.",
            );
            return;
        };
        // The pane follows a replacement through its `materialized` re-key, so
        // it then knows the session by the replacement's id.
        let session_id = if live_key == map_key {
            session_id
        } else {
            live_key.clone()
        };
        let map_key = live_key;

        let before = self.stated_settings(&map_key).await;
        if let Err(err) = self
            .configure_for_send(&map_key, &msg.settings, session_type)
            .await
        {
            // The refusal/failure is user-facing session state (busy turn,
            // sidecar death): the pane banner is the surface, on every device.
            self.emit_control_error(
                &session_id,
                msg.session_type,
                &request_id,
                "CLAUDE_SETTINGS_FAILED",
                &err,
            );
            return;
        }
        let after = self.stated_settings(&map_key).await;
        if before == after {
            // Idempotent configure: nothing to converge.
            return;
        }
        // Broadcast keyed at the CLIENT-ADDRESSED id (the id the configure
        // named): the client's fold resolves the sessions-map entry by it.
        self.broadcast_stated_settings(session_type, &session_id, after.unwrap_or_default());
    }

    /// The settings a `freshAgent.session.metadata` frame states for the
    /// session under `map_key` (`None` when it is gone): model, effort and
    /// permission mode. The configure and send paths diff these around an
    /// apply and broadcast only a change.
    async fn stated_settings(&self, map_key: &str) -> Option<StatedSettings> {
        let guard = self.sessions.lock().await;
        guard.get(map_key).map(|session| {
            let settings = &session.configuration.settings;
            StatedSettings {
                model: settings.model.clone(),
                effort: settings.effort.clone(),
                permission_mode: settings.permission_mode.clone(),
            }
        })
    }

    /// Converge every device's settings surfaces on `stated`.
    fn broadcast_stated_settings(
        &self,
        session_type: &str,
        session_id: &str,
        stated: StatedSettings,
    ) {
        self.broadcast(&crate::session_metadata::session_metadata_frame(
            PROVIDER,
            session_type,
            session_id,
            stated.model.as_deref(),
            stated.effort.as_deref(),
            stated.permission_mode.as_deref(),
        ));
    }

    // ── freshAgent.approval.respond / question.respond / compact (WS, Task 2) ─────────

    /// The shared Task 2 handler prologue: resolve the client-addressed id to the
    /// sessions-map key (`resolve_session_key` discipline — map key OR durable UUID via
    /// `cli_index`) and clone session handles for the sidecar write. A miss at
    /// either step broadcasts the nested `INVALID_SESSION_ID` lost-session envelope
    /// (engaging the client's recovery) and yields `None`.
    async fn response_session(
        &self,
        session_id: &str,
        session_type: SessionType,
    ) -> Option<ResponseSession> {
        let Some(map_key) = self.resolve_session_key(session_id).await else {
            self.broadcast(&lost_session_frame(session_id, session_type));
            return None;
        };
        let guard = self.sessions.lock().await;
        let Some(session) = guard.get(&map_key) else {
            drop(guard);
            self.broadcast(&lost_session_frame(session_id, session_type));
            return None;
        };
        Some(ResponseSession {
            map_key,
            ownership_id: session.ownership_id.clone(),
            stdin: session.stdin.clone(),
            sidecar_session_id: session.sidecar_session_id.clone(),
            pending: session.pending.clone(),
        })
    }

    /// Handle a `freshAgent.approval.respond` for claude/kilroy: forward a
    /// `permission.respond` request to the owned sidecar with the decision payload
    /// VERBATIM (a defined `updatedInput` wholesale replaces tool input — never
    /// synthesize one), resolving the parked SDK promise (`permission-channel.mjs
    /// respondPermission`). Every failure answers on the NESTED
    /// `freshAgent.event{freshAgent.error}` envelope (the client only surfaces top-level
    /// errors correlated with a pending send, which these control frames never
    /// establish): unknown session → `INVALID_SESSION_ID` (engages the lost-session
    /// recovery); a requestId outside the pending set → `INTERNAL_ERROR` with the parity
    /// message (`adapter.ts:192`). WRITE-THEN-REMOVE (fresh-eyes F3): the pending entry
    /// is removed only after the sidecar write's flush succeeds, so a failed write
    /// leaves the card actionable (the user can retry) — never clear-then-fail.
    pub async fn handle_approval_respond(&self, msg: FreshAgentApprovalRespond) {
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);
        let request_id = request_id_string(&msg.request_id);

        let Some(session) = self.response_session(&session_id, msg.session_type).await else {
            return;
        };
        if !session
            .pending
            .lock()
            .expect("pending lock")
            .permissions
            .iter()
            .any(|p| p.request_id == request_id)
        {
            drop(session);
            self.emit_fresh_agent_error(
                &session_id,
                session_type,
                "INTERNAL_ERROR",
                &format!("Claude approval {request_id} is not available"),
            );
            return;
        }
        // D2-M3 (delta-review round 2): the shared protocol requires the decision to
        // be a RECORD (`Record<string, unknown>`) and the sidecar resolves it VERBATIM
        // (`permission-channel.mjs` treats a null decision as a no-op), so forwarding
        // a null/array/scalar and removing the entry would hide the card while the
        // parked SDK promise stays unresolved forever (no retry, no resolve — the turn
        // wedges). Refuse LOUDLY and leave the entry pending: DO NOT forward, DO NOT
        // remove.
        if !msg.decision.is_object() {
            drop(session);
            self.emit_fresh_agent_error(
                &session_id,
                session_type,
                "INTERNAL_ERROR",
                &format!("Claude approval {request_id} requires a JSON object decision"),
            );
            return;
        }
        // Client-alerts G20: the decision's `updatedPermissions` (the CLI's own
        // suggestions the user accepted) reaches the CLI verbatim, so a malformed
        // one would fail or misapply the user's choice there. Refuse it with the
        // same discipline as above: nothing forwarded, the request stays pending.
        // The refusal names the failing update by position and variant only, so
        // neither the log nor the error frame carries a rule's content.
        if let Err(refusal) = crate::claude_permission_update::validate_decision(&msg.decision) {
            drop(session);
            tracing::warn!(
                target: "freshell_freshagent::claude",
                event = "freshagent.claude.approval_decision_refused",
                provider = PROVIDER,
                session_id = %session_id,
                session_type,
                request_id = %request_id,
                update_index = refusal.update_index(),
                update_type = refusal.update_type(),
                "a claude approval decision carried malformed permission updates; nothing was sent"
            );
            self.emit_fresh_agent_error(
                &session_id,
                session_type,
                "INVALID_APPROVAL_DECISION",
                &format!("Claude approval {request_id} was not sent: {refusal}"),
            );
            return;
        }
        // Address the sidecar by ITS id for this session (== the map key for created
        // sessions; differs for resumed-on-attach sessions, Task 6).
        let respond_req = json!({
            "type": "permission.respond",
            "sessionId": session.sidecar_session_id,
            "requestId": request_id,
            "decision": msg.decision,
        });
        if let Err(err) = session.stdin.write(&respond_req).await {
            drop(session);
            self.emit_fresh_agent_error(&session_id, session_type, "INTERNAL_ERROR", &err);
            return;
        }
        self.complete_pending_response(&session, &request_id, PendingResponse::Approval)
            .await;
    }

    /// Handle a `freshAgent.question.respond` for claude/kilroy: identical ordering
    /// discipline to [`Self::handle_approval_respond`]; the frame is
    /// `question.respond` with the answers as a JSON object (the sidecar wraps them
    /// into the SDK-shaped `updatedInput`, `permission-channel.mjs respondQuestion`).
    pub async fn handle_question_respond(&self, msg: FreshAgentQuestionRespond) {
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);
        let request_id = request_id_string(&msg.request_id);

        let Some(session) = self.response_session(&session_id, msg.session_type).await else {
            return;
        };
        if !session
            .pending
            .lock()
            .expect("pending lock")
            .questions
            .iter()
            .any(|q| q.request_id == request_id)
        {
            drop(session);
            self.emit_fresh_agent_error(
                &session_id,
                session_type,
                "INTERNAL_ERROR",
                &format!("Claude question {request_id} is not available"),
            );
            return;
        }
        let answers: Map<String, Value> = msg
            .answers
            .into_iter()
            .map(|(k, v)| (k, Value::String(v)))
            .collect();
        let respond_req = json!({
            "type": "question.respond",
            "sessionId": session.sidecar_session_id,
            "requestId": request_id,
            "answers": Value::Object(answers),
        });
        if let Err(err) = session.stdin.write(&respond_req).await {
            drop(session);
            self.emit_fresh_agent_error(&session_id, session_type, "INTERNAL_ERROR", &err);
            return;
        }
        self.complete_pending_response(&session, &request_id, PendingResponse::Question)
            .await;
    }

    /// Handle a `freshAgent.compact` for claude/kilroy: write the legacy adapter's plain
    /// user-turn shape (`adapter.ts:168-174`) — `/compact`, or `/compact <instructions
    /// trimmed>` when instructions are present. NO ack frame (compact does not reuse
    /// `handle_send`'s send.accepted broadcast; the turn is observable through the
    /// normal `sdk.*` stream).
    ///
    /// A compact is a command like any send (T15): the handler mirrors
    /// [`Self::handle_send`]. It takes the session `turn_lock` (an undo's
    /// replacement takes it over, and the compact follows the replacement) and
    /// arms the turn ledger with the compact's own uuid under the lock, before
    /// the sidecar write, so the rollback gate sees it from then on. The
    /// compact's own result settles it; a failed write takes back exactly it.
    pub async fn handle_compact(&self, msg: FreshAgentCompact) {
        let session_id = msg.session_id.clone();
        let session_type = session_type_str(msg.session_type);

        let fence =
            match crate::ownership_lane::wire_fence(msg.observed_epoch, msg.observed_generation) {
                Ok(fence) => fence,
                Err(error) => {
                    self.emit_control_error(
                        &session_id,
                        msg.session_type,
                        &msg.request_id,
                        error.code(),
                        error.message(),
                    );
                    return;
                }
            };
        let resolved = match self
            .ensure_runtime(&session_id, msg.session_type, msg.cwd.as_deref(), fence)
            .await
        {
            Ok(key) => key,
            Err(error) => {
                self.emit_resume_control_error(
                    &session_id,
                    msg.session_type,
                    &msg.request_id,
                    error,
                );
                return;
            }
        };
        let Some((map_key, turn_lock, ledger, durable_before_wait, quiet)) =
            self.turn_locked_handles(&resolved).await
        else {
            self.emit_control_error(
                &session_id,
                msg.session_type,
                &msg.request_id,
                "CLAUDE_COMPACT_FAILED",
                "Claude stopped before compaction. Try again.",
            );
            return;
        };
        // Held across the busy-set AND the sidecar write (the handle_send r2
        // serialization discipline) — a rollback holding this lock observes either
        // no-compact or a fully-marked in-flight compact turn.
        let _turn = turn_lock.lock().await;
        // An undo or redo that held this lock may have replaced the runtime
        // (C13): the compact runs on the replacement the pane now shows, which
        // took over this lock and the turn ledger.
        let Some(live_key) = self
            .live_key_after_turn_wait(
                TurnLockedRequest::Compact,
                &map_key,
                &session_id,
                durable_before_wait.as_deref(),
                &turn_lock,
            )
            .await
        else {
            self.emit_control_error(
                &session_id,
                msg.session_type,
                &msg.request_id,
                "CLAUDE_COMPACT_FAILED",
                "Claude stopped before compaction. Try again.",
            );
            return;
        };
        let session_id = if live_key == map_key {
            session_id
        } else {
            live_key.clone()
        };
        let map_key = live_key;
        let _ownership_guard = if fence.is_some() && self.ownership.is_some() {
            let owner_key = self.send_owner_key(&map_key, &session_id, fence).await;
            match crate::ownership_lane::arm_reclaimless_op_guard(
                &self.ownership,
                PROVIDER,
                owner_key.as_deref().unwrap_or(&map_key),
                &format!("compact-{}", uuid::Uuid::new_v4()),
                fence,
                "freshclaude/compact",
            ) {
                crate::ownership_lane::LaneOpGuard::Armed(guard) => Some(guard),
                crate::ownership_lane::LaneOpGuard::Unwired => None,
                crate::ownership_lane::LaneOpGuard::Refused { message, .. } => {
                    self.emit_control_error(
                        &session_id,
                        msg.session_type,
                        &msg.request_id,
                        "SESSION_RESERVED",
                        &message,
                    );
                    return;
                }
            }
        } else {
            None
        };
        // Arm before the write (as a send does): the compact is owed from now on.
        let uuid = crate::claude_turns::mint_send_uuid();
        let stamp = self.envelope_stamp(&map_key).await;
        ledger.lock().expect("turn ledger lock").arm(
            uuid.clone(),
            None,
            crate::claude_turns::SendKind::Compact,
        );
        self.arm_claude_quiet(&map_key, &ledger).await;
        self.publish_claude_status(&ledger, &quiet, &stamp, session_type, false);
        let guard = self.sessions.lock().await;
        let Some(session) = guard.get(&map_key) else {
            drop(guard);
            self.take_back_unwritten_send(&ledger, &quiet, &stamp, session_type, &uuid);
            self.emit_control_error(
                &session_id,
                msg.session_type,
                &msg.request_id,
                "CLAUDE_COMPACT_FAILED",
                "Claude stopped before compaction. Try again.",
            );
            return;
        };
        let text = match msg.instructions.as_deref().map(str::trim) {
            Some(instructions) if !instructions.is_empty() => {
                format!("/compact {instructions}")
            }
            _ => "/compact".to_string(),
        };
        // Address the sidecar by ITS id for this session (== the map key for created
        // sessions; differs for resumed-on-attach sessions, Task 6). A compact is a
        // command like any send: it carries its own uuid (C16).
        let send_req = json!({
            "type": "send",
            "sessionId": session.sidecar_session_id,
            "uuid": uuid,
            "text": text,
        });
        let writer = session.stdin.clone();
        drop(guard);
        if let Err(err) = writer.write(&send_req).await {
            // The write never went out: take back exactly this compact.
            self.take_back_unwritten_send(&ledger, &quiet, &stamp, session_type, &uuid);
            self.emit_control_error(
                &session_id,
                msg.session_type,
                &msg.request_id,
                "CLAUDE_COMPACT_FAILED",
                &err,
            );
        }
    }

    /// The session's live pending approvals + questions as overlay JSON (approvals,
    /// questions) — Task 3's snapshot route consumes this. Entry keys are exactly the
    /// `.strict()` contract shape (`{requestId, toolName?, toolUseID?, blockedPath?,
    /// decisionReason?, input?, suggestions?}` / `{requestId, questions}`, no extra
    /// keys, absent keys omitted). `any_id` resolves like every handler here: the map
    /// key OR the durable Claude UUID via `cli_index`. An untracked id yields two empty
    /// vecs.
    pub(crate) async fn snapshot_pending_overlay(&self, any_id: &str) -> (Vec<Value>, Vec<Value>) {
        let Some(map_key) = self.resolve_session_key(any_id).await else {
            return (Vec::new(), Vec::new());
        };
        let guard = self.sessions.lock().await;
        let Some(session) = guard.get(&map_key) else {
            return (Vec::new(), Vec::new());
        };
        let pending = session.pending.lock().expect("pending lock");
        let approvals = pending
            .permissions
            .iter()
            .map(PendingApprovalEntry::to_json)
            .collect();
        let questions = pending
            .questions
            .iter()
            .map(|q| json!({ "requestId": q.request_id, "questions": q.questions }))
            .collect();
        (approvals, questions)
    }

    /// Read the provider-owned transcript and apply this live runtime's pending
    /// request, settings, status, and rollback overlays. Session hosts use this
    /// read-only path for capture; it never consults web-owned pane state.
    pub async fn get_snapshot(
        &self,
        session_type: SessionType,
        thread_id: &str,
    ) -> Result<Value, String> {
        let mut snapshot = self
            .disk_snapshot(session_type_str(session_type), thread_id)
            .await
            .map_err(|error| match error {
                crate::claude_snapshot::ClaudeSnapshotError::NotFound => {
                    "claude session not found".to_string()
                }
                crate::claude_snapshot::ClaudeSnapshotError::Io(_) => {
                    "claude snapshot unavailable".to_string()
                }
            })?;
        let (approvals, questions) = self.snapshot_pending_overlay(thread_id).await;
        crate::claude_snapshot::apply_pending_overlay(&mut snapshot, approvals, questions);
        self.apply_snapshot_metadata(thread_id, &mut snapshot).await;
        Ok(snapshot)
    }

    /// Test seam (`test-support`, C09 rigs): the live-state overlay the snapshot
    /// route applies ([`Self::apply_snapshot_metadata`]), over an empty snapshot,
    /// for a test that checks the overlay alone (no transcript needed).
    #[cfg(any(test, feature = "test-support"))]
    pub async fn live_snapshot_overlay(&self, any_id: &str) -> Value {
        let mut snapshot = json!({});
        self.apply_snapshot_metadata(any_id, &mut snapshot).await;
        snapshot
    }

    /// The snapshot overlay from the server's own state: the live session's status,
    /// settings and commands, or, for a session whose sidecar ended unrequested,
    /// `exited` with the settings and commands it last had (C09, G05). Both are
    /// live-state truth (`statusFromLiveState`), so the client adopts the status.
    /// An id the server holds nothing for leaves the snapshot untouched.
    pub(crate) async fn apply_snapshot_metadata(&self, any_id: &str, snapshot: &mut Value) {
        let live = match self.resolve_session_key(any_id).await {
            Some(key) => self.sessions.lock().await.get(&key).map(|session| {
                (
                    session.current_status(),
                    session.configuration.settings.clone(),
                    session.configuration.commands.clone(),
                )
            }),
            None => None,
        };
        let (status, settings, commands) = match live {
            Some(live) => live,
            None => match self.dead_sessions.find(any_id) {
                Some(dead) => ("exited".to_string(), dead.settings, dead.commands),
                None => return,
            },
        };
        snapshot["status"] = json!(status);
        snapshot["extensions"]["claude"]["statusFromLiveState"] = json!(true);
        let mut fields = Map::new();
        for (key, value) in [
            ("model", &settings.model),
            ("effort", &settings.effort),
            ("permissionMode", &settings.permission_mode),
        ] {
            if let Some(value) = value {
                fields.insert(key.into(), json!(value));
            }
        }
        if !fields.is_empty() {
            snapshot["settings"] = Value::Object(fields);
        }
        if let Some(commands) = &commands {
            snapshot["commands"] = json!(commands);
        }
    }

    /// Kata 1wxv Task 5: the DURABLE rollback record for the snapshot route.
    /// The Task 4 handler keys the ledger row by the CURRENT durable id and
    /// re-keys it old→new inside the adoption write batch, so the record always
    /// lives under the live durable id. `any_id` resolves like every handler
    /// here (map key or durable UUID via `cli_index`); an UNTRACKED id (e.g. a
    /// disk-only read after a server restart) falls back to the raw id so a
    /// rolled-back session keeps its marked bucket without a live session.
    pub(crate) async fn load_rollback_record(
        &self,
        any_id: &str,
    ) -> Option<crate::rollback_record::RollbackRecord> {
        let durable = self.durable_session_id(any_id).await;
        self.identity_sink()
            .and_then(|s| s.load_rollback(PROVIDER, &durable))
    }

    /// Reconcile liveness probe (campaign §4.3, Task 13): resolve the DURABLE
    /// claude UUID through [`Self::cli_index`] to its sessions-map key, then
    /// check the map. The sessions map is read UNFILTERED — no session_type
    /// filter, so kilroy sessions count for free (V2 N-A17-1).
    pub async fn has_live_session(&self, session_id: &str) -> bool {
        let Some(key) = self.cli_index.lock().await.get(session_id).cloned() else {
            return false;
        };
        self.sessions.lock().await.contains_key(&key)
    }

    /// A runtime that disappears after a successful resolution is a transient
    /// failure. Only a clean transcript/genesis lookup can prove a conversation
    /// missing, so keep the user's prompt and allow another recovery attempt.
    fn refuse_send_after_runtime_stopped(
        &self,
        request_id: &Option<String>,
        session_id: &str,
        session_type: SessionType,
    ) -> ClaudeSendOutcome {
        self.refuse_runtime_resume(request_id, session_id, session_type,
            recovery::RuntimeResumeError::Unavailable {
                code: "CLAUDE_RUNTIME_UNAVAILABLE",
                message: "Claude stopped before accepting your message. Your message was not sent; try again.".into(),
                owner: None,
            })
    }

    pub(crate) async fn local_snapshot_owner(
        &self,
        native_id: &str,
    ) -> Option<freshell_ownership::OwnershipSnapshot> {
        let key = self.resolve_session_key(native_id).await?;
        let sessions = self.sessions.lock().await;
        let session = sessions.get(&key)?;
        let canonical = session.cli_session_id.as_deref().unwrap_or(native_id);
        crate::ownership_lane::current_local_snapshot_owner(
            &self.ownership,
            &self.ownership_stamps,
            PROVIDER,
            canonical,
            &key,
            session.child.id(),
        )
    }

    // ── freshAgent.undo / freshAgent.redo (kata 1wxv Task 4; fork-at-point) ────

    /// The pane re-key ride (kata 1wxv Task 4): the existing
    /// `freshAgent.session.materialized` broadcast shape (codex's mint-new respawn
    /// precedent), old client-facing id → new adopted durable id.
    /// Unified agent names: the frame carries the durable record's current
    /// projection — the pending→durable transfer commits in
    /// [`Self::adopt_session_init`] BEFORE this publishes the identity.
    async fn materialized_message(
        &self,
        old_id: &str,
        new_id: &str,
        session_type: &str,
    ) -> ServerMessage {
        let projection = if session_type == "kilroy" {
            None
        } else {
            crate::naming::session_projection(
                &self.naming(),
                freshell_protocol::session_names::NamedProvider::Claude,
                new_id,
            )
            .await
        };
        let name_ref = projection.as_ref().map(|(r, _)| r.clone());
        let session_name = projection.map(|(_, record)| record);
        let message = ServerMessage::FreshAgentSessionMaterialized(FreshAgentSessionMaterialized {
            previous_session_id: old_id.to_string(),
            provider: PROVIDER.to_string(),
            session_id: new_id.to_string(),
            session_type: session_type.to_string(),
            session_ref: Some(freshell_protocol::SessionLocator {
                provider: PROVIDER.to_string(),
                session_id: new_id.to_string(),
            }),
            name_ref,
            session_name,
        });
        self.edges.rekeyed(old_id, new_id);
        if let Ok(frame) = serde_json::to_string(&message) {
            if let Err(error) = self
                .checkpoint_event_sink
                .persist_before_broadcast(&frame, false)
                .await
            {
                tracing::error!(target: "freshell_freshagent::claude",
                    cause = %error,
                    "freshagent.claude.checkpoint_alias_persist_failed"
                );
            }
        }
        message
    }

    async fn broadcast_materialized(&self, old_id: &str, new_id: &str, session_type: &str) {
        let message = self
            .materialized_message(old_id, new_id, session_type)
            .await;
        self.broadcast(&message);
    }

    /// Resolve a client-addressed session id to the sessions-map key (Task 10b): the id
    /// itself when tracked, else through [`Self::cli_index`] (durable UUID -> map key).
    /// The map is never re-keyed (in-flight consumers hold the placeholder key);
    /// `cli_index` IS the alias table, so every map consumer works under BOTH keys.
    async fn resolve_session_key(&self, session_id: &str) -> Option<String> {
        if self.sessions.lock().await.contains_key(session_id) {
            return Some(session_id.to_string());
        }
        let mapped = self.cli_index.lock().await.get(session_id).cloned()?;
        self.sessions
            .lock()
            .await
            .contains_key(&mapped)
            .then_some(mapped)
    }

    /// The not-tracked resume (codex `ensure_session_resumable` analog, file-store
    /// flavored): boot decision (a found transcript resumes; a session with no
    /// transcript yet boots from its binding row's genesis, design §4.2) -> spawn
    /// sidecar with that boot -> register under the CLIENT's id -> idle snapshot. `lease_guard` (Task 13): the
    /// attach-path D8 lease -- the kill handle is armed after the spawn and the lease
    /// completed (bound to the map key) at registration; error paths tear down their
    /// own sidecar and leave the guard for the caller to `fail()`.
    async fn resume_for_attach(
        &self,
        msg: &FreshAgentAttach,
        claim: DurableClaim,
        lease_guard: &mut Option<crate::FreshSessionLeaseGuard>,
        // kata b8ke Task 3: the attach's coordinator claim ticket — committed
        // at the registration tail below; every error return leaves it armed
        // for the caller's drop (RAII typed fail).
        own_ticket: &mut Option<freshell_ownership::OperationTicket>,
        // b8ke focused episode-2 round-2 F2: the operation id of the
        // lifecycle op that OWNS this runtime's coordinator transition —
        // the attach's own claim, or the handoff runner's op for the
        // under-ticket target resume. Recorded on the session so the
        // session-init adoption's Blocked arm can correlate a blocking
        // coordinator state with the runtime being adopted (only the
        // runtime's OWN operation may proceed claim-free; an unrelated
        // blocker fails closed).
        owning_operation: Option<String>,
        // b8ke ext r27 F2: the GENERATION of the lifecycle op that owns
        // this runtime's coordinator transition (the handoff runner's
        // under-ticket target resume) — `owning_operation`'s numeric
        // twin, recorded on the session beside it. The session-init
        // adoption's durable binding write stamps the row with this
        // generation when the adoption holds no own ticket (the
        // under-ticket shape), so the target row carries the HANDOFF's
        // generation instead of preserving the prior one.
        handoff_generation: Option<u64>,
    ) -> Result<(), ResumeClaudeError> {
        let durable = claim.durable.as_str();
        let claim_dead_state = claim.dead_state;
        // b8ke delta round-2 F2: the attach-start's REAL watchdog machinery
        // — the sidecar pid slot (the registered cancellation SIGTERMs the
        // spawned child; the resume's own gates then tear down and unwind)
        // and the settle guard (fires when THIS resume's scope ends — the
        // operation's completion or unwind; the watchdog's bounded settle
        // treats it as the operation's confirmed death). No-op for the
        // under-ticket handoff-resume caller (no ticket).
        let start_pid_slot = crate::ownership_lane::sidecar_pid_cancel_slot();
        let _start_cancellation = crate::ownership_lane::register_start_cancellation_for_ticket(
            &self.ownership,
            PROVIDER,
            durable,
            own_ticket,
            crate::ownership_lane::pid_slot_cancellation(&start_pid_slot),
        );
        // Which conversation boots (design §4.2, I8): a found transcript resumes;
        // a positive denial only on a CLEAN miss in every candidate root
        // (CLAUDE_CONFIG_DIR > CLAUDE_HOME > platform home, ledger A3) of a session
        // with no genesis; a session with no transcript yet boots from the genesis
        // its binding row records (§4.3: a zero-turn session or a pending fork
        // after a restart); an unreadable store (or no root at all) cannot CHECK,
        // so it must not deny.
        let sink = self.identity_sink();
        let (boot, transcript_cwd, minted_id) = self.decide_attach_boot(durable, sink.as_ref())?;
        // The genesis the boot was decided from, for its one typed retry (§4.2).
        let recorded_genesis = self
            .recovery_genesis(durable, sink.as_ref())
            .map(|recorded| recorded.genesis);
        let dead = self.dead_sessions.find(durable);
        // P1.13 (Task 10): recover the pane's recorded settings from the ledger so a
        // resume-in-place does not silently revert model/permissionMode/effort (or,
        // G15, drop its plugins). V7/A10 alarm gate: alarm ONLY when the ledger
        // PROVES prior recording yet no snapshot is recoverable. Never-recorded
        // transcripts (the entire pre-existing ~/.claude/projects population —
        // resume_for_attach exists FOR them) stay silent.
        let recovered = sink
            .as_ref()
            .and_then(|s| s.load_settings("claude", durable))
            .or_else(|| dead.as_ref().map(|dead| dead.settings.clone()));
        if recovered.is_none()
            && sink
                .as_ref()
                .is_some_and(|s| s.was_recorded("claude", durable))
        {
            // Recorded before, unrecoverable now — the genuine anomaly.
            tracing::warn!(session = %durable, "freshagent.claude.settings_record_unrecoverable");
            self.emit_fresh_agent_error(
                durable,
                session_type_str(msg.session_type), // preserves freshclaude vs kilroy in the frame
                "SETTINGS_RESET",
                "Session settings could not be recovered after restart - the agent is running with default model and permissions. Reconfirm your settings.",
            );
        }
        let rec = recovered.clone().unwrap_or_default();
        // The CLI runs where the conversation was recorded when that directory
        // still exists; otherwise the attach cwd stays primary and the ledger
        // record's cwd is a FINAL fallback only when both are absent (Task 10).
        let resume_cwd = transcript_cwd
            .or_else(|| msg.cwd.clone())
            .or_else(|| rec.cwd.clone());

        // Round 4 (focused-ep5-r3 Finding 1): the claim's dead-state SNAPSHOT —
        // taken at claim start, before the sidecar spawn and the `created` await —
        // so a kill landing while this resume is in flight advances the durable
        // tombstone past it and the commit REFUSES instead of undoing the newer
        // close.
        let session_type = session_type_str(msg.session_type);
        let launch_genesis = minted_id
            .is_some()
            .then(|| recorded_genesis.clone())
            .flatten();
        let spec = ClaudeLaunchSpec::new(
            format!("attach-resume-{}", uuid::Uuid::new_v4()),
            session_type,
            boot,
            resume_cwd,
            &rec,
            self.hosted_mcp,
        )
        .with_session_id(minted_id)
        .with_freshell_context(
            crate::claude_freshell_mcp::ClaudeFreshellContext::from_ids(
                msg.tab_id.as_deref(),
                msg.pane_id.as_deref(),
            )
            .or_else(|| dead.as_ref().and_then(|dead| dead.freshell_context.clone())),
        );
        // Register under the CLIENT's id: the consumer stamps the map key on every
        // envelope and the frozen client routes by envelope sessionId
        // (fresh-agent-ws.ts:180-183) -- a fresh key would strand the pane. The
        // sidecar's created id is the eviction identity guard for this consumer.
        // `recorded_settings` (P1.13, Task 10): `Some(rec)` re-records the row under
        // any new cliSessionId (the old durable's row keeps serving `load_settings`,
        // so later attaches with the old id still resolve — no repeat-fire, V7 §4);
        // `None` records nothing (no laundered blank row under the new id, V7/A10).
        // A refusal stays transient: the transcript was found just above, so a CLI
        // that cannot resume it is not proof the conversation is gone.
        self.establish_runtime(
            EstablishPlan {
                lane: EstablishLane::AttachResume,
                spec,
                register_under: RegisterUnder::Pane(msg.session_id.clone()),
                claim: Some(DurableClaim {
                    durable: durable.to_string(),
                    dead_state: claim_dead_state,
                }),
                rekey_provisional_claim: false,
                recorded_settings: recovered,
                owning_operation,
                owning_generation: handoff_generation,
                // Conn-less lane (D8): attach-resume is not a create; the ledger
                // merge keeps the row's existing stamps.
                provenance: None,
                naming: None,
                partial_runtime_key: Some(durable.to_string()),
                start_pid_slot: &start_pid_slot,
                inherit: dead.map(|dead| InheritedRuntime {
                    turn_lock: dead.turn_lock,
                    clock: dead.clock,
                    ledger: crate::claude_turns::SharedLedger::default(),
                }),
                genesis: launch_genesis,
                retry: Some(BootRetry {
                    durable: durable.to_string(),
                    genesis: recorded_genesis,
                }),
            },
            lease_guard,
            own_ticket,
        )
        .await
        .map_err(|error| ResumeClaudeError::Transient(error.resume_detail()))?;
        Ok(())
    }

    fn send_error(&self, request_id: &Option<String>, code: &str, message: &str) {
        self.send_request_error(
            request_id,
            ErrorCode::InternalError,
            &format!("{code}: {message}"),
        );
    }

    /// A top-level `error` frame correlated to `request_id`.
    fn send_request_error(&self, request_id: &Option<String>, code: ErrorCode, message: &str) {
        self.broadcast(&ServerMessage::Error(ErrorMsg {
            provider_preparation_failure: None,
            owner_kind: None,
            owner_generation: None,
            owner_epoch: None,
            code,
            message: message.to_string(),
            timestamp: now_iso(),
            actual_session_ref: None,
            expected_session_ref: None,
            request_id: request_id.clone(),
            retry_after_ms: None,
            terminal_exit_code: None,
            terminal_id: None,
            live_terminal_id: None,
        }));
    }

    /// The sdk.session.init adoption block (the consumer's in-stream arm, and
    /// a settings apply; a rollback or a fork never adopts through it, C13/C14:
    /// its runtime registers already adopted): record the durable Claude UUID
    /// in cli_index + the session record, then AWAIT-write the identity binding
    /// row (V8/A11). A failed write is surfaced user-visibly, never
    /// warn-and-drop, then the identity event proceeds. `provenance` (D8): the
    /// creating connection's stamps, when this adoption flows from a
    /// connection-scoped create; `None` on conn-less lanes — the ledger's
    /// keep-when-None merge then keeps the prior stamps.
    async fn adopt_session_init(
        &self,
        cli_id: &str,
        session_id: &str,
        session_type: &str,
        settings: Option<&crate::identity_sink::FreshAgentSettings>,
        identity_sink: Option<SharedPaneIdentitySink>,
        provenance: Option<&crate::BindProvenance>,
    ) -> SessionInitAdoptionOutcome {
        self.adopt_session_init_inner(
            cli_id,
            session_id,
            session_type,
            settings,
            identity_sink,
            provenance,
            false,
        )
        .await
    }

    /// [`Self::adopt_session_init`] with a completion hook: `Deferred`
    /// outcomes settle asynchronously, and the deferred task answers
    /// `Some(cli_id)` (published) or `None` (abandoned) on the caller's
    /// channel. Only tests observe the deferred adoption this way since the
    /// rollback stopped adopting a pre-read init (C13).
    #[cfg(test)]
    #[allow(clippy::too_many_arguments)] // the adoption field set + the completion channel
    async fn adopt_session_init_with_completion(
        &self,
        cli_id: &str,
        session_id: &str,
        session_type: &str,
        settings: Option<&crate::identity_sink::FreshAgentSettings>,
        identity_sink: Option<SharedPaneIdentitySink>,
        provenance: Option<&crate::BindProvenance>,
        on_settled: Option<tokio::sync::oneshot::Sender<Option<String>>>,
    ) -> SessionInitAdoptionOutcome {
        // The adoption can run before its session is registered — the
        // registration gate must decide synchronously so the completion hook
        // routes to the deferred task on `Deferred`.
        let registered = self.sessions.lock().await.contains_key(session_id);
        if !registered {
            self.defer_session_init_adoption(
                cli_id,
                session_id,
                session_type,
                settings,
                identity_sink,
                provenance,
                on_settled,
            );
            return SessionInitAdoptionOutcome::Deferred;
        }
        let outcome = self
            .adopt_session_init_inner(
                cli_id,
                session_id,
                session_type,
                settings,
                identity_sink,
                provenance,
                false,
            )
            .await;
        if let Some(tx) = on_settled {
            match outcome {
                SessionInitAdoptionOutcome::Published => {
                    let _ = tx.send(Some(cli_id.to_string()));
                }
                _ => {
                    let _ = tx.send(None);
                }
            }
        }
        outcome
    }

    /// b8ke focused episode-2 round-1 F2: the pre-registration deferral.
    /// `handle_create` starts the detached consumer BEFORE it inserts the
    /// `ClaudeSession` into `self.sessions`, so the consumer's
    /// `sdk.session.init` adoption can run while the runtime is NOT yet
    /// registered/killable — committing a Live{FreshAgent} owner that a
    /// handoff cannot stop (kill_for_handoff answers AlreadyGone, the
    /// terminal target starts, and the create then inserts its still-live
    /// sidecar with no later commit: two writers). The deferred task
    /// waits (bounded) for the registration and re-runs the FULL
    /// adoption — gate, claim, publish-or-teardown — once the session is
    /// killable. A timeout means the create failed before registering
    /// (its own failure path killed the child): nothing adopted, nothing
    /// committed.
    #[allow(clippy::too_many_arguments)] // the adoption field set + the completion channel
    fn defer_session_init_adoption(
        &self,
        cli_id: &str,
        session_id: &str,
        session_type: &str,
        settings: Option<&crate::identity_sink::FreshAgentSettings>,
        identity_sink: Option<SharedPaneIdentitySink>,
        provenance: Option<&crate::BindProvenance>,
        on_settled: Option<tokio::sync::oneshot::Sender<Option<String>>>,
    ) {
        let state = self.clone();
        let cli_id = cli_id.to_string();
        let session_id = session_id.to_string();
        let session_type = session_type.to_string();
        let settings = settings.cloned();
        let provenance = provenance.cloned();
        tokio::spawn(async move {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
            loop {
                if state.sessions.lock().await.contains_key(&session_id) {
                    let outcome = state
                        .adopt_session_init_inner(
                            &cli_id,
                            &session_id,
                            &session_type,
                            settings.as_ref(),
                            identity_sink.clone(),
                            provenance.as_ref(),
                            true,
                        )
                        .await;
                    if let Some(tx) = on_settled {
                        let answer = match outcome {
                            SessionInitAdoptionOutcome::Published => Some(cli_id.clone()),
                            _ => None,
                        };
                        let _ = tx.send(answer);
                    }
                    return;
                }
                if tokio::time::Instant::now() >= deadline {
                    tracing::warn!(target: "freshell_freshagent::claude",
                        cli_id = %cli_id, placeholder = %session_id,
                        "freshagent.claude.init_ownership_adoption_deferred_timeout: the \
                         session never registered (the create failed and tore its child \
                         down) — nothing adopted, nothing committed"
                    );
                    if let Some(tx) = on_settled {
                        let _ = tx.send(None);
                    }
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        });
    }

    /// b8ke focused episode-2 round-1 F3: the refused-adoption teardown.
    /// A refused canonical claim (a foreign owner or an in-flight
    /// transition) must NEVER leave the freshly spawned runtime live and
    /// unowned — the pre-fix path only logged and the sidecar kept
    /// running while a competitor acquired the vacant key. Fail closed:
    /// remove the registered session, run the standard typed teardown,
    /// evict its placeholder aliases, and engage the client's
    /// lost-session recovery.
    async fn teardown_unadopted_session(&self, session_id: &str, session_type: &str) {
        tracing::error!(target: "invariant",
            placeholder = %session_id,
            "freshagent.claude.init_ownership_adoption_torn_down: the canonical key moved \
             on — the freshly spawned runtime is torn down, never left unowned"
        );
        // DETACHED: the adoption's caller is usually the session's OWN
        // consumer task, and the standard teardown aborts + joins the
        // consumer — running it inline would abort the caller mid-teardown
        // (the self-abort drops the teardown before the reap or the
        // lost-session frame). The spawned task performs the whole
        // fail-closed sequence; the consumer unwinds at its next await.
        let state = self.clone();
        let session_id = session_id.to_string();
        let session_type = session_type.to_string();
        tokio::spawn(async move {
            if let Some(session) = state.sessions.lock().await.remove(&session_id) {
                // R2-2: the typed outcome is propagated; this unwind path
                // holds no coordinator fence, so the helper's typed log +
                // its detached escalation are the whole discipline here.
                let _teardown: LoggedTeardown =
                    state.teardown_removed_session_logged(session).await;
            }
            state.evict_cli_index_aliases(&session_id).await;
            let typed = match session_type.as_str() {
                "kilroy" => SessionType::Kilroy,
                _ => SessionType::Freshclaude,
            };
            state.broadcast(&lost_session_frame(&session_id, typed));
        });
    }

    /// The adoption's alias publication (the mint-gated section): inserts
    /// `cli_index[durable] = map key` and stamps the session's durable id.
    /// Re-checks the kill's close gate under the SAME lock acquisition the
    /// gate discipline requires — a kill that armed the gate between the
    /// adoption's first read and this publication owns the session, so the
    /// publication abandons (`false`). Returns whether the publication
    /// landed.
    ///
    /// b8ke focused episode-2 round-2 F3: the publication ALSO revalidates
    /// the session's INCARNATION — the session must still exist AND its
    /// sidecar child must still be the exact runtime the adoption read at
    /// phase 1 (`expect_pid`). An explicit kill that completed between the
    /// read and here removed the session AND its close-pending entry, so
    /// the gate check alone cannot see it; without this validation the
    /// adoption would mint a dangling alias and commit `Live` over the
    /// captured pid of a KILLED runtime (snapshots then reported the dead
    /// runtime as the authoritative owner). Missing/incarnation-changed →
    /// `false`: no alias, no commit — the kill owns the session.
    async fn publish_session_init_alias(
        &self,
        cli_id: &str,
        session_id: &str,
        expect_pid: Option<u32>,
    ) -> bool {
        let mut index = self.cli_index.lock().await;
        let mut sessions = self.sessions.lock().await;
        let gated = {
            let gates = self.close_pending.lock().expect("close-pending lock");
            gates.get(session_id).copied().unwrap_or(0) > 0
        };
        if gated {
            tracing::info!(target: "freshell_freshagent::claude",
                cli_id = %cli_id,
                session_id = %session_id,
                "freshagent.claude.adoption_abandoned_by_kill_gate: the kill's one \\
                 envelope already enumerated this session; the mint lands nowhere"
            );
            return false;
        }
        // F3: the session must still exist with the SAME runtime incarnation
        // the adoption observed — a completed kill (or a re-registered
        // replacement) invalidates the adoption's captured identity.
        match sessions.get_mut(session_id) {
            None => {
                tracing::warn!(target: "freshell_freshagent::claude",
                    cli_id = %cli_id, placeholder = %session_id,
                    "freshagent.claude.adoption_abandoned_session_gone: the session was \\
                     removed (a completed kill) before the publication — no alias, no \\
                     commit of the dead runtime's identity"
                );
                return false;
            }
            Some(session) => {
                if session.child.id() != expect_pid {
                    tracing::warn!(target: "freshell_freshagent::claude",
                        cli_id = %cli_id, placeholder = %session_id,
                        expected_pid = ?expect_pid,
                        current_pid = ?session.child.id(),
                        "freshagent.claude.adoption_abandoned_incarnation_changed: the \\
                         session's runtime was replaced since the adoption's read — no \\
                         alias, no commit of a stale identity"
                    );
                    return false;
                }
                session.cli_session_id = Some(cli_id.to_string());
            }
        }
        index.insert(cli_id.to_string(), session_id.to_string());
        true
    }

    #[allow(clippy::too_many_arguments)] // the adoption field set (the deferral adds the re-entry flag)
    async fn adopt_session_init_inner(
        &self,
        cli_id: &str,
        session_id: &str,
        session_type: &str,
        settings: Option<&crate::identity_sink::FreshAgentSettings>,
        identity_sink: Option<SharedPaneIdentitySink>,
        provenance: Option<&crate::BindProvenance>,
        deferred_reentry: bool,
    ) -> SessionInitAdoptionOutcome {
        // Phase 1 — the mint-gate READ scope (never publishes): the gate
        // flag, the session's existing durable id (the in-stream remint
        // test), the registration presence (the F2 pre-registration test),
        // and the sidecar pid.
        // b8ke ext r27 F2: the session's recorded handoff generation reads
        // HERE — inside the pre-publication read scope — so the binding
        // pair's derivation (below) adds NO await between the publication
        // and the commit (a mid-flow sessions-lock await there widened
        // the publication→commit window a concurrent stamp take could
        // land inside).
        let (gated, existing_cli_id, registered, sidecar_pid, owning_generation);
        {
            let _index = self.cli_index.lock().await;
            let sessions = self.sessions.lock().await;
            gated = {
                let gates = self.close_pending.lock().expect("close-pending lock");
                gates.get(session_id).copied().unwrap_or(0) > 0
            };
            if gated {
                tracing::info!(target: "freshell_freshagent::claude",
                    cli_id = %cli_id,
                    session_id = %session_id,
                    "freshagent.claude.adoption_abandoned_by_kill_gate: the kill's one \
                     envelope already enumerated this session; the mint lands nowhere"
                );
                return SessionInitAdoptionOutcome::Abandoned;
            }
            existing_cli_id = sessions
                .get(session_id)
                .and_then(|s| s.cli_session_id.clone());
            registered = sessions.contains_key(session_id);
            sidecar_pid = sessions.get(session_id).and_then(|s| s.child.id());
            owning_generation = sessions.get(session_id).and_then(|s| s.owning_generation);
        }
        // b8ke focused episode-2 round-2 F3 test seam: the deterministic
        // kill-between-read-and-publication hold (never armed in
        // production). e2r3 F10: `reached` flips BEFORE the park, so the
        // test can prove the adoption reached this exact point before
        // releasing — never a vacuous pass.
        #[cfg(test)]
        if let Some(pause) = &self.adoption_pause {
            pause
                .reached
                .store(true, std::sync::atomic::Ordering::SeqCst);
            let _ = pause.notify.notified().await;
        }
        // b8ke focused episode-2 round-1 F4: the in-stream REMINT gate. An
        // init that names a durable id other than the one the session
        // already carries (the CLI moved the conversation to a new id)
        // must not adopt ownership under the new id: the runtime is owned
        // and committed under the id it already carries, and a second
        // Live{FreshAgent} record + stamp beside that key would leave
        // contradictory snapshots. Such a re-key publishes the bookkeeping
        // ONLY — ownership stays where it was committed.
        let fork_rekey = existing_cli_id
            .as_deref()
            .is_some_and(|existing| existing != cli_id);
        if !registered {
            // b8ke focused episode-2 round-1 F2: the pre-registration
            // window must not expose a Live owner that cannot be killed —
            // defer the whole adoption (claim + publication) until the
            // create registered the runtime. A deferred re-entry that
            // STILL finds the session absent gives up (the create died;
            // its failure path killed the child).
            if deferred_reentry {
                tracing::warn!(target: "freshell_freshagent::claude",
                    cli_id = %cli_id, placeholder = %session_id,
                    "freshagent.claude.init_ownership_adoption_deferred_unregistered: \
                     the session vanished before the deferred adoption — nothing \
                     published, nothing committed"
                );
                return SessionInitAdoptionOutcome::Abandoned;
            }
            tracing::info!(target: "freshell_freshagent::claude",
                cli_id = %cli_id, placeholder = %session_id,
                "freshagent.claude.init_ownership_adoption_deferred: the session is not \
                 yet registered (the create's insert window) — the adoption waits for \
                 the registration before claiming or publishing"
            );
            self.defer_session_init_adoption(
                cli_id,
                session_id,
                session_type,
                settings,
                identity_sink,
                provenance,
                None,
            );
            return SessionInitAdoptionOutcome::Deferred;
        }
        // b8ke focused episode-2 round-1 F3: CLAIM BEFORE PUBLISHING. The
        // pre-fix order minted the alias + the session's durable field
        // BEFORE the coordinator claim, so a REFUSED claim left the
        // freshly spawned sidecar running unowned under a published
        // identity while a competitor acquired the key. The publication
        // below happens only after the claim decision; a refused claim
        // tears the runtime down instead (fail closed).
        let mut adoption_ticket = None;
        if !fork_rekey {
            adoption_ticket = match self.begin_lane_claim_at(
                cli_id,
                &format!("claude-init-adopt-{}", uuid::Uuid::new_v4()),
                None,
                // b8ke focused episode-2 round-1 F7: the provenance-derived
                // initiator (the device id), never a fixed lane string.
                &Self::initiator_for(provenance, "claude/session-init-adoption"),
            ) {
                // Granted: the canonical key is vacant (a fresh create's
                // first init) — THIS adoption claims it.
                crate::ownership_lane::LaneClaim::Granted(ticket) => Some(ticket),
                // Unwired (no coordinator): the legacy behavior.
                crate::ownership_lane::LaneClaim::Unwired => None,
                // Adopt: the canonical key is ALREADY Live{FreshAgent} — a
                // resume/attach committed at create time; the record is
                // already authoritative.
                crate::ownership_lane::LaneClaim::Adopt => None,
                // Refused: the canonical key moved on (a foreign owner or
                // an in-flight transition). NEVER steal — and NEVER leave
                // the freshly spawned runtime live and unowned: tear it
                // down and engage the client's lost-session recovery,
                // publishing nothing.
                crate::ownership_lane::LaneClaim::Refused(outcome) => {
                    match &outcome {
                        // A BLOCKED coordinator state: correlate the
                        // blocking operation with the runtime being
                        // adopted (b8ke focused episode-2 round-2 F2).
                        // ONLY the runtime's OWN operation — recorded on
                        // the session as its `owning_operation` (the
                        // create-resume claim, the attach's claim, or the
                        // handoff runner's under-ticket target op) — may
                        // proceed: that operation owns the key's
                        // resolution and will perform the ONE commit, so
                        // the adoption claims nothing, tears nothing
                        // down, and the publication keeps the alias
                        // bookkeeping consistent with its commit.
                        // An UNRELATED blocker (another device's handoff
                        // on the still-vacant canonical key, a foreign
                        // start, a fenced/stop transition that does not
                        // name this runtime's owner) fails CLOSED: the
                        // freshly spawned runtime is torn down — never
                        // left running unowned while the other operation
                        // believes there was no prior owner.
                        freshell_ownership::BeginOutcome::Blocked { state, .. } => {
                            let blocking_op = state.operation_id().map(str::to_string);
                            let (own_op, own_live_key) = {
                                let sessions = self.sessions.lock().await;
                                match sessions.get(session_id) {
                                    Some(session) => (
                                        session.owning_operation.clone(),
                                        Some(session.sidecar_session_id.clone()),
                                    ),
                                    None => (None, None),
                                }
                            };
                            // The handoff stopping THIS runtime as its
                            // PRIOR is also "our" transition: the runner's
                            // Handoff state captures this session's runtime
                            // identity as the prior it is stopping — the
                            // deferred adoption (a create whose bookkeeping
                            // landed mid-handoff) must neither claim nor
                            // tear down; the handoff's kill_for_handoff is
                            // the one stopping this session, and the
                            // runner resolves the key.
                            let handoff_stops_this_runtime = matches!(
                                &state,
                                freshell_ownership::OwnershipState::Handoff {
                                    prior: Some((prior_owner, _)),
                                    ..
                                } if own_live_key.is_some()
                                    && prior_owner.live_session_key == own_live_key
                            );
                            if (blocking_op.is_some() && blocking_op == own_op)
                                || handoff_stops_this_runtime
                            {
                                tracing::info!(target: "freshell_freshagent::claude",
                                    cli_id = %cli_id, placeholder = %session_id,
                                    operation_id = ?blocking_op,
                                    "freshagent.claude.init_ownership_adoption_skipped_own_operation: \\
                                     the runtime's OWN lifecycle operation owns this key — the \\
                                     adoption claims nothing, the owning operation resolves it"
                                );
                                None
                            } else {
                                tracing::warn!(target: "freshell_freshagent::claude",
                                    cli_id = %cli_id, placeholder = %session_id,
                                    outcome = ?outcome,
                                    owning_operation = ?own_op,
                                    "freshagent.claude.init_ownership_adoption_blocked_foreign: an \\
                                     UNRELATED operation owns this key — the freshly spawned \\
                                     runtime is torn down (fail closed), nothing published"
                                );
                                self.teardown_unadopted_session(session_id, session_type)
                                    .await;
                                return SessionInitAdoptionOutcome::Abandoned;
                            }
                        }
                        // A genuinely FOREIGN owner (another kind holds
                        // the key): fail closed — the freshly spawned
                        // runtime is torn down, never left live and
                        // unowned beside the foreign owner.
                        _ => {
                            tracing::warn!(target: "freshell_freshagent::claude",
                                cli_id = %cli_id, placeholder = %session_id,
                                outcome = ?outcome,
                                "freshagent.claude.init_ownership_adoption_refused: the \\
                                 canonical key is held by a foreign owner — the freshly \\
                                 spawned runtime is torn down (fail closed), nothing published"
                            );
                            self.teardown_unadopted_session(session_id, session_type)
                                .await;
                            return SessionInitAdoptionOutcome::Abandoned;
                        }
                    }
                }
            };
        }
        // b8ke ext r22 F2: the binding row's fence pair — the pre-commit
        // ticket's generation (the delayed-write fence baseline the durable
        // row carries below). `None` when no ticket was claimed (the Adopt
        // arms — the record is already authoritative) or the coordinator
        // is unwired.
        // b8ke ext r27 F2: the UNDER-TICKET handoff continuation holds NO
        // own ticket — the session's recorded HANDOFF generation (the
        // runner's supplied pair, read in the phase-1 scope above) stamps
        // the row instead, so the target's durable row carries the
        // handoff's generation.
        let (binding_epoch, binding_generation) = (
            self.ownership.as_ref().map(|r| r.boot_epoch()),
            adoption_ticket
                .as_ref()
                .map(|t| t.generation())
                .or(owning_generation),
        );
        // The (re-gated) publication: abandons when the kill gate armed
        // between the read scope and here — the kill owns the session.
        if !self
            .publish_session_init_alias(cli_id, session_id, sidecar_pid)
            .await
        {
            return SessionInitAdoptionOutcome::Abandoned;
        }
        // b8ke ext r27 F4: the durable binding write runs BEFORE the
        // commit-Live, inside the SAME coordinator operation (the claim
        // held above). Pre-r27 the adoption committed Live FIRST and then
        // wrote the binding, so once the commit released the coordinator
        // operation a handoff or stop could begin while the binding write
        // was blocked, and a later failure tore the runtime down only
        // after the owner was already authoritative. The write stays
        // AFTER the alias publication deliberately: the publication is
        // what makes the durable id resolvable to a concurrent kill (the
        // tombstone fold + the sink's orphan-write suppression key off
        // it), so a kill landing while the binding write is in flight
        // still fences the released write. The row is also UNCONDITIONAL
        // now: an all-blank settings snapshot records a LINEAGE-only row
        // (blank settings verbatim) — pre-r27 default-settings sessions
        // skipped the binding entirely; the sink's was_recorded/
        // load_settings keying (Task 3) keeps a legitimately-default
        // session from ever arming a false SETTINGS_RESET on a later
        // resume (the codex REST lane's unconditional-lineage discipline).
        // Unified agent names (Task 2): the init hook runs EVEN for an
        // all-blank settings row — the naming bind is driven by verified
        // transcript durability, not by the settings row (their r27-F4
        // write below is unconditional for exactly the same reason). The
        // stashed pre-durable handle (keyed by this placeholder) binds to
        // the durable UUID exactly once (idempotent in the store); a
        // zero-turn init whose transcript has not materialized yet retains
        // the handle and records only the acquired location (InitialRecovery
        // semantics — the name authority never moves on unverified
        // evidence). Deliberately NOT
        // a lane blocker: a naming failure never fails the identity event
        // (the handle is retained; the main.rs naming tick retries the
        // transition visibly), and the bind targets the DURABLE session —
        // its verified transcript outlives even this runtime's teardown.
        let declared_transition = self
            .bind_naming_handle_at_init(cli_id, session_id, session_type)
            .await;
        if let Some(sink) = &identity_sink {
            if let Err(e) = sink
                .record_binding(crate::identity_sink::FreshAgentBindingUpsert {
                    genesis: crate::identity_sink::GenesisUpdate::Keep,
                    provider: PROVIDER.into(),
                    session_id: cli_id.to_string(),
                    mode: session_type.to_string(),
                    create_request_id: None,
                    resolves_pending: None,
                    supersedes: None,
                    // Unified agent names (Task 4, T2-M5 wired): the init lane's
                    // DECLARED classification — the same transition the direct
                    // naming fold above consumed (InitialMaterialization), so
                    // the identity event carries the naming fact alongside the
                    // ledger write.
                    name_transition: declared_transition,
                    provenance: provenance.cloned().into(),
                    observed_epoch: binding_epoch,
                    observed_generation: binding_generation,
                    // b8ke focused ep5 r2 F1: the UNDER-TICKET shape (no own
                    // adoption ticket; the session's recorded HANDOFF
                    // generation supplied the pair) is the handoff runner's
                    // OWN authoritative target binding — the ordinary
                    // create's own-ticket write stays a lane write.
                    authoritative: adoption_ticket.is_none() && owning_generation.is_some(),
                    settings: settings.cloned().unwrap_or_default(),
                })
                .await
            {
                // b8ke ext r27 F4: the binding failure PROPAGATES — the
                // freshly adopted runtime is torn down and the adoption is
                // ABANDONED BEFORE the publish and the commit (the ticket's
                // RAII drop settles the claim typed; the key never goes
                // Live), never a bare LEDGER_WRITE_FAILED notification and
                // never a committed Live with no recoverable registration.
                tracing::error!(target: "invariant",
                    error = %e, session = %cli_id,
                    "freshagent.claude.binding_write_failed_typed: the durable row write \
                     failed — the freshly adopted runtime is torn down (kata b8ke ext r27 F4)"
                );
                self.teardown_unadopted_session(session_id, session_type)
                    .await;
                return SessionInitAdoptionOutcome::Abandoned;
            }
        }
        // b8ke delta round-2 F1: the canonical-key adoption commit — for
        // the ordinary-create path (no fork re-key), a Granted claim
        // commits the authoritative Live{FreshAgent} ownership under the
        // durable id and broadcasts the owner record so every device
        // converges.
        if let Some(ticket) = adoption_ticket.as_ref() {
            let generation = ticket.generation();
            let operation_id = ticket.operation_id().to_string();
            // b8ke focused episode-2 post-cap F3 test seam: the pre-commit
            // park (never armed in production).
            #[cfg(test)]
            if let Some(pause) = &self.adoption_commit_pause {
                pause
                    .reached
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                let _ = pause.notify.notified().await;
            }
            match self.commit_lane_claim_at(&mut adoption_ticket, session_id, sidecar_pid) {
                Ok(()) => {
                    // Broadcast the authoritative owner record: every device
                    // holding the durable sessionRef converges on the
                    // committed Live{FreshAgent} owner (the ready replay
                    // covers reconnects; the broadcast covers the live ones).
                    self.broadcast(&ServerMessage::SessionRuntimeOwner(SessionRuntimeOwner {
                        provider: PROVIDER.to_string(),
                        session_id: cli_id.to_string(),
                        epoch: self.ownership.as_ref().map(|r| r.boot_epoch()).unwrap_or(0),
                        generation,
                        owner_kind: "fresh-agent".into(),
                        previous_kind: None,
                        terminal_id: None,
                        operation_id,
                        transition: "handoff-committed".into(),
                        reason: None,
                        fenced: None,
                        alias_of: None,
                    }));
                }
                Err(outcome) => {
                    // Stale/foreign commit: the coordinator moved on between
                    // the claim and the commit. Fail closed exactly like the
                    // refused claim — the freshly spawned runtime is never
                    // left live and unowned (the ticket's Drop performs the
                    // typed fail on the claimed key).
                    tracing::warn!(target: "freshell_freshagent::claude",
                        cli_id = %cli_id, placeholder = %session_id,
                        outcome = ?outcome,
                        "freshagent.claude.init_ownership_adoption_commit_stale: the \
                         coordinator moved on while the adoption committed — the freshly \
                         spawned runtime is torn down (fail closed)"
                    );
                    self.teardown_unadopted_session(session_id, session_type)
                        .await;
                    // b8ke focused episode-2 post-cap F3: the runtime IS
                    // torn down — the adoption is ABANDONED, HERE. The
                    // pre-fix fall-through persisted the alias
                    // tombstone/binding and reported Published for a
                    // runtime that no longer exists.
                    return SessionInitAdoptionOutcome::Abandoned;
                }
            }
        }
        // Round 6 (focused-ep5-r5 Finding 2): persist the alias AT MINT. The
        // finding's window needs the mapping durably recorded before ANY
        // demotion — a server restart kills the consumers (no exit-eviction
        // ever demotes), so mint-time persistence is the ONLY write that
        // reaches the post-restart kill naming this pane's bare placeholder.
        // Best-effort: warn-loud on failure, never a lane blocker (the
        // in-memory store still answers this process's kills).
        if let Some(sink) = identity_sink.as_ref().filter(|_| session_id != cli_id) {
            if let Err(e) = sink
                .record_alias_tombstone(
                    PROVIDER,
                    session_id,
                    cli_id,
                    crate::session_lease::now_epoch_ms() as i64,
                )
                .await
            {
                tracing::warn!(error = %e, session = %cli_id, placeholder = %session_id,
                    "freshagent.claude.alias_tombstone_write_failed");
            }
        }
        SessionInitAdoptionOutcome::Published
    }

    /// Unified agent names (Task 2): the `sdk.session.init` naming hook —
    /// see [`Self::adopt_session_init`]. Deliberately NOT a lane blocker: a
    /// naming failure never fails the identity event (the handle is
    /// retained; the main.rs naming tick retries the transition visibly).
    async fn bind_naming_handle_at_init(
        &self,
        cli_id: &str,
        placeholder: &str,
        session_type: &str,
    ) -> Option<crate::naming::NameTransition> {
        if session_type == "kilroy" {
            return None;
        }
        let handle = self.naming_handles.lock().await.get(placeholder).cloned()?;
        // Existing provider durability evidence: the claude CLI writes the
        // session transcript at startup, so a located transcript file
        // verifies the durable identity (`claude_snapshot::locate_transcript_selected`
        // walks the same ordered candidate roots the snapshot lane reads and
        // answers the selected root + original cwd the store retains).
        let selected = crate::claude_snapshot::locate_transcript_selected(cli_id);
        let (persistence, evidence) = if selected.is_some() {
            (
                freshell_protocol::native_location::NativePersistence::Verified,
                freshell_protocol::native_location::NativeEvidenceKind::SelectedTranscript,
            )
        } else {
            (
                freshell_protocol::native_location::NativePersistence::Prospective,
                freshell_protocol::native_location::NativeEvidenceKind::InitializedRuntime,
            )
        };
        let acquisition = freshell_protocol::native_location::NativeAcquisition {
            location: freshell_protocol::native_location::NativeLocation::Claude {
                config_root: selected
                    .as_ref()
                    .map(|s| s.config_root.display().to_string())
                    .or_else(|| {
                        crate::claude_snapshot::claude_home_candidates()
                            .first()
                            .map(|root| root.display().to_string())
                    })
                    .unwrap_or_default(),
                transcript_path: selected
                    .as_ref()
                    .map(|s| s.transcript_path.display().to_string()),
                project_directory_key: None,
                transcript_cwd: selected.as_ref().and_then(|s| s.transcript_cwd.clone()),
                effective_project_key_override: None,
            },
            evidence,
            persistence,
        };
        let target = freshell_protocol::session_names::SessionNameRef::Session {
            provider: freshell_protocol::session_names::NamedProvider::Claude,
            session_id: cli_id.to_string(),
        };
        // Transition classification: an init is the initial
        // materialization (a rollback's or a fork's runtime registers
        // already adopted and never reaches here, C13/C14). The shared
        // classification-driven fold (plan Task 4) applies the policy:
        // verified persistence binds the handle, prospective evidence
        // RETAINS it (zero-turn rule — only the routing evidence moves).
        let reason = crate::naming::NameTransitionReason::InitialMaterialization;
        let transition = crate::naming::NameTransition {
            reason,
            acquisition,
            pending: Some(handle),
        };
        let pending_ref = freshell_protocol::session_names::SessionNameRef::Pending {
            id: transition.pending.clone().unwrap_or_default(),
        };
        match crate::naming::fold_identity_transition(&self.naming(), &transition, target.clone())
            .await
        {
            Some(update) => {
                tracing::debug!(target: "freshell_freshagent::claude",
                    session_id = %cli_id,
                    reason = ?reason,
                    "freshagent.claude.naming_transition_committed"
                );
                // Bound: the stash entry is consumed once the handle is
                // redirected to the durable record.
                if update.record.name_ref == target {
                    self.naming_handles.lock().await.remove(placeholder);
                }
            }
            None => {
                // Retained (prospective zero-turn), unwired, or a failed
                // bind: the stash survives for the tick's visible retry.
                tracing::debug!(target: "freshell_freshagent::claude",
                    session_id = %cli_id,
                    reason = ?reason,
                    "freshagent.claude.naming_transition_retained"
                );
                let _ = pending_ref;
            }
        }
        Some(transition)
    }

    // ── stdout consumer (the completion edge normalization) ──────────────────────────

    /// Consume the sidecar's stdout event stream (one `sdk.*` JSON per line), normalize
    /// each `sdk.* → freshAgent.*` and broadcast it wrapped in a `freshAgent.event`. On EOF
    /// (a clean end OR a mid-turn death) the loop stops — never a false completion — and
    /// the dead session is evicted from both maps (identity-guarded, ledger A9).
    /// `sidecar_session_id` is the id THIS consumer's sidecar is keyed by; it guards the
    /// eviction so a stale consumer can never evict a newer session re-registered under
    /// the same map key (attach-resume, Task 6).
    ///
    /// `settings` (P1.13): `Some` = record a fresh-agent binding row at
    /// `sdk.session.init` (create path / resume-with-record); `None` = do NOT record
    /// (resume of a never-recorded session — writing would launder a blank row under
    /// the new cliSessionId, V7/A10). The row's `mode` is the `session_type` param
    /// (the `"freshclaude"` vs `"kilroy"` flavour; provider is always [`PROVIDER`]).
    /// `broadcast_id` (Task 10b): the shared envelope-stamp handle read PER EVENT --
    /// starts as the map key; an attach-by-durable rebind flips it to the durable id.
    /// `pending` (Task 2): the shared pending approval/question handle the consumer
    /// folds `sdk.permission.*`/`sdk.question.*` lines into BEFORE the normalize/
    /// broadcast step (so a respond racing the event never sees stale membership).
    /// `ledger` (C17, design §5.2): the session's turn ledger. The consumer
    /// folds every line into it BEFORE anything else reads the line (so a gate
    /// or an attach acknowledgement racing the line never understates it) and
    /// publishes the session's effective status on change: before a content
    /// frame is forwarded (so `running` precedes the first assistant frame), and
    /// after a result is forwarded (the result carries `sessionBusy`). C18: the
    /// ledger's verdict on each result says whether it rings, and every edge
    /// (a result, a waiting edge, a death while a turn was owed) leaves through
    /// the edge hub on the session's `clock`.
    #[allow(clippy::too_many_arguments)] // Session-scoped wiring handed to the detached consumer; four call sites.
    fn spawn_consumer(
        &self,
        mut reader: tokio::io::Lines<BufReader<ChildStdout>>,
        session_id: String,
        ownership_id: String,
        session_type: String,
        sidecar_session_id: String,
        settings: Option<crate::identity_sink::FreshAgentSettings>,
        broadcast_id: Arc<std::sync::Mutex<String>>,
        pending: Arc<std::sync::Mutex<ClaudePending>>,
        ledger: crate::claude_turns::SharedLedger,
        quiet: deadman::SharedQuiet,
        // The session's attention clock (see [`ClaudeSession::clock`]). Held by
        // the consumer (like the ledger above) so the unrequested-death arm
        // below can mint AFTER the eviction has already torn the session record
        // out of the map.
        clock: crate::attention::AttentionClock,
        // D8: the creating connection's provenance stamps, handed to the
        // in-stream `sdk.session.init` adoption. `None` on conn-less consumers
        // (rollback replacement, attach-resume) — the ledger merge keeps prior
        // stamps.
        provenance: Option<crate::BindProvenance>,
        create_binding_expected: bool,
    ) -> tokio::task::JoinHandle<()> {
        let broadcast_tx = self.broadcast_tx.clone();
        let sessions = self.sessions.clone();
        let identity_sink = self.identity_sink();
        let state = self.clone();
        tokio::spawn(async move {
            let mut session_id = session_id;
            // The sidecar's report of its SDK stream's end (its last line before it
            // exits), read by the end-of-output path below.
            let mut stream_ended: Option<crate::claude_sidecar_exit::StreamEnded> = None;
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    state
                        .note_claude_stdout(&session_id, &ownership_id, None)
                        .await;
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    state
                        .note_claude_stdout(&session_id, &ownership_id, None)
                        .await;
                    continue;
                };
                if let Some(ended) = crate::claude_sidecar_exit::StreamEnded::from_line(&value) {
                    state
                        .note_claude_stdout(&session_id, &ownership_id, Some(&value))
                        .await;
                    stream_ended = Some(ended);
                    continue;
                }
                if value["type"] == "sdk.session.rekeyed" {
                    if let Some(new) = value["newSessionId"].as_str() {
                        match state
                            .rekey_conversation(
                                &session_id,
                                new,
                                &session_type,
                                &pending,
                                "conversation_reset",
                            )
                            .await
                        {
                            Ok(new) => session_id = new,
                            Err(cause) => tracing::error!(target: "freshell_freshagent::claude",
                                event = "freshagent.claude.rekey_refused", provider = PROVIDER,
                                session_id = %session_id, requested_session_id = new, cause,
                                "the conversation identity could not follow its reset"),
                        }
                    }
                    continue;
                }
                // C17: fold the line into the session's turn ledger (design
                // §5.2) before anything else reads it: a gate, an attach
                // acknowledgement or the status published below sees it.
                let step = state.fold_into_ledger(&ledger, &value, &broadcast_id, &session_type);
                if !is_pending_frame(&value) && value["type"] != "sdk.send.rejected" {
                    state
                        .note_claude_stdout(&session_id, &ownership_id, Some(&value))
                        .await;
                }
                // C18: a latched Stop that missed a command the CLI was still
                // starting is sent again now (design §5.4); a refused one is
                // disarmed (the turn keeps running and rings when it ends).
                match &step {
                    LedgerStep::Reissue(reissue) => {
                        let stamp = broadcast_id.lock().expect("broadcast id lock").clone();
                        state
                            .reissue_stop(
                                &session_id,
                                &ownership_id,
                                &stamp,
                                &session_type,
                                reissue,
                            )
                            .await;
                    }
                    LedgerStep::StopRefused {
                        stop_id,
                        request_id,
                    } => {
                        let stamp = broadcast_id.lock().expect("broadcast id lock").clone();
                        state.report_stop_refused(
                            &stamp,
                            &session_type,
                            stop_id,
                            request_id,
                            value["message"]
                                .as_str()
                                .unwrap_or("Claude could not stop the current turn. Try again."),
                        );
                    }
                    LedgerStep::Nothing | LedgerStep::Settled(_) => {}
                }
                // C16: the lifecycle facts the sidecar forwards for turn
                // accounting (a command's lifecycle, the session state, a status
                // end or a model request, heartbeats) are never client content:
                // logged, never broadcast. A send the sidecar refused is taken
                // back. C17: nor is any status the sidecar reports: the server
                // publishes the session's status itself.
                if let Some(fact) = crate::claude_turns::SidecarFact::from_line(&value) {
                    let stamp = broadcast_id.lock().expect("broadcast id lock").clone();
                    match fact {
                        crate::claude_turns::SidecarFact::SendRejected(rejection) => state
                            .take_back_rejected_send(&ledger, &stamp, &session_type, &rejection),
                        fact => fact.log(&stamp, &session_type),
                    }
                    if value["type"] == "sdk.send.rejected" {
                        state
                            .note_claude_stdout(&session_id, &ownership_id, Some(&value))
                            .await;
                    }
                    state.publish_claude_status(&ledger, &quiet, &stamp, &session_type, false);
                    continue;
                }
                if value.get("type").and_then(Value::as_str) == Some("sdk.status") {
                    let status = value.get("status").map(ToString::to_string);
                    tracing::debug!(target: "freshell_freshagent::claude",
                        provider = PROVIDER, session_id = %session_id, status = ?status,
                        "freshagent.claude.status_dropped: the server publishes the status");
                    continue;
                }
                match value.get("type").and_then(Value::as_str) {
                    Some("sdk.session.changed") if value["reason"] == "session-commands" => {
                        if let Some(commands) = value["commands"].as_array() {
                            if let Some(session) = sessions.lock().await.get_mut(&session_id) {
                                session.configuration.commands = Some(commands.clone());
                            }
                        }
                    }
                    // The CLI changed its own permission mode (an approved
                    // ExitPlanMode returns it to the mode it had before plan
                    // mode). The sidecar already runs in it; the session's
                    // settings take it too, so a later configure stating the
                    // same mode applies nothing and the snapshot states it.
                    // The binding row takes it the way a configure's settings
                    // do (client-alerts G20), so a resume after a restart
                    // boots the conversation in the mode the CLI is in.
                    Some("sdk.session.metadata") => {
                        if let Some(mode) = value.get("permissionMode").and_then(Value::as_str) {
                            let adopted =
                                sessions.lock().await.get_mut(&session_id).map(|session| {
                                    session.configuration.settings.permission_mode =
                                        Some(mode.to_string());
                                    (
                                        session.cli_session_id.clone(),
                                        session.configuration.settings.clone(),
                                    )
                                });
                            if let Some((Some(durable), settings)) = adopted {
                                state
                                    .adopt_session_init(
                                        &durable,
                                        &session_id,
                                        &session_type,
                                        Some(&settings),
                                        identity_sink.clone(),
                                        // Conn-less, like a settings apply: the
                                        // ledger merge keeps the row's stamps.
                                        None,
                                    )
                                    .await;
                            }
                        }
                    }
                    Some("sdk.configured") => {
                        if let Some(session) = sessions.lock().await.get_mut(&session_id) {
                            if session
                                .configuration
                                .pending
                                .as_ref()
                                .is_some_and(|(id, _)| {
                                    value["requestId"].as_str() == Some(id.as_str())
                                })
                            {
                                if let Some((_, tx)) = session.configuration.pending.take() {
                                    if let Some(settings) = value["settings"].as_object() {
                                        let current = &mut session.configuration.settings;
                                        current.model = settings
                                            .get("model")
                                            .and_then(Value::as_str)
                                            .map(str::to_owned);
                                        current.effort = settings
                                            .get("effort")
                                            .and_then(Value::as_str)
                                            .map(str::to_owned);
                                        current.permission_mode = settings
                                            .get("permissionMode")
                                            .and_then(Value::as_str)
                                            .map(str::to_owned);
                                        if let Some(cwd) =
                                            settings.get("cwd").and_then(Value::as_str)
                                        {
                                            current.cwd = Some(cwd.to_string());
                                        }
                                    }
                                    let result = if value["ok"].as_bool() == Some(true) {
                                        Ok(())
                                    } else {
                                        Err(value["message"].as_str().unwrap_or("Claude could not apply these settings. Your message was not sent.").to_string())
                                    };
                                    let _ = tx.send(result);
                                }
                            }
                        }
                    }
                    Some("sdk.result") => {
                        // Core design §4.1: a session booted from its genesis
                        // writes its transcript around its first result; clear
                        // the genesis once the transcript is on disk.
                        state.spawn_genesis_clear_after_result(&session_id, &ownership_id);
                    }
                    // A protocol fake that predates C18 still sends its own
                    // edges: the server mints every edge itself, so they are
                    // dropped (the fakes are retired by C30).
                    Some(legacy @ ("sdk.turn.complete" | "sdk.turn.waiting")) => {
                        tracing::debug!(target: "freshell_freshagent::claude",
                            provider = PROVIDER, session_id = %session_id, line_type = legacy,
                            "freshagent.claude.legacy_edge_dropped: the server mints every edge");
                        continue;
                    }
                    _ => {}
                }
                // Pending mutation and its request/attention publication are
                // one ordered operation, fenced to this runtime. A response
                // may otherwise drain the set between the fold and its edge.
                if is_pending_frame(&value) {
                    state
                        .publish_pending_frame(&session_id, &pending, &value, &session_type)
                        .await;
                    continue;
                }
                // The status a content line changed is published before the line
                // is forwarded (`running` precedes the first assistant frame); a
                // result instead says whether the session is still busy, and the
                // status follows it.
                let mut value = value;
                match &step {
                    LedgerStep::Settled(settled) => value["sessionBusy"] = json!(settled.busy),
                    _ => {
                        let stamp = broadcast_id.lock().expect("broadcast id lock").clone();
                        state.publish_claude_status(&ledger, &quiet, &stamp, &session_type, false);
                    }
                }
                // Restart-parity (plan §2.8 item 2): record the durable Claude UUID
                // through the shared adoption block (cli_index insert is
                // load-bearing; the session-field copy is best-effort — the map
                // entry may not exist yet during create).
                if value.get("type").and_then(Value::as_str) == Some("sdk.session.init") {
                    if let Some(cli_id) = value.get("cliSessionId").and_then(Value::as_str) {
                        let (current_settings, known_identity) = {
                            let mut guard = sessions.lock().await;
                            guard
                                .get_mut(&session_id)
                                .map(|session| {
                                    session.configuration.runtime_cwd =
                                        value["cwd"].as_str().map(str::to_string);
                                    (
                                        Some(session.configuration.settings.clone()),
                                        session.cli_session_id.as_deref() == Some(cli_id),
                                    )
                                })
                                .unwrap_or_else(|| (settings.clone(), false))
                        };
                        if known_identity && create_binding_expected {
                            // Create/establish already bound this exact durable
                            // identity. Init verifies it; no second adoption or
                            // lineage rewrite is needed. A retained naming bind
                            // may still retry once native persistence appears.
                            state
                                .bind_naming_handle_at_init(cli_id, &session_id, &session_type)
                                .await;
                        } else if create_binding_expected {
                            tracing::error!(target: "freshell_freshagent::claude",
                                event = "freshagent.claude.unannounced_rekey", provider = PROVIDER,
                                session_id = %session_id, requested_session_id = cli_id,
                                "the CLI changed conversation without a reset announcement");
                            match state
                                .rekey_conversation(
                                    &session_id,
                                    cli_id,
                                    &session_type,
                                    &pending,
                                    "unannounced",
                                )
                                .await
                            {
                                Ok(new) => session_id = new,
                                Err(cause) => {
                                    tracing::error!(target: "freshell_freshagent::claude",
                                    event = "freshagent.claude.rekey_refused", provider = PROVIDER,
                                    session_id = %session_id, requested_session_id = cli_id, cause,
                                    "the unannounced conversation identity could not be followed")
                                }
                            }
                        } else {
                            state
                                .adopt_session_init(
                                    cli_id,
                                    &session_id,
                                    &session_type,
                                    current_settings.as_ref(),
                                    identity_sink.clone(),
                                    provenance.as_ref(),
                                )
                                .await;
                        }
                    }
                }
                // Task 10b: stamp the envelope from the SHARED handle (not the captured
                // map key) so an attach-by-durable rebind flips live event routing.
                let stamp = broadcast_id.lock().expect("broadcast id lock").clone();
                crate::claude_live_events::log_provider_event(&value, &stamp, &session_type);
                if let Some(frame) = sdk_line_to_frame(&value, &stamp, &session_type) {
                    if value.get("type").and_then(Value::as_str)
                        == Some("sdk.checkpointTurnIdentity")
                    {
                        if let Err(error) = state.broadcast_checkpoint_frame(frame, true).await {
                            tracing::error!(target: "freshell_freshagent::claude",
                                session_id = %stamp,
                                cause = %error,
                                "freshagent.claude.checkpoint_identity_persist_failed"
                            );
                        }
                    } else {
                        let _ = broadcast_tx.send(frame);
                    }
                }
                let record = crate::claude_edges::EdgeRecord {
                    session_key: &session_id,
                    stamp: &stamp,
                    sidecar_session_id: &sidecar_session_id,
                    session_type: &session_type,
                    clock: &clock,
                };
                if let LedgerStep::Settled(settled) = step {
                    state.ring_settled_turn(&record, settled);
                    state.publish_claude_status(&ledger, &quiet, &stamp, &session_type, true);
                }
            }
            // C17: the end of output ends whatever the CLI owed (its queue died
            // with it, and so did any Stop), before the eviction verdict below
            // (an unrequested death can never hold a rollback BUSY_TURN
            // hostage). Whether a turn was owed is captured here, because by the
            // time the unrequested-death arm below runs the ledger is cleared
            // and the session record evicted (the clock and id handles it needs
            // are consumer-owned locals that survive the eviction).
            quiet.lock().expect("quiet deadman lock").disarm();
            let turn_was_in_flight = ledger.lock().expect("turn ledger lock").eof();
            // Consumer exit == this sidecar's stdout closed == the sidecar ended
            // (ledger A9): it exits after reporting its SDK stream's end
            // (`sdk.stream.ended`, G02), or the Node process died. Evict the dead
            // session and its cli_index entries, identity-guarded: a newer session
            // re-registered under the same map key has a different pending-set
            // allocation, even when it reuses a durable sidecar session id, and
            // must not be evicted by this stale consumer.
            let evicted = {
                let mut map = sessions.lock().await;
                match map.get(&session_id) {
                    Some(s)
                        if s.sidecar_session_id == sidecar_session_id
                            && Arc::ptr_eq(&s.pending, &pending) =>
                    {
                        let stamp = s.broadcast_id.lock().expect("broadcast id lock").clone();
                        let removed = map.remove(&session_id);
                        // The old runtime has no actionable pending cards. Clear
                        // waiting attention before any teardown await or new
                        // registration; clearing it after reaping could erase a
                        // resumed runtime's newly raised request (G25).
                        state.edges.pending_drained(&stamp);
                        removed
                    }
                    _ => None,
                }
            };
            if let Some(evicted) = evicted {
                // Focused-ep5-r1 Finding 1: the aliases are DEMOTED to the
                // retained alias tombstones, never dropped — the client closes
                // a crashed pane by its ORIGINAL bare placeholder, and a kill
                // arriving after this eviction must still resolve the durable
                // id the ledger row is keyed on. The tombstone answers that
                // resolution for the RETIRE write only; it never feeds live
                // resolution (the session is dead — sends/attaches keep
                // missing it exactly as before).
                let removed_durables = state.evict_cli_index_aliases(&session_id).await;
                // Task 12: a dead BOUND session must reopen its durable id, or the
                // sessionRef stays adopt-only forever.
                for durable in &removed_durables {
                    state.leases.clear_binding(PROVIDER, durable);
                    // kata b8ke Task 3: an UNREQUESTED sidecar death releases
                    // the retained coordinator stamp with its fenced claim
                    // (round-1 review) — the durable key reopens for the next
                    // claimant. A delayed eviction can never erase a newer
                    // owner (the registry no-ops on mismatch).
                    crate::ownership_lane::release_retained_stamp(
                        &state.ownership,
                        &state.ownership_stamps,
                        PROVIDER,
                        durable,
                        "freshclaude/consumer-exit",
                    );
                }
                let stamp = broadcast_id.lock().expect("broadcast id lock").clone();
                // G05 (C09): the ended session stays known as ended — its ids
                // resolve to a dead record, not to nothing. It is recorded
                // before the stop on purpose: a resume (an attach, which is a
                // recovery verb, or a create that resumes) can land while the
                // stop runs and forgets the record, which is how the report
                // below knows to stay away from a session that is live again.
                // So for as long as the stop runs, a snapshot already reads
                // `exited` and a send already gets the lost-session frame.
                // That is short: node has usually exited by now (it ended its
                // stream, or it died), so the stop is the tree guard's kill and
                // the confirmation; only a node that closed its output and kept
                // running is given the whole grace period before it is killed.
                let reason = stream_ended
                    .as_ref()
                    .map_or(crate::claude_sidecar_exit::PROCESS_ENDED_REASON, |ended| {
                        ended.reason.as_str()
                    });
                state
                    .dead_sessions
                    .record(crate::claude_dead_sessions::Death {
                        map_key: &session_id,
                        stamp: &stamp,
                        session_type: &session_type,
                        durables: &removed_durables,
                        cli_session_id: evicted.cli_session_id.as_deref(),
                        settings: &evicted.configuration.settings,
                        ownership_id: &evicted.ownership_id,
                        launch_genesis: evicted.launch_genesis.as_ref(),
                        turn_lock: &evicted.turn_lock,
                        freshell_context: evicted.configuration.freshell_context.as_ref(),
                        commands: evicted.configuration.commands.as_ref(),
                        reason,
                        clock: &clock,
                    });
                state.test_holds.exit_report().await;
                // Stop the ended sidecar through the one sidecar stop every
                // teardown uses (G31): node is reaped for its exit status (the
                // cause of a death that reported no stream end), whatever is
                // left of its tree (the CLI) is killed and, within the stop's
                // bounded confirmation window, confirmed gone before the exit
                // report offers Resume, and no zombie is left behind. It is not
                // this consumer's to abort: the consumer is this task.
                let ownership_id = evicted.ownership_id.clone();
                let processes = SidecarProcesses {
                    child: evicted.child,
                    stdin: evicted.stdin,
                    tree_guard: evicted.tree_guard,
                    ownership_id: evicted.ownership_id,
                };
                let tree = processes.capture_tree();
                let (exit, confirmation) = processes
                    .stop(
                        tree,
                        &stamp,
                        state.tree_confirm_rounds(),
                        crate::claude_spawn::SIDECAR_GRACEFUL_EXIT,
                    )
                    .await;
                let confirmed = confirmation.label();
                // A tree the window could not confirm gone keeps being killed in
                // the background (logged there), and the report does not wait
                // for it. On Linux such a member has outlived SIGKILL: it runs
                // no more code and is only slow to finish dying (or stuck in
                // the kernel), so a resume cannot race it, while holding the
                // report back would leave the pane busy for as long as the
                // kernel keeps it. Off Linux an unconfirmed tree is the guard's
                // typed platform limitation, logged by the stop.
                let _ = escalate_unconfirmed_teardown(confirmation, stamp.clone());
                // A node that outlived the grace period was killed by the stop:
                // the signal it died of is ours, not the cause.
                let status = exit
                    .status
                    .filter(|_| exit.stop != crate::claude_spawn::SidecarStop::Forced);
                let cause =
                    crate::claude_sidecar_exit::SidecarExitCause::new(stream_ended.take(), status);
                // Adapter-asymmetry fix (bug-hunt pbh-20260807): an UNREQUESTED sidecar
                // end must never be TOTAL SILENCE. Broadcast the `freshAgent.error`
                // shape the client folds into a visible banner AND a
                // running/streaming->idle drop (`fresh-agent-ws.ts`,
                // `freshAgentSlice.sessionError`), with the cause. This branch is
                // UNREQUESTED-end only: `handle_kill`/`shutdown`/attach-teardown all
                // remove the map entry (and abort this consumer) first, so nothing is
                // evicted here and it stays silent.
                // C18: an unrequested end of a turn the user was owed rings,
                // however the sidecar ended (it reports no edge of its own).
                let rings = turn_was_in_flight;
                tracing::warn!(target: "freshell_freshagent::claude",
                    provider = PROVIDER,
                    session_id = %stamp,
                    session_type = %session_type,
                    reason = cause.reason(),
                    cause = %cause.detail(),
                    exit_status = %crate::claude_sidecar_exit::describe_status(exit.status),
                    stop = exit.stop.label(),
                    confirmation = confirmed,
                    turn_in_flight = turn_was_in_flight,
                    rings,
                    "freshagent.claude.sidecar_exit");
                // G05: every pane learns the session exited — a compacting or
                // running pane stops being busy and offers Resume — and why
                // (SIDECAR_EXITED, which also drops the pane to idle). The report
                // belongs to the dead incarnation: a resume that registered the
                // session again during the stop (an attach under the same pane
                // id) or a close forgot the dead record, and then neither frame
                // may reach the id, which names a live session or nothing now.
                if state.dead_sessions.find(&stamp).is_some() {
                    state.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
                        event: crate::claude_dead_sessions::exited_status_event(&stamp),
                        provider: PROVIDER.to_string(),
                        session_id: stamp.clone(),
                        session_type: session_type.clone(),
                    }));
                    state.broadcast(&ServerMessage::FreshAgentEvent(FreshAgentEvent {
                        event: crate::claude_sidecar_exit::sidecar_exited_event(&stamp, &cause),
                        provider: PROVIDER.to_string(),
                        session_id: stamp.clone(),
                        session_type: session_type.clone(),
                    }));
                } else {
                    tracing::info!(target: "freshell_freshagent::claude",
                        provider = PROVIDER,
                        session_id = %stamp,
                        session_type = %session_type,
                        reason = cause.reason(),
                        "freshagent.claude.exit_report_skipped: the session was resumed or \
                         closed while its dead sidecar was reaped");
                }
                // An UNREQUESTED end of a running turn is a turn end the user
                // did not witness, even when a resume brought the session back
                // during the stop: it rings once (design §5.7), from the
                // session's clock, and the end is published either way.
                state.edges.ended(
                    &crate::claude_edges::EdgeRecord {
                        session_key: &session_id,
                        stamp: &stamp,
                        sidecar_session_id: &sidecar_session_id,
                        session_type: &session_type,
                        clock: &clock,
                    },
                    rings,
                    cause.reason(),
                    &ownership_id,
                );
            }
        })
    }
}

// ── pending-set fold (Task 2) ────────────────────────────────────────────────────────────

/// How a line changed the session's pending approvals and questions.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PendingChange {
    /// From none to some: the session now waits on its user (the waiting edge).
    Waiting,
    /// From some to none.
    Drained,
}

impl PendingChange {
    fn between(before: usize, after: usize) -> Option<Self> {
        match (before, after) {
            (0, 1..) => Some(Self::Waiting),
            (1.., 0) => Some(Self::Drained),
            _ => None,
        }
    }
}

impl ClaudePending {
    fn len(&self) -> usize {
        self.permissions.len() + self.questions.len()
    }

    fn fold_frame(&mut self, value: &Value) -> Option<PendingChange> {
        let before = self.len();
        fold_pending_line(self, value);
        PendingChange::between(before, self.len())
    }
}

/// Fold one sidecar line into the session's pending approval/question state:
/// `sdk.permission.request`/`sdk.question.request` PUSH (resend of the same requestId
/// REPLACES — de-dupe), `sdk.permission.cancelled`/`sdk.question.cancelled` REMOVE.
/// Every other line is a no-op here. The cancelled frames are additionally forwarded
/// to the client (see `normalize_sdk_type`) — the fold never suppresses a broadcast.
/// Returns how the line changed the pending set's emptiness (C18: the server's
/// waiting edge rides the 0 -> >=1 change).
#[cfg(test)]
fn fold_pending_frame(
    pending: &std::sync::Mutex<ClaudePending>,
    value: &Value,
) -> Option<PendingChange> {
    pending.lock().expect("pending lock").fold_frame(value)
}

fn fold_pending_line(pending: &mut ClaudePending, value: &Value) {
    let Some(sdk_type) = value.get("type").and_then(Value::as_str) else {
        return;
    };
    match sdk_type {
        "sdk.permission.request" => {
            let Some(request_id) = value.get("requestId").and_then(frame_request_id) else {
                return;
            };
            let entry = PendingApprovalEntry {
                request_id,
                tool_name: value
                    .get("tool")
                    .and_then(|t| t.get("name"))
                    .and_then(Value::as_str)
                    .map(str::to_string),
                tool_use_id: value
                    .get("toolUseID")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                blocked_path: value
                    .get("blockedPath")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                decision_reason: value
                    .get("decisionReason")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                input: value.get("tool").and_then(|t| t.get("input")).cloned(),
                // Normalized like the questions below: the snapshot's strict
                // parse must never see an unknown variant or key (AGENT-06).
                suggestions: crate::claude_permission_update::normalize_permission_updates(
                    value.get("suggestions"),
                ),
            };
            pending
                .permissions
                .retain(|e| e.request_id != entry.request_id);
            pending.permissions.push(entry);
        }
        "sdk.permission.cancelled" => {
            if let Some(request_id) = value.get("requestId").and_then(frame_request_id) {
                pending.permissions.retain(|e| e.request_id != request_id);
            }
        }
        "sdk.question.request" => {
            let Some(request_id) = value.get("requestId").and_then(frame_request_id) else {
                return;
            };
            // Delta-review round 5 (AGENT-06): the pending set feeds ONLY the
            // respond-membership check and the snapshot overlay, so its question copy
            // is normalized to the strict wire contract on entry (see
            // [`normalize_question_definitions`]). The sibling WS broadcast
            // (`sdk_line_to_frame`) keeps the VERBATIM frame — an intentional
            // divergence: the event stream is schema-opaque and keeps
            // forwards-compat extras (e.g. `preview`), while the client parses the
            // REST snapshot against a `.strict()` schema that would reject them.
            let entry = PendingQuestionEntry {
                request_id,
                questions: normalize_question_definitions(value.get("questions")),
            };
            pending
                .questions
                .retain(|e| e.request_id != entry.request_id);
            pending.questions.push(entry);
        }
        "sdk.question.cancelled" => {
            if let Some(request_id) = value.get("requestId").and_then(frame_request_id) {
                pending.questions.retain(|e| e.request_id != request_id);
            }
        }
        _ => {}
    }
}

/// Normalize an `sdk.question.request`'s `questions` to the strict wire contract
/// (`shared/fresh-agent-contract.ts` `FreshAgentQuestionDefinitionSchema`): per
/// question exactly `{question, header?, options?, multiSelect?}` (keys omitted when
/// absent), per option exactly `{label, description}` — every other key is dropped at
/// those two levels. The Claude SDK's AskUserQuestion options may carry extras (e.g.
/// the documented `preview` field) and the sidecar preserves them verbatim
/// (`permission-channel.mjs`'s `...o`); relayed raw into the snapshot, the client's
/// `.strict()` parse rejects the whole snapshot response and the question card never
/// renders (delta review round 5, AGENT-06). Values are rewritten only by string
/// coercion of the known text fields (`frame_request_id`'s string|number tolerance)
/// and bool pass-through for `multiSelect`. Members that can never satisfy the
/// contract — a question without coercible `question` text, an option without
/// coercible `label`/`description` — are dropped so a malformed member cannot poison
/// the whole array. A missing/non-array `questions` yields an EMPTY array: the pending
/// entry itself stays (respond-membership semantics) with a contract-valid shape.
///
/// Intentional divergence: normalization applies ONLY to this snapshot-bound pending
/// copy. The WS broadcast of the same frame (`sdk_line_to_frame`) relays the sidecar
/// payload VERBATIM so the schema-opaque event stream keeps forwards-compat extras
/// for consumers that understand them.
fn normalize_question_definitions(questions: Option<&Value>) -> Value {
    let mut out = Vec::new();
    let Some(items) = questions.and_then(Value::as_array) else {
        return Value::Array(out);
    };
    for item in items {
        let Some(obj) = item.as_object() else {
            continue;
        };
        // `question` is contract-REQUIRED (z.string()) — drop a member without
        // coercible text; it could only ever break the snapshot parse.
        let Some(question) = obj.get("question").and_then(coerce_contract_string) else {
            continue;
        };
        let mut normalized = Map::new();
        normalized.insert("question".to_string(), Value::String(question));
        if let Some(header) = obj.get("header").and_then(coerce_contract_string) {
            normalized.insert("header".to_string(), Value::String(header));
        }
        if let Some(options) = obj.get("options").and_then(Value::as_array) {
            normalized.insert(
                "options".to_string(),
                Value::Array(
                    options
                        .iter()
                        .filter_map(normalize_question_option)
                        .collect(),
                ),
            );
        }
        if let Some(multi_select) = obj.get("multiSelect").and_then(Value::as_bool) {
            normalized.insert("multiSelect".to_string(), Value::Bool(multi_select));
        }
        out.push(Value::Object(normalized));
    }
    Value::Array(out)
}

/// One contract option: `label` + `description` are both REQUIRED strings — keep the
/// member only when both coerce, and then carry EXACTLY those two keys.
fn normalize_question_option(option: &Value) -> Option<Value> {
    let obj = option.as_object()?;
    let label = obj.get("label").and_then(coerce_contract_string)?;
    let description = obj.get("description").and_then(coerce_contract_string)?;
    let mut normalized = Map::new();
    normalized.insert("label".to_string(), Value::String(label));
    normalized.insert("description".to_string(), Value::String(description));
    Some(Value::Object(normalized))
}

/// String-coerce a contract text field (`frame_request_id`'s string|number tolerance):
/// a JSON string passes through, a number stringifies, anything else is absent.
fn coerce_contract_string(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_i64().map(|n| n.to_string()))
        .or_else(|| value.as_f64().map(|n| n.to_string()))
}

/// A sidecar frame's `requestId` as a string (the sidecar mints nanoid strings; tolerate
/// numeric ids so a non-string id can't wedge the fold).
fn frame_request_id(value: &Value) -> Option<String> {
    value
        .as_str()
        .map(str::to_string)
        .or_else(|| value.as_i64().map(|n| n.to_string()))
}

/// The coordinator key a claude session is owned under
/// ([`FreshClaudeState::claude_owner_key`]).
struct ClaudeOwnerKey {
    key: String,
    /// The key is the durable id the CLI reported (else the pane's wire id).
    reported: bool,
}

// ── sdk.* → freshAgent.event frame (port of sdk-events.ts normalizeFreshAgentProviderEvent) ─

/// Map an `sdk.*` event line from the sidecar to a `freshAgent.event` wire frame. Renames
/// the inner `type` `sdk.X → freshAgent.X` (only the known set — matching sdk-events.ts,
/// which passes unknown types through unchanged and thus never surfaces them as fresh-agent
/// events), preserving every other field, then wraps it in the envelope. Control lines
/// (`created` / `create.failed`) and unknown types return `None`.
fn sdk_line_to_frame(value: &Value, session_id: &str, session_type: &str) -> Option<String> {
    let sdk_type = value.get("type").and_then(Value::as_str)?;
    let fresh_type = normalize_sdk_type(sdk_type)?;

    // Clone the inner event, swapping only its `type` (structural parity with the TS
    // `{ ...providerEvent, type }` spread).
    let mut inner: Map<String, Value> = value.as_object()?.clone();
    inner.insert("type".to_string(), json!(fresh_type));

    let msg = ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: Value::Object(inner),
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: session_type.to_string(),
    });
    serde_json::to_string(&msg).ok()
}

/// The `sdk.* → freshAgent.*` rename table (server/fresh-agent/sdk-events.ts:48-83). Returns
/// `None` for a non-`sdk.` or unrecognized type (which the reference leaves unmapped).
fn normalize_sdk_type(sdk_type: &str) -> Option<&'static str> {
    Some(match sdk_type {
        "sdk.session.snapshot" => "freshAgent.session.snapshot",
        "sdk.session.changed" => "freshAgent.session.changed",
        "sdk.session.init" => "freshAgent.session.init",
        "sdk.checkpointTurnIdentity" => "checkpointTurnIdentity",
        "sdk.session.metadata" => "freshAgent.session.metadata",
        "sdk.assistant" => "freshAgent.assistant",
        "sdk.stream" => "freshAgent.stream",
        "sdk.result" => "freshAgent.result",
        "sdk.permission.request" => "freshAgent.permission.request",
        "sdk.permission.cancelled" => "freshAgent.permission.cancelled",
        "sdk.question.request" => "freshAgent.question.request",
        // Task 2 (fresh-eyes round-3 F3): forwarded, not dropped — the client folds
        // freshAgent.question.cancelled into removeQuestion (card clear on
        // provider-originated cancellation).
        "sdk.question.cancelled" => "freshAgent.question.cancelled",
        "sdk.status" => "freshAgent.status",
        // Non-terminal provider events (transcript-live plan P4): an API
        // retry and a notice (rate limit, informational banner, failed
        // compaction). Neither ends the turn; the client shows them in place.
        "sdk.retry" => "freshAgent.retry",
        "sdk.notice" => "freshAgent.notice",
        // `sdk.turn.complete` / `sdk.turn.waiting` are deliberately absent: the
        // server mints every edge itself (`claude_edges.rs`, C18), so no sidecar
        // line becomes one.
        "sdk.error" => "freshAgent.error",
        "sdk.killed" => "freshAgent.killed",
        _ => return None,
    })
}

/// `SessionType → wire string` for the claude provider (`freshclaude` | `kilroy`; both map
/// to provider `claude`). Any non-claude session type defaults to `freshclaude` (this slice
/// is only ever dispatched for the claude provider).
fn session_type_str(session_type: SessionType) -> &'static str {
    match session_type {
        SessionType::Kilroy => "kilroy",
        _ => "freshclaude",
    }
}

/// kata b8ke Task 6 (round-2 review): the claude lane covers BOTH flavors —
/// `freshclaude` and `kilroy` — and the flavor is a PARAM, so the handoff
/// runner's `resume_for_handoff` maps its wire string back to the enum
/// (never by provider alone: a kilroy session must resume AS kilroy).
fn session_type_from_flavor(flavor: &str) -> Option<SessionType> {
    match flavor {
        "freshclaude" => Some(SessionType::Freshclaude),
        "kilroy" => Some(SessionType::Kilroy),
        _ => None,
    }
}

/// The approval/question respond `requestId` as a string (the wire type is
/// `string | number`; the pending fold keys on the sidecar-minted nanoid string, so a
/// numeric respond id can still match its entry).
fn request_id_string(request_id: &freshell_protocol::StringOrNumber) -> String {
    match request_id {
        freshell_protocol::StringOrNumber::Str(s) => s.clone(),
        freshell_protocol::StringOrNumber::Num(n) => n.to_string(),
    }
}

/// The `freshAgent.error{code:'INVALID_SESSION_ID'}` shape (`sdk-events.ts:37`) the client
/// folds into `markSessionLost` (`fresh-agent-ws.ts:326-328`) instead of hanging on a stale
/// `freshAgent.attach` for a session this server has never heard of. Third copy after
/// `codex.rs`/`opencode_ws.rs` (both document the duplication) -- but unlike those two this
/// one cannot hardcode the session type: provider `claude` covers BOTH `freshclaude` and
/// `kilroy`, so the envelope's sessionType comes from the attach message.
/// The durable claude id an attach carries: `sessionRef.sessionId` first,
/// then the legacy `resumeSessionId` fallback — flipped from legacy-first
/// (kata ejh6 section 4b hygiene). After the wire-level reject on
/// `freshAgent.attach`, the legacy field is dead for external input; the
/// fallback remains only for internal/test constructions. Only canonical
/// UUIDs qualify (`shared/session-contract.ts:34`) — a nanoid here would
/// just miss the store.
fn attach_durable_id(msg: &FreshAgentAttach) -> Option<String> {
    let candidate = msg
        .session_ref
        .as_ref()
        .filter(|reference| reference.provider == PROVIDER)
        .map(|r| r.session_id.clone())
        .or_else(|| msg.resume_session_id.clone())
        .or_else(|| is_canonical_claude_uuid(&msg.session_id).then(|| msg.session_id.clone()))?;
    is_canonical_claude_uuid(&candidate).then_some(candidate)
}

fn is_canonical_claude_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

/// The codex-shape status snapshot (`freshAgent.session.snapshot`) claude emits as the
/// attach ack (rebind + resume-on-attach arms): provider-agnostic client-side
/// (`fresh-agent-ws.ts:196-206`), it settles the pane to the session's REAL tracked
/// status and hands the durable UUID over via `timelineSessionId`.
fn status_snapshot_frame(
    session_id: &str,
    timeline_session_id: &str,
    status: &str,
    session_type: &str,
) -> ServerMessage {
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: json!({
            "type": "freshAgent.session.snapshot",
            "sessionId": session_id,
            "latestTurnId": Value::Null,
            "status": status,
            "timelineSessionId": timeline_session_id,
        }),
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: session_type.to_string(),
    })
}

/// Why a resume-on-attach could not produce a live session (codex's
/// `ResumeSessionError` analog).
#[derive(Debug)]
enum ResumeClaudeError {
    /// The transcript store positively has no file for this durable id.
    NotFound,
    /// Spawn/pipe/`created` failure -- the session may be perfectly resumable;
    /// NEVER declared lost (opencode_ws.rs discipline).
    Transient(String),
}

/// A request the session's turn lock serializes (design §3.3). Each one that
/// waited on the lock re-resolves its session afterwards
/// ([`FreshClaudeState::live_key_after_turn_wait`]): an undo or redo holding
/// the lock may have replaced the runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum TurnLockedRequest {
    Send,
    Configure,
    Compact,
    Fork,
}

impl TurnLockedRequest {
    /// The event logged when the request follows a replacement.
    fn followed_replacement_event(self) -> &'static str {
        match self {
            Self::Send => "freshagent.claude.send_followed_replacement",
            Self::Configure => "freshagent.claude.configure_followed_replacement",
            Self::Compact => "freshagent.claude.compact_followed_replacement",
            Self::Fork => "freshagent.claude.fork_followed_replacement",
        }
    }
}

fn lost_session_frame(session_id: &str, session_type: SessionType) -> ServerMessage {
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: json!({
            "type": "freshAgent.error",
            "sessionId": session_id,
            "code": "INVALID_SESSION_ID",
            "message": format!("claude session {session_id} not found"),
        }),
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: session_type_str(session_type).to_string(),
    })
}

// ── Node sidecar spawn ──────────────────────────────────────────────────────────────────

/// A just-spawned claude sidecar: the owned child with its stdin and stdout, the
/// ownership tag the reaper finds its tree by, the labels its stderr log carries
/// (bound to the session once the sidecar names it), and the guard that owns the
/// child's whole process tree (G31).
struct SpawnedSidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    ownership_id: String,
    log_labels: crate::claude_sidecar_io::SidecarLogLabels,
    tree_guard: crate::claude_spawn::SidecarTreeGuard,
}

/// The session sidecar's launch recipe (G30: the model-catalog probe uses the same
/// builder, see `model_capabilities::catalog_node_command`): run-as wrapper, managed
/// secrets plus the OneCLI key flag, and the `/proc` ownership tag.
pub(crate) fn sidecar_node_command(
    command: crate::claude_spawn::ClaudeNodeCommand,
    ownership_id: &str,
) -> crate::claude_spawn::ClaudeNodeCommand {
    command
        .with_run_as()
        .with_managed_environment()
        .with_ownership_tag(ownership_id)
}

/// Spawn `node <sidecar>/index.mjs` for a session of `session_type`, ownership-tagged,
/// inheriting the server's isolated HOME (so the SDK's `claude` CLI authenticates from +
/// writes under `<isolatedHOME>/.claude`), inside its process-tree guard (G31). Its
/// stderr is re-emitted through `tracing` (`claude_sidecar_io::spawn_stderr_logger`, G14).
/// `environment`: when set, the sidecar's complete environment (the
/// `test-support` seam); otherwise it inherits this process's.
async fn spawn_sidecar(
    environment: Option<&[(String, String)]>,
    freshell_endpoint: Option<&crate::claude_freshell_mcp::FreshellEndpoint>,
    session_type: &str,
) -> Result<SpawnedSidecar, String> {
    let entry = sidecar_entry_path();
    if !entry.exists() {
        return Err(format!(
            "claude sidecar entry not found at {}",
            entry.display()
        ));
    }
    let ownership_id = mint_ownership_id();
    // Inherit the parent env (HOME=<isolated>, CLAUDE_HOME=<isolated>/.claude) and layer the
    // ownership tag so the /proc reaper can find our sidecar AND the claude CLI grandchild
    // (the SDK's clean-env passes FRESHELL_CLAUDE_SIDECAR_ID through — it strips only
    // CLAUDECODE + ANTHROPIC_API_KEY). A configured environment (test rigs) replaces the
    // inherited one; the tag and the managed secrets still layer over it.
    let command = sidecar_node_command(
        crate::claude_spawn::ClaudeNodeCommand::new(&entry),
        &ownership_id,
    )
    .with_complete_environment(environment)
    .with_freshell_endpoint(freshell_endpoint);
    let node = command.node().to_string();
    let (mut child, tree_guard) = command.spawn_guarded().map_err(|error| match error {
        crate::claude_spawn::ClaudeSpawnError::ExecProfile(classification) => classification,
        crate::claude_spawn::ClaudeSpawnError::Spawn(error) => format!(
            "claude sidecar spawn failed ({node} {}): {error}",
            entry.display()
        ),
    })?;
    let stdin = child.stdin.take().ok_or("sidecar stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("sidecar stdout unavailable")?;
    let log_labels =
        crate::claude_sidecar_io::SidecarLogLabels::new(&ownership_id, session_type, child.id());
    // Read stderr continuously (so verbose SDK/CLI output can never fill the pipe and
    // stall the sidecar) and log it; the task ends when the sidecar does.
    if let Some(stderr) = child.stderr.take() {
        crate::claude_sidecar_io::spawn_stderr_logger(
            stderr,
            log_labels.clone(),
            crate::claude_sidecar_io::hosted_sidecar(environment),
        );
    }
    Ok(SpawnedSidecar {
        child,
        stdin,
        stdout,
        ownership_id,
        log_labels,
        tree_guard,
    })
}

#[cfg(all(test, target_os = "linux"))]
mod provider_exec_tests {
    use super::*;

    #[tokio::test]
    async fn provider_exec_profile_checks_actual_managed_claude_sidecar_spawn() {
        const CASE: &str = "FRESHELL_EXEC_PROFILE_FIXTURE_CHILD";
        if let Ok(case) = std::env::var(CASE) {
            let owned = tempfile::tempdir().unwrap();
            let script = owned.path().join("synthetic-sidecar.mjs");
            std::fs::write(&script, "setInterval(()=>{},1000)\n").unwrap();
            std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
            let count = if case == "large" { 17 } else { 1 };
            freshell_platform::managed_child_secrets::install(
                (0..count)
                    .map(|i| (format!("FRESHELL_EXEC_FIXTURE_{i}"), "x".repeat(64 * 1024)))
                    .collect(),
            )
            .unwrap();
            let mut result = spawn_sidecar(None, None, "freshclaude").await;
            if let Ok(SpawnedSidecar { child, .. }) = &mut result {
                let pid = child.id().unwrap();
                child.kill().await.unwrap();
                child.wait().await.unwrap();
                eprintln!("synthetic owned sidecar pid {pid} stopped in fixture namespace");
            }
            if case == "large" {
                assert!(matches!(result,Err(ref cause) if cause.contains("provider exec profile")),"managed fresh sidecar must reject oversized actual inherited+selected environment before spawn");
            } else {
                assert!(result.is_ok(),"valid finite selected environment must still launch the actual sidecar command");
            }
            return;
        }
        for case in ["large", "small"] {
            let output=std::process::Command::new(std::env::current_exe().unwrap()).env_clear()
                .env("PATH","/usr/local/bin:/usr/bin:/bin").env(CASE,case)
                .args(["--exact","claude::provider_exec_tests::provider_exec_profile_checks_actual_managed_claude_sidecar_spawn","--nocapture"])
                .output().unwrap();
            assert!(
                output.status.success(),
                "actual sidecar fixture case {case} failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}

/// Resolve the sidecar entry (`index.mjs`). `FRESHELL_CLAUDE_SIDECAR` overrides; otherwise
/// the vendored package sits beside this crate at `crates/freshell-claude-sidecar/index.mjs`
/// (baked from `CARGO_MANIFEST_DIR` so it is cwd-independent).
pub(crate) fn sidecar_entry_path() -> PathBuf {
    if let Ok(path) = std::env::var("FRESHELL_CLAUDE_SIDECAR") {
        if !path.is_empty() {
            return PathBuf::from(path);
        }
    }
    PathBuf::from(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../freshell-claude-sidecar/index.mjs"
    ))
}

/// Write one newline-delimited JSON request to the sidecar's stdin.
async fn write_line(stdin: &mut ChildStdin, value: &Value) -> Result<(), String> {
    let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    line.push('\n');
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stdin.flush().await.map_err(|e| e.to_string())
}

// ── ownership / reaping (Linux /proc, mirrors freshell-codex) ───────────────────────────

/// Mint a unique sidecar ownership id (`claude-sidecar-<uuid>`) — the codex analog is
/// `codex-sidecar-<uuid>` (`runtime.ts:924`).
fn mint_ownership_id() -> String {
    format!("claude-sidecar-{}", uuid::Uuid::new_v4())
}

/// `killOwnedProcesses` analog for claude: SIGTERM any process whose `/proc/<pid>/environ`
/// carries our `FRESHELL_CLAUDE_SIDECAR_ID=<ownership_id>` tag — the Node sidecar AND the
/// `claude` CLI grandchild the SDK spawns (which inherits the tag through the SDK clean-env).
/// Linux `/proc`-based, best-effort; only processes carrying OUR unique tag are signaled.
#[cfg(target_os = "linux")]
fn reap_owned_claude_sidecars(ownership_id: &str) {
    for pid in owned_claude_sidecar_pids(ownership_id) {
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
}
#[cfg(not(target_os = "linux"))]
fn reap_owned_claude_sidecars(_ownership_id: &str) {
    // Non-Linux: the direct child is reaped via kill_on_drop; the /proc environ scan is
    // Linux-only (matches the reference's platform guard).
}

/// Every live pid whose `/proc/<pid>/environ` carries this sidecar's ownership
/// tag (the Node sidecar AND its SDK-spawned CLI grandchildren). Readable only
/// for processes this process may ptrace (YAMA) — see
/// [`capture_owned_claude_tree`] for why callers capture BEFORE killing.
#[cfg(target_os = "linux")]
fn owned_claude_sidecar_pids(ownership_id: &str) -> Vec<i32> {
    let needle = format!("{CLAUDE_SIDECAR_OWNERSHIP_ENV}={ownership_id}");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(pid) = name.parse::<i32>() else {
            continue;
        };
        let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else {
            continue;
        };
        let carries_tag = environ
            .split(|&b| b == 0)
            .any(|var| var == needle.as_bytes());
        if carries_tag {
            out.push(pid);
        }
    }
    out
}

/// b8ke delta review F2 (confirmed reap): the ownership-tagged tree as
/// `(pid, starttime)` pairs, captured BEFORE the teardown's kills. YAMA
/// (`ptrace_scope=1`, the Ubuntu default) makes a reparented
/// grandchild's `/proc/<pid>/environ` unreadable the moment the sidecar
/// dies, so the environ scan is taken while the chain is intact and death
/// is later confirmed via the world-readable `/proc/<pid>/stat` with a
/// starttime match (the pid-reuse guard) — the
/// [`crate::session_lease::kill_and_confirm_tree_dead`] discipline. The
/// sidecar child itself is included even when untagged (the fake-session
/// test fixtures spawn it without the env).
#[cfg(target_os = "linux")]
fn capture_owned_claude_tree(ownership_id: &str, child_pid: Option<u32>) -> Vec<(i32, u64)> {
    let mut tree: Vec<(i32, u64)> = owned_claude_sidecar_pids(ownership_id)
        .into_iter()
        .filter_map(|p| crate::session_lease::proc_starttime(p).map(|st| (p, st)))
        .collect();
    if let Some(pid) = child_pid {
        if !tree.iter().any(|(p, _)| *p == pid as i32) {
            if let Some(st) = crate::session_lease::proc_starttime(pid as i32) {
                tree.push((pid as i32, st));
            }
        }
    }
    tree
}
#[cfg(not(target_os = "linux"))]
fn capture_owned_claude_tree(_ownership_id: &str, _child_pid: Option<u32>) -> Vec<(i32, u64)> {
    Vec::new()
}

/// The kill-family teardown's confirmed-death answer (b8ke focused review
/// FR3): fail closed — a teardown that cannot confirm the runtime tree's
/// death says so with a typed result, never a silent success.
enum TeardownConfirmation {
    /// The direct child exited AND (on Linux) every captured tagged
    /// descendant is confirmed dead-by-starttime.
    Confirmed,
    /// The bounded confirmation rounds expired with tagged descendants
    /// still alive — death is UNCONFIRMED. Carries the captured tree and
    /// its ownership id so a caller that owns the coordinator fence (the
    /// handoff runner) can keep escalating detached.
    NotConfirmed {
        tree: Vec<(i32, u64)>,
        ownership_id: String,
    },
    /// Non-Linux (the typed platform limitation): the direct child's exit
    /// was AWAITED (the portable confirmation floor), but the
    /// descendant-tree check requires the Linux `/proc` walk — the gap is
    /// named here and in the structured log, never silently reported as a
    /// full confirmation. (Constructed only under `cfg(not(linux))` —
    /// dead-code on the Linux build by construction.)
    #[allow(dead_code)]
    PlatformLimited,
}

impl TeardownConfirmation {
    /// The log label (`freshagent.claude.teardown`'s `confirmation`).
    fn label(&self) -> &'static str {
        match self {
            Self::Confirmed => "confirmed",
            Self::NotConfirmed { .. } => "not_confirmed",
            Self::PlatformLimited => "platform_limited",
        }
    }
}

/// b8ke focused round-2 review R2-2: the typed outcome of the shared
/// logged teardown ([`FreshClaudeState::teardown_removed_session_logged`]).
/// `NotConfirmed` carries the DETACHED escalation handle (the SIGKILL
/// rounds keep killing the captured tree until it is dead) so a caller
/// holding a coordinator fence — the explicit kill's `Stopping` — can
/// defer its commit until the escalation confirms death.
enum LoggedTeardown {
    Confirmed,
    PlatformLimited,
    NotConfirmed {
        escalation: tokio::task::JoinHandle<bool>,
    },
}

/// A sidecar stop's typed outcome (b8ke focused round-2 review R2-2): an
/// unconfirmed tree is never a silent success — the structured error line
/// lands AND the detached escalation keeps killing the tree, its handle in
/// the answer.
fn escalate_unconfirmed_teardown(
    confirmation: TeardownConfirmation,
    session_label: String,
) -> LoggedTeardown {
    match confirmation {
        TeardownConfirmation::Confirmed => LoggedTeardown::Confirmed,
        TeardownConfirmation::PlatformLimited => LoggedTeardown::PlatformLimited,
        TeardownConfirmation::NotConfirmed { tree, ownership_id } => {
            tracing::error!(target: "freshell_freshagent::claude",
                session_id = %session_label,
                lingering = tree.len(),
                "freshagent.claude.teardown_unconfirmed: the bounded confirmation \
                 window expired with tagged descendants still alive — the teardown \
                 did NOT confirm the runtime tree's death; the escalation continues \
                 detached and the caller's coordinator fence (if any) stays held"
            );
            LoggedTeardown::NotConfirmed {
                escalation: spawn_claude_tree_death_escalation(tree, ownership_id, session_label),
            }
        }
    }
}

/// The detached unconfirmed-tree escalation (b8ke focused round-2 review
/// R2-2): SIGTERM→SIGKILL windows until the captured tree is confirmed
/// dead-by-starttime ([`escalate_until_dead`]). Resolves `true` only on
/// confirmed death — the deferred stop commit releases on exactly that.
fn spawn_claude_tree_death_escalation(
    tree: Vec<(i32, u64)>,
    ownership_id: String,
    session_label: String,
) -> tokio::task::JoinHandle<bool> {
    tokio::spawn(async move {
        let mut captured = CapturedClaudeTree { tree, ownership_id };
        escalate_until_dead(&mut captured, &session_label).await
    })
}

/// One bounded kill-and-confirm window of the detached escalation.
trait TreeDeathWindow {
    /// Signal the tree and poll it for one window; `true` once every member
    /// is confirmed dead.
    async fn confirm_dead(&mut self) -> bool;
    /// How many members were still alive after the last window.
    fn lingering(&self) -> usize;
}

/// The captured ownership-tagged tree a stop could not confirm gone.
struct CapturedClaudeTree {
    tree: Vec<(i32, u64)>,
    ownership_id: String,
}

impl TreeDeathWindow for CapturedClaudeTree {
    async fn confirm_dead(&mut self) -> bool {
        confirm_captured_claude_tree_dead(
            &mut self.tree,
            &self.ownership_id,
            TREE_DEATH_CONFIRM_ROUNDS,
        )
        .await
    }

    fn lingering(&self) -> usize {
        self.tree.len()
    }
}

/// The detached escalation's pause before the next window, after
/// `failed_windows` windows that ended with the tree alive: half a second,
/// doubling, at most a minute. A tree that outlives a whole window
/// (SIGKILL included) is stuck in the kernel; retrying it at once would only
/// rescan `/proc` every 25 ms and warn every 0.6 s for as long as it stays
/// stuck.
fn escalation_pause(failed_windows: u32) -> Duration {
    const FIRST: Duration = Duration::from_millis(500);
    const LONGEST: Duration = Duration::from_secs(60);
    let doublings = failed_windows.saturating_sub(1).min(16);
    FIRST.saturating_mul(1 << doublings).min(LONGEST)
}

/// Run `window` until it confirms the tree dead, pausing between windows
/// ([`escalation_pause`]). It never gives up: an explicit kill's deferred
/// stop commit waits on the confirmation. Each unconfirmed window logs
/// `freshagent.claude.teardown_escalation_continues` (warn), the
/// confirmation `freshagent.claude.teardown_escalation_confirmed` (info).
async fn escalate_until_dead(window: &mut impl TreeDeathWindow, session_label: &str) -> bool {
    let started = std::time::Instant::now();
    let mut failed_windows: u32 = 0;
    while !window.confirm_dead().await {
        failed_windows = failed_windows.saturating_add(1);
        let pause = escalation_pause(failed_windows);
        tracing::warn!(target: "freshell_freshagent::claude",
            session_id = %session_label,
            lingering = window.lingering(),
            windows = failed_windows,
            next_window_in_ms = u64::try_from(pause.as_millis()).unwrap_or(u64::MAX),
            "freshagent.claude.teardown_escalation_continues: the detached tree-death \
             escalation's window ended with the tree still alive; it tries again after a pause"
        );
        tokio::time::sleep(pause).await;
    }
    tracing::info!(target: "freshell_freshagent::claude",
        session_id = %session_label,
        windows = failed_windows.saturating_add(1),
        elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        "freshagent.claude.teardown_escalation_confirmed: the detached escalation confirmed \
         the runtime tree's death"
    );
    true
}

/// The bounded SIGTERM→SIGKILL confirmation round budget (24 × 25ms with
/// the escalation at round 20 — the [`kill_and_confirm_tree_dead`]
/// discipline).
const TREE_DEATH_CONFIRM_ROUNDS: u8 = 24;

/// b8ke delta review F2: poll the captured tree until every member is
/// confirmed dead-by-starttime (a zombie counts — it holds no pipes and
/// writes nothing), escalating SIGTERM → SIGKILL after 20 rounds and
/// folding in any still-readable tagged newcomers. Returns `true` only
/// when the captured tree is confirmed gone within `rounds` rounds (the
/// callers' reap timeouts bound the whole teardown; b8ke focused FR3 made
/// the answer typed — an exhausted window is NOT a confirmation).
#[cfg(target_os = "linux")]
async fn confirm_captured_claude_tree_dead(
    tree: &mut Vec<(i32, u64)>,
    ownership_id: &str,
    rounds: u8,
) -> bool {
    for round in 0..rounds {
        tree.retain(|(p, st)| crate::session_lease::proc_starttime(*p) == Some(*st));
        for p in owned_claude_sidecar_pids(ownership_id) {
            if !tree.iter().any(|(q, _)| *q == p) {
                if let Some(st) = crate::session_lease::proc_starttime(p) {
                    tree.push((p, st));
                }
            }
        }
        if tree.is_empty() {
            return true;
        }
        let sig = if round < 20 {
            libc::SIGTERM
        } else {
            libc::SIGKILL
        };
        for (p, _) in &*tree {
            unsafe {
                libc::kill(*p, sig);
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    tree.retain(|(p, st)| crate::session_lease::proc_starttime(*p) == Some(*st));
    tree.is_empty()
}
#[cfg(not(target_os = "linux"))]
async fn confirm_captured_claude_tree_dead(
    _tree: &mut Vec<(i32, u64)>,
    _ownership_id: &str,
    _rounds: u8,
) -> bool {
    // Non-Linux: no /proc — the direct child's awaited exit (the caller's
    // `child.wait()`) is the platform's confirmation floor; the
    // descendant-tree gap is the caller's typed PlatformLimited result.
    true
}

// ── helpers ─────────────────────────────────────────────────────────────────────────────

/// The kill-family session teardown, shared by the kill's own removal, the
/// round-5 post-close sweep, the claim lanes' late-orphan unwinds, the
/// rollback's replacement of the old sidecar, and server shutdown:
/// abort + join the consumer, send the graceful sidecar shutdown line and
/// give node [`crate::claude_spawn::SIDECAR_GRACEFUL_EXIT`] to exit (G31:
/// escalation only after that), then the `/proc` ownership reap and the
/// tree-death confirmation. Round 5's design
/// rule (the durable close precedes every teardown/settlement await) means
/// callers only run this AFTER the close is durable — a crash anywhere in
/// here never loses it.
///
/// b8ke delta review F2 (confirmed reap): the teardown AWAITS the child's
/// actual exit and confirms every ownership-tagged descendant gone before
/// returning — `kill_for_handoff` may only answer `StopResult::Reaped`
/// after this (the confirmed-reap ordering the handoff contract requires).
/// The tagged tree is captured FIRST (YAMA: once the sidecar dies, the
/// reparented grandchildren's environ becomes unreadable), mirroring
/// [`crate::session_lease::kill_and_confirm_tree_dead`].
///
/// b8ke focused review FR3: the answer is TYPED and fails closed — an
/// exhausted confirmation window with tagged descendants still alive is
/// [`TeardownConfirmation::NotConfirmed`] (carrying the tree for a
/// detached escalation), never a silent success. Non-Linux answers the
/// typed [`TeardownConfirmation::PlatformLimited`] (the child's awaited
/// exit is the portable floor; the descendant-tree check is
/// Linux-limited). `confirm_rounds` bounds the confirmation window (the
/// production callers pass [`TREE_DEATH_CONFIRM_ROUNDS`]).
async fn teardown_removed_session(
    session: ClaudeSession,
    confirm_rounds: u8,
) -> TeardownConfirmation {
    teardown_removed_session_within(
        session,
        confirm_rounds,
        crate::claude_spawn::SIDECAR_GRACEFUL_EXIT,
    )
    .await
}

/// [`teardown_removed_session`] with an explicit grace period (server stop
/// passes the shorter [`crate::claude_spawn::SERVER_STOP_GRACE`]).
async fn teardown_removed_session_within(
    session: ClaudeSession,
    confirm_rounds: u8,
    grace: Duration,
) -> TeardownConfirmation {
    let started = std::time::Instant::now();
    let processes = SidecarProcesses {
        child: session.child,
        stdin: session.stdin,
        tree_guard: session.tree_guard,
        ownership_id: session.ownership_id,
    };
    let tree = processes.capture_tree();
    session.consumer.abort();
    let _ = session.consumer.await;
    let (exit, confirmation) = processes
        .stop(tree, &session.sidecar_session_id, confirm_rounds, grace)
        .await;
    log_claude_teardown(&session.sidecar_session_id, &exit, started, &confirmation);
    confirmation
}

/// A claude sidecar's processes, taken out of its session record to be
/// stopped: node with its stdin, the guard that owns node's whole process
/// tree (G31), and the ownership tag the `/proc` reaper finds that tree by.
struct SidecarProcesses {
    child: Child,
    stdin: crate::claude_sidecar_io::SidecarWriter,
    tree_guard: crate::claude_spawn::SidecarTreeGuard,
    ownership_id: String,
}

impl SidecarProcesses {
    /// The ownership-tagged tree as `(pid, starttime)` pairs. Capture it
    /// before anything is stopped: YAMA hides a reparented grandchild's
    /// environ once node is gone ([`capture_owned_claude_tree`]).
    fn capture_tree(&self) -> Vec<(i32, u64)> {
        capture_owned_claude_tree(&self.ownership_id, self.child.id())
    }

    /// The ONE way a claude sidecar's process tree is stopped and reaped, for
    /// a requested teardown and for a sidecar that ended on its own (C08)
    /// alike. G31: ask first — the shutdown request lets the sidecar abort
    /// its SDK query (which stops the claude CLI mid-turn) and exit;
    /// SIGTERM/SIGKILL only after `grace`. A sidecar that already ended no
    /// longer reads the request, so its stop is just the wait for node's exit
    /// status and the guard settling the rest of the tree. Node's reaped exit
    /// is the portable confirmation floor, awaited on EVERY platform; then
    /// the `/proc` ownership reap and the captured `tree`'s confirmed death
    /// (bounded poll, SIGKILL escalation — a TERM-immune grandchild cannot
    /// outlive this).
    async fn stop(
        self,
        mut tree: Vec<(i32, u64)>,
        session_label: &str,
        confirm_rounds: u8,
        grace: Duration,
    ) -> (crate::claude_spawn::SidecarExit, TeardownConfirmation) {
        let exit = crate::claude_spawn::graceful_then_kill_with_writer(
            self.child,
            self.stdin,
            self.tree_guard,
            grace,
        )
        .await;
        reap_owned_claude_sidecars(&self.ownership_id);
        #[cfg(target_os = "linux")]
        let confirmation = {
            let _ = session_label;
            if confirm_captured_claude_tree_dead(&mut tree, &self.ownership_id, confirm_rounds)
                .await
            {
                TeardownConfirmation::Confirmed
            } else {
                TeardownConfirmation::NotConfirmed {
                    tree,
                    ownership_id: self.ownership_id,
                }
            }
        };
        // Off Linux the process-tree guard is the confirmation (macOS: the
        // sidecar's process group is empty). Without a guard the typed
        // platform limitation stands: node's awaited exit is the only floor.
        #[cfg(not(target_os = "linux"))]
        let confirmation = {
            let _ = (&mut tree, confirm_rounds);
            if exit.tree == crate::claude_spawn::TreeConfirmation::Confirmed {
                TeardownConfirmation::Confirmed
            } else {
                tracing::warn!(target: "freshell_freshagent::claude",
                    session_id = %session_label,
                    platform_limitation = "descendant_tree_unverifiable",
                    tree = ?exit.tree,
                    "freshagent.claude.teardown_platform_limited: the process-tree guard could \
                     not confirm the sidecar's descendants gone; node's awaited exit is the only \
                     confirmation"
                );
                TeardownConfirmation::PlatformLimited
            }
        };
        (exit, confirmation)
    }
}

/// The one structured record of every sidecar stop (G31): `info` when the
/// sidecar honored the shutdown request, `warn` when it crashed on its way
/// down or had to be forced.
fn log_claude_teardown(
    session_id: &str,
    exit: &crate::claude_spawn::SidecarExit,
    started: std::time::Instant,
    confirmation: &TeardownConfirmation,
) {
    use crate::claude_spawn::SidecarStop;
    let elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let confirmation = confirmation.label();
    let graceful = exit.graceful();
    let stop = exit.stop.label();
    match exit.stop {
        SidecarStop::Graceful => tracing::info!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.teardown",
            session_id, graceful, stop, elapsed_ms, confirmation,
            "claude sidecar stopped on its shutdown request"
        ),
        SidecarStop::AbnormalExit => tracing::warn!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.teardown",
            session_id, graceful, stop, elapsed_ms, confirmation,
            exit_code = exit.status.and_then(|status| status.code()),
            "claude sidecar exited abnormally while stopping; its process tree was killed at once"
        ),
        SidecarStop::Forced => tracing::warn!(target: "freshell_freshagent::claude",
            event = "freshagent.claude.teardown",
            session_id, graceful, stop, elapsed_ms, confirmation,
            node_reaped = exit.status.is_some(),
            "claude sidecar ignored its shutdown request for the grace period and was killed"
        ),
    }
}

mod create_binding;
mod create_outcome;
mod deadman;
mod recovery;
pub use create_outcome::ClaudeCreateOutcome;

mod send_outcome;
pub use send_outcome::ClaudeSendOutcome;

mod attach;
mod establish;
mod fork;
mod genesis;
mod history;
mod pending_runtime;
mod rekey;
use pending_runtime::{is_pending_frame, PendingResponse};
mod rollback;
mod sidecar_writer;
mod stop;
mod turn_status;
use establish::{
    BootRetry, DurableClaim, EstablishLane, EstablishPlan, InheritedRuntime, LaunchLease,
    RegisterUnder,
};

#[cfg(test)]
mod teardown_tests;

#[cfg(test)]
mod end_of_output_tests;

#[cfg(test)]
mod live_frames_tests;

#[cfg(test)]
mod pending_tests;

/// ISO-8601 / RFC-3339 millis-Z timestamp (`new Date().toISOString()`) for error frames.
fn now_iso() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let millis = now.subsec_millis();
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (hour, min, sec) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{min:02}:{sec:02}.{millis:03}Z")
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::naming::SessionNaming as _;

    mod control_tests;
    mod create_binding_tests;
    mod deadman_tests;
    mod recovery_tests;
    mod refusal_tests;

    fn state() -> FreshClaudeState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshClaudeState::new(Arc::new(tx))
    }

    fn state_with_bus() -> (FreshClaudeState, tokio::sync::broadcast::Receiver<String>) {
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(64);
        (FreshClaudeState::new(Arc::new(tx)), rx)
    }

    #[cfg(target_os = "linux")]
    async fn spawn_term_immune_tagged_child(
        ownership_id: &str,
    ) -> (tokio::process::Child, tempfile::TempDir) {
        let readiness = tempfile::tempdir().expect("readiness directory");
        let ready_path = readiness.path().join("term-trap-ready");
        let child = tokio::process::Command::new("bash")
            .arg("-c")
            .arg("trap '' TERM; printf ready > \"$FRESHELL_TEST_CHILD_READY\"; while :; do sleep 1; done")
            .env(CLAUDE_SIDECAR_OWNERSHIP_ENV, ownership_id)
            .env("FRESHELL_TEST_CHILD_READY", &ready_path)
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the lingering tagged grandchild");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        while !ready_path.exists() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "child never installed its TERM trap"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        (child, readiness)
    }

    fn attach_msg(session_id: &str) -> FreshAgentAttach {
        FreshAgentAttach {
            tab_id: None,
            pane_id: None,
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
            resume_session_id: None,
            session_ref: None,
        }
    }

    /// Insert a fake tracked session directly into the map, bypassing the sidecar spawn
    /// (the claude analog of codex.rs's `spawn_sleeper` + `insert_fake_session`). The
    /// `sleep 30` child stands in for the Node sidecar; `kill_on_drop` reaps it at test end.
    async fn insert_fake_claude_session(st: &FreshClaudeState, session_id: &str) {
        let mut child = tokio::process::Command::new("sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sleeper");
        let stdin = child.stdin.take().expect("piped stdin");
        let consumer = tokio::spawn(async {});
        st.sessions.lock().await.insert(
            session_id.to_string(),
            ClaudeSession {
                session_type: "freshclaude".into(),
                quiet: Default::default(),
                configuration: ClaudeConfiguration::default(),
                stdin: stdin.into(),
                child,
                tree_guard: crate::claude_spawn::SidecarTreeGuard::unguarded(),
                ownership_id: format!("test-{session_id}"),
                consumer,
                sidecar_session_id: session_id.to_string(),
                cli_session_id: None,
                owning_operation: None,
                owning_generation: None,
                broadcast_id: Arc::new(std::sync::Mutex::new(session_id.to_string())),
                pending: Arc::new(std::sync::Mutex::new(ClaudePending::default())),
                ledger: crate::claude_turns::SharedLedger::default(),
                clock: crate::attention::AttentionClock::default(),
                turn_lock: Arc::new(TokioMutex::new(())),
                launch_genesis: None,
            },
        );
    }

    /// b8ke delta review F2 (confirmed reap): the handoff teardown must not
    /// report `StopResult::Reaped` until the sidecar child has ACTUALLY
    /// exited and every ownership-tagged descendant is confirmed gone. A
    /// "CLI grandchild" that ignores SIGTERM lingers through the old
    /// teardown (it only ever SIGTERMs the tagged tree) — pre-fix,
    /// `kill_for_handoff` answers Reaped while that process still lives.
    ///
    /// b8ke focused review FR4: Linux-gated — the assertion predicate is
    /// `session_lease::proc_starttime`, which exists only under
    /// `cfg(target_os = "linux")` (the `/proc/<pid>/stat` walk); an ungated
    /// reference fails to COMPILE the crate on macOS/Windows.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn kill_for_handoff_confirms_the_tagged_tree_dead_before_reporting_reaped() {
        let st = state();
        let sid = uuid::Uuid::new_v4().to_string();
        insert_fake_claude_session(&st, &sid).await;
        // The lingering ownership-tagged "CLI grandchild": SIGTERM-immune
        // (only the confirmed-death escalation's SIGKILL can end it).
        // `kill_on_drop` backstops the assertion's own failure path.
        let (mut grandchild, _readiness) =
            spawn_term_immune_tagged_child(&format!("test-{sid}")).await;
        let grandchild_pid = grandchild.id().expect("grandchild pid");

        let result = st.kill_for_handoff(&sid, "test-f2").await;

        assert!(
            matches!(result, crate::session_handoff::StopResult::Reaped),
            "the teardown completed: {result:?}"
        );
        // THE confirmed-reap contract: by the time Reaped is reported, the
        // tagged tree is confirmed dead (the TERM-immune grandchild needed
        // the escalation — a teardown that merely SIGNALS would leave it
        // alive here). Death is the production predicate: gone or zombie
        // (`proc_starttime` reads None for state Z — a zombie has exited,
        // holds no pipes, writes nothing; the test process reaps it below).
        assert!(
            crate::session_lease::proc_starttime(grandchild_pid as i32).is_none(),
            "Reaped must not be reported while a tagged descendant still lives"
        );
        let _ = grandchild.wait().await;
    }

    /// b8ke focused review FR3 (fail closed): a lingering tagged descendant
    /// that outlives the bounded confirmation window makes
    /// `kill_for_handoff` answer the TYPED not-confirmed result — never a
    /// bare `Reaped` — and the carried continuation keeps escalating until
    /// the tree is dead (resolving `true`). The one-round window (the test
    /// seam) means the TERM-immune grandchild deterministically survives
    /// it; pre-fix the lane answered `Reaped` with the grandchild still
    /// alive. Linux-gated like the F2 test above (the `/proc` predicate).
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn kill_for_handoff_withholds_reaped_while_a_lingering_descendant_survives() {
        let mut st = state();
        let sid = uuid::Uuid::new_v4().to_string();
        st.set_handoff_confirm_rounds_for_test(Some(1));
        insert_fake_claude_session(&st, &sid).await;
        // The lingering ownership-tagged "CLI grandchild": SIGTERM-immune
        // (the one-round window never reaches the SIGKILL escalation).
        // `kill_on_drop` backstops the assertion's own failure path.
        let (mut grandchild, _readiness) =
            spawn_term_immune_tagged_child(&format!("test-{sid}")).await;
        let grandchild_pid = grandchild.id().expect("grandchild pid");

        let result = st.kill_for_handoff(&sid, "test-fr3").await;

        // THE fail-closed contract: the bounded window's expiry with a
        // live tagged descendant is the TYPED not-confirmed result — the
        // lane withholds Reaped (pre-fix: a bare Reaped while the
        // grandchild still lived).
        let confirmation = match result {
            crate::session_handoff::StopResult::NotConfirmed { confirmation } => confirmation,
            other => {
                panic!("a lingering descendant must yield the typed NotConfirmed, never {other:?}")
            }
        };
        assert!(
            crate::session_lease::proc_starttime(grandchild_pid as i32).is_some(),
            "the grandchild is still alive at the not-confirmed answer (the one-round \
             window cannot kill a TERM-immune process)"
        );

        // The carried continuation keeps escalating (production rounds —
        // the SIGKILL escalation lands) and resolves `true` only once the
        // tree is confirmed dead.
        assert!(
            confirmation.await,
            "the detached escalation must confirm the tree's death"
        );
        assert!(
            crate::session_lease::proc_starttime(grandchild_pid as i32).is_none(),
            "the continuation resolves only after the lingering descendant is dead"
        );
        let _ = grandchild.wait().await;
    }

    /// Task 3: insert a fake session AND stage its pending set by folding raw `sdk.*`
    /// lines through the PRODUCTION fold ([`fold_pending_frame`]) — the snapshot.rs
    /// route tests address the overlay this way. `durable` (when `Some`) registers the
    /// `cli_index` alias so the route's durable-id resolution (`resolve_session_key`)
    /// finds the session, exactly as a live post-init session is reachable.
    pub(crate) async fn insert_fake_claude_session_with_pending(
        st: &FreshClaudeState,
        map_key: &str,
        durable: Option<&str>,
        frames: &[Value],
    ) {
        insert_fake_claude_session(st, map_key).await;
        if let Some(durable) = durable {
            st.cli_index
                .lock()
                .await
                .insert(durable.to_string(), map_key.to_string());
        }
        let pending = {
            let sessions = st.sessions.lock().await;
            Arc::clone(&sessions[map_key].pending)
        };
        for frame in frames {
            fold_pending_frame(&pending, frame);
        }
    }

    /// P0.2 slice 1 (restart-resilience §2.8): an attach for a session this process does
    /// not track (the always-true case after a server restart) must emit the
    /// `freshAgent.error{code:'INVALID_SESSION_ID'}` lost-session shape -- NOT be
    /// swallowed -- so the client marks the pane `.lost` and `triggerRecovery`
    /// re-creates with `resumeSessionId` (`fresh-agent-ws.ts:325-327`).
    #[tokio::test]
    async fn handle_attach_untracked_session_emits_lost_session_frame() {
        let (st, mut rx) = state_with_bus();

        st.attach_for_test(attach_msg("does-not-exist")).await;

        let raw = rx.try_recv().expect("a lost-session frame was broadcast");
        let frame: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["sessionId"], "does-not-exist");
        assert_eq!(frame["provider"], "claude");
        assert_eq!(frame["sessionType"], "freshclaude");
        assert_eq!(frame["event"]["type"], "freshAgent.error");
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    /// b8ke delta review F7: a half-fenced `freshAgent.attach` (exactly one
    /// of the observed epoch/generation pair) is the TYPED invalid-fence
    /// refusal — never the silent legacy downgrade (which could let an
    /// old-generation half-fenced request reacquire a Vacant key). Both
    /// half-fence combinations refuse; nothing is spawned or resumed.
    #[tokio::test]
    async fn handle_attach_refuses_each_half_fenced_observation_typed() {
        for (epoch, generation) in [(Some(3u64), None), (None, Some(7u64))] {
            let (st, mut rx) = state_with_bus();
            let mut msg = attach_msg("half-fenced");
            msg.observed_epoch = epoch;
            msg.observed_generation = generation;

            st.attach_for_test(msg).await;

            let raw = rx.try_recv().expect("the typed refusal frame");
            let frame: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(frame["type"], "freshAgent.event", "{frame}");
            assert_eq!(frame["event"]["type"], "freshAgent.error", "{frame}");
            assert_eq!(frame["event"]["code"], "INVALID_FENCE", "{frame}");
            assert!(
                frame["event"]["message"]
                    .as_str()
                    .is_some_and(|m| m.contains("together")),
                "the refusal names the pair rule: {frame}"
            );
            // Nothing was spawned or resumed: the sessions map stays empty.
            assert!(
                st.sessions.lock().await.is_empty(),
                "a half-fenced attach must never resume or spawn"
            );
        }
    }

    /// Kilroy panes send `provider: "claude"` with `sessionType: "kilroy"` -- the envelope
    /// must echo the message's session type or the client builds the wrong locator and the
    /// pane never goes `.lost`.
    #[tokio::test]
    async fn handle_attach_untracked_kilroy_session_keeps_kilroy_session_type() {
        let (st, mut rx) = state_with_bus();
        let mut msg = attach_msg("kilroy-gone");
        msg.session_type = SessionType::Kilroy;

        st.attach_for_test(msg).await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["sessionType"], "kilroy");
        assert_eq!(frame["provider"], "claude");
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    /// A page observing a live UUID receives its current status without
    /// creating or replacing a runtime.
    #[tokio::test]
    async fn handle_attach_tracked_session_acknowledges_its_status() {
        let (st, mut rx) = state_with_bus();
        let id = uuid::Uuid::new_v4().to_string();
        insert_fake_claude_session(&st, &id).await;

        st.attach_for_test(attach_msg(&id)).await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], id);
        assert_eq!(frame["event"]["status"], "idle");
        assert_eq!(st.sessions.lock().await.len(), 1);
    }

    // ── freshAgent.attach: resume-on-attach (restart parity, Task 6) ──────────────

    fn attach_msg_with_resume(session_id: &str, durable: &str) -> FreshAgentAttach {
        let mut msg = attach_msg(session_id);
        msg.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "claude".to_string(),
            session_id: durable.to_string(),
        });
        msg
    }

    /// Delta review round-2 pin (kata ejh6 section 4b): `attach_durable_id` reads
    /// sessionRef-first after the Task-7 flip. A legacy-first ordering (pre-flip)
    /// returns the legacy id in the dual-carrier case — this test fails there.
    #[test]
    fn attach_durable_id_prefers_session_ref_over_legacy() {
        const REF_ID: &str = "11111111-2222-4333-8444-555555555555";
        const LEGACY_ID: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

        // (i) both carriers set with different canonical UUIDs → sessionRef wins
        let mut both = attach_msg("s");
        both.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "claude".to_string(),
            session_id: REF_ID.to_string(),
        });
        both.resume_session_id = Some(LEGACY_ID.to_string());
        assert_eq!(attach_durable_id(&both), Some(REF_ID.to_string()));

        // (ii) sessionRef only → its id
        let ref_only = attach_msg_with_resume("s", REF_ID);
        assert_eq!(attach_durable_id(&ref_only), Some(REF_ID.to_string()));

        // (iii) legacy only → its id (internal/test-compat lane)
        let mut legacy_only = attach_msg("s");
        legacy_only.resume_session_id = Some(LEGACY_ID.to_string());
        assert_eq!(attach_durable_id(&legacy_only), Some(LEGACY_ID.to_string()));

        // (iv) neither → None
        assert_eq!(attach_durable_id(&attach_msg("s")), None);
    }

    fn write_fake_transcript(home: &std::path::Path, durable: &str) {
        let dir = home.join("projects").join("-t");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{durable}.jsonl")),
            // `cwd` present + existing (ledger A15): the resume request must carry
            // the transcript's ORIGINAL cwd, and resume by UUID (primary path).
            r#"{"type":"user","cwd":"/tmp","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        )
        .unwrap();
    }

    /// Bounded drain of the broadcast receiver until a `freshAgent.event` envelope with
    /// the given INNER type arrives (mirroring [`await_claude_created`]'s shape, with a
    /// 45s dead-man budget: the awaited frames are near-instant under normal load, and
    /// only full-crate 96-way-parallel starvation delays them — 15s was observed to
    /// starve intermittently on the shared dev box (pre-existing flake, pinned on an
    /// unmodified checkout); 45s keeps the dead-man switch while riding out contention).
    async fn await_frame_of_inner_type(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        inner_type: &str,
    ) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(45), async {
            loop {
                let frame: Value = match rx.recv().await {
                    // Under host load the bounded drain can fall behind the
                    // 64-frame bus: re-sync and keep waiting (the 45s budget
                    // stays the dead-man switch); `Closed` surfaces through
                    // the same deadline as a lost sender.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(err) => panic!("broadcast recv failed: {err}"),
                    Ok(raw) => serde_json::from_str(&raw).unwrap(),
                };
                if frame["type"] == "freshAgent.event" && frame["event"]["type"] == inner_type {
                    return frame;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("freshAgent.event with inner type {inner_type} within budget"))
    }

    /// Bounded drain until a `freshAgent.status` broadcast carrying `status` arrives.
    /// The consumer folds the tracked status BEFORE it broadcasts the matching
    /// wire frame, so observing this frame proves the fold the attach acks read
    /// has landed — the arrangement races nothing.
    async fn await_status_on_wire(rx: &mut tokio::sync::broadcast::Receiver<String>, status: &str) {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = match rx.recv().await {
                    // Under host load the bounded drain can fall behind the
                    // 64-frame bus: re-sync and keep waiting (the 15s budget
                    // stays the dead-man switch); `Closed` surfaces through
                    // the same deadline as a lost sender.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(err) => panic!("broadcast recv failed: {err}"),
                    Ok(raw) => serde_json::from_str(&raw).unwrap(),
                };
                if frame["type"] == "freshAgent.event"
                    && frame["event"]["type"] == "freshAgent.status"
                    && frame["event"]["status"] == status
                {
                    return;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("freshAgent.status{{status:{status}}} within budget"));
    }

    /// Bounded drain until a TOP-LEVEL `error` ServerMessage arrives; returns its message.
    async fn await_top_level_error(rx: &mut tokio::sync::broadcast::Receiver<String>) -> String {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = match rx.recv().await {
                    // Under host load the bounded drain can fall behind the
                    // 64-frame bus: re-sync and keep waiting (the 15s budget
                    // stays the dead-man switch); `Closed` surfaces through
                    // the same deadline as a lost sender.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(err) => panic!("broadcast recv failed: {err}"),
                    Ok(raw) => serde_json::from_str(&raw).unwrap(),
                };
                if frame["type"] == "error" {
                    return frame["message"].as_str().unwrap_or_default().to_string();
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("top-level error frame within budget"))
    }

    #[tokio::test]
    async fn attach_untracked_with_transcript_resumes_and_emits_idle_snapshot() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let durable = "77777777-7777-4777-8777-777777777777";
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (st, mut rx) = state_with_bus();
        st.attach_for_test(attach_msg_with_resume("client-nanoid-1", durable))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        // A legacy pane now observes the canonical runtime.
        assert!(st.sessions.lock().await.contains_key(durable));
        assert_eq!(
            st.cli_index.lock().await.get(durable),
            Some(&durable.to_string())
        );
        // The fake received the resume boot (spawn log now records the create request).
        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        assert!(
            log.contains(durable),
            "sidecar create must carry the resume boot"
        );
        // Idle snapshot frame, tagged with the client's id + the durable timeline id.
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], durable);
        assert_eq!(frame["event"]["status"], "idle");
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    #[tokio::test]
    async fn attach_untracked_with_missing_transcript_emits_lost_frame() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("projects")).unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        let (st, mut rx) = state_with_bus();
        st.attach_for_test(attach_msg_with_resume(
            "client-nanoid-2",
            "88888888-8888-4888-8888-888888888888",
        ))
        .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    #[tokio::test]
    async fn attach_transient_spawn_failure_is_not_a_lost_frame() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        let durable = "99999999-9999-4999-8999-999999999999";
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        std::env::set_var("FRESHELL_CLAUDE_NODE", "/nonexistent-node-binary");
        let (st, mut rx) = state_with_bus();
        st.attach_for_test(attach_msg_with_resume("client-nanoid-3", durable))
            .await;
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let err = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(err["event"]["code"], "CLAUDE_ATTACH_RESUME_FAILED");
        assert_eq!(err["sessionId"], "client-nanoid-3");
        assert!(st.sessions.lock().await.is_empty());
    }

    #[tokio::test]
    async fn attach_untracked_without_any_durable_id_still_emits_lost_frame() {
        // The pre-parity fallback (PR #529) is preserved verbatim.
        let (st, mut rx) = state_with_bus();
        st.attach_for_test(attach_msg("no-resume-anywhere")).await;
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    #[tokio::test]
    async fn concurrent_attaches_for_the_same_durable_id_spawn_at_most_one_sidecar() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let durable = "12121212-1212-4121-8121-121212121212";
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        let (st, _rx) = state_with_bus();
        let a = st.clone();
        let b = st.clone();
        let m1 = attach_msg_with_resume("nano-a", durable);
        let m2 = attach_msg_with_resume("nano-b", durable);
        tokio::join!(a.attach_for_test(m1), b.attach_for_test(m2));
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert_eq!(env.spawn_count(), 1, "single-flight per durable id");
        drop(env);
    }

    /// A legacy page observes the same canonical runtime and receives its
    /// correction before its status acknowledgement.
    #[tokio::test]
    async fn attach_to_a_live_uuid_keeps_its_envelope_and_acknowledges_the_legacy_page() {
        let (st, mut rx) = state_with_bus();
        let durable = "56565656-5656-4656-8656-565656565656";
        insert_fake_claude_session(&st, durable).await;
        st.attach_for_test(attach_msg_with_resume("late-attacher", durable))
            .await;
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], durable);
        assert_eq!(frame["event"]["status"], "idle");
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        let sessions = st.sessions.lock().await;
        let session = sessions
            .get(durable)
            .expect("the canonical runtime stays registered");
        assert_eq!(
            session.broadcast_id.lock().unwrap().as_str(),
            durable,
            "attaching a page preserves the runtime's canonical envelope"
        );
    }

    /// The rebind arm's ack must announce the session's REAL tracked status (the
    /// stdout consumer's status fold), not a hardcoded `"idle"`: attaching to a
    /// live session mid-compaction must keep the pane truthfully busy instead of
    /// flipping it to idle, and a completion that landed in the reconnect dead
    /// window must be told truthfully by the ack that rescues the pane. The
    /// arrangement drives a REAL wire value (`compacting` — one of the two
    /// statuses the production sidecar actually announces, index.mjs:151-153)
    /// through the REAL consumer fold (the fake sidecar's `__set_status__`
    /// hook), and the fold is observed on the WIRE (the `freshAgent.status`
    /// broadcast) before the attach, so the assertion races nothing.
    #[tokio::test]
    async fn attach_rebind_ack_stamps_the_tracked_live_status_not_hardcoded_idle() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();

        // A tracked live claude session (fake sidecar standing in for the Node one).
        st.handle_create(dedup_create_msg("req-rebind-status"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-rebind-status").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Alias a durable id at it (live: the consumer's sdk.session.init fold writes
        // this row; here the test writes it directly).
        let durable = "9c9c9c9c-9c9c-49c9-8c9c-9c9c9c9c9c9c";
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), session_id.clone());

        // Drive sdk.status { status: "compacting" } through the REAL stdout consumer
        // fold, and wait until its broadcast is observable — the fold (which the ack
        // reads) lands before that broadcast, so the attach below sees "compacting".
        st.handle_send(send_msg(&session_id, "__set_status__:compacting"))
            .await;
        await_status_on_wire(&mut rx, "compacting").await;

        // The reconnect rescue: attach addressing the durable id → the REBIND arm.
        st.attach_for_test(attach_msg_with_resume("late-attacher", durable))
            .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], durable);
        assert_eq!(
            frame["event"]["status"], "compacting",
            "the rebind ack must speak the session's tracked status, not a hardcoded idle: {frame}"
        );
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    /// A mid-turn `compacting` must NOT wedge the tracked status for the rest of
    /// the session's life. The turn's `sdk.result` settles it (C17: the result
    /// retires the turn's command and ends the compaction), so once the
    /// compacted turn completes, the close-and-reopen
    /// rescue ack announces `"idle"` — never a sticky `compacting` that leaves
    /// the revived pane blue with user input queueing forever (the client's
    /// flush gate runs only when `!isBusy`). Both transitions are driven through
    /// the REAL consumer fold (fake-sidecar hooks) in the REAL value space, and
    /// each fold is observed on the WIRE before the attach, so the assertion
    /// races nothing.
    #[tokio::test]
    async fn attach_rebind_ack_settles_to_idle_once_the_compacted_turn_completes() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();

        // A tracked live claude session (fake sidecar standing in for the Node one).
        st.handle_create(dedup_create_msg("req-settle-status"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-settle-status").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Alias a durable id at it (as above: live the init fold writes this row).
        let durable = "8b8b8b8b-8b8b-48b8-8b8b-8b8b8b8b8b8b";
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), session_id.clone());

        // The wedge repro: a turn compacts mid-flight → tracked status "compacting".
        st.handle_send(send_msg(&session_id, "__set_status__:compacting"))
            .await;
        await_status_on_wire(&mut rx, "compacting").await;

        // The compacted turn completes: its sdk.result settles it. Observing
        // its broadcast proves the settle fold has landed. inject_raw_send: the
        // same turn's result, not a second send (which would still be owed).
        inject_raw_send(&st, &session_id, "__emit_result__").await;
        let _ = await_frame_of_inner_type(&mut rx, "freshAgent.result").await;

        // The reconnect rescue AFTER the turn settled: the ack must speak "idle",
        // never the pre-completion "compacting".
        st.attach_for_test(attach_msg_with_resume("late-attacher-settled", durable))
            .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], durable);
        assert_eq!(
            frame["event"]["status"], "idle",
            "a completed turn must settle the tracked status (no sticky compacting): {frame}"
        );
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    /// Attaching while a turn is genuinely in flight must ack `"running"` — the
    /// reference bridge's per-turn lifecycle edge (sdk-bridge.ts:426 — the real
    /// sidecar announces NO `sdk.status: running`, busy is derived from stream
    /// deltas, so the turn ledger speaks "running" from turn evidence).
    /// Drives a REAL `sdk.assistant` frame through the fold and observes its
    /// broadcast before the attach, so the assertion races nothing.
    #[tokio::test]
    async fn attach_rebind_ack_speaks_running_while_a_turn_is_in_flight() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();

        // A tracked live claude session (fake sidecar standing in for the Node one).
        st.handle_create(dedup_create_msg("req-running-status"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-running-status").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Alias a durable id at it (as above: live the init fold writes this row).
        let durable = "7a7a7a7a-7a7a-47a7-8a7a-7a7a7a7a7a7a";
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), session_id.clone());

        // A turn starts: sdk.assistant is the running edge. Observing its
        // broadcast proves the running fold has landed.
        st.handle_send(send_msg(&session_id, "__emit_assistant__"))
            .await;
        let _ = await_frame_of_inner_type(&mut rx, "freshAgent.assistant").await;

        // The reconnect rescue mid-turn: the ack must speak "running".
        st.attach_for_test(attach_msg_with_resume("late-attacher-midturn", durable))
            .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], durable);
        assert_eq!(
            frame["event"]["status"], "running",
            "the rebind ack must speak \"running\" while a turn is in flight: {frame}"
        );
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    /// Pins the DEFAULT: a freshly resumed session has folded no non-idle status, so
    /// its resume-for-attach ack must still announce `"idle"`. Truth by construction
    /// (the tracked status starts "idle"), not a hardcoded literal — a regression that
    /// keeps the resume ack truthful must not be confused with the pre-fix literal.
    #[tokio::test]
    async fn attach_ack_stays_idle_for_a_freshly_resumed_session() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let durable = "abababab-abab-4bab-8bab-abababababab";
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (st, mut rx) = state_with_bus();
        st.attach_for_test(attach_msg_with_resume("client-fresh-resume", durable))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], durable);
        assert_eq!(
            frame["event"]["status"], "idle",
            "a freshly resumed session's ack must announce idle (the tracked default): {frame}"
        );
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    /// Ledger A15's failure case: the transcript's recorded cwd no longer exists on
    /// disk, so the resume request must carry the transcript's `.jsonl` PATH (the
    /// verified cli.js escape hatch bypassing slug scoping) instead of the bare UUID.
    #[tokio::test]
    async fn attach_resume_falls_back_to_transcript_path_when_original_cwd_is_gone() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let durable = "34343434-3434-4343-8343-343434343434";
        let dir = home.path().join("projects").join("-t");
        std::fs::create_dir_all(&dir).unwrap();
        let transcript = dir.join(format!("{durable}.jsonl"));
        std::fs::write(
            &transcript,
            r#"{"type":"user","cwd":"/nonexistent-original-cwd-freshell-task6","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        )
        .unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        let (st, mut rx) = state_with_bus();
        st.attach_for_test(attach_msg_with_resume("client-nanoid-4", durable))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        assert!(
            log.contains(transcript.to_string_lossy().as_ref()),
            "cwd-gone resume must carry the transcript PATH, got: {log}"
        );
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    #[test]
    fn normalize_maps_the_known_sdk_set_and_ignores_others() {
        assert_eq!(
            normalize_sdk_type("sdk.session.init"),
            Some("freshAgent.session.init")
        );
        assert_eq!(
            normalize_sdk_type("sdk.assistant"),
            Some("freshAgent.assistant")
        );
        assert_eq!(normalize_sdk_type("sdk.stream"), Some("freshAgent.stream"));
        assert_eq!(normalize_sdk_type("sdk.result"), Some("freshAgent.result"));
        // The attention edges are not renamed here: the stdout consumer hands
        // them to `emit_attention_edge`, the one edge exit (G14, design §9.2 I-1).
        assert_eq!(normalize_sdk_type("sdk.turn.complete"), None);
        assert_eq!(normalize_sdk_type("sdk.turn.waiting"), None);
        // Task 2 (g): the pending-state family is forwarded too — including
        // sdk.question.cancelled (fresh-eyes round-3 F3 REPLACED the earlier "keep it
        // dropped" plan: the client folds freshAgent.question.cancelled into
        // removeQuestion, so a provider-cancelled question must reach it to clear the card).
        assert_eq!(
            normalize_sdk_type("sdk.permission.request"),
            Some("freshAgent.permission.request")
        );
        assert_eq!(
            normalize_sdk_type("sdk.permission.cancelled"),
            Some("freshAgent.permission.cancelled")
        );
        assert_eq!(
            normalize_sdk_type("sdk.question.request"),
            Some("freshAgent.question.request")
        );
        assert_eq!(
            normalize_sdk_type("sdk.question.cancelled"),
            Some("freshAgent.question.cancelled")
        );
        // Control + unknown types are NOT surfaced as fresh-agent events.
        assert_eq!(normalize_sdk_type("created"), None);
        assert_eq!(normalize_sdk_type("create.failed"), None);
        assert_eq!(normalize_sdk_type("sdk.unknown"), None);
    }

    #[test]
    fn session_init_frame_carries_inner_type_and_durable_uuid() {
        // sdk.session.init → freshAgent.event { event.type: freshAgent.session.init, cliSessionId }.
        let line = json!({
            "type": "sdk.session.init",
            "sessionId": "nano_placeholder_1234567",
            "cliSessionId": "0199abcd-1234-7abc-8def-0123456789ab",
            "model": "haiku",
            "cwd": "/tmp/x",
            "tools": [{ "name": "Read" }],
        });
        let frame = sdk_line_to_frame(&line, "nano_placeholder_1234567", "freshclaude").unwrap();
        let wire: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(wire["type"], "freshAgent.event");
        assert_eq!(wire["provider"], "claude");
        assert_eq!(wire["sessionType"], "freshclaude");
        assert_eq!(wire["sessionId"], "nano_placeholder_1234567");
        assert_eq!(wire["event"]["type"], "freshAgent.session.init");
        assert_eq!(
            wire["event"]["cliSessionId"],
            "0199abcd-1234-7abc-8def-0123456789ab"
        );
        assert_eq!(wire["event"]["model"], "haiku");
    }

    #[test]
    fn sidecar_edge_lines_never_become_frames() {
        // C18: the server mints every attention edge itself (`claude_edges.rs`),
        // so an edge line a protocol fake still writes is never forwarded as a
        // frame of its own (the consumer drops it with a debug log).
        for line in [
            json!({ "type": "sdk.turn.complete", "sessionId": "s-1", "at": 42 }),
            json!({ "type": "sdk.turn.waiting", "sessionId": "s-1", "at": 43 }),
            json!({ "type": "sdk.exit", "sessionId": "s-1" }),
        ] {
            assert!(
                sdk_line_to_frame(&line, "s-1", "freshclaude").is_none(),
                "{line} must not become a plain frame"
            );
        }
    }

    /// Delta-review round 5 (AGENT-06): the `sdk.question.request` →
    /// `freshAgent.question.request` WS broadcast stays VERBATIM even though the
    /// snapshot-bound copy is normalized (see
    /// `fold_normalizes_question_definitions_to_the_strict_contract_shape`). The
    /// event-stream path is schema-opaque, so forwards-compat extras (e.g. the
    /// SDK-documented `preview` option field, preserved by
    /// `permission-channel.mjs`'s `...o`) must reach consumers that understand them.
    #[test]
    fn question_request_broadcast_keeps_the_verbatim_payload() {
        let line = json!({
            "type": "sdk.question.request",
            "sessionId": "s",
            "requestId": "q-prev",
            "questions": [{
                "question": "Pick one",
                "options": [{ "label": "Yes", "description": "go", "preview": "diff…" }],
                "extraTop": { "nested": "kept" }
            }]
        });
        let frame = sdk_line_to_frame(&line, "s", "freshclaude").unwrap();
        let wire: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(wire["event"]["type"], "freshAgent.question.request");
        assert_eq!(
            wire["event"]["questions"][0]["options"][0]["preview"], "diff…",
            "the WS event stream keeps the verbatim payload (forwards-compat)"
        );
        assert_eq!(
            wire["event"]["questions"][0]["extraTop"],
            json!({ "nested": "kept" })
        );
    }

    #[test]
    fn control_lines_are_not_forwarded_as_events() {
        // `created` / `create.failed` are handled in the create flow, never as events.
        assert!(sdk_line_to_frame(
            &json!({ "type": "created", "sessionId": "x" }),
            "x",
            "freshclaude"
        )
        .is_none());
        assert!(sdk_line_to_frame(
            &json!({ "type": "create.failed", "message": "boom" }),
            "x",
            "freshclaude"
        )
        .is_none());
    }

    #[test]
    fn sidecar_death_while_idle_emits_no_completion() {
        // The ADR Decision 2.1 no-FALSE-completion property, IDLE-death twin: a
        // death-truncated stream with nothing owed (no send armed, so the turn
        // ledger owes the user nothing at the end of output) can NEVER produce
        // a freshAgent.turn.complete: the end-of-output arm rings only what the
        // ledger owed, and no sidecar line becomes an edge frame.
        let death_stream = [
            json!({ "type": "sdk.session.init", "sessionId": "s", "cliSessionId": "0199abcd-1234-7abc-8def-0123456789ab" }),
            json!({ "type": "sdk.session.state", "sessionId": "s", "state": "idle" }),
            // …process is SIGKILLed here — stdout ends. NO sdk.result.
        ];
        let mut ledger = crate::claude_turns::ClaudeTurnLedger::default();
        for line in &death_stream {
            if let Some(fact) = crate::claude_turns::TurnFact::from_line(line) {
                ledger.fold(&fact);
            }
        }
        assert!(!ledger.eof(), "an idle session owes nothing at its death");
        let inner_types: Vec<String> = death_stream
            .iter()
            .filter_map(|l| sdk_line_to_frame(l, "s", "freshclaude"))
            .map(|f| serde_json::from_str::<Value>(&f).unwrap()["event"]["type"].to_string())
            .collect();
        assert!(
            !inner_types.iter().any(|t| t.contains("turn.complete")),
            "a death-truncated stream must never yield a completion chime, got {inner_types:?}"
        );
        // And a turn in flight IS owed — the death edge is real, not disabled.
        ledger.arm(
            "u".into(),
            Some("r".into()),
            crate::claude_turns::SendKind::Turn,
        );
        assert!(ledger.eof(), "a turn in flight is owed at its death");
    }

    /// Task 5 (unified needs-attention signal): an UNREQUESTED sidecar death
    /// with a turn in flight is a turn end the user did not witness — the
    /// consumer's EOF tail synthesizes the SAME `freshAgent.turn.complete`
    /// edge the sidecar would have emitted, alongside the
    /// `freshAgent.error{SIDECAR_EXITED}` banner frame, both for the broadcast
    /// id, with a finite numeric `at`; a second such death cycle stamps a
    /// STRICTLY greater `at` (the per-session Rust clock is monotonic;
    /// wall-clock advancement orders the two cycles — the accepted regime,
    /// same as Task 3).
    #[tokio::test]
    async fn sidecar_death_with_turn_in_flight_rings_the_unified_edge() {
        let (log_events, _log_guard) = crate::claude_sidecar_io::test_capture::capture();
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();

        // One full death cycle: create → a plain send ARMS the turn (the
        // fake's create-time idle can land at any point: an idle never ends a
        // command the CLI has not reported, C17) → a mid-turn assistant frame
        // models the truncated stream →
        // the sidecar dies through its own exit hook (the consumer observes
        // plain stdout EOF — indistinguishable from a SIGKILL mid-turn, the one
        // death shape whose sidecar finally never runs). Returns the minted
        // `at`. The `__exit__`/`__emit_assistant__` writes go through
        // `inject_raw_send` (NOT handle_send) so no phantom second op arms —
        // the armed state under test is exactly the one plain send.
        async fn death_cycle(
            st: &FreshClaudeState,
            rx: &mut tokio::sync::broadcast::Receiver<String>,
            request_id: &str,
        ) -> i64 {
            st.handle_create(dedup_create_msg(request_id), None).await;
            let created = await_claude_created(rx, request_id).await;
            let sid = created["sessionId"].as_str().unwrap().to_string();
            st.handle_send(send_msg(&sid, "a turn that dies mid-flight"))
                .await;
            await_ledger_busy(st, &sid, true).await;
            inject_raw_send(st, &sid, "__emit_assistant__").await;
            inject_raw_send(st, &sid, "__exit__").await;
            // The death arm's two frames arrive in stream order (banner, then
            // the synthesized edge) but the scan is order-agnostic. Poll with a
            // deadline: a blocking recv could
            // never observe the deadline once the bus goes quiet.
            let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
            let mut saw_exited_banner = false;
            let mut at: Option<i64> = None;
            while !(saw_exited_banner && at.is_some()) {
                while let Ok(raw) = rx.try_recv() {
                    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
                        continue;
                    };
                    if v["type"] != "freshAgent.event" || v["sessionId"] != sid {
                        continue;
                    }
                    match v["event"]["type"].as_str() {
                        Some("freshAgent.error") if v["event"]["code"] == "SIDECAR_EXITED" => {
                            saw_exited_banner = true;
                        }
                        Some("freshAgent.turn.complete") => {
                            at = v["event"]["at"].as_i64();
                        }
                        _ => {}
                    }
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the death frames never fully arrived (banner={saw_exited_banner}, at={at:?})"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let at = at.expect("the turn.complete frame carries a finite numeric at");
            assert!(at > 0, "at must be a finite numeric timestamp: {at}");
            at
        }

        let first = death_cycle(&st, &mut rx, "req-death-edge-1").await;
        // The clock is per-session (a fresh session's first stamp is bare
        // `now`), so guarantee wall-clock advancement past the first mint
        // before the second cycle — the accepted-regime ordering.
        tokio::time::sleep(Duration::from_millis(2)).await;
        let second = death_cycle(&st, &mut rx, "req-death-edge-2").await;
        assert!(
            second > first,
            "the second death cycle's at ({second}) must strictly exceed the first ({first})"
        );
        // G14: each death edge is logged as it leaves, with its source and `at`.
        let logged: Vec<(Option<String>, Option<String>, Option<String>)> =
            crate::claude_sidecar_io::test_capture::with_message(
                &log_events,
                "freshagent.turn.complete",
            )
            .iter()
            .map(|event| {
                (
                    event.field("source").map(str::to_string),
                    event.field("session_type").map(str::to_string),
                    event.field("at").map(str::to_string),
                )
            })
            .collect();
        let expected = |at: i64| {
            (
                Some("death".to_string()),
                Some("freshclaude".to_string()),
                Some(at.to_string()),
            )
        };
        assert_eq!(logged, vec![expected(first), expected(second)]);
        drop(env);
    }

    #[test]
    fn session_type_maps_claude_flavours() {
        assert_eq!(session_type_str(SessionType::Freshclaude), "freshclaude");
        assert_eq!(session_type_str(SessionType::Kilroy), "kilroy");
    }

    #[test]
    fn ownership_id_is_unique_and_tagged() {
        let a = mint_ownership_id();
        let b = mint_ownership_id();
        assert!(a.starts_with("claude-sidecar-"));
        assert_ne!(a, b);
    }

    #[test]
    fn sidecar_entry_resolves_to_the_vendored_package() {
        // Guard against the dedup tests' concurrent FRESHELL_CLAUDE_SIDECAR mutation
        // (see CLAUDE_ENV_LOCK below) -- this test reads the SAME process-global env var.
        let _guard = CLAUDE_ENV_LOCK.blocking_lock();
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        // The compile-time path points at the vendored Node package beside this crate.
        let entry = sidecar_entry_path();
        assert!(
            entry.ends_with("freshell-claude-sidecar/index.mjs"),
            "{}",
            entry.display()
        );
    }

    #[tokio::test]
    async fn shutdown_is_safe_with_no_sessions() {
        state().shutdown().await;
    }

    /// C04 (`test-support` seam): a configured sidecar environment REPLACES the
    /// inherited one (only the ownership tag is layered on), so a test rig can
    /// point the real sidecar at the CLI simulator and an isolated HOME without
    /// touching this process's environment. Unconfigured, the sidecar inherits it.
    #[tokio::test]
    async fn a_configured_sidecar_environment_replaces_the_inherited_one() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("print-env.mjs");
        std::fs::write(
            &script,
            "process.stdout.write(JSON.stringify(process.env) + '\\n')\n",
        )
        .unwrap();
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("FRESHELL_TEST_INHERITED_MARKER", "inherited");

        async fn child_env(state: &FreshClaudeState) -> (HashMap<String, String>, String) {
            // The tree guard lives until the child is reaped: dropping it kills the tree.
            let SpawnedSidecar {
                mut child,
                stdout,
                ownership_id,
                tree_guard: _tree_guard,
                ..
            } = state
                .spawn_sidecar_process("freshclaude")
                .await
                .expect("spawn sidecar");
            let line = BufReader::new(stdout)
                .lines()
                .next_line()
                .await
                .expect("read sidecar stdout")
                .expect("the sidecar prints its environment");
            let _ = child.wait().await;
            (serde_json::from_str(&line).expect("env json"), ownership_id)
        }
        let configured = state().with_sidecar_environment([
            (
                "PATH".to_string(),
                std::env::var("PATH").unwrap_or_default(),
            ),
            (
                "FRESHELL_TEST_SIDECAR_ENV".to_string(),
                "chosen".to_string(),
            ),
        ]);
        let (env, ownership_id) = child_env(&configured).await;
        let (inherited, _) = child_env(&state()).await;
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        std::env::remove_var("FRESHELL_TEST_INHERITED_MARKER");

        let mut keys: Vec<&str> = env.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                CLAUDE_SIDECAR_OWNERSHIP_ENV,
                "FRESHELL_TEST_SIDECAR_ENV",
                "PATH"
            ],
            "the configured environment replaces the inherited one: {env:?}"
        );
        assert_eq!(env[CLAUDE_SIDECAR_OWNERSHIP_ENV], ownership_id);
        assert_eq!(
            inherited
                .get("FRESHELL_TEST_INHERITED_MARKER")
                .map(String::as_str),
            Some("inherited"),
            "without a configured environment the sidecar inherits this process's"
        );
    }

    /// G14: every spawned sidecar's stderr is logged, labelled with its
    /// ownership id, pid and session type. A sidecar whose environment marks
    /// it hosted (the session host sets FRESHELL_HOSTED_FRESH_AGENT, to
    /// `claude` or `kilroy`) has its raw lines logged by size only.
    #[tokio::test]
    async fn a_spawned_sidecar_stderr_is_logged_and_redacted_when_hosted() {
        use crate::claude_sidecar_io::test_capture::{capture, with_message};
        let (events, _log_guard) = capture();
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("stderr-sidecar.mjs");
        std::fs::write(
            &script,
            "process.stderr.write('secret raw output\\n')\n\
             process.stderr.write(JSON.stringify({ severity: 'info', component: 'claude-sidecar', event: 'sidecar.ready' }) + '\\n')\n",
        )
        .unwrap();
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);

        async fn spawn_and_log(
            state: &FreshClaudeState,
            events: &Arc<std::sync::Mutex<Vec<crate::claude_sidecar_io::test_capture::Captured>>>,
        ) -> (String, Option<u32>) {
            let before = with_message(events, "freshagent.claude.sidecar_log").len();
            // The tree guard lives until the child is reaped: dropping it kills the tree.
            let SpawnedSidecar {
                mut child,
                ownership_id,
                tree_guard: _tree_guard,
                ..
            } = state
                .spawn_sidecar_process("kilroy")
                .await
                .expect("spawn sidecar");
            let pid = child.id();
            let _ = child.wait().await;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            while with_message(events, "freshagent.claude.sidecar_log").len() < before + 2 {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the sidecar's two stderr lines were never logged"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            (ownership_id, pid)
        }
        let path = (
            "PATH".to_string(),
            std::env::var("PATH").unwrap_or_default(),
        );
        let ordinary = state().with_sidecar_environment([path.clone()]);
        let hosted = state().with_sidecar_environment([
            path,
            (
                "FRESHELL_HOSTED_FRESH_AGENT".to_string(),
                "kilroy".to_string(),
            ),
        ]);
        let (ordinary_owner, ordinary_pid) = spawn_and_log(&ordinary, &events).await;
        let (hosted_owner, _) = spawn_and_log(&hosted, &events).await;
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");

        let logs = with_message(&events, "freshagent.claude.sidecar_log");
        let of = |owner: &str| -> Vec<_> {
            logs.iter()
                .filter(|event| event.field("ownership_id") == Some(owner))
                .cloned()
                .collect()
        };
        let ordinary_logs = of(&ordinary_owner);
        assert_eq!(ordinary_logs.len(), 2, "{logs:?}");
        assert_eq!(ordinary_logs[0].level, tracing::Level::WARN);
        assert_eq!(ordinary_logs[0].field("raw"), Some("true"));
        assert_eq!(ordinary_logs[0].field("text"), Some("secret raw output"));
        assert_eq!(ordinary_logs[1].level, tracing::Level::INFO);
        assert_eq!(
            ordinary_logs[1].field("sidecar_event"),
            Some("sidecar.ready")
        );
        let ordinary_pid = ordinary_pid.map(|pid| pid.to_string());
        for event in &ordinary_logs {
            assert_eq!(event.field("session_type"), Some("kilroy"));
            assert_eq!(event.field("pid"), ordinary_pid.as_deref());
        }
        let hosted_logs = of(&hosted_owner);
        assert_eq!(hosted_logs.len(), 2, "{logs:?}");
        assert_eq!(hosted_logs[0].field("raw"), Some("true"));
        assert_eq!(hosted_logs[0].field("bytes"), Some("17"));
        assert_eq!(hosted_logs[0].field("text"), None, "hosted: size only");
        assert_eq!(hosted_logs[1].field("sidecar_event"), Some("sidecar.ready"));
    }

    // ── freshAgent.create requestId dedup (parity gap fix) ──────────────────

    /// Serializes every test in this file that mutates process-global env vars
    /// (`FRESHELL_CLAUDE_SIDECAR` / `FRESHELL_CLAUDE_NODE`), mirroring codex's
    /// `ENV_LOCK` (`codex.rs`).
    // `pub(crate)` so snapshot.rs's claude-store tests share this ONE lock (mirroring
    // how snapshot.rs reuses `crate::codex::tests::ENV_LOCK`) -- two independent
    // per-file locks would NOT serialize against each other.
    pub(crate) static CLAUDE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    /// A minimal scripted fake claude sidecar (no real `@anthropic-ai/claude-agent-sdk`,
    /// no network, no cost): on `{"type":"create",...}` it appends a marker line to
    /// `FRESHELL_TEST_CLAUDE_SPAWN_LOG` (so tests can count spawns without a global
    /// tracing subscriber) and replies with a fresh `{"type":"created","sessionId":...}`;
    /// on `{"type":"interrupt",sessionId}` it appends `sessionId` to
    /// `FRESHELL_TEST_CLAUDE_INTERRUPT_LOG` (the observable proxy for "the sidecar's
    /// `query.interrupt()` was actually invoked", mirroring the real sidecar's
    /// `handleInterrupt`); on `{"type":"shutdown"}` it exits. Task 2 arms: a magic send
    /// of `__raise_permission__` emits a canned `sdk.permission.request` (the canUseTool
    /// stand-in — the fake parks nothing), a magic send of `__set_status__:<status>`
    /// emits a real `sdk.status` frame (the attach-ack status-arrangement hook),
    /// `__emit_assistant__` emits a real `sdk.assistant` frame (a turn's RUNNING edge)
    /// and `__emit_result__` a real `sdk.result` frame (a completed turn's SETTLE edge
    /// — the real sidecar emits it on every SDK result whatever the subtype), and
    /// `permission.respond`/`question.respond`/non-magic `send` frames append the full
    /// received line to `FRESHELL_TEST_CLAUDE_RESPOND_LOG` (the assertion surface for
    /// the respond/compact handlers' exact stdin frame shapes).
    const FAKE_CLAUDE_SIDECAR_SOURCE: &str = r#"
import fs from 'node:fs'
import readline from 'node:readline'

const spawnLog = process.env.FRESHELL_TEST_CLAUDE_SPAWN_LOG
const respondLog = process.env.FRESHELL_TEST_CLAUDE_RESPOND_LOG
// Task 4 review (C1) determinism knob: DEFER every create ANSWER by N ms. The
// create request is still logged IMMEDIATELY (the spawn-log gate observes the
// rollback parked inside its respawn), so a test can fire a send while the
// rollback deterministically waits on `created` — the mid-rollback send
// interleaving is guaranteed, never luck.
const deferCreateMs = parseInt(process.env.FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS || '0', 10)
// Task 4 review (M3) provable-rejection knob: die on create like a spawn-time
// provider rejection (EOF before `created`).
const failCreate = process.env.FRESHELL_TEST_CLAUDE_FAIL_CREATE === '1'

let counter = 0
// The sessions this sidecar hosts; a send to another is answered with the
// real sidecar's signed session-not-found error.
const liveSessions = new Set()
const configuredSettings = new Map()
// Sessions booted under a server-minted id whose init waits for the first send.
const deferredInit = new Map()
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }
  if (msg.type === 'create') {
    // Log the WHOLE create request (one line per create) so tests can both count
    // spawns AND assert what the sidecar received (e.g. the resume boot).
    if (spawnLog) {
      fs.appendFileSync(spawnLog, `${JSON.stringify(msg)}\n`)
    }
    const answer = () => {
      if (failCreate) process.exit(1)
      counter += 1
      const sessionId = msg.sessionId ?? `fake-claude-session-${process.pid}-${counter}`
      liveSessions.add(sessionId)
      configuredSettings.set(sessionId, { model: msg.model, effort: msg.effort, permissionMode: msg.permissionMode, cwd: msg.cwd })
      process.stdout.write(JSON.stringify({ type: 'created', sessionId, protocol: 2 }) + '\n')
      if (msg.sessionId) {
        // A boot under a server-minted id (a rollback's replacement, a boot
        // from a genesis): the CLI runs under that id and, like the real CLI
        // (T1), reports it only once a prompt runs — at the first send.
        deferredInit.set(sessionId, msg.sessionId)
        return
      }
      // Mirror the real sidecar's post-create init: echo the resume boot's id as the
      // durable id when present (resume continuity), else a fixed fake uuid.
      const cliSessionId = msg.boot?.kind === 'fork'
        ? `fork-${process.pid}-${counter}-0000-4000-8000-000000000000`
        : (msg.boot?.resume || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      console.log(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }))
      console.log(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }))
    }
    if (deferCreateMs > 0) setTimeout(answer, deferCreateMs)
    else answer()
  } else if (msg.type === 'configure') {
    if (respondLog) fs.appendFileSync(respondLog, `${JSON.stringify(msg)}\n`)
    console.log(JSON.stringify({ type: 'sdk.session.changed', sessionId: msg.sessionId, reason: 'session-commands', commands: [{ name: 'review', description: 'Review changes' }] }))
    const settings = configuredSettings.get(msg.sessionId) ?? {}
    const ok = msg.settings?.model !== 'unavailable' && msg.settings?.effort !== 'invalid'
    if (msg.settings?.model !== 'unavailable') settings.model = msg.settings.model
    if (ok) Object.assign(settings, msg.settings)
    console.log(JSON.stringify({ type: 'sdk.configured', sessionId: msg.sessionId, requestId: msg.requestId, ok, settings, message: 'Model or effort is unavailable' }))
  } else if (msg.type === 'send') {
    // Test hook: lets tests kill the sidecar THROUGH the public API to exercise
    // the consumer-exit eviction path (ledger A9).
    if (msg.text === '__exit__') process.exit(0)
    const deferredCliId = deferredInit.get(msg.sessionId)
    if (deferredCliId) {
      deferredInit.delete(msg.sessionId)
      console.log(JSON.stringify({ type: 'sdk.session.init', sessionId: msg.sessionId, cliSessionId: deferredCliId, model: 'fake-model', cwd: '/tmp', tools: [] }))
    }
    // Magic texts: each emits ONE canned sdk.* line through the real stdout
    // consumer (the fake reports no command lifecycle, so the turn ledger
    // settles a result by its old-CLI head fallback).
    if (msg.text === '__emit_result_error__') {
      console.log(JSON.stringify({ type: 'sdk.result', sessionId: msg.sessionId, result: 'error_during_execution' }))
    } else if (!liveSessions.has(msg.sessionId)) {
      // A send to a session this sidecar does not host is refused before any
      // CLI sees it, as the real sidecar refuses it (sdk.send.rejected): the
      // server takes the send back.
      console.log(JSON.stringify({ type: 'sdk.send.rejected', sessionId: msg.sessionId, uuid: msg.uuid ?? null, code: 'SESSION_NOT_FOUND', message: 'Claude session is no longer available.' }))
    } else if (msg.text === '__emit_assistant__') {
      console.log(JSON.stringify({ type: 'sdk.assistant', sessionId: msg.sessionId, content: [{ type: 'text', text: 'noise' }] }))
    // Task 2 test hook: raise a canned pending permission the approve/deny flow can
    // respond to. The fake parks nothing — Rust's pending fold is the state under test.
    } else if (msg.text === '__raise_permission__') {
      process.stdout.write(JSON.stringify({
        type: 'sdk.permission.request',
        sessionId: msg.sessionId,
        requestId: 'req-1',
        subtype: 'can_use_tool',
        tool: { name: 'Bash', input: { command: 'ls' } },
        toolUseID: 'toolu_fake_1',
        blockedPath: null,
        decisionReason: null,
      }) + '\n')
    } else if (msg.text.startsWith('__set_status__:')) {
      // Reconnect-revive hook: emit a real sdk.status frame so a test can arrange a
      // non-default tracked status through the REAL stdout consumer fold (the attach
      // ack under test speaks it back).
      process.stdout.write(JSON.stringify({ type: 'sdk.status', sessionId: msg.sessionId, status: msg.text.slice('__set_status__:'.length) }) + '\n')
    } else if (msg.text === '__emit_assistant__') {
      // Reconnect-revive hook: emit a real sdk.assistant frame (the real wire shape —
      // index.mjs:165) so a test can drive the turn ledger's turn evidence ("running").
      process.stdout.write(JSON.stringify({ type: 'sdk.assistant', sessionId: msg.sessionId, content: [{ type: 'text', text: 'part' }], model: 'fake-model' }) + '\n')
    } else if (msg.text === '__emit_result__') {
      // Reconnect-revive hook: emit a real sdk.result frame (the real wire shape —
      // index.mjs:177) so a test can drive the turn ledger's result settle.
      process.stdout.write(JSON.stringify({ type: 'sdk.result', sessionId: msg.sessionId, result: 'success', durationMs: 1, costUsd: 0, usage: {} }) + '\n')
    } else if (respondLog) {
      // Non-magic sends (e.g. `/compact …`) land in the respond log verbatim so
      // tests can assert the exact stdin frame shape the compact handler writes.
      fs.appendFileSync(respondLog, `${JSON.stringify(msg)}\n`)
    }
  } else if (msg.type === 'permission.respond' || msg.type === 'question.respond') {
    if (respondLog) fs.appendFileSync(respondLog, `${JSON.stringify(msg)}\n`)
  } else if (msg.type === 'interrupt') {
    const interruptLog = process.env.FRESHELL_TEST_CLAUDE_INTERRUPT_LOG
    if (interruptLog) fs.appendFileSync(interruptLog, `${msg.sessionId}\n`)
    // The control receipt (echoing the Stop's id) is written BEFORE the
    // interrupted turn's own result (sdk.d.ts:3760): the settle frame first,
    // then the stopped turn's result in the pinned CLI's aborted shape (T11; no
    // trailing idle: the real sidecar sends none).
    console.log(JSON.stringify({ type: 'sdk.interrupt_settled', sessionId: msg.sessionId, stopId: msg.stopId, ok: true }))
    console.log(JSON.stringify({ type: 'sdk.result', sessionId: msg.sessionId, result: 'error_during_execution', subtype: 'error_during_execution', isError: true, terminalReason: 'aborted_streaming', numTurns: 1 }))
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
"#;

    /// A fresh temp dir holding the fake sidecar script + this test's spawn-count log,
    /// with `FRESHELL_CLAUDE_SIDECAR`/`FRESHELL_CLAUDE_NODE`/
    /// `FRESHELL_TEST_CLAUDE_SPAWN_LOG` pointed at it. Caller must hold
    /// [`CLAUDE_ENV_LOCK`] for the lifetime of the returned guard.
    struct FakeClaudeSidecarEnv {
        dir: PathBuf,
        spawn_log: PathBuf,
        interrupt_log: PathBuf,
        respond_log: PathBuf,
    }
    impl FakeClaudeSidecarEnv {
        fn install() -> Self {
            Self::install_with_knobs(None, false)
        }

        /// `install` + the fake sidecar's scripted knobs (see the source header):
        /// `defer_create_ms` delays every create ANSWER (the request is logged
        /// immediately — a test can park the rollback inside its respawn);
        /// `fail_create` makes every create a spawn-time provider rejection.
        fn install_with_knobs(defer_create_ms: Option<u64>, fail_create: bool) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "freshell-fake-claude-sidecar-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).expect("create fake sidecar temp dir");
            let script = dir.join("fake-claude-sidecar.mjs");
            std::fs::write(&script, FAKE_CLAUDE_SIDECAR_SOURCE).expect("write fake sidecar");
            let spawn_log = dir.join("spawn.log");
            std::fs::write(&spawn_log, "").expect("init spawn log");
            let interrupt_log = dir.join("interrupt.log");
            std::fs::write(&interrupt_log, "").expect("init interrupt log");
            let respond_log = dir.join("respond.log");
            std::fs::write(&respond_log, "").expect("init respond log");
            std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
            std::env::set_var("FRESHELL_CLAUDE_NODE", "node");
            std::env::set_var("FRESHELL_TEST_CLAUDE_SPAWN_LOG", &spawn_log);
            std::env::set_var("FRESHELL_TEST_CLAUDE_INTERRUPT_LOG", &interrupt_log);
            std::env::set_var("FRESHELL_TEST_CLAUDE_RESPOND_LOG", &respond_log);
            match defer_create_ms {
                Some(ms) => {
                    std::env::set_var("FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS", ms.to_string())
                }
                None => std::env::remove_var("FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS"),
            }
            if fail_create {
                std::env::set_var("FRESHELL_TEST_CLAUDE_FAIL_CREATE", "1");
            } else {
                std::env::remove_var("FRESHELL_TEST_CLAUDE_FAIL_CREATE");
            }
            Self {
                dir,
                spawn_log,
                interrupt_log,
                respond_log,
            }
        }

        /// Path of the spawn log (one full JSON create-request line per spawn) so tests
        /// can assert what the sidecar received (e.g. the resume boot).
        fn spawn_log_path(&self) -> &std::path::Path {
            &self.spawn_log
        }

        async fn create_request(&self) -> Value {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            loop {
                let text = std::fs::read_to_string(self.spawn_log_path()).unwrap_or_default();
                if let Some(line) = text.lines().next() {
                    return serde_json::from_str(line).expect("logged create JSON");
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "create never reached sidecar"
                );
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }

        /// Number of times the fake sidecar has been spawned so far (one marker line per
        /// process start).
        fn spawn_count(&self) -> usize {
            std::fs::read_to_string(&self.spawn_log)
                .map(|s| s.lines().filter(|l| !l.is_empty()).count())
                .unwrap_or(0)
        }

        /// Contents of the interrupt log (one `sessionId` per line the fake sidecar
        /// received a `{"type":"interrupt",...}` request for).
        fn interrupt_log_contents(&self) -> String {
            std::fs::read_to_string(&self.interrupt_log).unwrap_or_default()
        }

        /// The parsed respond-log lines (one full JSON frame per line the fake sidecar
        /// received a `permission.respond` / `question.respond` / non-magic `send`
        /// request for). Bounded-waits for at least `min` lines so the assertion reads
        /// AFTER the sidecar's append, never racing it.
        async fn respond_log_frames(&self, min: usize) -> Vec<Value> {
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
            loop {
                let frames: Vec<Value> = std::fs::read_to_string(&self.respond_log)
                    .unwrap_or_default()
                    .lines()
                    .filter(|l| !l.trim().is_empty())
                    .map(|l| serde_json::from_str(l).expect("respond log line is JSON"))
                    .collect();
                if frames.len() >= min {
                    return frames;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "respond log never reached {min} frame(s)"
                );
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
    }
    impl Drop for FakeClaudeSidecarEnv {
        fn drop(&mut self) {
            std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
            std::env::remove_var("FRESHELL_CLAUDE_NODE");
            std::env::remove_var("FRESHELL_TEST_CLAUDE_SPAWN_LOG");
            std::env::remove_var("FRESHELL_TEST_CLAUDE_INTERRUPT_LOG");
            std::env::remove_var("FRESHELL_TEST_CLAUDE_RESPOND_LOG");
            std::env::remove_var("FRESHELL_TEST_CLAUDE_DEFER_CREATE_MS");
            std::env::remove_var("FRESHELL_TEST_CLAUDE_FAIL_CREATE");
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn send_msg(session_id: &str, text: &str) -> FreshAgentSend {
        FreshAgentSend {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            text: text.to_string(),
            cwd: None,
            images: None,
            request_id: None,
            settings: None,
            observed_epoch: None,
            observed_generation: None,
            checkpoint_intent: None,
        }
    }

    #[test]
    fn checkpoint_turn_identity_claude_send_carries_the_attempt_correlation() {
        let mut msg = send_msg("claude-placeholder", "same prompt");
        msg.request_id = Some("request-7".to_string());
        msg.checkpoint_intent = Some(freshell_protocol::FreshAgentCheckpointIntent {
            logical_attempt_id: "attempt-7".to_string(),
            workspace: None,
        });

        // C16: the attempt binds under the send's own uuid (the send line's
        // `uuid`, `a_send_line_carries_its_uuid_and_the_acceptance_names_it`),
        // so the correlation record carries no uuid of its own.
        assert_eq!(
            checkpoint_attempt_for_send(&msg).expect("checkpoint attempt"),
            json!({ "requestId": "request-7", "logicalAttemptId": "attempt-7" })
        );
        assert!(checkpoint_attempt_for_send(&send_msg("legacy", "prompt")).is_none());
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn checkpoint_delayed_send_with_stale_owner_fence_is_refused_before_dispatch() {
        let (mut st, mut rx) = state_with_bus();
        let session_id = "claude-send-stale-owner";
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        insert_fake_claude_session(&st, session_id).await;

        let mut first_ticket = match crate::ownership_lane::begin_lane_claim(
            &st.ownership,
            PROVIDER,
            session_id,
            "test-send-owner-first",
            None,
            "test",
            crate::session_lease::now_epoch_ms(),
        ) {
            crate::ownership_lane::LaneClaim::Granted(ticket) => Some(ticket),
            _ => panic!("fixture: first send owner claim must be granted"),
        };
        assert!(crate::ownership_lane::commit_lane_claim(
            &st.ownership,
            &st.ownership_stamps,
            Some(&st.broadcast_tx),
            PROVIDER,
            session_id,
            &mut first_ticket,
            session_id,
            None,
        )
        .is_ok());
        let old = registry.observe(PROVIDER, session_id);
        let old_generation = old.generation;
        let old_owner = match old.state {
            freshell_ownership::OwnershipState::Live { owner, .. } => owner,
            other => panic!("fixture: first owner must be live: {other:?}"),
        };
        let old_operation = old_owner
            .ownership_id
            .clone()
            .expect("the committed owner has an operation id");
        registry.release(
            PROVIDER,
            session_id,
            &freshell_ownership::ReleaseClaim {
                operation_id: old_operation,
                generation: old_generation,
                runtime: Some(old_owner),
            },
            "test",
        );

        let mut replacement_ticket = match crate::ownership_lane::begin_lane_claim(
            &st.ownership,
            PROVIDER,
            session_id,
            "test-send-owner-replacement",
            None,
            "test",
            crate::session_lease::now_epoch_ms(),
        ) {
            crate::ownership_lane::LaneClaim::Granted(ticket) => Some(ticket),
            _ => panic!("fixture: replacement send owner claim must be granted"),
        };
        assert!(crate::ownership_lane::commit_lane_claim(
            &st.ownership,
            &st.ownership_stamps,
            Some(&st.broadcast_tx),
            PROVIDER,
            session_id,
            &mut replacement_ticket,
            session_id,
            None,
        )
        .is_ok());
        let current = registry.observe(PROVIDER, session_id);
        assert!(current.generation > old_generation);

        let mut send = send_msg(session_id, "delayed checkpoint prompt");
        send.request_id = Some("stale-checkpoint-send".into());
        send.checkpoint_intent = Some(freshell_protocol::FreshAgentCheckpointIntent {
            logical_attempt_id: "stale-checkpoint-attempt".into(),
            workspace: None,
        });
        send.observed_epoch = Some(old.epoch);
        send.observed_generation = Some(old_generation);
        st.handle_send(send).await;

        let mut frames: Vec<Value> = Vec::new();
        while let Ok(raw) = rx.try_recv() {
            if let Ok(frame) = serde_json::from_str(&raw) {
                frames.push(frame);
            }
        }
        assert!(
            frames.iter().any(|frame| {
                frame.to_string().contains("SESSION_RESERVED")
                    && frame.to_string().contains("stale")
            }),
            "the delayed send reports the stale owner fence: {frames:?}"
        );
        let sessions = st.sessions.lock().await;
        let session = sessions
            .get(session_id)
            .expect("the old session stays mapped");
        assert!(
            !session.ledger.lock().expect("turn ledger lock").busy(),
            "a stale delayed prompt never arms a turn or reaches the sidecar"
        );
    }

    /// F4 (PR-A review): before the CLI reports a new pane's session the
    /// coordinator holds no record for it, and an unfenced (checkpointed)
    /// send runs: refusing it would lose every new pane's first message
    /// (827d9395d). A send that DOES carry an observed owner pair is still
    /// checked: the pair names an owner the coordinator does not hold, so it
    /// is stale and refused typed, never run unguarded.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_fenced_send_before_the_session_report_is_checked_not_skipped() {
        let (mut st, mut rx) = state_with_bus();
        let session_id = "claude-send-before-report";
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        insert_fake_claude_session(&st, session_id).await;
        let vacant = registry.observe(PROVIDER, session_id);
        assert!(
            matches!(vacant.state, freshell_ownership::OwnershipState::Vacant),
            "fixture: nothing owns an unreported session"
        );
        let checkpointed = |request_id: &str| {
            let mut send = send_msg(session_id, "first message");
            send.request_id = Some(request_id.to_string());
            send.checkpoint_intent = Some(freshell_protocol::FreshAgentCheckpointIntent {
                logical_attempt_id: format!("{request_id}-attempt"),
                workspace: None,
            });
            send
        };
        let drain = |rx: &mut tokio::sync::broadcast::Receiver<String>| {
            let mut frames: Vec<Value> = Vec::new();
            while let Ok(raw) = rx.try_recv() {
                if let Ok(frame) = serde_json::from_str(&raw) {
                    frames.push(frame);
                }
            }
            frames
        };

        let mut fenced = checkpointed("fenced-before-report");
        fenced.observed_epoch = Some(vacant.epoch);
        fenced.observed_generation = Some(vacant.generation);
        st.handle_send(fenced).await;
        let frames = drain(&mut rx);
        assert!(
            frames.iter().any(|frame| {
                frame["requestId"] == json!("fenced-before-report")
                    && frame.to_string().contains("SESSION_RESERVED")
            }),
            "the supplied fence is honored and refuses typed: {frames:?}"
        );
        assert!(
            !st.sessions.lock().await[session_id]
                .ledger
                .lock()
                .expect("turn ledger lock")
                .busy(),
            "the refused send never reaches the sidecar"
        );

        st.handle_send(checkpointed("unfenced-before-report")).await;
        let frames = drain(&mut rx);
        assert!(
            !frames
                .iter()
                .any(|frame| frame.to_string().contains("SESSION_RESERVED")),
            "an unfenced first send of a new pane runs: {frames:?}"
        );
        assert!(
            st.sessions.lock().await[session_id]
                .ledger
                .lock()
                .expect("turn ledger lock")
                .busy(),
            "the unfenced first send reaches the sidecar"
        );
    }

    /// The checkpointed send a new pane makes before the CLI reported its
    /// session: the browser's send shape (a checkpoint intent, no owner pair),
    /// addressed by the lane's placeholder id.
    fn checkpointed_send_before_session_report(session_id: &str) -> FreshAgentSend {
        let mut send = send_msg(session_id, "first prompt of a new pane");
        send.request_id = Some(format!("send-{session_id}"));
        send.checkpoint_intent = Some(freshell_protocol::FreshAgentCheckpointIntent {
            logical_attempt_id: format!("attempt-{session_id}"),
            workspace: None,
        });
        send
    }

    /// The events named `freshagent.claude.send_before_session_report` that
    /// the capture recorded.
    fn send_before_session_report_events(
        events: &std::sync::Mutex<Vec<(String, std::collections::BTreeMap<String, String>)>>,
    ) -> usize {
        events
            .lock()
            .expect("capture lock")
            .iter()
            .filter(|(_message, fields)| {
                fields.get("event").is_some_and(|event| {
                    event.contains("freshagent.claude.send_before_session_report")
                })
            })
            .count()
    }

    /// With an ownership coordinator wired, a checkpointed send to a session the
    /// CLI has not reported yet (and the coordinator holds no record for) runs
    /// unfenced, and says so in `freshagent.claude.send_before_session_report`.
    #[tokio::test]
    async fn a_send_before_the_session_report_logs_that_it_ran_unfenced() {
        let (events, _capture_guard) = info_capture_for_test::capture();
        let (mut st, mut rx) = state_with_bus();
        st.set_ownership(Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new()));
        let session_id = "claude-placeholder-wired";
        insert_fake_claude_session(&st, session_id).await;

        st.handle_send(checkpointed_send_before_session_report(session_id))
            .await;

        let frames = drain(&mut rx).await;
        assert!(
            frames
                .iter()
                .any(|frame| frame["type"] == "freshAgent.send.accepted"),
            "the send runs: {frames:?}"
        );
        assert_eq!(send_before_session_report_events(&events), 1);
    }

    /// Without an ownership coordinator (the session host's lane) there is no
    /// fence to skip: the send runs as before and the before-report event,
    /// which says the coordinator holds no record, is not logged.
    #[tokio::test]
    async fn a_send_on_a_lane_without_a_coordinator_does_not_log_a_skipped_fence() {
        let (events, _capture_guard) = info_capture_for_test::capture();
        let (st, mut rx) = state_with_bus();
        let session_id = "claude-placeholder-unwired";
        insert_fake_claude_session(&st, session_id).await;

        st.handle_send(checkpointed_send_before_session_report(session_id))
            .await;

        let frames = drain(&mut rx).await;
        assert!(
            frames
                .iter()
                .any(|frame| frame["type"] == "freshAgent.send.accepted"),
            "the send runs: {frames:?}"
        );
        assert_eq!(send_before_session_report_events(&events), 0);
    }

    /// kata z7j7 (claude scope honesty): a settings-bearing send whose payload
    /// includes `sandbox` — a knob claude has NO wire concept for (the configure
    /// frame carries only model/effort/permissionMode/cwd) — must surface the
    /// drop observably as `freshagent.claude.unsupported-settings-ignored`
    /// (session id + a boolean flag ONLY, never prompt content), instead of
    /// silently vanishing (the pre-z7j7 "parsed and discarded" bug pattern).
    ///
    /// Thread-local capture: the event fires INLINE in `handle_send`, awaited
    /// by this test's own current-thread runtime, so `set_default` (thread-local)
    /// is sound and must not touch the test binary's global subscriber.
    mod info_capture_for_test {
        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex};
        use tracing::field::{Field, Visit};
        use tracing::{Event, Subscriber};
        use tracing_subscriber::layer::{Context, SubscriberExt};
        use tracing_subscriber::Layer;

        #[derive(Default)]
        struct FieldVisitor {
            message: String,
            fields: BTreeMap<String, String>,
        }
        impl Visit for FieldVisitor {
            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                let rendered = format!("{value:?}");
                if field.name() == "message" {
                    self.message = rendered;
                } else {
                    self.fields.insert(field.name().to_string(), rendered);
                }
            }
        }
        type Captured = (String, BTreeMap<String, String>);

        struct CaptureLayer {
            events: Arc<Mutex<Vec<Captured>>>,
        }
        impl<S: Subscriber> Layer<S> for CaptureLayer {
            fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
                let mut visitor = FieldVisitor::default();
                event.record(&mut visitor);
                self.events
                    .lock()
                    .expect("capture lock")
                    .push((visitor.message, visitor.fields));
            }
        }
        pub fn capture() -> (Arc<Mutex<Vec<Captured>>>, tracing::subscriber::DefaultGuard) {
            let events = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer {
                events: Arc::clone(&events),
            };
            let subscriber = tracing_subscriber::registry().with(layer);
            (events, tracing::subscriber::set_default(subscriber))
        }
    }

    #[tokio::test]
    async fn send_with_unsupported_sandbox_emits_unsupported_settings_ignored_log() {
        let (events, _capture_guard) = info_capture_for_test::capture();
        let _env_guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        state
            .handle_create(dedup_create_msg("sandbox-ignored"), None)
            .await;
        let created = await_claude_created(&mut rx, "sandbox-ignored").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        let mut send = send_msg(&session_id, "carries an unsupported knob");
        send.settings = Some(freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            model: None,
            effort: None,
            permission_mode: None,
            sandbox: Some(freshell_protocol::Sandbox::WorkspaceWrite),
        });
        state.handle_send(send).await;
        // Give the sidecar-ack'd send a beat so the knowledge that this is the
        // exact turn's settings moment (the log fires BEFORE the configure
        // ack wait completes) is exercised.
        let _ = env.respond_log_frames(1).await;

        let events = events.lock().expect("capture lock");
        let found = events
            .iter()
            .find(|(message, _fields)| {
                message.contains("freshagent.claude.unsupported-settings-ignored")
            })
            .expect("expected a freshagent.claude.unsupported-settings-ignored info event");
        assert_eq!(
            found.1.get("session_id").map(String::as_str),
            Some(session_id.as_str()),
            "the event is tagged with the send's session id"
        );
        assert_eq!(found.1.get("has_sandbox").map(String::as_str), Some("true"));
        // Repo logging discipline: ids + flags ONLY — no content-shaped fields.
        for key in found.1.keys() {
            assert!(
                !matches!(key.as_str(), "text" | "prompt" | "parts" | "body"),
                "the observability event must never carry prompt content (saw `{key}`)"
            );
        }
    }

    /// DEFLAKE (parallel-starvation family): the send's activity feed
    /// lands on the SPAWNED sidecar-notification pump, not on the send's
    /// own await path — under tokio worker starvation the pump can trail
    /// the `respond_log_frames` return by seconds (observed: 3
    /// consecutive full-crate failures of the racing-send test at host
    /// load ~30, each passing solo). The protection under test is "the
    /// feed is never silently dropped", not "it lands within
    /// nanoseconds": poll for the wanted count with a generous deadline,
    /// then assert on the collected snapshot.
    async fn await_activities(
        sink: &crate::naming::test_support::RecordingSink,
        wanted: usize,
    ) -> Vec<crate::naming::NameActivity> {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            {
                let activities = sink.activities.lock().unwrap();
                if activities.len() >= wanted {
                    return activities.clone();
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the send's activity feed never landed: {activities:?}"
                );
            }
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    /// Unified agent names (Task 4): the shared accepted-input callback — an
    /// accepted freshclaude send feeds the naming authority ONE activity
    /// carrying the prompt text (the first-message fallback upgrade plus
    /// generation arming happen store-side); the pre-durable handle is the
    /// activity target until the init adoption binds it.
    #[tokio::test(flavor = "multi_thread")]
    async fn send_feeds_the_naming_authority_once_with_the_accepted_text() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let sink = crate::naming::test_support::RecordingSink::new();
        state.set_session_naming(sink.clone());
        let mut create = dedup_create_msg("naming-send");
        create.naming_handle = Some("handle-naming-send".into());
        state.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "naming-send").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        state
            .handle_send(send_msg(&session_id, "Fix the sardine crash"))
            .await;
        let _ = env.respond_log_frames(1).await;

        let activities = await_activities(&sink, 1).await;
        assert_eq!(activities.len(), 1, "{activities:?}");
        assert_eq!(
            activities[0].target,
            freshell_protocol::session_names::SessionNameRef::Pending {
                id: "handle-naming-send".to_string()
            }
        );
        assert_eq!(activities[0].mode, "freshclaude");
        assert_eq!(
            activities[0].first_user_message.as_deref(),
            Some("Fix the sardine crash")
        );
        assert_eq!(
            activities[0].reason,
            crate::naming::NameActivityReason::AcceptedUserMessage
        );
    }

    /// Unified agent names (Task 8 acceptance): the pre-durable pending
    /// record is admitted at REQUEST RECEIPT, not after the sidecar answers
    /// `created`. The pane content (and the client's rename capture)
    /// carries the handle from the moment the create frame is sent, and
    /// the sidecar spawn + `created` handshake takes seconds — a
    /// pane-header rename committed inside that window targeted a record
    /// the server had accepted on the wire but not yet admitted (404
    /// NAME_NOT_FOUND), silently losing the manual pre-durable name to the
    /// first-message fallback. Admission is idempotent, so the
    /// post-`created` re-ensure answers the same record unchanged.
    #[tokio::test(flavor = "multi_thread")]
    async fn create_admits_the_pending_record_before_the_sidecar_answers_created() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install_with_knobs(Some(1_500), false);
        let (state, _rx) = state_with_bus();
        let sink = crate::naming::test_support::RecordingSink::new();
        state.set_session_naming(sink.clone());
        let mut create = dedup_create_msg("naming-early-admit");
        create.naming_handle = Some("handle-early-admit".into());

        // Park the create inside its deferred `created` handshake.
        let joined = tokio::spawn(async move { state.handle_create(create, None).await });
        // The create request reached the sidecar (the spawn log is written
        // immediately, BEFORE the deferred answer) — we are INSIDE the
        // window where the pane exists but `created` has not answered.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while env.spawn_count() == 0 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "create never reached the sidecar"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // The pending record for the create frame's handle EXISTS while the
        // sidecar is still parking `created` — a pane-header rename in this
        // window targets a record the server already knows.
        let updates = sink
            .get(vec![
                freshell_protocol::session_names::SessionNameRef::Pending {
                    id: "handle-early-admit".to_string(),
                },
            ])
            .await
            .expect("get resolves");
        assert_eq!(
            updates.len(),
            1,
            "the pending record must exist before `created` answers"
        );

        // Cleanup: let the deferred handshake finish (the task must end so
        // no spawned session outlives the test).
        let _ = joined.await;
    }

    /// Unified agent names (Task 4, review N1): a send RACING the init
    /// adoption — the stash entry already consumed by the adoption's
    /// bound cleanup, the addressed id still the placeholder (the
    /// client has not yet learned the adopted id) — must still feed the
    /// authority instead of silently dropping the activity. The feed
    /// falls back to the pending ref for the addressed id itself (the
    /// store's redirect resolution decides); the next send addresses the
    /// adopted id anyway.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_send_racing_the_init_adoption_still_feeds_the_naming_authority() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let sink = crate::naming::test_support::RecordingSink::new();
        state.set_session_naming(sink.clone());
        let mut create = dedup_create_msg("naming-race");
        create.naming_handle = Some("handle-naming-race".into());
        state.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "naming-race").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // The adoption's bound cleanup consumed the stash entry
        // (`bind_naming_handle_at_init` removes it once the handle is
        // redirected to the durable record) — this send is still
        // addressed to the placeholder and is not a canonical UUID.
        // Model the TRUE racing moment: BEFORE the adoption recorded the
        // durable id on the session row, neither the stash nor the adopted
        // id can answer, and the feed falls back to the pending ref for
        // the addressed id itself (the store's redirect resolution
        // decides); the next send addresses the adopted id anyway.
        //
        // DEFLAKE (parallel-starvation family): the fake's ASYNC init
        // adoption re-writes `cli_session_id` whenever it lands, so
        // hand-clearing it immediately after `created` races the adoption
        // — a scheduling delay lets the adoption land between the
        // hand-clear and the send, and the feed then targets the fake's
        // adopted id instead of the pending fallback (observed in a
        // full-crate run). Wait for the adoption to COMPLETE first (the
        // fake emits init ONCE), then hand-model the mid-adoption window:
        // stash consumed + durable id not yet recorded.
        {
            let adoption_deadline =
                tokio::time::Instant::now() + std::time::Duration::from_secs(15);
            loop {
                {
                    let adopted_yet = state
                        .sessions
                        .lock()
                        .await
                        .get(&session_id)
                        .and_then(|s| s.cli_session_id.clone());
                    if adopted_yet.is_some() {
                        break;
                    }
                    assert!(
                        tokio::time::Instant::now() < adoption_deadline,
                        "the fake sidecar's init adoption never landed"
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
        state.naming_handles.lock().await.remove(&session_id);
        state
            .sessions
            .lock()
            .await
            .get_mut(&session_id)
            .expect("the created session row")
            .cli_session_id = None;

        let legacy_id = "legacy-name-placeholder";
        state
            .cli_index
            .lock()
            .await
            .insert(legacy_id.into(), session_id.clone());
        state
            .handle_send(send_msg(legacy_id, "Race the adoption"))
            .await;
        let _ = env.respond_log_frames(1).await;

        let activities = await_activities(&sink, 1).await;
        assert_eq!(
            activities.len(),
            1,
            "the racing send must not silently drop the activity feed: {activities:?}"
        );
        assert_eq!(
            activities[0].target,
            freshell_protocol::session_names::SessionNameRef::Pending {
                id: legacy_id.into()
            }
        );
        assert_eq!(activities[0].mode, "freshclaude");
        assert_eq!(
            activities[0].first_user_message.as_deref(),
            Some("Race the adoption")
        );
    }

    /// Unified agent names (Task 8 acceptance): once the init ADOPTION has
    /// consumed the pre-durable stash and recorded the session's durable
    /// `cli_session_id`, a send still addressed to the PLACEHOLDER (the
    /// client has not yet learned the adopted id) must feed the activity to
    /// the ADOPTED durable record — the pending-<placeholder> fallback of
    /// the racing-send shape can never resolve in the real store (no naming
    /// record is keyed by a placeholder id), and the first-message fallback
    /// upgrade was silently lost for exactly these sends.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_post_adoption_send_targets_the_adopted_durable_record() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let sink = crate::naming::test_support::RecordingSink::new();
        state.set_session_naming(sink.clone());
        let mut create = dedup_create_msg("naming-adopted");
        create.naming_handle = Some("handle-naming-adopted".into());
        state.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "naming-adopted").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // The real post-adoption shape, set directly (the unit lane's fake
        // sidecar emits init asynchronously and the racing-send precedent
        // models the state the same way): the stash is consumed (the init
        // bind's cleanup) and the session row carries the adopted durable
        // id — the client is still addressing the placeholder.
        //
        // DEFLAKE (parallel-starvation family): the fake's ASYNC init
        // adoption overwrites `cli_session_id` (with the fake's own id)
        // whenever it runs, so hand-setting the adopted id immediately
        // after `created` races it — a scheduling delay lets the adoption
        // land between the hand-set and the send, and the activity then
        // targets the fake's id (observed once in a full-crate run). Wait
        // for the adoption to COMPLETE first, then hand-set the modeled
        // adopted id — the scenario is the POST-adoption state either way.
        let adopted_cli_id = "11111111-2222-4333-8444-555555555555".to_string();
        {
            let adoption_deadline =
                tokio::time::Instant::now() + std::time::Duration::from_secs(15);
            loop {
                {
                    let adopted_yet = state
                        .sessions
                        .lock()
                        .await
                        .get(&session_id)
                        .and_then(|s| s.cli_session_id.clone());
                    if adopted_yet.is_some() {
                        break;
                    }
                    assert!(
                        tokio::time::Instant::now() < adoption_deadline,
                        "the fake sidecar's init adoption never landed"
                    );
                }
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            let mut sessions = state.sessions.lock().await;
            sessions
                .get_mut(&session_id)
                .expect("the created session row")
                .cli_session_id = Some(adopted_cli_id.clone());
        }
        state.naming_handles.lock().await.remove(&session_id);

        state
            .handle_send(send_msg(&session_id, "Feed the adopted record"))
            .await;
        let _ = env.respond_log_frames(1).await;

        let activities = await_activities(&sink, 1).await;
        assert_eq!(
            activities.len(),
            1,
            "the post-adoption send must not silently drop the activity feed: {activities:?}"
        );
        assert_eq!(
            activities[0].target,
            freshell_protocol::session_names::SessionNameRef::Session {
                provider: freshell_protocol::session_names::NamedProvider::Claude,
                session_id: adopted_cli_id,
            },
            "the activity targets the ADOPTED durable record, not the unresolvable placeholder"
        );
        assert_eq!(
            activities[0].first_user_message.as_deref(),
            Some("Feed the adopted record")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn send_applies_changed_settings_before_text_and_persists_them() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());
        let mut create = dedup_create_msg("settings-send");
        create.model = Some("opus".into());
        create.effort = Some("high".into());
        state.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "settings-send").await;
        let session_id = created["sessionId"].as_str().unwrap();
        let mut send = send_msg(session_id, "Review this image");
        send.settings = Some(freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            model: Some("sonnet".into()),
            effort: Some("max".into()),
            permission_mode: Some("plan".into()),
            sandbox: None,
        });
        send.images = Some(vec![freshell_protocol::FreshAgentImage {
            data: "YWJj".into(),
            media_type: "image/png".into(),
        }]);
        state.handle_send(send).await;
        let frames = env.respond_log_frames(1).await;
        assert_eq!(
            frames[0]["type"], "configure",
            "settings must apply before sending text"
        );
        let frames = env.respond_log_frames(2).await;
        assert_eq!(frames[1]["text"], "Review this image");
        assert_eq!(frames[1]["images"][0]["data"], "YWJj");
        let mut snapshot = json!({});
        state
            .apply_snapshot_metadata(session_id, &mut snapshot)
            .await;
        assert_eq!(
            snapshot["settings"],
            json!({ "model": "sonnet", "effort": "max", "permissionMode": "plan" })
        );
        assert_eq!(
            snapshot["commands"],
            json!([{ "name": "review", "description": "Review changes" }])
        );
        assert_eq!(
            snapshot["status"], "running",
            "accepted input is busy before the first provider output"
        );
        assert_eq!(
            snapshot["extensions"]["claude"]["statusFromLiveState"],
            true
        );
        let bindings = fake.bindings.lock().unwrap();
        let settings = &bindings.last().unwrap().settings;
        assert_eq!(settings.model.as_deref(), Some("sonnet"));
        assert_eq!(settings.effort.as_deref(), Some("max"));
        assert_eq!(settings.permission_mode.as_deref(), Some("plan"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn failed_effort_records_the_model_that_already_took_effect() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());
        let mut create = dedup_create_msg("partial-settings");
        create.model = Some("opus".into());
        create.effort = Some("high".into());
        state.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "partial-settings").await;
        let session_id = created["sessionId"].as_str().unwrap();
        let mut send = send_msg(session_id, "Keep this unsent");
        send.settings = Some(freshell_protocol::FreshAgentSendSettings {
            model: Some("sonnet".into()),
            effort: Some("invalid".into()),
            cwd: None,
            permission_mode: None,
            sandbox: None,
        });
        state.handle_send(send).await;
        assert!(await_top_level_error(&mut rx)
            .await
            .contains("CLAUDE_SETTINGS_FAILED"));
        assert_eq!(
            env.respond_log_frames(1).await.len(),
            1,
            "failed configuration must not send the prompt"
        );
        let mut snapshot = json!({"status": "idle"});
        state
            .apply_snapshot_metadata(session_id, &mut snapshot)
            .await;
        assert_eq!(snapshot["settings"]["model"], "sonnet");
        assert_eq!(snapshot["settings"]["effort"], "high");
        assert_eq!(snapshot["status"], "idle");
        let bindings = fake.bindings.lock().unwrap();
        assert_eq!(
            bindings.last().unwrap().settings.model.as_deref(),
            Some("sonnet")
        );
        assert_eq!(
            bindings.last().unwrap().settings.effort.as_deref(),
            Some("high")
        );
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn send_rejects_failed_settings_without_losing_text_or_changing_saved_settings() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());
        let mut create = dedup_create_msg("settings-fail");
        create.model = Some("opus".into());
        state.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "settings-fail").await;
        let session_id = created["sessionId"].as_str().unwrap();
        let mut send = send_msg(session_id, "Do not lose this prompt");
        send.request_id = Some("retained-prompt".into());
        send.settings = Some(freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            model: Some("unavailable".into()),
            effort: None,
            permission_mode: None,
            sandbox: None,
        });
        state.handle_send(send).await;
        let frames = env.respond_log_frames(1).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["type"], "configure");
        let error = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let frame: Value = serde_json::from_str(&rx.recv().await.unwrap()).unwrap();
                assert_ne!(frame["type"], "freshAgent.send.accepted");
                if frame["type"] == "error" {
                    break frame;
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(error["requestId"], "retained-prompt");
        assert!(error["message"].as_str().unwrap().contains("unavailable"));
        assert_eq!(
            fake.bindings
                .lock()
                .unwrap()
                .last()
                .unwrap()
                .settings
                .model
                .as_deref(),
            Some("opus")
        );
        assert!(!state
            .sessions
            .lock()
            .await
            .get(session_id)
            .unwrap()
            .ledger
            .lock()
            .expect("turn ledger lock")
            .busy());
    }

    fn dedup_create_msg(request_id: &str) -> FreshAgentCreate {
        FreshAgentCreate {
            pane_id: None,
            naming_handle: None,
            observed_epoch: None,
            observed_generation: None,
            request_id: request_id.to_string(),
            session_type: SessionType::Freshclaude,
            provider: Some(freshell_protocol::AgentProvider::Claude),
            cwd: None,
            legacy_restore_context: None,
            resume_session_id: None,
            session_ref: None,
            model: None,
            model_selection: None,
            permission_mode: None,
            sandbox: None,
            effort: None,
            plugins: None,
            tab_id: None,
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn local_snapshot_owner_requires_current_native_and_presentation_registration() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        for kind in [SessionType::Freshclaude, SessionType::Kilroy] {
            let (mut state, mut rx) = state_with_bus();
            let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
            state.set_ownership(registry.clone());
            let mut create = dedup_create_msg("local-snapshot-owner");
            create.session_type = kind;
            state.handle_create(create, None).await;
            let created = await_claude_created(&mut rx, "local-snapshot-owner").await;
            let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
            let presentation = created["sessionId"].as_str().unwrap();
            let native = fresh_create_durable_id;
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            while state.local_snapshot_owner(native).await.is_none() {
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "native owner never published"
                );
                tokio::task::yield_now().await;
            }
            let expected = registry.observe("claude", native);
            let native_owner = state.local_snapshot_owner(native).await;
            let presentation_owner = state.local_snapshot_owner(presentation).await;
            let unknown_owner = state.local_snapshot_owner("different-native-thread").await;
            // Map presence alone cannot override a missing retained ownership stamp.
            let stamp = crate::ownership_lane::take_retained_stamp(&state.ownership_stamps, native)
                .unwrap();
            let unstamped = state.local_snapshot_owner(native).await;
            crate::ownership_lane::restore_retained_stamp(&state.ownership_stamps, native, stamp);
            let mut kill = kill_msg(presentation);
            kill.session_type = kind;
            state.handle_kill(kill).await;
            assert_eq!(native_owner, Some(expected.clone()));
            assert_eq!(presentation_owner, Some(expected));
            assert!(unknown_owner.is_none());
            assert!(unstamped.is_none());
            assert!(state.local_snapshot_owner(native).await.is_none());
        }
        assert_eq!(env.spawn_count(), 2);
    }

    /// Model a session registered by the older host before it knew its
    /// native UUID. Only compatibility tests call this; current creates are
    /// already durably owned and never take this path.
    async fn prepare_legacy_init(st: &FreshClaudeState, map_key: &str) {
        let durable = {
            let mut sessions = st.sessions.lock().await;
            let session = sessions.get_mut(map_key).expect("legacy fixture runtime");
            session.owning_operation = None;
            session.owning_generation = None;
            session.cli_session_id.take()
        };
        if let Some(durable) = durable {
            st.cli_index.lock().await.remove(&durable);
            crate::ownership_lane::release_retained_stamp(
                &st.ownership,
                &st.ownership_stamps,
                PROVIDER,
                &durable,
                "test/legacy-init-fixture",
            );
        }
    }

    async fn adopt_legacy_fixture(st: &FreshClaudeState, map_key: &str, durable: &str) {
        prepare_legacy_init(st, map_key).await;
        st.adopt_session_init(
            durable,
            map_key,
            "freshclaude",
            None,
            st.identity_sink(),
            None,
        )
        .await;
        await_alias(st, durable, map_key).await;
    }

    /// Drain `rx` until the `freshAgent.created` (or `.create.failed`) frame for
    /// `request_id` arrives (mirrors codex's `await_created`).
    async fn await_claude_created(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        request_id: &str,
    ) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = match rx.recv().await {
                    // Under host load the bounded drain can fall behind the
                    // 64-frame bus: re-sync and keep waiting (the 15s budget
                    // stays the dead-man switch); `Closed` surfaces through
                    // the same deadline as a lost sender.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(err) => panic!("broadcast recv failed: {err}"),
                    Ok(raw) => serde_json::from_str(&raw).unwrap(),
                };
                if (frame["type"] == "freshAgent.created"
                    || frame["type"] == "freshAgent.create.failed")
                    && frame["requestId"] == request_id
                {
                    return frame;
                }
            }
        })
        .await
        .unwrap_or_else(|_| panic!("freshAgent.created for {request_id} resolves within budget"))
    }

    /// Await the create's `sdk.session.init` binding row in the test's
    /// FakeIdentitySink — the ROW BARRIER of the combined drain.
    ///
    /// At this base the init frame does NOT prove the row: the consumer
    /// can read `sdk.session.init` before `handle_create` inserts the
    /// session, the adoption then defers (`defer_session_init_adoption`,
    /// a 25 ms registration poll that performs the binding write only
    /// once registered), and the init frame broadcasts IMMEDIATELY either
    /// way — so the frame drain orders the FRAMES while THIS barrier
    /// proves the ROW. Polls `bindings`, not `was_recorded`: the
    /// all-blank lineage row never enters the fake's `recorded` set
    /// (Task-3 keying excludes blank-settings bindings), so the vec is
    /// the only witness all three family tests share. Same bounded-poll
    /// idiom as the was_recorded poll in
    /// `a_refused_kill_keeps_the_durable_ledger_bound_and_answers_typed`
    /// — under the deferred ordering the row lands ~25 ms after the
    /// insert, so the wait is milliseconds in practice and the 15 s
    /// budget stays a dead-man switch, never a patience raise.
    async fn await_claude_session_init_binding_row(
        fake: &std::sync::Arc<crate::identity_sink::FakeIdentitySink>,
        durable_id: &str,
    ) -> crate::identity_sink::FreshAgentBindingUpsert {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let row = {
                let bindings = fake.bindings.lock().unwrap();
                bindings
                    .iter()
                    .rev()
                    .find(|b| b.provider == "claude" && b.session_id == durable_id)
                    .cloned()
            };
            if let Some(row) = row {
                return row;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the create binding row (claude, {durable_id}) \
                 never landed within budget"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    /// Node parity (`runtime-manager.ts:106-108`): a `freshAgent.create` whose
    /// ONLY identity is a provider-matched `sessionRef` must resume exactly
    /// like the legacy `resumeSessionId` carrier — the canonical field cannot
    /// be a second-class citizen while the client migrates off the legacy
    /// duplicate. The fake sidecar echoes the create request's resume
    /// boot back as the durable id, so the created frame's
    /// sessionId proves the promotion reached the sidecar.
    #[tokio::test]
    async fn handle_create_with_session_ref_only_resumes_like_legacy() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let durable = "66666666-6666-4666-8666-666666666666";
        let mut msg = dedup_create_msg("req-sref-only-1");
        msg.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "claude".to_string(),
            session_id: durable.to_string(),
        });

        st.handle_create(msg, None).await;
        let frame = await_claude_created(&mut rx, "req-sref-only-1").await;

        assert_eq!(
            frame["type"], "freshAgent.created",
            "sessionRef-only create must succeed: {frame}"
        );
        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        assert!(
            log.contains(durable),
            "sidecar create must carry the sessionRef-derived resume boot: {log}"
        );
        drop(env);
    }

    /// THE regression this task fixes: a duplicate `freshAgent.create` sharing a
    /// `requestId` (the frozen client's reconnect-resend while a pane is
    /// `status==creating`) must spawn the claude sidecar exactly once and replay the
    /// SAME session id on the second response.
    #[tokio::test]
    async fn handle_create_duplicate_request_id_reuses_the_session_and_spawns_once() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-dedup-seq"), None)
            .await;
        let first = await_claude_created(&mut rx, "req-claude-dedup-seq").await;
        assert_eq!(first["type"], "freshAgent.created", "sanity: {first}");
        let first_session_id = first["sessionId"].as_str().unwrap().to_string();

        st.handle_create(dedup_create_msg("req-claude-dedup-seq"), None)
            .await;
        let second = await_claude_created(&mut rx, "req-claude-dedup-seq").await;

        assert_eq!(
            second["sessionId"], first_session_id,
            "a duplicate requestId must replay the SAME session, not mint a new one: {second}"
        );
        assert_eq!(
            env.spawn_count(),
            1,
            "two sequential creates sharing a requestId must spawn the claude sidecar \
             exactly once"
        );
    }

    /// The concurrent variant: two GENUINELY CONCURRENT creates sharing a `requestId`
    /// must still spawn at most one sidecar and both resolve to the SAME session.
    #[tokio::test]
    async fn handle_create_concurrent_duplicate_request_id_spawns_at_most_once() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        let st1 = st.clone();
        let st2 = st.clone();
        tokio::join!(
            st1.handle_create(dedup_create_msg("req-claude-dedup-race"), None),
            st2.handle_create(dedup_create_msg("req-claude-dedup-race"), None),
        );

        let first = await_claude_created(&mut rx, "req-claude-dedup-race").await;
        let second = await_claude_created(&mut rx, "req-claude-dedup-race").await;
        assert_eq!(
            first["sessionId"], second["sessionId"],
            "both racing creates for the same requestId must resolve to the SAME session: \
             {first} / {second}"
        );
        assert_eq!(
            env.spawn_count(),
            1,
            "two CONCURRENT creates racing on the same requestId must spawn the claude \
             sidecar exactly once"
        );
    }

    /// Control: DISTINCT requestIds must never dedup against each other.
    #[tokio::test]
    async fn handle_create_distinct_request_ids_create_distinct_sessions() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-dedup-a"), None)
            .await;
        let a = await_claude_created(&mut rx, "req-claude-dedup-a").await;

        st.handle_create(dedup_create_msg("req-claude-dedup-b"), None)
            .await;
        let b = await_claude_created(&mut rx, "req-claude-dedup-b").await;

        assert_ne!(
            a["sessionId"], b["sessionId"],
            "distinct requestIds must never replay each other's session: {a} / {b}"
        );
        assert_eq!(
            env.spawn_count(),
            2,
            "two distinct requestIds must spawn the sidecar once each"
        );
    }

    /// Cache invalidation: an EXPLICIT `freshAgent.kill` DOES evict the requestId dedup
    /// cache, so a duplicate `create` for the SAME requestId after the kill genuinely
    /// mints a fresh session (a new spawn), not a replay of the killed one.
    ///
    /// NOTE (task-specified suite reduction, justified): unlike codex, claude has no
    /// exit-watcher/self-heal state machine ([`ClaudeSession`] carries no `exited` bit --
    /// an unrequested sidecar death is simply an EOF the stdout consumer stops on, with
    /// no separate "replay after unrequested exit" code path for the dedup cache to
    /// interact with). That codex-suite test would be a byte-for-byte duplicate of
    /// `handle_create_duplicate_request_id_reuses_the_session_and_spawns_once` here, so
    /// it is dropped rather than mirrored redundantly -- 4 tests, not 5.
    #[tokio::test]
    async fn handle_create_duplicate_after_explicit_kill_creates_a_fresh_session() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-dedup-kill"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-claude-dedup-kill").await;
        let killed_session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: killed_session_id.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        st.handle_create(dedup_create_msg("req-claude-dedup-kill"), None)
            .await;
        let recreated = await_claude_created(&mut rx, "req-claude-dedup-kill").await;

        assert_ne!(
            recreated["sessionId"], killed_session_id,
            "a duplicate create after an EXPLICIT kill must mint a fresh session, not \
             replay the killed one: {recreated}"
        );
        assert_eq!(
            env.spawn_count(),
            2,
            "the kill must evict the dedup cache, so the duplicate create genuinely \
             re-spawns"
        );
    }

    // ── b8ke ext r22 F1: the fresh claude create is coordinator-owned from BEFORE spawn ──

    /// b8ke ext r22 F1 (a): during the fresh claude create's spawn window
    /// (the DEFER knob holds the create answer open) the coordinator shows
    /// a Starting record under the pane-scoped provisional identity — a
    /// competing claim on that key is refused typed — and at the `created`
    /// mint the SAME ticket rekeys, leaving the provisional key as the
    /// resolution alias for the minted session id.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_fresh_claude_create_window_holds_a_coordinator_starting_record() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install_with_knobs(Some(2_000), false);
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        let task_st = st.clone();
        let create = tokio::spawn(async move {
            task_st
                .handle_create(dedup_create_msg("req-r22-claude-window"), None)
                .await;
        });

        let launch = env.create_request().await;
        let durable = launch["sessionId"].as_str().unwrap();
        assert!(uuid::Uuid::parse_str(durable).is_ok());
        // THE WINDOW: the durable record is Starting{FreshAgent} while
        // the create is held open (red pre-r22: no record at all).
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe(PROVIDER, durable).state,
                freshell_ownership::OwnershipState::Starting { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the fresh claude create's window never showed the durable \
                 Starting record (r22 F1)"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        // A competing claim on the pane-scoped key is refused typed — the
        // window's record blocks, never a silent overlap.
        assert!(matches!(
            registry.begin_start(
                PROVIDER,
                durable,
                freshell_ownership::RuntimeOwnerKind::Terminal,
                "op-r22-claude-compete",
                None,
                "test",
                freshell_ownership::now_epoch_ms(),
            ),
            freshell_ownership::BeginOutcome::Blocked { .. }
        ));

        // Let the create finish: the created answer arrives and the SAME
        // ticket rekeys to the minted session id (the durable key
        // becomes the resolution alias).
        create.await.expect("the create task joins");
        let created = await_claude_created(&mut rx, "req-r22-claude-window").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        assert_eq!(session_id, durable);
        assert!(matches!(
            registry.observe(PROVIDER, durable).state,
            freshell_ownership::OwnershipState::Live { .. }
        ));
        assert!(matches!(
            registry
                .observe(PROVIDER, "pending-create-req-r22-claude-window")
                .state,
            freshell_ownership::OwnershipState::Vacant
        ));
    }

    /// A fresh create whose pane-scoped claim the coordinator refuses (another
    /// operation holds the key) answers that refusal and nothing else: no
    /// sidecar is spawned and no `created` follows the `create.failed`.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_fresh_create_claim_answers_only_the_refusal_and_spawns_nothing() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        let mut msg = dedup_create_msg("req-refused-claim");
        msg.observed_epoch = Some(registry.boot_epoch() + 1);
        msg.observed_generation = Some(0);

        let outcome = st.handle_create(msg, None).await;

        let mut answers = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&frame).expect("json frame");
            if frame["requestId"] == json!("req-refused-claim") {
                answers.push(frame);
            }
        }
        assert_eq!(answers.len(), 1, "one answer: {answers:?}");
        assert_eq!(answers[0]["type"], "freshAgent.create.failed");
        assert_eq!(answers[0]["code"], "SESSION_RESERVED");
        assert_eq!(env.spawn_count(), 0, "no sidecar was spawned");
        // I1: the returned outcome is the answer the frame carries.
        assert!(matches!(
            &outcome,
            ClaudeCreateOutcome::Failed { code, retryable: Some(true), .. } if code == "SESSION_RESERVED"
        ));
        assert_eq!(
            serde_json::to_value(outcome.create_failed_frame("req-refused-claim").unwrap())
                .unwrap(),
            answers[0]
        );
    }

    /// I1: a create returns the session its `freshAgent.created` frame names, with
    /// the durable conversation when it resumed one.
    #[tokio::test]
    async fn a_create_returns_the_session_its_created_frame_names() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();

        let fresh = st
            .handle_create(dedup_create_msg("req-outcome-fresh"), None)
            .await;
        let frame = await_claude_created(&mut rx, "req-outcome-fresh").await;
        assert_eq!(
            fresh,
            ClaudeCreateOutcome::Created {
                session_id: frame["sessionId"].as_str().unwrap().to_string(),
                session_ref: Some(claude_session_ref(frame["sessionId"].as_str().unwrap())),
            }
        );

        let durable = "77777777-7777-4777-8777-777777777777";
        let mut resume = dedup_create_msg("req-outcome-resume");
        resume.resume_session_id = Some(durable.to_string());
        let resumed = st.handle_create(resume, None).await;
        let frame = await_claude_created(&mut rx, "req-outcome-resume").await;
        assert_eq!(
            resumed,
            ClaudeCreateOutcome::Created {
                session_id: frame["sessionId"].as_str().unwrap().to_string(),
                session_ref: Some(claude_session_ref(durable)),
            }
        );
        assert_eq!(frame["sessionRef"]["sessionId"], durable);
        drop(env);
    }

    /// b8ke ext r22 F1 (b): a spawn-time provider rejection during the
    /// fresh-create window settles the provisional record typed through the
    /// ticket — the record is never left wedged in Starting and the create
    /// answers the typed failure.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_fresh_claude_create_spawn_failure_settles_the_durable_record() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        // The FAIL knob: the sidecar dies before `created` (a spawn-time
        // provider rejection — EOF).
        let env = FakeClaudeSidecarEnv::install_with_knobs(Some(1500), true);
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        let task_st = st.clone();
        let create = tokio::spawn(async move {
            task_st
                .handle_create(dedup_create_msg("req-r22-claude-fail"), None)
                .await;
        });

        let launch = env.create_request().await;
        let durable = launch["sessionId"].as_str().unwrap();
        // The window's record exists before the failure lands.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe(PROVIDER, durable).state,
                freshell_ownership::OwnershipState::Starting { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the spawn-failure create never showed the durable record"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // The failure lands: the ticket's RAII typed fail settles the
        // durable record — never a wedged Starting.
        create.await.expect("the create task joins");
        let mut failed_code = None;
        while let Ok(frame) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&frame).expect("json frame");
            if frame["type"] == "freshAgent.create.failed"
                && frame["requestId"] == json!("req-r22-claude-fail")
            {
                failed_code = frame["code"].as_str().map(str::to_string);
            }
        }
        assert_eq!(
            failed_code.as_deref(),
            Some("CLAUDE_CREATE_FAILED"),
            "the spawn failure answers typed"
        );
        assert!(
            matches!(
                registry.observe(PROVIDER, durable).state,
                freshell_ownership::OwnershipState::Vacant
            ),
            "the durable record settles typed (Vacant) — got {:?}",
            registry.observe(PROVIDER, durable).state
        );
    }

    // Creation may publish the CLI index and durable binding while its
    // ownership attach guard still holds the key. Match the production
    // handoff caller's bounded retry of that transient Blocked outcome.
    async fn begin_test_terminal_handoff(
        registry: &freshell_ownership::RuntimeOwnershipRegistry,
        durable_id: &str,
        operation_id: &str,
    ) -> u64 {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            match registry.begin_handoff(
                "claude",
                durable_id,
                freshell_ownership::RuntimeOwnerKind::Terminal,
                operation_id,
                None,
                "test",
                0,
            ) {
                freshell_ownership::BeginOutcome::Granted { generation } => return generation,
                freshell_ownership::BeginOutcome::Blocked { retry_after_ms, .. } => {
                    assert!(
                        tokio::time::Instant::now() < deadline,
                        "the Handoff begin never cleared its transient Blocked window"
                    );
                    tokio::time::sleep(std::time::Duration::from_millis(retry_after_ms.min(50)))
                        .await;
                }
                other => panic!("expected the Handoff begin to be granted, got {other:?}"),
            }
        }
    }

    /// Wait until the fresh create's adoption has COMMITTED ownership under
    /// `durable_id`. The adoption publishes the `cli_index` alias and then
    /// writes the identity binding BEFORE its commit (ext r27 F4: a failed
    /// binding abandons it pre-commit), and the commit-to-Live plus the
    /// retained release stamp are one critical section under the stamps
    /// lock (ext r30 F1) — so neither the alias nor `was_recorded` proves
    /// the commit: both can be observed while the claim is still Starting
    /// and the stamp is absent. The stamp is the real condition.
    async fn await_create_ownership_committed(st: &FreshClaudeState, durable_id: &str) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while crate::ownership_lane::peek_retained_stamp(&st.ownership_stamps, durable_id).is_none()
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the create's adoption never committed ownership (no retained stamp)"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    /// [`await_create_ownership_committed`] for a create with a RECORDABLE
    /// binding, then pins the binding-first order.
    async fn await_create_adoption_committed(
        st: &FreshClaudeState,
        sink: &crate::identity_sink::FakeIdentitySink,
        durable_id: &str,
    ) {
        await_create_ownership_committed(st, durable_id).await;
        assert!(
            sink.was_recorded("claude", durable_id),
            "the adoption records the binding before it commits ownership"
        );
    }

    /// b8ke delta round-3 F1: a coordinator-REFUSED kill mutates NOTHING
    /// durable — the pane-ledger row stays BOUND, the session stays live,
    /// and the refusal broadcast is TYPED (code + message, never
    /// code:None). Pre-d3 the durable close retired the row BEFORE the
    /// claim, so a BlockedHandoff/StaleClaim refusal returned with the
    /// durable row closed although the runtime still ran.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_kill_keeps_the_durable_ledger_bound_and_answers_typed() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink.clone());

        let mut create_f1 = dedup_create_msg("req-d3-f1");
        create_f1.model = Some("opus".into());
        st.handle_create(create_f1, None).await;
        let created = await_claude_created(&mut rx, "req-d3-f1").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        // The adoption publishes + commits ownership under the durable id
        // (non-default settings make the binding RECORDABLE so the
        // ledger-bound assertions are non-vacuous).
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !sink.was_recorded("claude", fresh_create_durable_id) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the create's adoption never recorded the binding"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // THE REFUSAL WINDOW: the handoff owns the key's transition.
        let _handoff_generation = begin_test_terminal_handoff(
            &registry,
            fresh_create_durable_id,
            "handoff-blocking-d3-f1",
        )
        .await;

        st.handle_kill(kill_msg(&placeholder)).await;

        // THE TYPED refusal broadcast (code + message set — pre-d3 both
        // were None).
        let frame = await_specific_frame(&mut rx, "freshAgent.killed", &placeholder).await;
        assert_eq!(frame["success"], json!(false));
        assert_eq!(
            frame["code"],
            json!("HANDOFF_IN_FLIGHT"),
            "the refusal broadcast is TYPED: {frame}"
        );
        assert!(
            frame["message"].is_string(),
            "the refusal broadcast carries the typed message"
        );

        // THE F1 CONTRACT: the durable ledger stays BOUND on refusal — the
        // row was never closed (pre-d3 the close retired it before the
        // claim). The load-settings path still resolves the record.
        assert!(
            sink.was_recorded("claude", fresh_create_durable_id),
            "the durable ledger row stays recorded (bound) on refusal"
        );
        // THE deterministic closed-vs-bound probe: the fake's retire log is
        // EMPTY for this session — the kill never reached the durable
        // close (pre-d3 the close retired the row before the claim).
        assert!(
            sink.retires
                .lock()
                .unwrap()
                .iter()
                .all(|(_, id)| id != fresh_create_durable_id),
            "the durable ledger row was NOT closed on refusal — the retire \
             log must not name it"
        );
        // And the runtime is still live in the map (has_live_session keys
        // through cli_index — the DURABLE id is the index's entry).
        assert!(
            st.has_live_session(fresh_create_durable_id).await,
            "the refused kill left the session live"
        );
    }

    /// b8ke e3r1 F1: a DELAYED kill after a completed handoff NEVER
    /// fabricates a claim against the replacement owner. The handoff
    /// consumed the Fresh Agent stamp and committed a TERMINAL owner; the
    /// stale `freshAgent.kill` reaches the no-stamp fallback, observes the
    /// terminal, and must answer the TYPED refusal — the terminal owner
    /// stays Live and untouched (pre-e3r1 the fallback fabricated a
    /// matching terminal StopClaim, got Granted, and committed the key to
    /// Vacant while the live PTY was never torn down — the untracked
    /// second-writer hole).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_delayed_kill_after_a_handoff_never_fabricates_a_foreign_owner_claim() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        st.handle_create(dedup_create_msg("req-e3r1-f1"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-e3r1-f1").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        await_create_ownership_committed(&st, fresh_create_durable_id).await;

        // THE COMPLETED HANDOFF (simulated at the coordinator level): the
        // stamp is consumed and a TERMINAL owner is committed under the
        // durable id.
        crate::ownership_lane::take_retained_stamp(&st.ownership_stamps, fresh_create_durable_id);
        let generation = begin_test_terminal_handoff(
            &registry,
            fresh_create_durable_id,
            "handoff-completed-e3r1",
        )
        .await;
        let terminal_owner = freshell_ownership::OwnerIdentity {
            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-replacement".into()),
            live_session_key: None,
            pid: None,
            ownership_id: Some("handoff-completed-e3r1".into()),
        };
        assert!(matches!(
            registry.commit_live(
                "claude",
                fresh_create_durable_id,
                "handoff-completed-e3r1",
                generation,
                terminal_owner.clone(),
            ),
            freshell_ownership::CommitOutcome::Committed
        ));

        // THE DELAYED KILL (no stamp — the fallback path).
        st.handle_kill(kill_msg(&placeholder)).await;

        let frame = await_specific_frame(&mut rx, "freshAgent.killed", &placeholder).await;
        assert_eq!(frame["success"], json!(false));
        assert_eq!(
            frame["code"],
            json!("FOREIGN_OWNER"),
            "the delayed kill answers the TYPED foreign-owner refusal: {frame}"
        );
        // The replacement TERMINAL owner is untouched — the coordinator
        // still holds it Live (never fabricated into a Vacant commit).
        match registry.observe("claude", fresh_create_durable_id).state {
            freshell_ownership::OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, freshell_ownership::RuntimeOwnerKind::Terminal);
                assert_eq!(owner.terminal_id.as_deref(), Some("t-replacement"));
            }
            other => panic!(
                "the terminal owner must stay Live — got {other:?} \
                 (pre-e3r1: the fabricated claim committed it to Vacant)"
            ),
        }
    }

    /// b8ke e3r1 F2: a clean-close failure after a GRANTED kill unwinds
    /// EVERYTHING the grant consumed — the registry via abort_stop AND the
    /// retained stamp — so the natural-exit watcher can still release
    /// ownership (pre-e3r1 the abort restored the registry but left the
    /// runtime release-less: a later crash stayed recorded live).
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_clean_close_failure_unwinds_the_grant_and_restores_the_release_stamp() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink.clone());

        let mut create = dedup_create_msg("req-e3r1-f2");
        create.model = Some("opus".into());
        st.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "req-e3r1-f2").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        await_create_adoption_committed(&st, &sink, fresh_create_durable_id).await;
        assert!(
            crate::ownership_lane::peek_retained_stamp(
                &st.ownership_stamps,
                fresh_create_durable_id
            )
            .is_some(),
            "the create's commit retained the release stamp"
        );

        // The clean close failure (identity-conditional on the durable id).
        sink.fail_retires_for("claude", fresh_create_durable_id);
        st.handle_kill(kill_msg(&placeholder)).await;

        let frame = await_specific_frame(&mut rx, "freshAgent.killed", &placeholder).await;
        assert_eq!(
            frame["code"],
            json!("DURABLE_CLOSE_FAILED"),
            "the recoverable close failure answers typed: {frame}"
        );
        // THE ABORT restored the registry to Live{FreshAgent} ...
        assert!(matches!(
            registry.observe("claude", fresh_create_durable_id).state,
            freshell_ownership::OwnershipState::Live { .. }
        ));
        // ... AND the stamp is back (pre-e3r1: consumed forever).
        assert!(
            crate::ownership_lane::peek_retained_stamp(
                &st.ownership_stamps,
                fresh_create_durable_id
            )
            .is_some(),
            "the abort RESTORED the consumed release stamp — the exit watcher \
             can release ownership after the recoverable failure"
        );
        // THE NATURAL EXIT now works: the release path takes the restored
        // stamp and vacates the key.
        crate::ownership_lane::release_retained_stamp(
            &Some(Arc::clone(&registry)),
            &st.ownership_stamps,
            "claude",
            fresh_create_durable_id,
            "claude-exit",
        );
        assert!(
            matches!(
                registry.observe("claude", fresh_create_durable_id).state,
                freshell_ownership::OwnershipState::Vacant
            ),
            "the natural exit released the restored stamp — the owner is \
             vacated (pre-e3r1: a crash stayed recorded live forever)"
        );
    }

    /// b8ke e3r3 F8: a sidecar that exits AFTER the live verdict — the
    /// atomic re-validation under the stamps lock refuses to restore its
    /// stamp (pre-e3r3 the restore wrote the stamp back for a dead
    /// process after ownership returned to Live — a zombie stamp with no
    /// future watcher). The deterministic window: the clean-close
    /// failure's pre-restore park holds the kill AFTER its granted take;
    /// the sidecar dies while parked.
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_sidecar_exit_after_the_live_verdict_never_gets_its_stamp_restored() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink.clone());

        let mut create = dedup_create_msg("req-e3r3-f8");
        create.model = Some("opus".into());
        st.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "req-e3r3-f8").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        await_create_adoption_committed(&st, &sink, fresh_create_durable_id).await;
        let stamp = crate::ownership_lane::peek_retained_stamp(
            &st.ownership_stamps,
            fresh_create_durable_id,
        )
        .expect("the create's stamp");
        let runtime_pid = stamp.owner.pid.expect("the sidecar pid");

        // Arm the close failure + the pre-restore park; the kill parks
        // AFTER its granted take (the stamp is consumed, the sidecar LIVE).
        sink.fail_retires_for("claude", fresh_create_durable_id);
        let pause = std::sync::Arc::new(AdoptionTestPause {
            notify: tokio::sync::Notify::new(),
            reached: std::sync::atomic::AtomicBool::new(false),
        });
        st.set_kill_close_failure_test_pause(Some(std::sync::Arc::clone(&pause)));
        let st2 = st.clone();
        let ph = placeholder.clone();
        let kill_task = tokio::spawn(async move {
            st2.handle_kill(kill_msg(&ph)).await;
        });
        let park_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !pause.reached.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(
                tokio::time::Instant::now() < park_deadline,
                "the kill never reached the pre-restore park"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        st.set_kill_close_failure_test_pause(None);

        // THE SIDECAR EXITS AFTER the take, while the kill is parked in
        // the clean-failure arm (before the verdict+restore).
        let kill_res = tokio::process::Command::new("kill")
            .arg("-9")
            .arg(runtime_pid.to_string())
            .status()
            .await
            .expect("kill -9 the sidecar");
        assert!(kill_res.success());
        let reap_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !crate::ownership_lane::partial_pid_confirmed_dead(runtime_pid) {
            assert!(
                tokio::time::Instant::now() < reap_deadline,
                "the killed sidecar was never reaped"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // Release: the atomic re-validation (under the stamps lock) sees
        // the DEAD incarnation → NO restore; the registry ends Vacant.
        pause.notify.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(15), kill_task)
            .await
            .expect("the kill task completed")
            .expect("the kill task did not panic");
        let frame = await_specific_frame(&mut rx, "freshAgent.killed", &placeholder).await;
        assert_eq!(
            frame["code"],
            json!("DURABLE_CLOSE_FAILED"),
            "the recoverable close failure answers typed: {frame}"
        );
        assert!(
            matches!(
                registry.observe("claude", fresh_create_durable_id).state,
                freshell_ownership::OwnershipState::Vacant
            ),
            "the dead sidecar ends VACANT — the registry followed the same \
             verdict (never a dead runtime resurrected as Live)"
        );
        assert!(
            crate::ownership_lane::peek_retained_stamp(
                &st.ownership_stamps,
                fresh_create_durable_id
            )
            .is_none(),
            "the stamp is NOT restored for the dead sidecar (the atomic \
             re-validation refused it under the lock)"
        );
    }

    /// b8ke e3r4 F1: the NO-STAMP live-owner close failure is NOT
    /// converted to "runtime exited" — the fallback's Granted path records
    /// the SAME bookkeeping as the stamp-present path (the synthesized
    /// rollback stamp + the settlement guard), so the unwind verifies the
    /// runtime's liveness directly (the LIVE sidecar stays Live; the key
    /// is never committed to Vacant over a live runtime). A slow-but-
    /// running no-stamp stop is never fenced as unregistered (the guard).
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_no_stamp_live_owner_close_failure_stays_live_never_vacant() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink.clone());

        let mut create = dedup_create_msg("req-e3r4-f1");
        create.model = Some("opus".into());
        st.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "req-e3r4-f1").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        await_create_adoption_committed(&st, &sink, fresh_create_durable_id).await;

        // THE NO-STAMP SHAPE: consume the retained stamp (the handoff's
        // kill_for_handoff consumption) — the kill runs the no-stamp
        // fallback with a LIVE owner observed.
        crate::ownership_lane::take_retained_stamp(&st.ownership_stamps, fresh_create_durable_id);

        // The clean close failure.
        sink.fail_retires_for("claude", fresh_create_durable_id);
        st.handle_kill(kill_msg(&placeholder)).await;
        let frame = await_specific_frame(&mut rx, "freshAgent.killed", &placeholder).await;
        assert_eq!(
            frame["code"],
            json!("DURABLE_CLOSE_FAILED"),
            "the recoverable close failure answers typed: {frame}"
        );

        // THE F1 CONTRACT: the LIVE runtime stays LIVE (abort_stop
        // restored it) — NEVER committed to Vacant over a live runtime
        // (pre-e3r4 the absent stamp was converted to "exited" and the
        // key vacated, licensing a second writer).
        assert!(
            matches!(
                registry.observe("claude", fresh_create_durable_id).state,
                freshell_ownership::OwnershipState::Live { owner, .. }
                    if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent,
            ),
            "the no-stamp live-owner close failure keeps the runtime LIVE \
             (the synthesized rollback evidence verified the live sidecar)"
        );
        // And the session stays live in the lane.
        assert!(
            st.has_live_session(fresh_create_durable_id).await,
            "the runtime still runs — nothing was killed"
        );

        // b8ke e3 post-cap F1: THE END-TO-END natural-exit path — the
        // restored stamp must SATISFY release's identity checks (the
        // exact end-to-end recovery, not just the stamp's presence):
        // the sidecar later exits; the exit watcher releases; the key
        // goes Vacant (pre-post-cap the minted stop generation + kill
        // op id could never match abort_stop's restored Live, so a
        // recovered close failure stayed falsely Live until restart).
        {
            let stamp = crate::ownership_lane::peek_retained_stamp(
                &st.ownership_stamps,
                fresh_create_durable_id,
            )
            .expect("the recovered stamp (the original identity)");
            // Kill the sidecar so the exit shape is real.
            let sidecar_pid = stamp.owner.pid.expect("the sidecar pid");
            let kill_res = tokio::process::Command::new("kill")
                .arg("-9")
                .arg(sidecar_pid.to_string())
                .status()
                .await
                .expect("kill -9 the sidecar");
            assert!(kill_res.success());
            let reap_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
            while !crate::ownership_lane::partial_pid_confirmed_dead(sidecar_pid) {
                assert!(
                    tokio::time::Instant::now() < reap_deadline,
                    "the killed sidecar was never reaped"
                );
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
            // THE EXIT WATCHER's path.
            crate::ownership_lane::release_retained_stamp(
                &Some(Arc::clone(&registry)),
                &st.ownership_stamps,
                "claude",
                fresh_create_durable_id,
                "claude-exit",
            );
            assert!(
                matches!(
                    registry.observe("claude", fresh_create_durable_id).state,
                    freshell_ownership::OwnershipState::Vacant
                ),
                "the natural exit RELEASES the key — the recovered stamp \
                 matched abort_stop's restored identity"
            );
        }
    }

    /// b8ke e3r2 F1: a DELAYED kill arriving MID-HANDOFF is refused typed.
    /// During a handoff, kill_for_handoff consumes the stamp while the
    /// coordinator stays Handoff — the concurrent kill enters the no-stamp
    /// fallback, observes the Handoff state, and answers the TYPED
    /// HANDOFF_IN_FLIGHT refusal: NOTHING durable closes, the session stays
    /// live, and the handoff completes undisturbed (pre-e3r2 the wildcard
    /// arm treated Handoff as "residue" and proceeded — racing the
    /// replacement commit over a closed ledger row).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_delayed_kill_mid_handoff_answers_typed_and_does_not_race_the_handoff() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink.clone());

        let mut create = dedup_create_msg("req-e3r2-f1");
        create.model = Some("opus".into());
        st.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "req-e3r2-f1").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        await_create_adoption_committed(&st, &sink, fresh_create_durable_id).await;

        // THE MID-HANDOFF WINDOW: kill_for_handoff consumed the stamp
        // while the coordinator record stays Handoff.
        crate::ownership_lane::take_retained_stamp(&st.ownership_stamps, fresh_create_durable_id);
        let generation = begin_test_terminal_handoff(
            &registry,
            fresh_create_durable_id,
            "handoff-in-flight-e3r2",
        )
        .await;

        // THE CONCURRENT KILL: typed refusal, NOTHING durable.
        st.handle_kill(kill_msg(&placeholder)).await;
        let frame = await_specific_frame(&mut rx, "freshAgent.killed", &placeholder).await;
        assert_eq!(frame["success"], json!(false));
        assert_eq!(
            frame["code"],
            json!("HANDOFF_IN_FLIGHT"),
            "the mid-handoff kill answers the TYPED in-flight refusal: {frame}"
        );
        assert!(
            sink.retires
                .lock()
                .unwrap()
                .iter()
                .all(|(_, id)| id != fresh_create_durable_id),
            "NOTHING durable closed — the ledger row stays bound"
        );
        assert!(
            st.has_live_session(fresh_create_durable_id).await,
            "the session stays live for the handoff"
        );

        // THE HANDOFF COMPLETES UNDISTURBED (the coordinator record was
        // never vacated or stolen by the kill).
        let terminal_owner = freshell_ownership::OwnerIdentity {
            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-replacement-e3r2".into()),
            live_session_key: None,
            pid: None,
            ownership_id: Some("handoff-in-flight-e3r2".into()),
        };
        assert!(matches!(
            registry.commit_live(
                "claude",
                fresh_create_durable_id,
                "handoff-in-flight-e3r2",
                generation,
                terminal_owner,
            ),
            freshell_ownership::CommitOutcome::Committed
        ));
    }

    /// b8ke e3r2 F2: the watcher-race take — a concurrent consumer-exit
    /// watcher removes the retained stamp BETWEEN the stop claim and the
    /// take. The take is Option-tolerant (pre-e3r2: `.expect` PANICKED and
    /// the claim stranded in Stopping); the kill proceeds coherently under
    /// the held claim and commits the stop.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_watcher_race_on_the_stamp_take_never_panics_and_completes_coherently() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink.clone());

        let mut create = dedup_create_msg("req-e3r2-f2");
        create.model = Some("opus".into());
        st.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "req-e3r2-f2").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while crate::ownership_lane::peek_retained_stamp(
            &st.ownership_stamps,
            fresh_create_durable_id,
        )
        .is_none()
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the create's adoption never retained the ownership stamp"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // The race window: park between the stop claim and the take.
        let pause = std::sync::Arc::new(AdoptionTestPause {
            notify: tokio::sync::Notify::new(),
            reached: std::sync::atomic::AtomicBool::new(false),
        });
        st.set_kill_stop_take_test_pause(Some(std::sync::Arc::clone(&pause)));
        let st2 = st.clone();
        let ph = placeholder.clone();
        let kill_task = tokio::spawn(async move {
            st2.handle_kill(kill_msg(&ph)).await;
        });
        let park_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !pause.reached.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(
                tokio::time::Instant::now() < park_deadline,
                "the kill never reached the take-race park"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        st.set_kill_stop_take_test_pause(None);

        // THE WATCHER'S RACE: the stamp vanishes while the kill is parked
        // (its registry release no-ops against our Stopping).
        let raced_stamp = crate::ownership_lane::take_retained_stamp(
            &st.ownership_stamps,
            fresh_create_durable_id,
        );
        assert!(raced_stamp.is_some(), "the stamp existed at the park");

        // Release: NO PANIC (the pre-e3r2 expect panicked here); the kill
        // completes coherently — the stop commits, the key vacates.
        pause.notify.notify_one();
        let kill_result = tokio::time::timeout(std::time::Duration::from_secs(15), kill_task).await;
        match kill_result {
            Ok(Ok(())) => {}
            Ok(Err(join_err)) => {
                panic!("the kill task PANICKED on the raced take (pre-e3r2 shape): {join_err}")
            }
            Err(_) => panic!("the kill never completed after the raced take"),
        }
        let frame = await_specific_frame(&mut rx, "freshAgent.killed", &placeholder).await;
        assert_eq!(
            frame["success"],
            json!(true),
            "the kill completed coherently under the held claim: {frame}"
        );
        assert!(matches!(
            registry.observe("claude", fresh_create_durable_id).state,
            freshell_ownership::OwnershipState::Vacant
        ));
    }

    /// b8ke e3r2 F4: the runtime exits during the awaited close — the
    /// failure path does NOT resurrect it. The unwind's liveness verdict
    /// sees the dead child and ends the key VACANT (never falsely Live
    /// with no future watcher); the stamp is not restored.
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread")]
    async fn a_runtime_exit_during_the_close_failure_is_never_resurrected() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink.clone());

        let mut create = dedup_create_msg("req-e3r2-f4");
        create.model = Some("opus".into());
        st.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "req-e3r2-f4").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        await_create_adoption_committed(&st, &sink, fresh_create_durable_id).await;

        // THE RUNTIME EXITS (the sidecar's recorded pid is killed outright
        // — it is dead by the time the kill's unwind verdict runs).
        let stamp = crate::ownership_lane::peek_retained_stamp(
            &st.ownership_stamps,
            fresh_create_durable_id,
        )
        .expect("the create's stamp");
        let runtime_pid = stamp.owner.pid.expect("the sidecar pid");
        let kill_res = tokio::process::Command::new("kill")
            .arg("-9")
            .arg(runtime_pid.to_string())
            .status()
            .await
            .expect("kill -9 the sidecar");
        assert!(kill_res.success(), "the sidecar was killed");
        // Wait for the consumer's reap (the EOF path reaps its child; the
        // verdict's recorded-incarnation probe is /proc-based, so the
        // zombie must be gone before the kill runs — the same ordering
        // production guarantees: the consumer always reaps its own child).
        let reap_deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !crate::ownership_lane::partial_pid_confirmed_dead(runtime_pid) {
            assert!(
                tokio::time::Instant::now() < reap_deadline,
                "the killed sidecar was never reaped"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // The clean close failure → the unwind's verdict: DEAD → Vacant.
        sink.fail_retires_for("claude", fresh_create_durable_id);
        st.handle_kill(kill_msg(&placeholder)).await;
        let frame = await_specific_frame(&mut rx, "freshAgent.killed", &placeholder).await;
        assert_eq!(
            frame["code"],
            json!("DURABLE_CLOSE_FAILED"),
            "the recoverable close failure answers typed: {frame}"
        );
        // NOT resurrected: the key ends VACANT (pre-e3r2: abort_stop
        // restored a DEAD runtime as Live with no future watcher).
        assert!(
            matches!(
                registry.observe("claude", fresh_create_durable_id).state,
                freshell_ownership::OwnershipState::Vacant
            ),
            "the exited runtime ends VACANT — never resurrected as Live"
        );
        // And the stamp is not restored (peek absent — or, if the watcher's
        // race emptied it first, still absent).
        assert!(
            crate::ownership_lane::peek_retained_stamp(
                &st.ownership_stamps,
                fresh_create_durable_id
            )
            .is_none(),
            "no release stamp is restored for a dead runtime"
        );
    }

    /// b8ke e3r1 F3: an adopt over a LIVE runtime COMMITS that runtime as
    /// the authoritative owner — the ticket's drop never leaves a live
    /// writer's key Vacant (pre-e3r1 the adopt returned while the drop
    /// restored Vacant, licensing a terminal claim to start a second
    /// writer beside the live one).
    #[tokio::test(flavor = "multi_thread")]
    async fn an_adopt_over_a_live_runtime_commits_the_owner() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        st.handle_create(dedup_create_msg("req-e3r1-f3"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-e3r1-f3").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let _placeholder = created["sessionId"].as_str().unwrap().to_string();
        await_create_ownership_committed(&st, fresh_create_durable_id).await;

        // THE UNOWNED-LIVE shape: the coordinator key goes Vacant (a
        // confirmed-kill release) while the lane map still holds the live
        // session.
        let stamp = crate::ownership_lane::take_retained_stamp(
            &st.ownership_stamps,
            fresh_create_durable_id,
        )
        .expect("the create's stamp");
        registry.force_release_for_confirmed_kill(
            "claude",
            fresh_create_durable_id,
            &freshell_ownership::ReleaseClaim {
                operation_id: stamp.operation_id.clone(),
                generation: stamp.generation,
                runtime: Some(stamp.owner.clone()),
            },
            "test-release",
        );
        assert!(matches!(
            registry.observe("claude", fresh_create_durable_id).state,
            freshell_ownership::OwnershipState::Vacant
        ));

        // A resume-create against the live session: the claim grants (the
        // key is Vacant) and the ADOPT must COMMIT the live runtime as the
        // owner.
        let mut resume = dedup_create_msg("req-e3r1-f3-resume");
        resume.resume_session_id = Some(fresh_create_durable_id.to_string());
        st.handle_create(resume, None).await;
        let adopted =
            await_specific_frame(&mut rx, "freshAgent.created", "req-e3r1-f3-resume").await;
        assert_eq!(
            adopted["sessionId"],
            json!(fresh_create_durable_id),
            "the live session was adopted under its durable id (no fresh spawn): {adopted}"
        );

        // THE F3 CONTRACT: the adopted runtime is the AUTHORITATIVE Live
        // owner — the key is NOT Vacant (pre-e3r1: the ticket's drop
        // restored Vacant while the runtime kept running).
        match registry.observe("claude", fresh_create_durable_id).state {
            freshell_ownership::OwnershipState::Live { owner, .. } => {
                assert_eq!(owner.kind, freshell_ownership::RuntimeOwnerKind::FreshAgent);
            }
            other => panic!("the adopt COMMITTED the live runtime as owner — got {other:?}"),
        }
        // And a subsequent TERMINAL start claim is refused while the
        // adopted owner holds (never a second writer).
        assert!(
            !matches!(
                registry.begin_start(
                    "claude",
                    fresh_create_durable_id,
                    freshell_ownership::RuntimeOwnerKind::Terminal,
                    "op-second-writer",
                    None,
                    "test",
                    0,
                ),
                freshell_ownership::BeginOutcome::Granted { .. }
            ),
            "a terminal claim cannot start a second writer beside the \
             adopted live owner"
        );
    }

    /// b8ke delta round-3 F2: a DELAYED create/attach against a session
    /// whose key a Handoff owns is blocked TYPED — never a silent
    /// map-hit adopt (the create) or a silent parity no-op (the attach).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_delayed_create_and_attach_during_handoff_answer_typed() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        st.handle_create(dedup_create_msg("req-d3-f2"), None).await;
        let created = await_claude_created(&mut rx, "req-d3-f2").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while st
            .cli_index
            .lock()
            .await
            .get(fresh_create_durable_id)
            .is_none()
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the create's adoption never published"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // The Handoff window: the map entry still exists (the runtime has
        // not stopped yet) — the pre-d3 fast paths adopted/no-op'd here.
        begin_test_terminal_handoff(&registry, fresh_create_durable_id, "handoff-blocking-d3-f2")
            .await;

        // A delayed CREATE (resume through the live session): the claim
        // sees the Handoff state and answers the typed refusal — never
        // adopt_live_create's created frame.
        // The delayed create addresses the DURABLE id (the pane's
        // sessionRef) — the claim resolves and sees the Handoff state.
        let mut delayed_create = dedup_create_msg("req-d3-f2-delayed");
        delayed_create.resume_session_id = Some(fresh_create_durable_id.to_string());
        st.handle_create(delayed_create, None).await;
        let refused =
            await_specific_frame(&mut rx, "freshAgent.create.failed", "req-d3-f2-delayed").await;
        assert_eq!(
            refused["code"],
            json!("SESSION_RESERVED"),
            "the delayed create answers the TYPED refusal: {refused}"
        );

        // A delayed ATTACH: the tracked-and-alive fast path is BLOCKED
        // with the typed error (pre-d3: the silent parity return).
        st.attach_for_test(freshell_protocol::FreshAgentAttach {
            tab_id: None,
            pane_id: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: placeholder.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
            observed_epoch: None,
            observed_generation: None,
            resume_session_id: None,
            session_ref: None,
        })
        .await;
        // The typed attach refusal rides a freshAgent.event envelope
        // (inner type freshAgent.error).
        let attach_refused = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(
            attach_refused["event"]["code"],
            json!("SESSION_RESERVED"),
            "the delayed attach answers the TYPED refusal: {attach_refused}"
        );
        assert_eq!(
            attach_refused["event"]["sessionId"],
            json!(placeholder),
            "the refusal names the addressed session"
        );
    }

    /// b8ke delta round-3: bounded drain until a frame of the given TYPE
    /// whose `requestId` OR `sessionId` matches the key arrives.
    async fn await_specific_frame(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        frame_type: &str,
        key: &str,
    ) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                let frame: Value = match rx.recv().await {
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(err) => panic!("broadcast recv failed: {err}"),
                    Ok(raw) => serde_json::from_str(&raw).unwrap(),
                };
                if frame["type"] != frame_type {
                    continue;
                }
                let request_match = frame
                    .get("requestId")
                    .and_then(Value::as_str)
                    .is_some_and(|v| v == key);
                let session_match = frame
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .is_some_and(|v| v == key);
                if request_match || session_match {
                    return frame;
                }
            }
        })
        .await
        .expect("the expected frame arrived within budget")
    }

    /// `freshAgent.kill` for an session id this process never created is idempotent
    /// (`success:true`), matching the codex/opencode pattern.
    #[tokio::test]
    async fn handle_kill_of_unknown_session_still_broadcasts_success() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: "unknown-session".to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.killed");
        assert_eq!(frame["success"], true);
        assert_eq!(frame["sessionId"], "unknown-session");
    }

    /// A configure handler can hold the turn lock while awaiting a receipt
    /// from this same consumer. Native rekey must let that consumer advance.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_conversation_rekey_does_not_wait_on_a_handler_awaiting_its_receipt() {
        let (st, _rx) = state_with_bus();
        let old = uuid::Uuid::new_v4().to_string();
        let new = uuid::Uuid::new_v4().to_string();
        insert_fake_claude_session(&st, &old).await;
        let (turn, pending) = {
            let sessions = st.sessions.lock().await;
            let session = &sessions[&old];
            (session.turn_lock.clone(), session.pending.clone())
        };
        let held = turn.lock().await;
        let moved = tokio::time::timeout(
            Duration::from_millis(500),
            st.rekey_conversation(&old, &new, "freshclaude", &pending, "test-configure"),
        )
        .await;
        assert!(
            moved.is_ok(),
            "the consumer cannot wait on a handler that needs its next receipt"
        );
        assert_eq!(moved.unwrap().unwrap(), new);
        assert!(Arc::ptr_eq(
            &st.sessions.lock().await[&new].turn_lock,
            &turn
        ));
        drop(held);
        st.shutdown().await;
    }

    /// A kill can resolve the old key just before `/clear` rekeys the same
    /// live runtime. Its close gate must re-resolve the wire id while holding
    /// the alias index and session map together, including in hosted states
    /// without an ownership coordinator.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn kill_re_resolves_a_conversation_rekey_before_arming_its_close_gate() {
        let (mut st, mut rx) = state_with_bus();
        let identity_sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(identity_sink.clone());
        let old = uuid::Uuid::new_v4().to_string();
        let new = uuid::Uuid::new_v4().to_string();
        insert_fake_claude_session(&st, &old).await;
        {
            let mut sessions = st.sessions.lock().await;
            sessions.get_mut(&old).unwrap().cli_session_id = Some(old.clone());
        }
        st.cli_index.lock().await.insert(old.clone(), old.clone());

        let pause = std::sync::Arc::new(AdoptionTestPause {
            notify: tokio::sync::Notify::new(),
            reached: std::sync::atomic::AtomicBool::new(false),
        });
        st.set_kill_after_resolve_test_pause(Some(std::sync::Arc::clone(&pause)));
        let kill_state = st.clone();
        let kill_id = old.clone();
        let kill = tokio::spawn(async move {
            kill_state.handle_kill(kill_msg(&kill_id)).await;
        });
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !pause.reached.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "kill did not reach the post-resolution pause"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        let pending = Arc::clone(&st.sessions.lock().await[&old].pending);
        assert_eq!(
            st.rekey_conversation(&old, &new, "freshclaude", &pending, "test")
                .await
                .expect("the live conversation rekeys"),
            new,
        );
        pause.notify.notify_one();
        tokio::time::timeout(std::time::Duration::from_secs(15), kill)
            .await
            .expect("the kill settles")
            .expect("the kill task completes");

        assert!(
            !st.sessions.lock().await.contains_key(&new),
            "kill(old) must remove the runtime after it was rekeyed to new"
        );
        let killed = await_specific_frame(&mut rx, "freshAgent.killed", &old).await;
        assert_eq!(killed["success"], true, "the kill result is {killed}");
        let retired = identity_sink.retires.lock().unwrap().clone();
        assert!(
            retired.contains(&("claude".to_string(), old.clone()))
                && retired.contains(&("claude".to_string(), new.clone())),
            "kill(old) must close both the addressed alias and current identity: {retired:?}"
        );
    }

    /// Retire-on-kill (delta-review round 5, restore-open-sessions-only): an
    /// explicit kill is an intentional session END — the pane-ledger row retires
    /// `Closed` through the identity sink, so the recovery inventory (Bound-only
    /// at its pre-filter) can never re-offer a pane the user just closed inside
    /// the 7s creation-race grace window. The ledger row is keyed on the DURABLE
    /// claude UUID while the wire kill may name the placeholder (the created
    /// frame's sessionId) or the durable alias — BOTH must retire the
    /// durable-keyed row.
    #[tokio::test]
    async fn handle_kill_retires_the_durable_row_whichever_id_addresses_it() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(dedup_create_msg("req-retire-claude"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-retire-claude").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        let durable = "3d3d3d3d-3d3d-4d3d-8d3d-3d3d3d3d3d3d";
        // Alias the durable id at it (live: the consumer's sdk.session.init fold
        // writes this mapping; here the test writes it directly, same trick as
        // attach_rebind_ack_stamps_the_tracked_live_status_not_hardcoded_idle).
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), placeholder.clone());
        st.sessions
            .lock()
            .await
            .get_mut(&placeholder)
            .expect("session tracked under the placeholder")
            .cli_session_id = Some(durable.to_string());

        // Kill addressed by the DURABLE id must retire the durable-keyed row
        // (resolve_session_key walks cli_index to the live map key).
        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: durable.to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;
        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            retires.contains(&("claude".to_string(), durable.to_string())),
            "a durable-addressed kill must retire (claude, {durable}): {retires:?}"
        );

        // Re-create + re-alias (the kill removed both), then kill addressed by
        // the PLACEHOLDER — the same durable row must retire.
        st.handle_create(dedup_create_msg("req-retire-claude-2"), None)
            .await;
        let created2 = await_claude_created(&mut rx, "req-retire-claude-2").await;
        let placeholder2 = created2["sessionId"].as_str().unwrap().to_string();
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), placeholder2.clone());
        st.sessions
            .lock()
            .await
            .get_mut(&placeholder2)
            .expect("session tracked under the placeholder")
            .cli_session_id = Some(durable.to_string());
        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: placeholder2.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;
        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            retires
                .iter()
                .filter(|(p, s)| p == "claude" && s == durable)
                .count()
                >= 2,
            "a placeholder-addressed kill must retire the same durable row: {retires:?}"
        );
        drop(env);
    }

    /// The unknown-id arm of the same contract: a kill for a session this
    /// process already evicted (the map is process memory; the durable row
    /// outlives it) still retires the row the id names — idempotently when no
    /// row exists.
    #[tokio::test]
    async fn handle_kill_of_an_evicted_session_still_retires_the_row_it_names() {
        let (st, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: "evicted-durable".to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            retires.contains(&("claude".to_string(), "evicted-durable".to_string())),
            "the kill must retire (claude, evicted-durable): {retires:?}"
        );
    }

    /// Delta-r6 close-durability finding (claude lane): the durable close must
    /// be recorded BEFORE the kill mutates any live state — the pre-fix lane
    /// removed the session from its map, aborted its consumer, and awaited the
    /// alias collection BEFORE the retire, so a restart or cancellation inside
    /// those awaits left the row Bound for a pane the user had closed ("the
    /// close has already altered live state" with nothing durable). The test
    /// holds the `sessions` map guard (the removal's gate): the named
    /// identity's retire must be observable while the removal parks there —
    /// with the session still mapped (no live-state mutation yet).
    #[tokio::test(flavor = "multi_thread")]
    async fn handle_kill_records_the_close_before_the_map_removal() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(dedup_create_msg("req-close-before-removal"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-close-before-removal").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();

        // Delta-r6-r3 staging: park the kill AT the close envelope itself —
        // its mutations have landed (the durable close IS on record) and only
        // its answer stalls — while nothing live may have been touched yet.
        // (The pre-envelope staging held the `sessions` map guard to park the
        // removal; the envelope lane legitimately consults that map while
        // collecting the close set, so the gate moved to where the property
        // lives.)
        let stall = fake.arm_retire_stall("claude", &placeholder);
        let st2 = st.clone();
        let ph = placeholder.clone();
        let mut kill = tokio::spawn(async move {
            st2.handle_kill(FreshAgentKill {
                observed_epoch: None,
                observed_generation: None,
                provider: freshell_protocol::AgentProvider::Claude,
                session_id: ph,
                session_type: SessionType::Freshclaude,
                cwd: None,
            })
            .await;
        });

        stall
            .entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect(
                "the durable close must be recorded BEFORE the map removal — the kill \
                 parked without recording anything (a restart there leaves the row Bound \
                 behind an already-closing pane)",
            );
        assert!(
            st.sessions.lock().await.contains_key(&placeholder),
            "no live-state mutation yet: the session is still mapped while the close envelope's answer parks"
        );
        stall.release.send(()).expect("release the stall");
        tokio::time::timeout(std::time::Duration::from_secs(15), &mut kill)
            .await
            .expect("the kill completes once the hold releases")
            .expect("kill task completed");
        assert!(
            st.sessions.lock().await.get(&placeholder).is_none(),
            "the full lane completed: the session is removed"
        );
    }

    /// Delta-r6 close-durability (failures propagate), the claude lane: a kill
    /// whose durable close could NOT be recorded must FAIL — the
    /// `freshAgent.killed` answer reports `success:false` and NO live state
    /// was touched (the session stays mapped, its consumer un-aborted; the
    /// abort/removal/teardown never ran). Warn-and-continue would leave the
    /// row Bound and recoverable while the client believes the pane closed.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kill_whose_durable_close_fails_reports_failure_and_touches_no_live_state() {
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        insert_fake_claude_session(&st, "sess-kill-fail").await;
        // The ledger fails every write (disk-full/permission shape).
        fake.set_fail_writes(true);

        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: "sess-kill-fail".to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        assert!(
            st.sessions.lock().await.contains_key("sess-kill-fail"),
            "a failed durable close must leave the session mapped (nothing torn down)"
        );
        assert!(
            !fake
                .retires
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), "sess-kill-fail".to_string())),
            "sanity: the failed retire recorded nothing"
        );
        let mut killed_frame = None;
        while let Ok(raw) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.killed" {
                killed_frame = Some(frame);
            }
        }
        let killed_frame = killed_frame.expect("the kill answers freshAgent.killed");
        assert_eq!(
            killed_frame["success"], false,
            "a kill whose durable close failed must report success:false: {killed_frame}"
        );
    }

    /// Delta-r6-r4 (focused-episode-6 round 3, Finding 3), the claude lane's
    /// PERSISTED class on the pre-destruction envelope: the whole identity
    /// set's journal record IS durable although its write reports failure.
    /// The kill must END the session (map removal, consumer abort, teardown —
    /// never a live session beside durable close evidence) while the answer
    /// reports `success:false`.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kill_whose_close_persists_despite_the_reported_error_ends_the_session_and_fails_visibly(
    ) {
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        insert_fake_claude_session(&st, "sess-kill-pers").await;
        fake.fail_retires_as_persisted
            .store(true, std::sync::atomic::Ordering::SeqCst);

        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: "sess-kill-pers".to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        assert!(
            !st.sessions.lock().await.contains_key("sess-kill-pers"),
            "the close IS durable: the session ends (never a live session beside close evidence)"
        );
        assert!(
            fake.retires
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), "sess-kill-pers".to_string())),
            "the close's facts are on record"
        );
        let mut killed_frame = None;
        while let Ok(raw) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.killed" {
                killed_frame = Some(frame);
            }
        }
        let killed_frame = killed_frame.expect("the kill answers freshAgent.killed");
        assert_eq!(
            killed_frame["success"], false,
            "the kill fails VISIBLY even though the close is durable: {killed_frame}"
        );
    }

    /// Delta-r6-r2 (focused-episode-6 round 1, Finding 3): the FULL durable
    /// close — the wire id AND every alias-resolved durable row — completes
    /// BEFORE any live-state destruction (the map removal, the consumer
    /// abort). The delta-r6 two-pass retired the alias-resolved rows only
    /// AFTER removal/abort: a restart or task cancellation there left the
    /// durable row Bound while the live session was already destroyed (the
    /// recovery offer's exact never-actually-open shape). The gate: the
    /// durable id's close mutation lands and its answer PARKS (the
    /// retire-stall hook); while parked, nothing live may have been touched.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_alias_resolved_close_completes_before_any_live_state_destruction() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(dedup_create_msg("req-close-before-teardown"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-close-before-teardown").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        adopt_legacy_fixture(&st, &placeholder, durable).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let present = st
                .cli_index
                .lock()
                .await
                .get(durable)
                .is_some_and(|mapped| mapped == &placeholder);
            if present {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the sdk.session.init adoption must alias the durable id at the placeholder"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        let stall = fake.arm_retire_stall("claude", durable);
        let st2 = st.clone();
        let ph = placeholder.clone();
        let mut kill = tokio::spawn(async move {
            st2.handle_kill(FreshAgentKill {
                observed_epoch: None,
                observed_generation: None,
                provider: freshell_protocol::AgentProvider::Claude,
                session_id: ph,
                session_type: SessionType::Freshclaude,
                cwd: None,
            })
            .await;
        });
        stall
            .entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the alias-resolved durable close mutation landed (answer parked)");

        // THE FINDING'S ASSERTION: while the durable close's answer is parked,
        // the session must STILL be mapped and its consumer STILL running —
        // live-state destruction follows the close, never the other way.
        {
            let sessions = st.sessions.lock().await;
            let session = sessions
                .get(&placeholder)
                .expect("the session is still mapped while the durable close is in flight");
            assert!(
                !session.consumer.is_finished(),
                "the consumer abort must follow the durable close, never precede it"
            );
        }
        stall.release.send(()).expect("release the stall");
        tokio::time::timeout(std::time::Duration::from_secs(15), &mut kill)
            .await
            .expect("the kill completes")
            .expect("kill task completed");
        assert!(
            st.sessions.lock().await.get(&placeholder).is_none(),
            "the lane completes: the session is removed AFTER the close"
        );
    }

    /// Delta-r6-r3 (focused-episode-6 round 2, Finding 4): the claude kill's
    /// close is ONE failure-atomic envelope over the whole identity set (the
    /// wire placeholder AND every alias-resolved durable id). A failed
    /// envelope ABORTS the kill before any live state is touched — the
    /// session stays mapped, its consumer stays running, the answer reports
    /// `success:false` — and leaves NO durable close evidence behind: the
    /// wire id's fence does NOT survive the failed envelope either. The
    /// pre-envelope lane wrote the wire-id close first and left it standing
    /// across a later failure — a standing tombstone with no row reads as
    /// closed in the recovery inventory and would suppress a genuinely open
    /// session.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kill_whose_alias_resolved_close_fails_aborts_before_any_live_state_destruction() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(dedup_create_msg("req-alias-close-fails"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-alias-close-fails").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        adopt_legacy_fixture(&st, &placeholder, durable).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let present = st
                .cli_index
                .lock()
                .await
                .get(durable)
                .is_some_and(|mapped| mapped == &placeholder);
            if present {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "adoption aliases the durable id"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        // The whole close envelope fails (disk-full/permission shape).
        fake.fail_retires_after(0);
        while rx.try_recv().is_ok() {} // drain pre-kill frames

        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: placeholder.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        {
            let sessions = st.sessions.lock().await;
            let session = sessions
                .get(&placeholder)
                .expect("a failed close envelope leaves the session MAPPED");
            assert!(
                !session.consumer.is_finished(),
                "a failed close envelope leaves the consumer RUNNING"
            );
        }
        assert!(
            fake.retires.lock().unwrap().is_empty(),
            "round 2 Finding 4: NO identity's close may survive a failed envelope \
             (the wire-id fence included — a standing tombstone with no row reads \
             as closed in the recovery inventory): {:?}",
            fake.retires.lock().unwrap()
        );
        assert!(
            fake.kill_tombstones.lock().unwrap().is_empty(),
            "no durable close fence survives the failed envelope"
        );
        let mut killed_frame = None;
        while let Ok(raw) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.killed" {
                killed_frame = Some(frame);
            }
        }
        let killed_frame = killed_frame.expect("the kill answers freshAgent.killed");
        assert_eq!(
            killed_frame["success"], false,
            "the kill reports failure: {killed_frame}"
        );
    }

    /// Delta-r6-r3 (focused-episode-6 round 2, Finding 4): the close is ONE
    /// envelope call over the WHOLE identity set — never the delta-r6-r2
    /// multi-pass shape (per-identity writes interleaved with live-state
    /// destruction, a later pass's failure leaving the earlier closes
    /// durable over a still-live session). The completion-diff envelope is
    /// the only legal second call, and only when a mint landed mid-close.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kill_closes_the_whole_identity_set_in_one_envelope_call() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(dedup_create_msg("req-one-envelope"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-one-envelope").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        adopt_legacy_fixture(&st, &placeholder, durable).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let present = st
                .cli_index
                .lock()
                .await
                .get(durable)
                .is_some_and(|mapped| mapped == &placeholder);
            if present {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "adoption aliases the durable id"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: placeholder.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        let batches = fake.retire_batches.lock().unwrap().clone();
        assert_eq!(
            batches.len(),
            1,
            "the close is ONE envelope call (no multi-pass partials): {batches:?}"
        );
        let (provider, ids, pendings) = &batches[0];
        assert_eq!(provider, "claude");
        assert!(
            ids.contains(&placeholder),
            "the envelope covers the wire placeholder: {ids:?}"
        );
        assert!(
            ids.contains(&durable.to_string()),
            "the envelope covers the alias-resolved durable id: {ids:?}"
        );
        assert!(pendings.is_empty(), "claude kills carry no marker ids");
    }

    /// Focused-episode-6 round 4 (Finding F5) — the mint gate: with the
    /// kill's close-pending enumeration armed, an adoption ABANDONS: no
    /// cli_index insert, no alias-tombstone write, no binding-row write —
    /// nothing the kill's ONE envelope could miss. This retires the
    /// delta-r6-r2 completion-diff design (a SECOND close for an id
    /// discovered only after the consumer abort, whose own clean failure
    /// could never roll the teardown back): discovery completes before the
    /// envelope now, by construction.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_mint_adoption_abandons_once_the_kills_close_gate_is_set() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(dedup_create_msg("req-gate-mint"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-gate-mint").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();

        // Park the kill INSIDE its one durable close (mutations recorded;
        // the answer stalled): the enumeration + mint gate are provably in
        // force — the placeholder rides the envelope.
        let stall = fake.arm_retire_stall("claude", &placeholder);
        let st2 = st.clone();
        let ph = placeholder.clone();
        let mut kill = tokio::spawn(async move {
            st2.handle_kill(FreshAgentKill {
                observed_epoch: None,
                observed_generation: None,
                provider: freshell_protocol::AgentProvider::Claude,
                session_id: ph,
                session_type: SessionType::Freshclaude,
                cwd: None,
            })
            .await;
        });
        stall
            .entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the durable close is in flight (the gate is armed)");

        // The mint that could slip the enumeration→teardown window in the
        // completion-diff shape: discard it entirely.
        let gated = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        st.adopt_session_init(
            gated,
            &placeholder,
            "freshclaude",
            Some(&crate::identity_sink::FreshAgentSettings {
                model: Some("gate-model".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            }),
            Some(fake.clone()),
            None,
        )
        .await;
        assert!(
            st.cli_index.lock().await.get(gated).is_none(),
            "the gated mint inserts nothing: {:?}",
            st.cli_index.lock().await
        );

        stall.release.send(()).expect("release the stall");
        tokio::time::timeout(std::time::Duration::from_secs(15), &mut kill)
            .await
            .expect("the kill completes")
            .expect("kill task completed");
        assert!(
            !fake
                .retires
                .lock()
                .unwrap()
                .iter()
                .any(|(_, id)| id == gated),
            "nothing retires an id the envelope never saw: {:?}",
            fake.retires.lock().unwrap()
        );
        assert!(
            !fake
                .bindings
                .lock()
                .unwrap()
                .iter()
                .any(|b| b.session_id == gated),
            "the gated adoption writes no binding row: {:?}",
            fake.bindings.lock().unwrap()
        );
        assert!(
            !fake
                .alias_record_writes
                .lock()
                .unwrap()
                .iter()
                .any(|(_, _, d)| d == gated),
            "the gated adoption writes no alias record: {:?}",
            fake.alias_record_writes.lock().unwrap()
        );
    }

    // ── b8ke focused episode-2 round-1: the adoption's atomicity tests ─────

    /// A minimal thread-local tracing capture (the session_handoff
    /// tracing_capture pattern, trimmed to the events the e2r1 tests need).
    mod init_capture {
        use std::sync::{Arc, Mutex};
        use tracing::field::{Field, Visit};
        use tracing::{Event, Subscriber};
        use tracing_subscriber::layer::{Context, SubscriberExt};
        use tracing_subscriber::registry::LookupSpan;
        use tracing_subscriber::Layer;

        #[derive(Default)]
        struct FieldVisitor {
            pub event: String,
            pub initiator: String,
            pub operation_id: String,
        }

        impl Visit for FieldVisitor {
            fn record_debug(&mut self, _field: &Field, _value: &dyn std::fmt::Debug) {}
            fn record_str(&mut self, field: &Field, value: &str) {
                match field.name() {
                    "event" => self.event = value.to_string(),
                    "initiator" => self.initiator = value.to_string(),
                    "operation_id" => self.operation_id = value.to_string(),
                    _ => {}
                }
            }
        }

        struct CaptureLayer(Arc<Mutex<Vec<CapturedOwnershipEvent>>>);

        impl<S> Layer<S> for CaptureLayer
        where
            S: Subscriber + for<'a> LookupSpan<'a>,
        {
            fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
                if event.metadata().target() != "freshell_ownership" {
                    return;
                }
                let mut visitor = FieldVisitor::default();
                event.record(&mut visitor);
                self.0.lock().expect("capture lock").push((
                    visitor.event,
                    visitor.initiator,
                    visitor.operation_id,
                ));
            }
        }

        /// One captured `freshell_ownership` event: (event, initiator,
        /// operation_id).
        pub type CapturedOwnershipEvent = (String, String, String);

        /// Install a thread-local capture of `freshell_ownership` events;
        /// returns the shared sink and the scope guard (HOLD the guard for
        /// as long as the capture must stay installed — dropping it removes
        /// the thread-local default). Every event: (event, initiator,
        /// operation_id).
        pub fn install() -> (
            Arc<Mutex<Vec<CapturedOwnershipEvent>>>,
            tracing::subscriber::DefaultGuard,
        ) {
            let sink = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer(Arc::clone(&sink));
            let subscriber = tracing_subscriber::registry().with(layer);
            (sink, tracing::subscriber::set_default(subscriber))
        }
    }

    /// b8ke focused episode-2 round-1 F2: the pre-registration window must
    /// not expose a Live owner that cannot be killed. An adoption for a
    /// session that is NOT yet registered defers the WHOLE adoption — no
    /// claim, no commit, no alias — until the create registers the
    /// runtime. Pre-fix: the consumer's init committed Live{FreshAgent}
    /// and minted the alias immediately (a handoff in the window saw a
    /// killable-owner lie: kill_for_handoff answered AlreadyGone and the
    /// create then inserted its still-live sidecar — two writers).
    #[tokio::test(flavor = "multi_thread")]
    async fn the_init_adoption_defers_until_the_runtime_is_registered() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, _rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        // An adoption for a session that was never registered (the
        // create's insert window): nothing commits, nothing publishes.
        st.adopt_session_init(
            "dur-e2r2-f2",
            "placeholder-never-registered",
            "freshclaude",
            None,
            None,
            None,
        )
        .await;

        // Give the immediate (pre-fix) commit ample time to land, then
        // assert the deferral: NO Live owner, NO alias.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(
            !matches!(
                registry.observe("claude", "dur-e2r2-f2").state,
                freshell_ownership::OwnershipState::Live { .. }
            ),
            "the pre-registration window must not expose a Live owner, got {:?}",
            registry.observe("claude", "dur-e2r2-f2").state
        );
        assert!(
            st.cli_index.lock().await.get("dur-e2r2-f2").is_none(),
            "the deferred adoption publishes no alias"
        );
    }

    /// b8ke focused episode-2 round-1 F3: a REFUSED adoption fails closed.
    /// A foreign owner (a live terminal) holds the canonical key — the
    /// freshly spawned runtime is TORN DOWN (removed + the standard
    /// teardown + the lost-session recovery), the alias is never
    /// published, and the foreign owner is never stolen. Pre-fix: the
    /// refusal only logged — the sidecar kept running unowned beside the
    /// foreign owner while the alias minted.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_init_adoption_tears_the_fresh_runtime_down() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        let fresh_create_durable_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        // The FOREIGN OWNER: a live terminal under the durable id the
        // fresh create's sidecar is about to mint.
        let foreign = freshell_ownership::OwnerIdentity {
            kind: freshell_ownership::RuntimeOwnerKind::Terminal,
            terminal_id: Some("t-foreign".into()),
            live_session_key: None,
            pid: None,
            ownership_id: None,
        };
        let freshell_ownership::BeginOutcome::Granted { generation } = registry.begin_start(
            "claude",
            fresh_create_durable_id,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-foreign-owner",
            None,
            "test",
            0,
        ) else {
            panic!("expected Granted")
        };
        assert!(matches!(
            registry.commit_live(
                "claude",
                fresh_create_durable_id,
                "op-foreign-owner",
                generation,
                foreign
            ),
            freshell_ownership::CommitOutcome::Committed
        ));

        // The ordinary fresh create: the consumer's init mints the durable
        // id; the adoption claim is REFUSED (OwnedByOtherKind) → teardown.
        st.handle_create(dedup_create_msg("req-e2r3-f3"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-e2r3-f3").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        prepare_legacy_init(&st, &placeholder).await;
        st.adopt_session_init(
            fresh_create_durable_id,
            &placeholder,
            "freshclaude",
            None,
            None,
            None,
        )
        .await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let removed = !st.sessions.lock().await.contains_key(&placeholder);
            if removed {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the refused adoption must tear the fresh runtime down — the \
                 session stays registered"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // Nothing published: no alias for the minted durable id.
        assert!(
            st.cli_index
                .lock()
                .await
                .get(fresh_create_durable_id)
                .is_none(),
            "the refused adoption publishes nothing"
        );
        // The foreign owner is NEVER stolen.
        assert!(matches!(
            registry.observe("claude", fresh_create_durable_id).state,
            freshell_ownership::OwnershipState::Live { owner, .. }
                if owner.kind == freshell_ownership::RuntimeOwnerKind::Terminal
        ));
        // The lost-session recovery frame reached the bus (bounded: the
        // teardown's reap precedes the broadcast).
        let mut saw_lost = false;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !saw_lost && tokio::time::Instant::now() < deadline {
            while let Ok(raw) = rx.try_recv() {
                if raw.contains("freshAgent.error") && raw.contains(&placeholder) {
                    saw_lost = true;
                }
            }
            if !saw_lost {
                tokio::time::sleep(std::time::Duration::from_millis(25)).await;
            }
        }
        assert!(saw_lost, "the teardown engages the lost-session recovery");
    }

    /// b8ke focused episode-2 round-1 F4: an in-stream RE-KEY (an init
    /// naming a durable id other than the one the session already carries)
    /// never adopts ownership under the NEW durable id — the runtime is
    /// owned and committed under the OLD durable id, so a second
    /// Live{FreshAgent} record under the new id would leave contradictory
    /// snapshots (the old key falsely Live after the runtime moves). The
    /// re-key bookkeeping (the alias) still lands.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_rollback_fork_rekey_never_adopts_ownership_under_the_new_id() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        // An ordinary fresh create: the runtime registers + the adoption
        // commits Live{FreshAgent} under the minted durable id (the OLD id
        // of this scenario's rollback).
        st.handle_create(dedup_create_msg("req-e2r4-f4"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-e2r4-f4").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe("claude", fresh_create_durable_id).state,
                freshell_ownership::OwnershipState::Live { owner, .. }
                    if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the ordinary create's adoption must commit under the old id"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // The RE-KEY: the session's next sdk.session.init names a NEW durable
        // id. The re-key bookkeeping lands — but NO ownership under the new
        // id.
        st.adopt_session_init(
            "new-fork-id-e2r4",
            &placeholder,
            "freshclaude",
            None,
            None,
            None,
        )
        .await;

        assert!(
            !matches!(
                registry.observe("claude", "new-fork-id-e2r4").state,
                freshell_ownership::OwnershipState::Live { .. }
            ),
            "the fork ADOPTION must NOT claim under the new id — the ROLLBACK's \
             commit owns the one move (the delta-r2 dual-record shape): {:?}",
            registry.observe("claude", "new-fork-id-e2r4").state
        );
        // The re-key bookkeeping: the alias maps the fork id to the session.
        assert_eq!(
            st.cli_index.lock().await.get("new-fork-id-e2r4"),
            Some(&placeholder),
            "the fork re-key alias still lands"
        );
        // b8ke focused episode-2 round-2 F1: after the rollback's COMMIT, the
        // canonical ownership MOVES to the client-visible new id
        // (`commit_lane_claim_rekey_at` — pinned by the registry's
        // commit_live_rekey test), and the OLD id becomes a resolvable
        // alias: the lane resolves it for every lifecycle operation, and
        // the snapshot reports the CANONICAL record for it — never a false
        // Vacant that licenses a second writer beside the live runtime.
        // The registry-backed alias: the coordinator record (the e2r3 F3
        // single source of truth) — driven through the registry's own
        // rekey_live (the same move the rollback's Adopt-path commit
        // performs).
        assert!(matches!(
            registry.rekey_live(
                "claude",
                fresh_create_durable_id,
                "new-fork-id-e2r4",
                &placeholder,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some(placeholder.clone()),
                    pid: Some(4321),
                    ownership_id: Some("rekey-op-fork-e2r4".into()),
                },
                "test-rekey",
                "rekey-op-fork-e2r4",
            ),
            freshell_ownership::CommitOutcome::Committed
        ));
        assert_eq!(
            st.resolve_ownership_key(fresh_create_durable_id),
            "new-fork-id-e2r4",
            "the superseded old id resolves to the client-visible canonical id"
        );
        assert_eq!(
            st.resolve_ownership_key("new-fork-id-e2r4"),
            "new-fork-id-e2r4",
            "the canonical id resolves to itself"
        );
        // The snapshot for the OLD id reports the CANONICAL record.
        let snap = st.ownership_snapshot("claude", fresh_create_durable_id);
        assert_eq!(
            snap.state,
            registry.observe("claude", "new-fork-id-e2r4").state,
            "a snapshot on the superseded id reports the canonical record — \
             never a false Vacant over the live re-keyed runtime"
        );
    }

    /// b8ke ext r13 F3: the rollback's replace window holds REAL
    /// authority. The rollback is parked INSIDE its respawn (the fake
    /// sidecar's deferred create answer) while the Adopt-path attach guard
    /// is armed, and a handoff BEGIN is attempted in the window: it answers
    /// the typed Blocked outcome — no terminal can start beside the
    /// replacement (pre-r13 the Adopt arm held NO claim, so the racing
    /// handoff granted and the overlapping writers ran until the rekey's
    /// verify rejected).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_handoff_during_the_rollback_replace_window_is_blocked_typed() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install_with_knobs(Some(3_000), false);
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        // A LIVE owner under the OLD durable id — the Adopt shape the
        // rollback's claim observes.
        st.handle_create(dedup_create_msg("req-r13-f3-window"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-r13-f3-window").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let map_key = created["sessionId"].as_str().unwrap().to_string();
        let old_dur = fresh_create_durable_id;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe("claude", old_dur).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the create's adoption never committed"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // A rollback the sidecar can service (the transcript + record).
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), old_dur, &two_turn_transcript());

        // Truncate the spawn log: the FIXTURE's create already logged a
        // spawn — only the ROLLBACK's respawn line is the park proof.
        if let Ok(log) = std::env::var("FRESHELL_TEST_CLAUDE_SPAWN_LOG") {
            let _ = std::fs::write(&log, "");
        }
        // Drive the rollback in a task; the deferred create answer parks
        // it INSIDE the respawn window (the guard is armed).
        let st_for_task = st.clone();
        // The honest client shape (ep5 r4 F3): the op CARRIES its observed
        // pair — the absent pair is the typed INVALID_FENCE refusal now.
        let before = registry.observe("claude", old_dur);
        let mut op = rollback_op(&map_key, "req-r13-f3-window", RollbackDirection::Undo);
        op.observed_epoch = Some(before.epoch);
        op.observed_generation = Some(before.generation);
        let (sink, captured) = capturing_sink();
        let task = tokio::spawn(async move {
            st_for_task.handle_rollback(op, sink).await;
        });
        // Park proof: the fake sidecar logged the spawn (inside the
        // window; the create ANSWER is deferred 3s).
        {
            let spawn_log = std::env::var("FRESHELL_TEST_CLAUDE_SPAWN_LOG")
                .map(std::path::PathBuf::from)
                .ok();
            let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                let spawned = spawn_log
                    .as_ref()
                    .map(|p| {
                        std::fs::read_to_string(p)
                            .map(|s| !s.is_empty())
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                if spawned {
                    break;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the rollback never reached its respawn window"
                );
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }

        // THE CONTRACT: a handoff BEGIN inside the rollback's replace
        // window answers the typed Blocked outcome.
        match registry.begin_handoff(
            "claude",
            old_dur,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-r13-f3-racing-handoff",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        ) {
            freshell_ownership::BeginOutcome::Blocked {
                state,
                retry_after_ms,
            } => {
                assert!(retry_after_ms > 0);
                assert!(
                    matches!(state, freshell_ownership::OwnershipState::Live { .. }),
                    "the blocked state names the still-Live key: {state:?}"
                );
            }
            other => panic!(
                "a handoff begin inside the rollback window must answer Blocked — got {other:?}"
            ),
        }
        // No terminal ever started beside the replacement.
        let _ = task.await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        drop(captured);
    }

    /// b8ke ext r38 F1: the rollback Adopt arm is the ATOMIC ADOPT — a
    /// terminal handoff COMMITTING between the AdoptLive claim answer and
    /// the guard arm refuses typed, and NO sidecar ever spawns beside the
    /// terminal. Pre-r38 the arm re-observed whatever was live and armed
    /// on it (the discard-and-re-observe laundering): the terminal
    /// handoff's committed owner armed the guard and the rollback spawned
    /// a Fresh Claude sidecar beside the terminal — two live writers held
    /// the same session until the late rekey tore the sidecar down. The
    /// adopt validates the request's ORIGINAL pair + the expected
    /// fresh-agent owner in ONE coordinator decision, so the committed
    /// terminal handoff (a generation advance) refuses before any
    /// teardown or spawn.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_terminal_handoff_between_the_rollback_claim_and_the_adopt_arm_refuses_typed_without_spawning(
    ) {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install_with_knobs(Some(3_000), false);
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        // A LIVE owner under the OLD durable id — the Adopt shape the
        // rollback's claim observes.
        st.handle_create(dedup_create_msg("req-r38-f1-race"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-r38-f1-race").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let map_key = created["sessionId"].as_str().unwrap().to_string();
        let old_dur = fresh_create_durable_id;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe("claude", old_dur).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the create's adoption never committed"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // A rollback the sidecar can service (the transcript + record),
        // so the pre-fix RED shape can reach its spawn.
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), old_dur, &two_turn_transcript());

        // Truncate the spawn log: the FIXTURE's create already logged a
        // spawn — only a ROLLBACK respawn line proves the bug.
        if let Ok(log) = std::env::var("FRESHELL_TEST_CLAUDE_SPAWN_LOG") {
            let _ = std::fs::write(&log, "");
        }

        // Arm the claim-to-arm park seam.
        let parked = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        st.set_rollback_adopt_park_for_test(Some(parked.clone()), Some(release.clone()));

        // The honest client shape: the op CARRIES its observed pair.
        let before = registry.observe("claude", old_dur);
        let mut op = rollback_op(&map_key, "req-r38-f1-race", RollbackDirection::Undo);
        op.observed_epoch = Some(before.epoch);
        op.observed_generation = Some(before.generation);
        let (sink, captured) = capturing_sink();
        let st_for_task = st.clone();
        let task = tokio::spawn(async move {
            st_for_task.handle_rollback(op, sink).await;
        });

        // Arrival proof: the claim answered Adopt and the handler sits
        // BETWEEN the claim and the guard arm.
        parked.notified().await;

        // THE RACE: a terminal handoff COMMITS against the key while the
        // rollback holds no window (the guard is not yet armed).
        let freshell_ownership::BeginOutcome::Granted {
            generation: term_generation,
        } = registry.begin_handoff(
            "claude",
            old_dur,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-r38-f1-racing-terminal-handoff",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        )
        else {
            panic!("the racing terminal handoff must grant against the pre-arm key")
        };
        assert_eq!(
            registry.commit_live(
                "claude",
                old_dur,
                "op-r38-f1-racing-terminal-handoff",
                term_generation,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-r38-race".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                },
            ),
            freshell_ownership::CommitOutcome::Committed,
        );

        // Release the park: the ATOMIC adopt validates the ORIGINAL pair
        // + the expected fresh-agent owner — the committed terminal
        // handoff refused typed, nothing torn down or spawned.
        release.notify_one();
        let _ = task.await;

        let frames = captured_json(&captured);
        assert!(
            frames.iter().any(|f| {
                f["type"] == "freshAgent.event"
                    && f["event"]["type"] == json!("freshAgent.error")
                    && f["event"]["code"] == json!("SESSION_RESERVED")
            }),
            "the raced adopt must answer the typed refusal: {frames:?}"
        );
        let spawned = std::env::var("FRESHELL_TEST_CLAUDE_SPAWN_LOG")
            .ok()
            .and_then(|log| std::fs::read_to_string(log).ok())
            .unwrap_or_default();
        assert!(
            spawned.trim().is_empty(),
            "no sidecar may spawn beside the terminal owner: {spawned:?}"
        );
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        drop(captured);
    }

    /// b8ke ext r13 F3 (reshaped by focused ep5 r4 F3): the rollback
    /// carries an OBSERVED generation fence — a generation advance ACROSS
    /// the handler's awaits (the turn lock, the parked/retried spawn
    /// work) is still the typed stale refusal. Pre-ep5-r4 the unfenced
    /// shape laundered the handler-ENTRY observation into the claim; the
    /// r4 F3 contract removed that laundering (an absent pair is the
    /// typed INVALID_FENCE refusal — an entry observation can detect a
    /// change AFTER it, but never that the request was already stale on
    /// arrival), so the op now carries the observed pair the honest
    /// client sends, and this test still pins the r13 window: the claim
    /// re-validates the SUPPLIED pair against the advanced generation.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stale_generation_rollback_is_refused_typed() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        st.handle_create(dedup_create_msg("req-r13-f3-stale"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-r13-f3-stale").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let map_key = created["sessionId"].as_str().unwrap().to_string();
        let old_dur = fresh_create_durable_id;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe("claude", old_dur).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "never committed Live"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), old_dur, &two_turn_transcript());

        // Hold the session's TURN LOCK: the rollback observes the fence at
        // entry, then parks at the turn-lock await.
        let turn_lock = {
            let sessions = st.sessions.lock().await;
            sessions
                .get(&map_key)
                .expect("the live session")
                .turn_lock
                .clone()
        };
        let _park = turn_lock.lock().await;

        let st_for_task = st.clone();
        // The honest client shape (ep5 r4 F3): the op CARRIES the pair it
        // observed — the laundered entry observation is gone.
        let before = registry.observe("claude", old_dur);
        let mut op = rollback_op(&map_key, "req-r13-f3-stale", RollbackDirection::Undo);
        op.observed_epoch = Some(before.epoch);
        op.observed_generation = Some(before.generation);
        let (sink, captured) = capturing_sink();
        let task = tokio::spawn(async move {
            st_for_task.handle_rollback(op, sink).await;
        });
        // Let the task observe the fence and park at the turn lock.
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;

        // The generation ADVANCES while the rollback is parked: a handoff
        // begin + fail-restore bumps the record's generation.
        let freshell_ownership::BeginOutcome::Granted { .. } = registry.begin_handoff(
            "claude",
            old_dur,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-r13-f3-bump",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        ) else {
            panic!("the generation-bump handoff must grant")
        };
        let _ = registry.fail("claude", old_dur, "op-r13-f3-bump", 2, true);

        // Release the park: the rollback's claim re-validates the entry
        // fence against the ADVANCED generation → typed stale refusal.
        drop(_park);
        let _ = task.await;
        let frames = captured_json(&captured);
        assert!(
            frames.iter().any(|f| {
                f["type"] == "freshAgent.event"
                    && f["event"]["type"] == json!("freshAgent.error")
                    && f["event"]["code"] == json!("SESSION_RESERVED")
            }),
            "the stale-generation rollback must answer the typed refusal: {frames:?}"
        );
        std::env::remove_var("CLAUDE_CONFIG_DIR");
    }

    /// b8ke ext r29 F2: the TRULY stale-on-arrival rollback — the
    /// generation advances BEFORE the handler runs and the op carries the
    /// PRE-advance observed pair on the wire (ext r21 F2's additive
    /// fields). Pre-r29 the handler DISCARDED the supplied pair and
    /// substituted the coordinator's CURRENT pair at entry, so a request
    /// already stale when received was made current — it entered the
    /// same-kind Adopt path and tore down / rolled back the NEWER
    /// runtime. The supplied pair is now HONORED: the claim
    /// typed-refuses it (the r13 fenced window never even opens).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stale_on_arrival_rollback_is_refused_typed() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        st.handle_create(dedup_create_msg("req-r29-f2-stale-arrival"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-r29-f2-stale-arrival").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let map_key = created["sessionId"].as_str().unwrap().to_string();
        let old_dur = fresh_create_durable_id;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe("claude", old_dur).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "never committed Live"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // The generation ADVANCES BEFORE the rollback is sent: a handoff
        // begin + fail-restore bumps the record's generation (the
        // client's pane still holds the PRE-advance observed pair).
        let before = registry.observe("claude", old_dur);
        let freshell_ownership::BeginOutcome::Granted { generation: ho_gen } = registry
            .begin_handoff(
                "claude",
                old_dur,
                freshell_ownership::RuntimeOwnerKind::Terminal,
                "op-r29-f2-bump",
                None,
                "test",
                freshell_ownership::now_epoch_ms(),
            )
        else {
            panic!("the generation-bump handoff must grant")
        };
        let _ = registry.fail("claude", old_dur, "op-r29-f2-bump", ho_gen, true);
        let after = registry.observe("claude", old_dur);
        assert!(
            after.generation > before.generation,
            "the record's generation advanced: {} -> {}",
            before.generation,
            after.generation
        );

        // THE STALE-ON-ARRIVAL ROLLBACK: the wire pair is the pre-advance
        // observation — the handler must refuse it typed, never
        // substitute the current pair.
        let mut op = rollback_op(
            &map_key,
            "req-r29-f2-stale-arrival",
            RollbackDirection::Undo,
        );
        op.observed_epoch = Some(before.epoch);
        op.observed_generation = Some(before.generation);
        let (sink, captured) = capturing_sink();
        st.handle_rollback(op, sink).await;

        let frames = captured_json(&captured);
        assert!(
            frames.iter().any(|f| {
                f["type"] == "freshAgent.event"
                    && f["event"]["type"] == json!("freshAgent.error")
                    && f["event"]["code"] == json!("SESSION_RESERVED")
                    && f["event"]["requestId"] == json!("req-r29-f2-stale-arrival")
            }),
            "the stale-on-arrival rollback must answer the typed refusal: {frames:?}"
        );
        // And the record is UNTOUCHED at the advanced generation — the
        // newer runtime was never torn down or re-keyed.
        let settled = registry.observe("claude", old_dur);
        assert_eq!(
            settled.generation, after.generation,
            "the refused rollback never moved the record"
        );
        assert!(
            matches!(
                settled.state,
                freshell_ownership::OwnershipState::Live { .. }
            ),
            "the restored live owner stands: {settled:?}"
        );
    }

    /// b8ke focused ep5 r4 F3: an UNFENCED rollback (the wire pair fully
    /// absent) arriving after a COMPLETED OWNERSHIP CYCLE is the typed
    /// INVALID_FENCE refusal — never laundered with the handler-START
    /// observation. Pre-F3 the absent pair was replaced with the
    /// generation observed when the handler started, so a rollback
    /// queued under generation N, arriving after the session moved away
    /// and returned to Fresh Agent ownership at N+2, adopted the NEWER
    /// owner and could tear it down, resume/re-key it, and roll back its
    /// history. Post-F3 the refusal is the actionable contract (the
    /// client re-observes the owner record and retries WITH the pair),
    /// and the newer owner is untouched.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unfenced_rollback_after_a_completed_ownership_cycle_is_refused_typed() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        st.handle_create(dedup_create_msg("req-ep5-r4-f3-cycle"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-ep5-r4-f3-cycle").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let map_key = created["sessionId"].as_str().unwrap().to_string();
        let old_dur = fresh_create_durable_id;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe("claude", old_dur).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "never committed Live"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // THE CYCLE: away — a terminal handoff commits at N+1 — then
        // back — a fresh-agent handoff commits at N+2: the session
        // "moved away and returned to Fresh Agent ownership".
        let freshell_ownership::BeginOutcome::Granted {
            generation: away_gen,
        } = registry.begin_handoff(
            "claude",
            old_dur,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "op-ep5-r4-f3-away",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        )
        else {
            panic!("the away handoff must grant")
        };
        assert_eq!(
            registry.commit_live(
                "claude",
                old_dur,
                "op-ep5-r4-f3-away",
                away_gen,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::Terminal,
                    terminal_id: Some("t-cycle-f3".into()),
                    live_session_key: None,
                    pid: None,
                    ownership_id: None,
                },
            ),
            freshell_ownership::CommitOutcome::Committed
        );
        let freshell_ownership::BeginOutcome::Granted {
            generation: back_gen,
        } = registry.begin_handoff(
            "claude",
            old_dur,
            freshell_ownership::RuntimeOwnerKind::FreshAgent,
            "op-ep5-r4-f3-back",
            None,
            "test",
            freshell_ownership::now_epoch_ms(),
        )
        else {
            panic!("the back handoff must grant")
        };
        assert!(back_gen > away_gen, "the cycle advanced the generation");
        assert_eq!(
            registry.commit_live(
                "claude",
                old_dur,
                "op-ep5-r4-f3-back",
                back_gen,
                freshell_ownership::OwnerIdentity {
                    kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
                    terminal_id: None,
                    live_session_key: Some("cycle-f3-newer".into()),
                    pid: None,
                    ownership_id: None,
                },
            ),
            freshell_ownership::CommitOutcome::Committed
        );
        assert!(matches!(
            registry.observe("claude", old_dur).state,
            freshell_ownership::OwnershipState::Live { ref owner, .. }
                if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
        ));

        // THE UNFENCED ROLLBACK — queued under the ORIGINAL generation,
        // wire pair absent, arriving after the completed cycle. The
        // typed INVALID_FENCE refusal; nothing mutated.
        let op = rollback_op(&map_key, "req-ep5-r4-f3-cycle", RollbackDirection::Undo);
        let (sink, captured) = capturing_sink();
        st.handle_rollback(op, sink).await;

        let frames = captured_json(&captured);
        assert!(
            frames.iter().any(|f| {
                f["type"] == "freshAgent.event"
                    && f["event"]["type"] == json!("freshAgent.error")
                    && f["event"]["code"] == json!("INVALID_FENCE")
                    && f["event"]["requestId"] == json!("req-ep5-r4-f3-cycle")
            }),
            "the unfenced rollback after a completed cycle must answer the \\
             typed INVALID_FENCE refusal: {frames:?}"
        );
        // The NEWER owner is untouched: the coordinator still holds the
        // N+2 fresh-agent record, and the live session was never torn
        // down (the refusal precedes the claim, the record write, and
        // every spawn).
        let settled = registry.observe("claude", old_dur);
        assert_eq!(settled.generation, back_gen, "the record never moved");
        assert!(
            matches!(
                settled.state,
                freshell_ownership::OwnershipState::Live { ref owner, .. }
                    if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
            ),
            "the newer fresh-agent owner stands: {settled:?}"
        );
        assert!(
            st.sessions.lock().await.contains_key(&map_key),
            "the live session was never torn down by the refused rollback"
        );
    }

    /// b8ke ext r29 F2: a half-sent observed pair (exactly one of
    /// epoch/generation) on a rollback is the typed INVALID_FENCE
    /// refusal — the F7 discipline, which the rollback lane never had
    /// (pre-r29 it discarded the pair entirely, so a half-fence silently
    /// degraded to the unfenced legacy path).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_half_sent_rollback_fence_is_refused_typed() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        st.handle_create(dedup_create_msg("req-r29-f2-half-fence"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-r29-f2-half-fence").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let map_key = created["sessionId"].as_str().unwrap().to_string();
        let old_dur = fresh_create_durable_id;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe("claude", old_dur).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "never committed Live"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // HALF-SENT: the epoch without the generation.
        let mut op = rollback_op(&map_key, "req-r29-f2-half-fence", RollbackDirection::Undo);
        op.observed_epoch = Some(registry.boot_epoch());
        op.observed_generation = None;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(op, sink).await;

        let frames = captured_json(&captured);
        assert!(
            frames.iter().any(|f| {
                f["type"] == "freshAgent.event"
                    && f["event"]["type"] == json!("freshAgent.error")
                    && f["event"]["code"] == json!("INVALID_FENCE")
            }),
            "the half-sent fence must answer the typed INVALID_FENCE refusal: {frames:?}"
        );
        // The live owner stands untouched.
        assert!(
            matches!(
                registry.observe("claude", old_dur).state,
                freshell_ownership::OwnershipState::Live { .. }
            ),
            "the half-fenced rollback never touched the live owner"
        );
    }

    /// b8ke focused episode-2 round-3 F1: the NORMAL live-rollback path —
    /// the claim observes the existing Live{FreshAgent} owner and answers
    /// Adopt with NO ticket — MUST still move ownership to the
    /// client-visible new id. Pre-e2r3 the lane helper's None arm
    /// reported success without doing anything (the reviewer's
    /// deterministic failure: the pane carried the new id while ownership
    /// and the retained stamp stayed under the old id — a handoff on the
    /// new id saw Vacant and could start a terminal beside the live
    /// replacement). Red/green: the Adopt-path commit moves the Live
    /// record old→new (Aliased residue at the old key) and retains the
    /// stamp under the NEW id.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_live_rollback_adopt_path_rekeys_ownership_to_the_new_id() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        // A LIVE owner under the OLD durable id — the pre-rollback state
        // the rollback's lane claim observes (Adopt, no ticket).
        st.handle_create(dedup_create_msg("req-e2r3-f1"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-e2r3-f1").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        let old_dur = fresh_create_durable_id;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe("claude", old_dur).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the first create's adoption never committed"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // THE ADOPT-PATH REKEY (e2 post-cap F1 contract): own_ticket =
        // None (the Adopt answer) — the helper performs the REAL
        // coordinator transition: expected-owner verified, the
        // REPLACEMENT identity (a CURRENT pid + ONE consistent rekey
        // operation id) moved, generation incremented, and the retained
        // stamp carries the SAME identity the record holds.
        let new_dur = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        let replacement_pid = 7777;
        let mut no_ticket: Option<freshell_ownership::OperationTicket> = None;
        st.commit_lane_claim_rekey_at(
            old_dur,
            &mut no_ticket,
            new_dur,
            &placeholder,
            &placeholder,
            Some(replacement_pid),
            "claude/rollback",
        )
        .expect("the Adopt-path rekey commits");

        // Identities MUST MATCH: the record's owner AND the retained
        // stamp carry the REPLACEMENT pid + the SAME operation id —
        // never the dead old pid, never a fabricated divergence.
        let observed = registry.observe("claude", new_dur);
        let live_generation = match observed.state {
            freshell_ownership::OwnershipState::Live {
                owner, generation, ..
            } => {
                assert_eq!(owner.pid, Some(replacement_pid));
                assert!(
                    owner.ownership_id.is_some(),
                    "the moved record carries ONE rekey op id"
                );
                assert_eq!(
                    owner.ownership_id.as_deref(),
                    Some(stamp_ref(&st, new_dur).operation_id.as_str()),
                    "the record's ownership_id IS the retained stamp's operation id — exit/crash release matches"
                );
                generation
            }
            other => panic!("expected Live under the new id, got {other:?}"),
        };
        assert_eq!(
            live_generation, observed.generation,
            "the rekey INCREMENTS the generation (the new Live era's number)"
        );
        assert!(matches!(
            registry.observe("claude", old_dur).state,
            freshell_ownership::OwnershipState::Aliased { to, .. } if to == new_dur
        ));
        let stamp = stamp_ref(&st, new_dur);
        assert_eq!(stamp.owner.pid, Some(replacement_pid));
        assert_eq!(stamp.generation, live_generation);
        assert_eq!(st.resolve_ownership_key(old_dur), new_dur);

        // A subsequent KILL against the moved record must succeed — the
        // stop claim's expected runtime matches the REPLACEMENT identity
        // the rekey installed (pre-fix runtime_matches could never match
        // the moved dead pid).
        let replacement_owner = match registry.observe("claude", new_dur).state {
            freshell_ownership::OwnershipState::Live { owner, .. } => owner,
            other => panic!("expected Live under the new id, got {other:?}"),
        };
        let stop_claim = freshell_ownership::StopClaim {
            expected_kind: freshell_ownership::RuntimeOwnerKind::FreshAgent,
            expected_runtime: Some(replacement_owner.clone()),
            observed: freshell_ownership::ObservedFence {
                epoch: registry.boot_epoch(),
                generation: live_generation,
            },
        };
        match registry.begin_stop(
            "claude",
            new_dur,
            "test-kill-after-rekey",
            &stop_claim,
            "test",
            0,
        ) {
            freshell_ownership::StopOutcome::Granted {
                generation: stop_gen,
            } => {
                assert!(matches!(
                    registry.commit_stop("claude", new_dur, "test-kill-after-rekey", stop_gen),
                    freshell_ownership::CommitOutcome::Committed
                ));
            }
            other => panic!("the kill after rekey must be granted, got {other:?}"),
        }
        assert!(matches!(
            registry.observe("claude", new_dur).state,
            freshell_ownership::OwnershipState::Vacant
        ));
    }

    /// e2 post-cap F1 helper: the retained stamp under a durable id.
    fn stamp_ref(st: &FreshClaudeState, durable_id: &str) -> crate::ownership_lane::OwnershipStamp {
        crate::ownership_lane::peek_retained_stamp(&st.ownership_stamps, durable_id)
            .expect("the retained stamp exists under the durable id")
    }

    /// b8ke focused episode-2 post-cap F3: a STALE/FOREIGN ownership
    /// commit tears the runtime down AND the adoption answers ABANDONED —
    /// the pre-fix fall-through reported Published for a runtime that no
    /// longer exists. The deterministic window: the pre-commit park holds
    /// the adoption with its claim granted; the test fences the claimed
    /// key (the watchdog's own recovery seizure); the released commit
    /// fails, the teardown runs, and the adoption answers ABANDONED.
    /// b8ke ext r27 F4 reshape: the durable binding now writes BEFORE the
    /// commit (inside the coordinator operation, after the publication),
    /// so it HAS legitimately landed by the park point — the stale
    /// commit's abandonment no longer implies "nothing durable
    /// persists"; the row is the same Bound-after-death shape every
    /// crashed session's row has (the ledger's load-bearing normal), and
    /// the claim settles typed through the teardown (the key never goes
    /// Live).
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stale_commit_tears_down_and_abandons_after_the_in_operation_binding() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        let sink = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink.clone());

        // A live session (the create) whose adoption completes normally.
        st.handle_create(dedup_create_msg("req-postcap-f3"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-postcap-f3").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let _placeholder = created["sessionId"].as_str().unwrap().to_string();
        // The first create's adoption must COMMIT before the pre-commit
        // park arms — otherwise it parks there too, and both the `reached`
        // flag and the stale-start recovery below see the WRONG claim.
        await_create_ownership_committed(&st, fresh_create_durable_id).await;

        // The pre-commit park: a SECOND session (fresh map key — the
        // ordinary-create shape, no prior durable id) whose adoption
        // defers, then claims the fresh durable key, publishes, and parks
        // before the commit.
        let stale_dur = "abcdefab-abcd-4abc-8abc-abcdefabcde";
        let stale_map_key = "stale-map-key-postcap-f3";
        let pause = std::sync::Arc::new(AdoptionTestPause {
            notify: tokio::sync::Notify::new(),
            reached: std::sync::atomic::AtomicBool::new(false),
        });
        st.set_adoption_commit_test_pause(Some(std::sync::Arc::clone(&pause)));
        let (tx, mut rx_done) = tokio::sync::oneshot::channel::<Option<String>>();
        let st2 = st.clone();
        let sink2: Option<crate::identity_sink::SharedPaneIdentitySink> = Some(sink.clone());
        // Non-default settings: the binding is RECORDABLE, so the pre-fix
        // fall-through would have PERSISTED it for the torn-down runtime —
        // the `was_recorded` assertion is not vacuous.
        let settings = crate::identity_sink::FreshAgentSettings {
            model: Some("opus".into()),
            ..Default::default()
        };
        tokio::spawn(async move {
            let _ = st2
                .adopt_session_init_with_completion(
                    stale_dur,
                    stale_map_key,
                    "freshclaude",
                    Some(&settings),
                    sink2,
                    None,
                    Some(tx),
                )
                .await;
        });
        // The registration lands (the deferred adoption proceeds to the
        // claim + publication and parks before the commit).
        insert_fake_claude_session(&st, stale_map_key).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !pause.reached.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the adoption never reached the pre-commit park"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        st.set_adoption_commit_test_pause(None);

        // THE STALE SEIZURE: the watchdog's own recovery path fences the
        // claimed key while the adoption is parked.
        let recs = registry.recover_stale_starts(0, 0);
        assert_eq!(recs.len(), 1);
        let rec = recs.into_iter().next().unwrap();
        assert_eq!(rec.session_id, stale_dur);
        assert!(matches!(
            registry.fence_unconfirmed_stop(
                "claude",
                stale_dur,
                &rec.operation_id,
                rec.generation,
                freshell_ownership::FenceReason::StaleStart,
            ),
            freshell_ownership::FenceOutcome::Fenced
        ));

        // Release: the commit is stale (the key is Fenced) → teardown +
        // ABANDONED, and NOTHING persists for the dead runtime.
        pause.notify.notify_one();
        let answer = tokio::time::timeout(std::time::Duration::from_secs(15), &mut rx_done)
            .await
            .expect("the adoption settles")
            .expect("the completion channel survived");
        assert_eq!(
            answer, None,
            "the stale commit answers ABANDONED — never Published for a torn-down runtime"
        );
        // r27 F4: the binding wrote INSIDE the operation, BEFORE the commit
        // — it legitimately landed for the (now torn-down) runtime, exactly
        // like a crashed session's Bound row; the stale commit's
        // abandonment is proven by the ABANDONED answer and the claim's
        // typed settle, not by row absence.
        assert!(
            sink.was_recorded("claude", stale_dur),
            "the in-operation binding landed before the stale commit was known"
        );
    }

    /// b8ke focused episode-2 round-3 F2: a FAILED re-key publication (an
    /// in-stream init naming a durable id other than the one the session
    /// carries) FAILS the adoption — the completion hook answers `None`,
    /// never a live runtime unreachable by its advertised id. The
    /// deterministic failure shape: the mint gate armed (a kill's
    /// enumeration in flight) → the publication abandons → `Abandoned`
    /// + `on_settled` receives None.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_fork_rekey_publication_fails_the_adoption_through_the_completion() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        st.handle_create(dedup_create_msg("req-e2r3-f2"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-e2r3-f2").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        // The first adoption publishes.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while st
            .cli_index
            .lock()
            .await
            .get(fresh_create_durable_id)
            .is_none()
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the first create's adoption never published"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // THE FAILED PUBLICATION: the kill's mint gate armed (the session
        // enumerated; the gate check alone cannot see the kill's
        // completion), then the fork-rekey adoption for the NEW id.
        st.close_pending
            .lock()
            .expect("close-pending lock")
            .insert(placeholder.clone(), 1);
        let (tx, mut rx_done) = tokio::sync::oneshot::channel::<Option<String>>();
        let outcome = st
            .adopt_session_init_with_completion(
                "ffeeeeee-ffff-4fff-8fff-ffffffffffff",
                &placeholder,
                "freshclaude",
                None,
                None,
                None,
                Some(tx),
            )
            .await;
        assert!(
            matches!(outcome, SessionInitAdoptionOutcome::Abandoned),
            "the gated publication abandons (pre-fix: the adoption returned nothing \
             and the handler continued unaliased)"
        );
        let answer = rx_done
            .try_recv()
            .expect("the completion hook answered synchronously on Abandoned");
        assert_eq!(
            answer, None,
            "the rollback handler receives the FAILED answer"
        );
    }

    /// b8ke focused episode-2 round-2 F2: an adoption whose claim is BLOCKED
    /// by an UNRELATED operation fails CLOSED. The finding's shape: a fresh
    /// create exposes its cliSessionId while the adoption is deferred;
    /// another device starts a handoff on the still-vacant canonical key —
    /// the deferred adoption then sees Blocked{Handoff} whose op id is NOT
    /// this runtime's own owning operation (a plain create's session
    /// carries none): the freshly spawned runtime must be TORN DOWN and
    /// NOTHING published — never left running unowned while the handoff
    /// believes there was no prior owner. The runtime's OWN operation
    /// (the session's recorded owning op — the create-resume claim's op id)
    /// still proceeds claim-free.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_foreign_blocked_adoption_tears_down_while_the_own_operation_proceeds() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        // (a) The FOREIGN blocker: an ordinary fresh create's session (no
        // owning operation) + an UNRELATED handoff holding the key.
        st.handle_create(dedup_create_msg("req-e2r2-f2a"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-e2r2-f2a").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder_a = created["sessionId"].as_str().unwrap().to_string();
        // Let the fresh create's OWN adoption commit first (it is the first
        // claimant — this part is the pre-existing behavior).
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe("claude", fresh_create_durable_id).state,
                freshell_ownership::OwnershipState::Live { .. }
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the fresh create's own adoption must commit"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // A SECOND session registered with NO owning operation (the plain
        // create's shape) whose durable id is already blocked by a FOREIGN
        // handoff: enter Handoff on the id directly, then adopt for the
        // second session under the same id.
        let foreign_dur = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
        assert!(matches!(
            registry.begin_handoff(
                "claude",
                foreign_dur,
                freshell_ownership::RuntimeOwnerKind::Terminal,
                "foreign-handoff-op",
                None,
                "other-device",
                1,
            ),
            freshell_ownership::BeginOutcome::Granted { .. }
        ));
        // The second session (a plain create's session: owning op None).
        st.sessions
            .lock()
            .await
            .get_mut(&placeholder_a)
            .expect("session")
            .owning_operation = None;
        st.sessions
            .lock()
            .await
            .get_mut(&placeholder_a)
            .expect("session")
            .cli_session_id = None;
        st.adopt_session_init(foreign_dur, &placeholder_a, "freshclaude", None, None, None)
            .await;
        // The teardown is DETACHED (the adoption's caller is the session's
        // own consumer — the standard teardown aborts it, so the sequence
        // runs in a spawned task): bounded-poll for the fail-closed result.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while st.sessions.lock().await.contains_key(&placeholder_a) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the foreign-blocked adoption must TEAR the runtime down (pre-fix: \
                 published over it and left the sidecar running unowned)"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        assert!(
            st.cli_index.lock().await.get(foreign_dur).is_none(),
            "the foreign-blocked adoption publishes NOTHING"
        );
        assert!(
            !matches!(
                registry.observe("claude", foreign_dur).state,
                freshell_ownership::OwnershipState::Live {
                    owner,
                    ..
                } if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
            ),
            "the foreign handoff's key never becomes FreshAgent-owned by the adoption"
        );

        // (b) The OWN operation: a session whose recorded owning op IS the
        // blocking operation — the under-ticket handoff-target shape. The
        // adoption proceeds claim-free (the owning operation performs the
        // one commit); the runtime stays.
        let own_dur = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
        assert!(matches!(
            registry.begin_handoff(
                "claude",
                own_dur,
                freshell_ownership::RuntimeOwnerKind::FreshAgent,
                "own-runner-op",
                None,
                "runner",
                2,
            ),
            freshell_ownership::BeginOutcome::Granted { .. }
        ));
        // A second live session carrying the runner's op id.
        st.handle_create(dedup_create_msg("req-e2r2-f2b"), None)
            .await;
        let created_b = await_claude_created(&mut rx, "req-e2r2-f2b").await;
        let placeholder_b = created_b["sessionId"].as_str().unwrap().to_string();
        {
            let mut sessions = st.sessions.lock().await;
            let session = sessions.get_mut(&placeholder_b).expect("second session");
            session.owning_operation = Some("own-runner-op".to_string());
            session.cli_session_id = None;
        }
        st.adopt_session_init(own_dur, &placeholder_b, "freshclaude", None, None, None)
            .await;
        assert!(
            st.sessions.lock().await.contains_key(&placeholder_b),
            "the runtime's OWN operation proceeds — no teardown"
        );
        assert_eq!(
            st.cli_index.lock().await.get(own_dur),
            Some(&placeholder_b),
            "the own-operation adoption publishes the bookkeeping"
        );
    }

    /// b8ke focused episode-2 round-2 F3: the publication revalidates the
    /// session's INCARNATION. A kill that COMPLETES between the adoption's
    /// read and its publication (the session removed AND its close-pending
    /// entry gone — the gate check alone cannot see it) must fail the
    /// publication: no dangling alias, no Live commit of the killed
    /// runtime's captured pid. Pre-fix the publication returned success and
    /// committed the dead runtime as the authoritative owner.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_completed_kill_before_publication_abandons_the_adoption() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        // The deterministic hold: the adoption parks between its phase-1
        // read (session LIVE, pid captured) and the publication. Armed
        // BELOW — only AFTER the first create's own adoption has provably
        // published, so the spawned adoption is the ONLY parker (the e2r3
        // F10 fix: the reached flag then belongs to the task under test).
        let pause = std::sync::Arc::new(AdoptionTestPause {
            notify: tokio::sync::Notify::new(),
            reached: std::sync::atomic::AtomicBool::new(false),
        });

        st.handle_create(dedup_create_msg("req-e2r2-f3"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-e2r2-f3").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        // The durable id the sidecar will mint must differ from the FIRST
        // create's own adoption. The FIRST create's adoption must PROVABLY
        // complete BEFORE the pause arms — otherwise it parks on the same
        // pause and the `reached` flag would prove the WRONG task parked
        // (the e2r3 F10 fix: exactly one parker, unambiguously the one
        // under test).
        let first_dur = fresh_create_durable_id;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while st.cli_index.lock().await.get(first_dur).is_none() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the first create's own adoption never published"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        st.set_adoption_test_pause(Some(std::sync::Arc::clone(&pause)));
        let killed_dur = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

        let st2 = st.clone();
        let ph = placeholder.clone();
        let mut adoption = tokio::spawn(async move {
            st2.adopt_session_init(killed_dur, &ph, "freshclaude", None, None, None)
                .await;
        });
        // b8ke focused episode-2 round-3 F10: the test must PROVE the
        // adoption reached the park before the kill — the seam's `reached`
        // flag flips exactly at the hold, so a park that never happened
        // fails here instead of passing vacuously.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !pause.reached.load(std::sync::atomic::Ordering::SeqCst) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the adoption never reached the kill-window park — the test's \
                 interleaving did not occur"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // THE COMPLETED KILL between the read and the publication: the
        // session REMOVED and its close-pending entry GONE (the kill
        // finished; nothing re-arms the mint gate — the gate check alone
        // cannot see this).
        let removed = st.sessions.lock().await.remove(&placeholder);
        assert!(removed.is_some(), "the kill removed the session");
        assert!(
            st.close_pending
                .lock()
                .expect("close-pending probe")
                .get(&placeholder)
                .is_none(),
            "the completed kill left no close-pending entry"
        );

        // Release the adoption: the publication must fail closed on the
        // session-incarnation revalidation. The join must COMPLETE (a
        // timeout-elapsed adoption means the release never landed — a
        // hang, not a pass).
        // e2 post-cap F7: notify_one RETAINS a permit for a waiter that
        // has not registered yet — the reached→notify gap cannot lose
        // the wake.
        pause.notify.notify_one();
        match tokio::time::timeout(std::time::Duration::from_secs(15), &mut adoption).await {
            Ok(joined) => {
                assert!(joined.is_ok(), "the adoption task completed without panic");
            }
            Err(_) => {
                panic!("the released adoption never completed — the park release did not land")
            }
        }

        assert!(
            st.cli_index.lock().await.get(killed_dur).is_none(),
            "the adoption over a killed session publishes NO alias (pre-fix: \
             the dangling alias landed)"
        );
        assert!(
            !matches!(
                registry.observe("claude", killed_dur).state,
                freshell_ownership::OwnershipState::Live { .. }
            ),
            "the adoption never commits the KILLED runtime as the owner \
             (pre-fix: snapshots reported the dead runtime as authoritative)"
        );
    }

    /// b8ke focused episode-2 round-1 F7: the adoption's claim records the
    /// PROVENANCE-derived initiator (the device id) — never the fixed lane
    /// string. Captured off the coordinator's `ownership.start.begin` event
    /// for the adoption's own claim (operation_id `claude-init-adopt-*`).
    #[tokio::test]
    async fn the_init_adoption_claim_records_the_provenance_initiator() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());

        let (sink, _capture_guard) = init_capture::install();
        let provenance = Some(crate::identity_sink::BindProvenance {
            client_instance_id: Some("client-e2r7".into()),
            device_id: Some("dev-e2r7".into()),
            tab_key: None,
            asserted_at: 1,
        });
        st.handle_create(dedup_create_msg("req-e2r7-f7"), provenance)
            .await;

        let created = await_claude_created(&mut rx, "req-e2r7-f7").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        // The deferred adoption claims under the minted durable id once the
        // create registers the runtime.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if matches!(
                registry.observe("claude", fresh_create_durable_id).state,
                freshell_ownership::OwnershipState::Live { owner, .. }
                    if owner.kind == freshell_ownership::RuntimeOwnerKind::FreshAgent
            ) {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the provenance-carrying create's adoption must commit"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let events = sink.lock().expect("capture lock").clone();
        let claim = events
            .iter()
            .find(|(event, _initiator, op)| {
                event == "ownership.start.begin" && op == "create-resume-req-e2r7-f7"
            })
            .expect("the adoption's claim event is captured");
        assert_eq!(
            claim.1, "dev-e2r7",
            "the adoption claim records the provenance device id, got {:?}",
            events
        );
    }

    /// F5's abort path: a kill whose ONE envelope fails Clean releases the
    /// close gate it armed — the session is genuinely untouched (a later
    /// adoption mints normally), exactly like the r2 abort the envelope
    /// failure rules promised.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kill_whose_envelope_fails_clean_reopens_the_close_gate() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(dedup_create_msg("req-gate-abort"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-gate-abort").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();

        fake.fail_retires_after(0); // every close call fails Clean
        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: placeholder.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        assert!(
            st.sessions.lock().await.contains_key(&placeholder),
            "the failed kill leaves the session MAPPED"
        );
        assert!(
            st.close_pending
                .lock()
                .expect("close-pending probe")
                .get(&placeholder)
                .is_none(),
            "the aborted kill released the gate it armed"
        );
        // The mint channel is open again: an adoption lands exactly like on
        // a never-killed session.
        st.adopt_session_init(
            "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            &placeholder,
            "freshclaude",
            None,
            Some(fake.clone()),
            None,
        )
        .await;
        assert_eq!(
            st.cli_index
                .lock()
                .await
                .get("cccccccc-cccc-4ccc-8ccc-cccccccccccc")
                .cloned(),
            Some(placeholder.clone()),
            "the post-abort adoption mints normally"
        );
    }

    /// kata b8ke Task 3 review I-1: a typed kill REFUSAL (the coordinator
    /// blocked the stop — here: a handoff owns the session's transition)
    /// kills NOTHING, so it must also roll back the pre-kill mint gate it
    /// armed — otherwise the still-live session's adoptions abandon
    /// forever (the held gate makes `adopt_session_init` discard every
    /// mint). The refused kill must leave the session fully operational
    /// for a subsequent adoption.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_refused_kill_releases_the_close_gate_and_adoptions_proceed() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(dedup_create_msg("req-kill-refused"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-kill-refused").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();

        await_create_ownership_committed(&st, &placeholder).await;
        // The refusal precondition: a handoff owns the placeholder's
        // transition, so the kill's fenced stop is typed-blocked.
        let freshell_ownership::BeginOutcome::Granted { .. } = registry.begin_handoff(
            PROVIDER,
            &placeholder,
            freshell_ownership::RuntimeOwnerKind::Terminal,
            "ho-refused-1",
            None,
            "test",
            crate::session_lease::now_epoch_ms() + 1,
        ) else {
            panic!("fixture: the handoff begins from the committed Live state")
        };
        while rx.try_recv().is_ok() {}

        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: placeholder.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        // The refusal killed nothing: the session stays mapped and the
        // answer reports failure.
        assert!(
            st.sessions.lock().await.contains_key(&placeholder),
            "a refused kill must leave the session mapped"
        );
        let mut killed_frame = None;
        while let Ok(raw) = rx.try_recv() {
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.killed" {
                killed_frame = Some(frame);
            }
        }
        let killed_frame = killed_frame.expect("the kill answers freshAgent.killed");
        assert_eq!(
            killed_frame["success"], false,
            "the refused kill reports success:false: {killed_frame}"
        );
        // THE regression: the mint gate is released, so an adoption lands
        // exactly like on a never-killed session.
        let gated = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        st.adopt_session_init(
            gated,
            &placeholder,
            "freshclaude",
            None,
            Some(fake.clone()),
            None,
        )
        .await;
        assert_eq!(
            st.cli_index.lock().await.get(gated).cloned(),
            Some(placeholder.clone()),
            "the post-refusal adoption mints normally (the gate was released)"
        );
        assert!(
            fake.alias_record_writes
                .lock()
                .unwrap()
                .iter()
                .any(|(_, p, d)| p == &placeholder && d == gated),
            "the post-refusal adoption writes its alias record"
        );
    }

    /// b8ke focused round-2 review R2-2: an explicit kill whose teardown
    /// CANNOT confirm the runtime tree's death (a TERM-immune tagged
    /// descendant outlives the bounded confirmation window) must NOT
    /// commit `Stopping` → `Vacant` and must NOT broadcast success — the
    /// key stays fenced in `Stopping` (a create is Blocked) until the
    /// detached escalation's SIGKILL rounds confirm the tree's death, and
    /// only that deferred commit releases the key. Pre-fix: the helper
    /// discarded the `NotConfirmed` outcome after logging it and the kill
    /// committed the stop + broadcast success regardless — a descendant
    /// writer could outlive the released ownership. Linux-only (the /proc
    /// ownership-tag scan is the Linux discipline).
    #[cfg(target_os = "linux")]
    #[tokio::test(flavor = "multi_thread")]
    async fn an_unconfirmed_kill_fences_the_key_until_the_escalation_confirms_death() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(registry.clone());
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        // The one-round confirmation window: a TERM-immune tagged descendant
        // deterministically outlives it (the FR3 seam, now shared by the
        // kill-family helper).
        st.set_handoff_confirm_rounds_for_test(Some(1));

        st.handle_create(dedup_create_msg("req-kill-unconfirmed"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-kill-unconfirmed").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();

        await_create_ownership_committed(&st, &placeholder).await;
        // Park a TERM-immune tagged "CLI grandchild" under the sidecar's
        // ownership tag (the FR3 fixture): it deterministically outlives the
        // one-round confirmation window.
        let prior_pid = st
            .sessions
            .lock()
            .await
            .get(&placeholder)
            .and_then(|session| session.child.id())
            .expect("the live session's sidecar pid");
        let ownership_id = {
            let environ = std::fs::read(format!("/proc/{prior_pid}/environ"))
                .expect("read the sidecar's environ");
            environ
                .split(|&b| b == 0)
                .find_map(|var| {
                    let var = std::str::from_utf8(var).ok()?;
                    var.strip_prefix("FRESHELL_CLAUDE_SIDECAR_ID=")
                })
                .expect("the sidecar's ownership id")
                .to_string()
        };
        let (mut grandchild, _readiness) = spawn_term_immune_tagged_child(&ownership_id).await;
        let grandchild_pid = grandchild.id().expect("grandchild pid");

        while rx.try_recv().is_ok() {}
        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: placeholder.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        // THE R2-2 regression: the kill visibly FAILS with the typed code
        // while the tree is unconfirmed — never a silent success.
        let mut killed_frame = None;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while killed_frame.is_none() {
            let raw = tokio::time::timeout(std::time::Duration::from_millis(250), rx.recv())
                .await
                .expect("a broadcast arrives within budget")
                .expect("the bus stays open");
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.killed" {
                killed_frame = Some(frame);
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the killed frame never arrived"
            );
        }
        let killed_frame = killed_frame.unwrap();
        assert_eq!(
            killed_frame["success"], false,
            "the unconfirmed kill reports success:false: {killed_frame}"
        );
        assert_eq!(
            killed_frame["code"], "TEARDOWN_NOT_CONFIRMED",
            "the typed not-confirmed code rides the failure: {killed_frame}"
        );
        // The key stays FENCED in Stopping — the stop commit is deferred on
        // the escalation (pre-fix: the kill committed Stopping → Vacant and
        // a create was Granted over the still-lingering descendant).
        assert!(
            matches!(
                registry.observe(PROVIDER, &placeholder).state,
                freshell_ownership::OwnershipState::Stopping { .. }
            ),
            "the unconfirmed kill must keep the key fenced in Stopping, got {:?}",
            registry.observe(PROVIDER, &placeholder).state
        );
        assert!(
            matches!(
                registry.begin_start(
                    PROVIDER,
                    &placeholder,
                    freshell_ownership::RuntimeOwnerKind::FreshAgent,
                    "r22-fence-probe-create",
                    None,
                    "test",
                    0,
                ),
                freshell_ownership::BeginOutcome::Blocked { .. }
            ),
            "a create during the unconfirmed-kill fence must be Blocked"
        );

        // The detached escalation's SIGKILL rounds confirm the grandchild's
        // death — and ONLY then does the deferred commit release the key.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
        while crate::session_lease::proc_starttime(grandchild_pid as i32).is_some() {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the escalation never killed the lingering descendant"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        while registry.observe(PROVIDER, &placeholder).state
            != freshell_ownership::OwnershipState::Vacant
        {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the deferred stop commit never released the fenced key, got {:?}",
                registry.observe(PROVIDER, &placeholder).state
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let _ = grandchild.wait().await;
    }

    /// Focused-ep5-r1 Finding 1 (retire-on-kill round 2), the REAL wire shape:
    /// the client closes a pane by its ORIGINAL BARE PLACEHOLDER sessionId,
    /// while the ledger row is keyed on the durable cli UUID. The round-1
    /// evicted-session test sent the DURABLE id (which is exactly why the
    /// miss escaped it) — this test sends the placeholder, AFTER driving the
    /// sidecar to a real exit: the consumer-exit eviction must DEMOTE the
    /// alias to the retained tombstones (never drop it), so the kill still
    /// resolves and retires the durable-keyed row.
    #[tokio::test]
    async fn handle_kill_after_exit_eviction_with_the_bare_placeholder_still_retires_the_durable_row(
    ) {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        st.handle_create(dedup_create_msg("req-alias-exit"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-alias-exit").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        // The fake sidecar's default durable cliSessionId (its script emits it
        // on sdk.session.init when no resume boot was supplied).
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        adopt_legacy_fixture(&st, &placeholder, durable).await;
        // The REAL consumer fold adopts the alias (poll, bounded) — the kill
        // must race NOTHING here: the alias exists before the exit.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let present = st
                .cli_index
                .lock()
                .await
                .get(durable)
                .is_some_and(|mapped| mapped == &placeholder);
            if present {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the sdk.session.init adoption must alias the durable id at the placeholder"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }

        // Drive the REAL exit-eviction: the sidecar dies ('__exit__'), the
        // consumer's EOF arm evicts the session and demotes the alias.
        st.handle_send(send_msg(&placeholder, "__exit__")).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if st.sessions.lock().await.is_empty() && st.cli_index.lock().await.is_empty() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "consumer exit must still evict the dead session and its live cli_index entries"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }

        // THE WIRE SHAPE THE CLIENT ACTUALLY SENDS: the bare placeholder.
        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: placeholder.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            retires.contains(&("claude".to_string(), durable.to_string())),
            "an evicted-alias kill naming the bare placeholder must still retire \
             the DURABLE-keyed row: {retires:?}"
        );
        assert!(
            retires.contains(&("claude".to_string(), placeholder.clone())),
            "the placeholder itself still retires by name: {retires:?}"
        );
        // Finding 2 twin: the tombstone mirror — the durable identity's late
        // adoption write would now be fenced.
        assert!(
            fake.kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), durable.to_string())),
            "the kill folds the durable's kill tombstone"
        );
        drop(env);
    }

    /// Focused-ep5-r1 Finding 2 (retire-on-kill round 2), the in-flight
    /// adoption race with REAL concurrency (no synchronous-install shortcut):
    /// the orphan gate models the production spawn_blocking closure
    /// faithfully — the binding write's apply is detached and lands only on
    /// release, exactly like a closure that survives the consumer task's
    /// abort. The kill lands IN BETWEEN. The durable row must never reappear:
    /// the kill's tombstone fences the released write.
    #[tokio::test(flavor = "multi_thread")]
    async fn handle_kill_while_the_adoption_write_is_in_flight_never_rebounds_the_row() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // Arm the gate for the durable the fake sidecar will emit, BEFORE the
        // create: the consumer's sdk.session.init adoption write detaches.
        let gate = fake.arm_orphan_binding_gate("claude", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
        st.set_identity_sink(fake.clone());

        let mut msg = dedup_create_msg("req-orphan-kill");
        msg.cwd = Some("/tmp".to_string()); // settings-bearing => the adoption writes
        st.handle_create(msg, None).await;
        let created = await_claude_created(&mut rx, "req-orphan-kill").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        adopt_legacy_fixture(&st, &placeholder, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa").await;

        // The adoption write has been INVOKED (production's spawn-launch
        // point) — it is in flight, not yet applied.
        gate.entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the sdk.session.init adoption entered the binding write");

        // The user closes the pane NOW (the bare placeholder — the real wire
        // shape) while that write is still in flight.
        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: placeholder.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;
        assert!(
            fake.kill_tombstones.lock().unwrap().contains_key(&(
                "claude".to_string(),
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string()
            )),
            "the kill folded the durable identity's kill tombstone"
        );

        // The in-flight write lands NOW, after both the kill and its retire.
        gate.release.send(()).expect("release the orphan write");
        gate.applied
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the detached apply ran");

        assert!(
            !fake
                .bindings
                .lock()
                .unwrap()
                .iter()
                .any(|b| b.session_id == "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            "a binding write in flight at kill time must never land the row"
        );
        assert!(
            fake.suppressed.lock().unwrap().contains(&(
                "claude".to_string(),
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".to_string()
            )),
            "the tombstone suppression of the orphan write is positively observable"
        );
        drop(env);
    }

    /// Focused-ep5-r1 Finding 2, the tombstone lifecycle's exit: an EXPLICIT
    /// late resume of a killed session still works — the claim clears the
    /// tombstone, and the resumed session's own adoption write (the fake
    /// sidecar echoes the resume boot's id as the durable cliSessionId) lands
    /// instead of being suppressed as a stale orphan.
    #[tokio::test]
    async fn resume_create_after_a_kill_clears_the_tombstone_and_rebinds() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

        // Create, let the alias land, kill (placeholder — the real wire shape).
        st.handle_create(dedup_create_msg("req-claim-kill"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-claim-kill").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        adopt_legacy_fixture(&st, &placeholder, durable).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let present = st
                .cli_index
                .lock()
                .await
                .get(durable)
                .is_some_and(|mapped| mapped == &placeholder);
            if present {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "alias lands pre-kill"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: placeholder,
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;
        assert!(
            fake.kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), durable.to_string())),
            "the kill folded the tombstone"
        );

        // The user resumes the SAME durable session explicitly — the wire
        // shape: create with resumeSessionId.
        let mut resume = dedup_create_msg("req-claim-resume");
        resume.resume_session_id = Some(durable.to_string());
        resume.cwd = Some("/tmp".to_string());
        st.handle_create(resume, None).await;
        let recreated = await_claude_created(&mut rx, "req-claim-resume").await;
        assert_eq!(
            recreated["type"].as_str().unwrap(),
            "freshAgent.created",
            "the resume itself answers created (never a failure): {recreated}"
        );

        assert!(
            fake.claim_commits
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), durable.to_string())),
            "the genuine claim COMMITS (round 4: fence-clear + revive in one conditional \
             transition) BEFORE its own write"
        );
        assert!(
            !fake
                .kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), durable.to_string())),
            "the durable fence is gone post-commit"
        );
        // The resumed session's adoption write landed: never suppressed.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let bound = fake
                .bindings
                .lock()
                .unwrap()
                .iter()
                .any(|b| b.provider == "claude" && b.session_id == durable);
            if bound {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the resumed session's adoption write must land (never tombstone-suppressed); \
                 suppressed={:?}",
                fake.suppressed.lock().unwrap()
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(
            !fake
                .suppressed
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), durable.to_string())),
            "the claim's own write is never suppressed"
        );
        drop(env);
    }

    // ── Retire-on-kill round 3 (focused-ep5-r2 Findings 2/3/5 + Finding 4 claude) ──

    fn kill_msg(session_id: &str) -> FreshAgentKill {
        FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        }
    }

    /// b8ke focused review FR9: the half-fenced kill refusal carries the
    /// typed INVALID_FENCE code in the `freshAgent.killed` answer — clients
    /// reduce the code instead of the generic KILL_FAILED default.
    /// Pre-fix the frame carried only `success:false`.
    #[tokio::test]
    async fn half_fenced_kill_refusal_carries_the_typed_invalid_fence_code() {
        for (epoch, generation) in [(Some(3u64), None), (None, Some(7u64))] {
            let (st, mut rx) = state_with_bus();
            let mut msg = kill_msg("half-fenced-kill");
            msg.observed_epoch = epoch;
            msg.observed_generation = generation;

            st.handle_kill(msg).await;

            let raw = rx.try_recv().expect("the refusal frame");
            let frame: Value = serde_json::from_str(&raw).unwrap();
            assert_eq!(frame["type"], "freshAgent.killed", "{frame}");
            assert_eq!(frame["success"], json!(false), "{frame}");
            assert_eq!(
                frame["code"],
                json!("INVALID_FENCE"),
                "the typed refusal code must ride the kill answer: {frame}"
            );
            assert!(
                frame["message"]
                    .as_str()
                    .is_some_and(|m| m.contains("together")),
                "the message names the pair rule: {frame}"
            );
        }
    }

    /// Bounded-wait until `cli_index[durable] == expected` — the same poll the
    /// round-1/2 kill tests use to observe the consumer's adoption fold
    /// without racing it.
    async fn await_alias(st: &FreshClaudeState, durable: &str, expected: &str) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let present = st
                .cli_index
                .lock()
                .await
                .get(durable)
                .is_some_and(|mapped| mapped == expected);
            if present {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the alias {durable} -> {expected} never landed"
            );
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    /// Focused-ep5-r2 Finding 2 (retire-on-kill round 3), THE pin: reopen the
    /// durable session D, then kill via the OLD pane's placeholder P — the
    /// live row must SURVIVE. The reopen (the genuine claim) consumes the
    /// stale P→D alias tombstone (and clears the ledger fence for every known
    /// alias of D), so the late placeholder-addressed kill retires only the
    /// placeholder it names.
    #[tokio::test]
    async fn reopened_session_survives_a_late_kill_naming_the_old_placeholder() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

        // Epoch 1: create + adoption, then the close (bare placeholder — the
        // real wire shape), which retires D and demotes P1→D to the alias
        // tombstones.
        st.handle_create(dedup_create_msg("req-reopen-1"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-reopen-1").await;
        let placeholder_old = created["sessionId"].as_str().unwrap().to_string();
        adopt_legacy_fixture(&st, &placeholder_old, durable).await;
        await_alias(&st, durable, &placeholder_old).await;
        st.handle_kill(kill_msg(&placeholder_old)).await;
        assert!(
            fake.kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), durable.to_string())),
            "epoch 1 close folded D's fence"
        );

        // Epoch 2: the genuine claim — resume the SAME durable id (the fake
        // sidecar echoes the resume boot's id as the cliSessionId).
        let mut resume = dedup_create_msg("req-reopen-2");
        resume.resume_session_id = Some(durable.to_string());
        resume.cwd = Some("/tmp".to_string());
        st.handle_create(resume, None).await;
        let recreated = await_claude_created(&mut rx, "req-reopen-2").await;
        assert_eq!(recreated["type"].as_str().unwrap(), "freshAgent.created");
        let placeholder_new = recreated["sessionId"].as_str().unwrap().to_string();
        await_alias(&st, durable, &placeholder_new).await;

        // The late kill naming the OLD placeholder (the finding's shape — a
        // stale pane closes against its original session id).
        st.handle_kill(kill_msg(&placeholder_old)).await;

        let retires = fake.retires.lock().unwrap().clone();
        assert_eq!(
            retires
                .iter()
                .filter(|(p, s)| p == "claude" && s == durable)
                .count(),
            1,
            "the reopened durable must NOT be retired by the old placeholder's kill: {retires:?}"
        );
        assert!(
            retires
                .iter()
                .any(|(p, s)| p == "claude" && s == &placeholder_old),
            "the wire id still retires by name: {retires:?}"
        );
        // The claim consumed the stale alias record at reopen time.
        let now = crate::session_lease::now_epoch_ms() as i64;
        assert!(
            st.alias_tombstones
                .lock()
                .unwrap()
                .durables_for(&placeholder_old, now, &st.alias_row_bound_probe())
                .is_empty(),
            "the genuine claim must consume the old placeholder's alias tombstone"
        );
        // ...and the ledger fence of the consumed alias was cleared at the
        // same commit (the reopened identity's every known alias reopens).
        assert!(
            fake.tombstone_clears
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), placeholder_old.clone())),
            "the claim also cleared the old placeholder's own ledger fence"
        );
        assert!(
            fake.claim_commits
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), durable.to_string())),
            "the claim revived the durable row its close had retired"
        );
        drop(env);
    }

    /// Focused-ep5-r2 Finding 2, the defense-in-depth half: even if a demoted
    /// P→D alias tombstone somehow SURVIVES the claim's consumption, kill
    /// handling must not follow it while a DIFFERENT live session owns D
    /// (live session state contradicts the stale alias).
    #[tokio::test]
    async fn a_surviving_alias_tombstone_never_retires_a_durable_a_live_session_claims() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

        // A live session owning D under a NEW placeholder (the reopened shape).
        st.handle_create(dedup_create_msg("req-live-owner"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-live-owner").await;
        let placeholder_live = created["sessionId"].as_str().unwrap().to_string();
        adopt_legacy_fixture(&st, &placeholder_live, durable).await;
        await_alias(&st, durable, &placeholder_live).await;

        // Fabricate the surviving stale record: the OLD epoch's placeholder
        // demoted to a tombstone that (hypothetically) escaped consumption.
        let now = crate::session_lease::now_epoch_ms() as i64;
        st.alias_tombstones
            .lock()
            .expect("alias tombstones lock")
            .record(
                "placeholder-old-epoch",
                durable,
                now,
                &st.alias_row_bound_probe(),
            );

        st.handle_kill(kill_msg("placeholder-old-epoch")).await;

        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            retires.contains(&("claude".to_string(), "placeholder-old-epoch".to_string())),
            "the wire id still retires by name: {retires:?}"
        );
        assert!(
            !retires.iter().any(|(_, s)| s == durable),
            "the stale alias tombstone must not reach a LIVE durable identity: {retires:?}"
        );
        drop(env);
    }

    /// Focused-ep5-r2 Finding 3 (retire-on-kill round 3), the exact
    /// interleaving from the report, constructed deterministically: the
    /// consumer-exit eviction has removed the session entry but has NOT YET
    /// demoted its cli_index alias (and no alias tombstone exists yet) when
    /// the kill lands. The kill must still resolve the durable identity via
    /// the LIVE alias — consulting only the tombstones misses it (the old
    /// no-session branch read tombstones alone).
    #[tokio::test]
    async fn kill_in_the_exit_eviction_gap_retires_the_durable_via_the_live_alias() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

        st.handle_create(dedup_create_msg("req-evict-gap"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-evict-gap").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        adopt_legacy_fixture(&st, &placeholder, durable).await;
        await_alias(&st, durable, &placeholder).await;

        // THE WINDOW: the eviction's first half (sessions-map removal) has
        // run; its second half (cli_index demotion) has NOT.
        assert!(
            st.sessions.lock().await.remove(&placeholder).is_some(),
            "fixture: remove the session entry exactly like the eviction's first half"
        );
        assert!(
            st.alias_tombstones
                .lock()
                .expect("alias tombstones lock")
                .durables_for(
                    &placeholder,
                    crate::session_lease::now_epoch_ms() as i64,
                    &st.alias_row_bound_probe()
                )
                .is_empty(),
            "fixture: no alias tombstone exists yet either"
        );

        // The kill lands NOW — inside the eviction gap.
        st.handle_kill(kill_msg(&placeholder)).await;

        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            retires.contains(&("claude".to_string(), durable.to_string())),
            "a kill inside the exit-eviction gap must still resolve the live alias and \
             retire the durable row: {retires:?}"
        );
        drop(env);
    }

    /// Focused-ep5-r3 Finding 2 (retire-on-kill round 4), the eviction-gap
    /// interleaving from the report — pinned as a STRUCTURAL property (the
    /// exact schedule the finding names is otherwise a microseconds-wide
    /// race): the eviction's demote+remove must be ONE critical section
    /// holding `cli_index` across the tombstone record, matching the kill
    /// consult's `cli_index → sessions → alias_tombstones` lock order, so a
    /// kill consult can NEVER observe "neither the live alias nor the
    /// tombstone". In the round-3 shape (index released before the tombstone
    /// lock) the gap was real: the alias was gone from `cli_index` while the
    /// eviction parked on a held tombstones lock, with `cli_index` FREE the
    /// whole window.
    #[tokio::test(flavor = "multi_thread")]
    // The test deliberately widens the eviction's window by holding the
    // tombstone lock across awaits (the deterministic staging of the
    // finding's interleaving) — never a production shape.
    #[allow(clippy::await_holding_lock)]
    async fn the_eviction_holds_the_index_across_the_demote_and_remove() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

        st.handle_create(dedup_create_msg("req-evict-cs"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-evict-cs").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        adopt_legacy_fixture(&st, &placeholder, durable).await;
        await_alias(&st, durable, &placeholder).await;

        // The consumer-exit shape per the report: the session entry is GONE
        // (removed) while the alias demotion is mid-flight.
        assert!(
            st.sessions.lock().await.remove(&placeholder).is_some(),
            "fixture: the exit removed the session entry"
        );

        // Widen the eviction's window to a deterministic hold: park the
        // tombstones lock BEFORE the eviction can take it, then start the
        // eviction. A single-critical-section eviction blocks on the
        // tombstones lock STILL HOLDING `cli_index`; the two-phase shape
        // releases `cli_index` for the whole window.
        let tombstones_hold = st.alias_tombstones.lock().expect("alias tombstones lock");
        let st2 = st.clone();
        let placeholder_for_evict = placeholder.clone();
        let evict =
            tokio::spawn(async move { st2.evict_cli_index_aliases(&placeholder_for_evict).await });

        // Wait for engagement: the eviction has TAKEN `cli_index` (try_lock
        // fails while it works). Then the pin: for the entire rest of the
        // hold window, `cli_index` must NEVER become free — free once means
        // the demote+remove is split and a kill in that window sees neither
        // map.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        let mut engaged = false;
        while tokio::time::Instant::now() < deadline {
            match st.cli_index.try_lock() {
                Err(_) => {
                    engaged = true;
                    break;
                }
                Ok(guard) => {
                    drop(guard);
                    tokio::time::sleep(std::time::Duration::from_millis(1)).await;
                }
            }
        }
        assert!(engaged, "the eviction never engaged cli_index");
        for _ in 0..50 {
            assert!(
                st.cli_index.try_lock().is_err(),
                "the eviction must hold cli_index across the demote+remove: a kill in \
                 the gap (index free, tombstones not yet recorded) sees neither map"
            );
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }

        // Release the hold: the eviction completes as ONE transition, and a
        // kill naming the bare placeholder now resolves the durable through
        // the freshly-recorded tombstone.
        let demoted = {
            drop(tombstones_hold);
            evict.await.expect("the eviction completed")
        };
        assert_eq!(demoted, vec![durable.to_string()]);
        st.handle_kill(kill_msg(&placeholder)).await;
        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            retires.contains(&("claude".to_string(), durable.to_string())),
            "post-eviction the bare-placeholder kill retires the durable via the tombstone: {retires:?}"
        );
        drop(env);
    }

    /// Focused-ep5-r2 Finding 5 (retire-on-kill round 3): the durable kill
    /// fence is cleared only once the replacement session is ESTABLISHED
    /// (sidecar created + answered). A resume whose create fails mid-way must
    /// KEEP the fence — and then an older in-flight binding write (the
    /// orphan-gate shape, released AFTER the failure) is still fenced instead
    /// of resurrecting Bound.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_resume_create_that_fails_midway_keeps_the_fence_and_no_orphan_rebounds_the_row() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        // Arm the orphan gate for D BEFORE the create: the epoch-1 adoption
        // write detaches (in-flight when the kill lands).
        let gate = fake.arm_orphan_binding_gate("claude", durable);
        st.set_identity_sink(fake.clone());

        let mut msg = dedup_create_msg("req-fence-orphan");
        msg.cwd = Some("/tmp".to_string()); // settings-bearing => the adoption writes
        st.handle_create(msg, None).await;
        let created = await_claude_created(&mut rx, "req-fence-orphan").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        adopt_legacy_fixture(&st, &placeholder, durable).await;
        gate.entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the adoption write entered (in flight)");

        st.handle_kill(kill_msg(&placeholder)).await;
        assert!(
            fake.kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), durable.to_string())),
            "the kill folded D's fence"
        );

        // The resume attempt fails MID-WAY: the provider's create dies before
        // `created` (the fake sidecar's fail knob — the replacement session
        // is never established).
        std::env::set_var("FRESHELL_TEST_CLAUDE_FAIL_CREATE", "1");
        let mut resume = dedup_create_msg("req-fence-resume");
        resume.resume_session_id = Some(durable.to_string());
        st.handle_create(resume, None).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let raw = tokio::time::timeout(std::time::Duration::from_secs(15), rx.recv())
                .await
                .expect("a frame arrives")
                .expect("bus open");
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.create.failed"
                && frame["requestId"] == "req-fence-resume"
            {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the failed resume never answered create.failed: {frame}"
            );
        }

        // The orphaned epoch-1 write lands NOW — against whatever fence state
        // the failed resume left behind.
        gate.release.send(()).expect("release the orphan write");
        gate.applied
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the detached apply ran");

        assert!(
            fake.suppressed
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), durable.to_string())),
            "the fence must OUTLIVE the failed resume — the orphan stays fenced; \
             clears={:?}",
            fake.tombstone_clears.lock().unwrap()
        );
        // The pin is "no Bound resurrection": the gated epoch-1 write is the
        // ONLY binding attempt this lane ever ran, so the durable's row never
        // reached Bound on the fake's state map at all — the fence held from
        // kill through failed resume through orphan release.
        assert_ne!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), durable.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Bound),
            "no Bound resurrection after a mid-way-failed resume"
        );
        drop(env);
    }

    /// Focused-ep5-r2 Finding 4 (retire-on-kill round 3), the claude attach
    /// lane: a kill-closed, LINEAGE-ONLY row (load_settings answers None, so
    /// the settings-gated adoption writes nothing) must still return to Bound
    /// on a successful attach — the claim records the row live-again
    /// unconditionally.
    #[tokio::test(flavor = "multi_thread")]
    async fn attach_of_a_killed_lineage_only_session_revives_the_closed_row() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // The lineage-only seed: a binding row exists, with an all-blank
        // settings snapshot (load_settings answers None).
        fake.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
            genesis: crate::identity_sink::GenesisUpdate::Keep,
            name_transition: None,
            provider: "claude".into(),
            session_id: DURABLE.into(),
            mode: "freshclaude".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            provenance: crate::identity_sink::ProvenanceUpdate::Inherit,
            observed_epoch: None,
            observed_generation: None,

            authoritative: false,
            settings: crate::identity_sink::FreshAgentSettings::default(),
        })
        .await
        .expect("lineage seed write");
        state.set_identity_sink(fake.clone());
        assert!(
            fake.load_settings("claude", DURABLE).is_none(),
            "fixture: the lineage-only row answers no settings snapshot"
        );

        // The close: row Closed + fence (the evicted-id arm — no session is
        // tracked; the row is durable).
        state.handle_kill(kill_msg(DURABLE)).await;
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), DURABLE.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "fixture: the kill closed the row"
        );

        // The attach (conn-less): resume succeeds; the row must be Bound
        // again even though no settings-bearing adoption write ever runs.
        state
            .attach_for_test(attach_msg_with_resume("client-lineage-attach", DURABLE))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), DURABLE.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Bound),
            "a successful attach must return the kill-closed row to Bound \
             (bindings log: {:?})",
            fake.bindings.lock().unwrap()
        );
        assert!(
            fake.claim_commits
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), DURABLE.to_string())),
            "the claim's revive fired even though no settings snapshot exists"
        );
        drop(env);
    }

    /// Focused-ep5-r3 Finding 1 (retire-on-kill round 4) — the report's
    /// exact interleaving on the claude ATTACH lane, staged with REAL
    /// provider timing (no scheduling shortcut): the fake sidecar defers its
    /// `created` answer, the user closes the pane while the resume sits in
    /// that await, and the kill records the close BEFORE the attach's commit
    /// point arrives. The commit must REFUSE the newer close's identity:
    /// the row stays Retired, the fence stands, no session registers, and
    /// the just-spawned sidecar is torn down.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kill_landing_mid_attach_resume_is_never_undone_by_the_claim_commit() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install_with_knobs(Some(1_500), false);
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "fefefefe-fefe-4efe-8efe-fefefefefefe";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "claude",
            DURABLE,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        state.set_identity_sink(fake.clone());

        // The close the user will MEAN: row Closed + fence, before the attach.
        state.handle_kill(kill_msg(DURABLE)).await;
        let claim_start_snapshot = fake.kill_tombstone_at_ms("claude", DURABLE);
        assert!(
            claim_start_snapshot.is_some(),
            "fixture: the fence is durable"
        );

        // The attach starts; the fake sidecar holds `created` for 1.5s, so the
        // resume parks inside its provider await.
        let st2 = state.clone();
        let attach = tokio::spawn(async move {
            st2.attach_for_test(attach_msg_with_resume("client-kill-mid-resume", DURABLE))
                .await;
        });
        // Determinism: wait until the resume's create request has REACHED the
        // sidecar (the fake logs it on receipt, before the defer) — the lane
        // is now provably mid-await.
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while env.spawn_count() < 1 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the resume's create never reached the sidecar"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // THE INTERLEAVING: the user closes the pane now — the kill lands
        // while the resume's `created` is still outstanding.
        state.handle_kill(kill_msg(DURABLE)).await;
        assert_ne!(
            fake.kill_tombstone_at_ms("claude", DURABLE),
            claim_start_snapshot,
            "fixture: the mid-claim close advanced the durable dead-state"
        );

        attach.await.expect("the attach task completed");
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        // The lane answered with the attach-resume failure (never a silent
        // adoption of a closed pane).
        let mut saw_attach_failure = false;
        while let Ok(raw) = rx.try_recv() {
            if raw.contains("CLAUDE_ATTACH_RESUME_FAILED") {
                saw_attach_failure = true;
            }
        }
        assert!(
            saw_attach_failure,
            "the refused claim answers the attach with a failure frame"
        );

        // No commit side effect ran: the row stays Retired, the newer fence
        // stands, nothing ever registered, and the alias map never learned
        // the durable.
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), DURABLE.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the claim must never revive the row the newer close retired"
        );
        assert!(
            fake.kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), DURABLE.to_string())),
            "the newer kill's fence stands — never cleared by the stale claim"
        );
        assert!(
            fake.claim_commits.lock().unwrap().is_empty(),
            "the closed pane never commits a launch claim"
        );
        assert!(
            !fake
                .claim_commits
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), DURABLE.to_string())),
            "no commit side effect ran"
        );
        assert!(
            state.sessions.lock().await.is_empty(),
            "the orphan session was torn down, never registered"
        );
        assert!(
            state.cli_index.lock().await.get(DURABLE).is_none(),
            "the durable never aliased into a live session"
        );
        drop(env);
    }

    /// The claim lifecycle pair at helper level (retire-on-kill round 3,
    /// Findings 2+4+5): `commit_session_claim` clears BOTH fence kinds (the
    /// durable ledger fence AND every demoted alias tombstone pointing at
    /// the durable, whose own ledger fences go too) and revives the closed
    /// row; `rollback_session_claim` restores the close exactly (fence
    /// re-raised, the revived row re-retired Closed).
    #[tokio::test]
    async fn commit_session_claim_clears_every_fence_and_revives_rollback_re_raises_all_of_it() {
        let (st, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

        // The closed epoch: a Bound row, killed; the alias demoted (as a
        // post-eviction close would leave it).
        fake.seed(
            "claude",
            durable,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        st.handle_kill(kill_msg(durable)).await;
        let now = crate::session_lease::now_epoch_ms() as i64;
        st.alias_tombstones
            .lock()
            .expect("alias tombstones lock")
            .record("placeholder-old", durable, now, &st.alias_row_bound_probe());
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), durable.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed)
        );

        // The claim-start snapshot the lanes take (before any provider await):
        // CURRENT dead-state → the commit must accept.
        let snapshot = fake.kill_tombstone_at_ms("claude", durable);
        assert!(snapshot.is_some(), "fixture: the kill's fence is durable");
        assert!(
            st.commit_session_claim(durable, snapshot, &[]).await,
            "an unchanged dead-state commits"
        );
        assert!(
            !fake
                .kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), durable.to_string())),
            "the durable ledger fence is cleared"
        );
        assert!(
            !fake
                .kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), "placeholder-old".to_string())),
            "the consumed alias's ledger fence is cleared too"
        );
        assert!(
            st.alias_tombstones
                .lock()
                .expect("alias tombstones lock")
                .durables_for("placeholder-old", now, &st.alias_row_bound_probe())
                .is_empty(),
            "the alias tombstone is consumed"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), durable.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Bound),
            "the closed row revived"
        );

        // The rollback (Finding 5's re-raise): the close is durable again.
        st.rollback_session_claim(durable).await;
        assert!(
            fake.kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), durable.to_string())),
            "the fence is re-raised"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), durable.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the revived row is re-retired"
        );
    }

    /// Focused-ep5-r3 Finding 1 (retire-on-kill round 4), the helper-level
    /// pin: a claim whose dead-state snapshot a NEWER close has advanced
    /// past must be REFUSED — and refusal is side-effect-free on EVERY axis
    /// the commit owns: no durable fence clear, no row revive, no alias
    /// tombstone consumption, no alias fence clears (the report's "verify no
    /// commit side effect runs when the check fails").
    #[tokio::test]
    async fn a_claim_commit_against_an_advanced_dead_state_refuses_every_side_effect() {
        let (st, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

        // The closed epoch: Bound row, killed (fence stamp 1); alias demoted
        // and fenced (as a post-eviction close leaves it).
        fake.seed(
            "claude",
            durable,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        st.handle_kill(kill_msg(durable)).await;
        st.handle_kill(kill_msg("placeholder-old")).await; // the alias's own fence
        let now = crate::session_lease::now_epoch_ms() as i64;
        st.alias_tombstones
            .lock()
            .expect("alias tombstones lock")
            .record("placeholder-old", durable, now, &st.alias_row_bound_probe());
        let stale_snapshot = fake.kill_tombstone_at_ms("claude", durable);

        // THE KILL DURING THE CLAIM: a newer close advances the durable
        // dead-state past the claim's snapshot.
        st.handle_kill(kill_msg(durable)).await;
        assert_ne!(
            fake.kill_tombstone_at_ms("claude", durable),
            stale_snapshot,
            "fixture: the newer close advanced the fence stamp"
        );

        assert!(
            !st.commit_session_claim(durable, stale_snapshot, &[]).await,
            "a claim the close outranked must REFUSE"
        );
        // Every commit side effect stayed down:
        assert!(
            fake.kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), durable.to_string())),
            "the newer fence is never cleared"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), durable.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the row is never revived"
        );
        assert!(
            !st.alias_tombstones
                .lock()
                .expect("alias tombstones lock")
                .durables_for("placeholder-old", now, &st.alias_row_bound_probe())
                .is_empty(),
            "the alias tombstone is never consumed"
        );
        assert!(
            fake.kill_tombstones
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), "placeholder-old".to_string())),
            "the alias's own ledger fence is never cleared"
        );
        assert!(
            fake.tombstone_clears.lock().unwrap().is_empty(),
            "no alias fence clear was even attempted: {:?}",
            fake.tombstone_clears.lock().unwrap()
        );
        assert!(
            fake.claim_refusals
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), durable.to_string())),
            "the refusal is positively logged"
        );
    }

    // ── retire-on-kill round 5 (focused-ep5-r4 Findings 1+2+5) ─────────────────

    /// Finding 2, the RETENTION rule at the store level: an alias record's
    /// lifetime is the ROW lifetime its durable resolves to — TTL expiry and
    /// capacity eviction may only discard a record whose row is already
    /// Retired-or-GC'd. With a still-Bound row, the record survives ANY age;
    /// with the row gone, the 6h TTL applies as before. (The probe parameter
    /// is the identity sink's raw `row_is_bound` answer; `|_| true` /
    /// `|_| false` stand in for the two row states here.)
    #[test]
    fn the_alias_record_lives_as_long_as_the_row_it_resolves_to() {
        let bound = |_: &str| true;
        let gone = |_: &str| false;
        let over_ttl = ALIAS_TOMBSTONE_TTL_MS + 60_000;

        let mut kept = AliasTombstones::default();
        kept.record("p", "d", 0, &bound);
        assert_eq!(
            kept.durables_for("p", over_ttl, &bound),
            vec!["d".to_string()],
            "a still-Bound row retains its alias mapping past the TTL — the pane's close \
             (days later, by the bare placeholder) must still reach the durable row"
        );

        let mut aged = AliasTombstones::default();
        aged.record("p", "d", 0, &gone);
        assert!(
            aged.durables_for("p", over_ttl, &gone).is_empty(),
            "a Retired-or-GC'd row's alias record ages out on schedule"
        );
    }

    /// Finding 2's cap half: capacity eviction consults ROW STATE, not age
    /// alone — the oldest record is NOT evicted while its durable row is
    /// Bound (a long-lived pane is ordinary); the eviction proceeds against
    /// the oldest UNBOUND placeholder, and a wholly bound-set may exceed the
    /// cap (correctness over the bound, loudly).
    #[test]
    fn the_alias_cap_never_evicts_a_record_whose_row_is_still_bound() {
        // "d-p0" is Bound; every other durable's row is gone.
        let probe = |durable: &str| durable == "d-p0";
        let mut t = AliasTombstones::default();
        for i in 0..(ALIAS_TOMBSTONE_CAP + 4) {
            t.record(&format!("p{i}"), &format!("d-p{i}"), i as i64, &probe);
        }
        // Cap+4 records: exactly 4 placeholders evicted, and the eviction
        // order is oldest-UNBOUND-first — p0 (the oldest, but bound) survives
        // while p1..p4 (older unbound) go first.
        assert_eq!(
            t.durables_for("p0", ALIAS_TOMBSTONE_CAP as i64 + 4, &probe),
            vec!["d-p0".to_string()],
            "the bound-row record survives the cap — age alone never evicts it"
        );
        for gone in ["p1", "p2", "p3", "p4"] {
            assert!(
                t.durables_for(gone, ALIAS_TOMBSTONE_CAP as i64 + 4, &probe)
                    .is_empty(),
                "oldest unbound placeholders are the eviction candidates ({gone} must go)"
            );
        }
    }

    /// Finding 2 at the kill boundary (the report's verbatim failure): the
    /// pane lived past the alias TTL (long-lived panes are ordinary), the
    /// sidecar exit-demoted the alias days later, and the pane's close names
    /// the bare placeholder. The mapping must still resolve to the durable
    /// row — the kill retires it.
    #[tokio::test]
    async fn handle_kill_after_the_alias_ttl_with_a_still_bound_row_still_retires_the_durable() {
        let (st, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        fake.seed(
            "claude",
            durable,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        // The demoted alias, stamped 7h ago (past the 6h TTL).
        let now = crate::session_lease::now_epoch_ms() as i64;
        let stale_at = now - (ALIAS_TOMBSTONE_TTL_MS + 60 * 60 * 1000);
        st.alias_tombstones
            .lock()
            .expect("alias tombstones lock")
            .record(
                "placeholder-old",
                durable,
                stale_at,
                &st.alias_row_bound_probe(),
            );

        st.handle_kill(kill_msg("placeholder-old")).await;

        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            retires.contains(&("claude".to_string(), durable.to_string())),
            "the close must still find the durable row past the alias TTL while its row is Bound: {retires:?}"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), durable.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the durable row retires Closed"
        );
    }

    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 1), the claude
    /// ATTACH-resume lane: a kill QUEUED behind the claim's commit (the
    /// commit's dead-state decision pre-dated it) lands between the commit
    /// and the registration. Kill still wins: the lane's post-registration
    /// re-check observes the advanced fence, the registered orphan is torn
    /// down, and the row the kill retired stays Retired. (The fake sidecar
    /// answers promptly; the fake sink's post-commit stall holds the lane
    /// exactly in the finding's window.)
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kill_landing_between_the_commit_and_the_registration_still_closes_the_attached_session(
    ) {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "abababab-abab-4aba-8aba-abababababab";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "claude",
            DURABLE,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        state.set_identity_sink(fake.clone());

        // The close the user MEANT (before this attach): row Closed + fence.
        state.handle_kill(kill_msg(DURABLE)).await;
        let claim_start_snapshot = fake.kill_tombstone_at_ms("claude", DURABLE);
        assert!(
            claim_start_snapshot.is_some(),
            "fixture: the fence is durable"
        );

        let stall = fake.arm_post_commit_stall("claude", DURABLE);
        let st2 = state.clone();
        let attach = tokio::spawn(async move {
            st2.attach_for_test(attach_msg_with_resume("client-killed-post-commit", DURABLE))
                .await;
        });
        stall
            .applied
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the claim's commit landed (the lane is parked pre-registration)");
        assert_eq!(
            fake.kill_tombstone_at_ms("claude", DURABLE),
            None,
            "fixture: the commit cleared the fence — its decision pre-dates the kill below"
        );

        // THE INTERLEAVING (Finding 1): the user's close lands between the
        // completed commit and the registration.
        state.handle_kill(kill_msg(DURABLE)).await;
        let post_kill = fake.kill_tombstone_at_ms("claude", DURABLE);
        assert!(
            post_kill.is_some() && post_kill > claim_start_snapshot,
            "fixture: the post-commit close re-raised the fence past the claim's snapshot"
        );
        stall.release.send(()).expect("release the stalled claim");

        tokio::time::timeout(std::time::Duration::from_secs(15), attach)
            .await
            .expect("the attach resolves")
            .expect("attach task completed");
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let mut saw_resume_failed = false;
        while let Ok(raw) = rx.try_recv() {
            if raw.contains("CLAUDE_ATTACH_RESUME_FAILED") {
                saw_resume_failed = true;
            }
        }
        assert!(
            saw_resume_failed,
            "the kill-queued-behind-the-commit attach answers the resume failure"
        );
        assert!(
            state.sessions.lock().await.is_empty(),
            "the late orphan session was torn down, never kept"
        );
        assert!(
            state.cli_index.lock().await.get(DURABLE).is_none(),
            "the durable's registration alias is gone too"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), DURABLE.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the row the kill retired stays Retired"
        );
        assert!(
            fake.kill_tombstone_at_ms("claude", DURABLE).is_some(),
            "the post-commit kill's fence stands"
        );
        drop(env);
    }

    /// The CREATE-resume lane twin: the post-commit kill lands while the lane
    /// is between commit and the sessions/cli_index inserts — the create
    /// answers failed and nothing registers.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_kill_landing_between_the_commit_and_the_registration_still_closes_the_resumed_create(
    ) {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        let durable = "cdcdcdcd-cdcd-4cdc-8dcd-cdcdcdcdcdcd";
        fake.seed(
            "claude",
            durable,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        state.set_identity_sink(fake.clone());

        state.handle_kill(kill_msg(durable)).await;
        assert!(
            fake.kill_tombstone_at_ms("claude", durable).is_some(),
            "fixture: the fence is durable"
        );

        let stall = fake.arm_post_commit_stall("claude", durable);
        let st2 = state.clone();
        let create = tokio::spawn(async move {
            let mut msg = dedup_create_msg("req-killed-post-commit");
            msg.resume_session_id = Some(durable.to_string());
            msg.cwd = Some("/tmp".to_string());
            st2.handle_create(msg, None).await;
        });
        stall
            .applied
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the claim's commit landed (the lane is parked pre-registration)");

        state.handle_kill(kill_msg(durable)).await;
        stall.release.send(()).expect("release the stalled claim");

        tokio::time::timeout(std::time::Duration::from_secs(15), create)
            .await
            .expect("the create resolves")
            .expect("create task completed");

        let frame = {
            let mut last = None;
            while let Ok(raw) = rx.try_recv() {
                let v: Value = serde_json::from_str(&raw).unwrap();
                if (v["type"] == "freshAgent.created" || v["type"] == "freshAgent.create.failed")
                    && v["requestId"] == "req-killed-post-commit"
                {
                    last = Some(v);
                }
            }
            last.expect("the create answers")
        };
        assert_eq!(
            frame["type"], "freshAgent.create.failed",
            "the kill-queued-behind-the-commit create answers failed (never a live orphan): {frame}"
        );
        assert!(
            state.sessions.lock().await.is_empty(),
            "nothing registers behind a kill the commit pre-dated"
        );
        assert!(
            state.cli_index.lock().await.get(durable).is_none(),
            "no registration alias survives"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), durable.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the row the kill retired stays Retired"
        );
        drop(env);
    }

    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 1), the kill's half of
    /// the claude protocol: the post-close SWEEP. The claim's re-check covers
    /// the retire-landed-before-registration order; the sweep covers the
    /// retire-landed-after order — any session registered behind the close
    /// whose fence STILL stands is the claim's late orphan (the commit's
    /// decision pre-dated the kill): tear it down. A RE-COMMITTED claim (the
    /// fence cleared by a newer claim's commit) is never the kill's orphan —
    /// the sweep leaves it live.
    #[tokio::test]
    async fn the_kill_sweep_tears_down_a_session_registered_behind_the_still_standing_close() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "bebebebe-bebe-4ebe-8ebe-bebebebebebe";

        // A live session owning the durable (the alias written directly, the
        // trick the kill tests use — the fake sidecar mints its own cli id).
        st.handle_create(dedup_create_msg("req-sweep-1"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-sweep-1").await;
        assert_eq!(created["type"].as_str().unwrap(), "freshAgent.created");
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), placeholder.clone());
        st.sessions
            .lock()
            .await
            .get_mut(&placeholder)
            .expect("session tracked under the placeholder")
            .cli_session_id = Some(durable.to_string());

        // The close the sweep answers for: the fence stands, the row retired.
        fake.retire_closed("claude", durable)
            .await
            .expect("the close records");
        assert!(
            fake.kill_tombstone_at_ms("claude", durable).is_some(),
            "fixture: the fence stands"
        );

        st.sweep_late_claim_orphans(&[durable.to_string()]).await;

        assert!(
            st.sessions.lock().await.get(&placeholder).is_none(),
            "the session registered behind a standing close is swept down"
        );
        drop(env);
    }

    /// The sweep's other half (above): a claim that COMMITTED after the kill
    /// cleared the fence — the live session is a genuine reopen, never the
    /// kill's orphan.
    #[tokio::test]
    async fn the_kill_sweep_spares_a_session_whose_claim_cleared_the_fence() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "cfcfcfcf-cfcf-4cfc-8cfc-cfcfcfcfcfcf";

        st.handle_create(dedup_create_msg("req-sweep-2"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-sweep-2").await;
        assert_eq!(created["type"].as_str().unwrap(), "freshAgent.created");
        let placeholder = created["sessionId"].as_str().unwrap().to_string();
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), placeholder.clone());
        st.sessions
            .lock()
            .await
            .get_mut(&placeholder)
            .expect("session tracked under the placeholder")
            .cli_session_id = Some(durable.to_string());

        // A kill stamped the fence, then a NEWER claim committed against that
        // stamp and cleared it — the live session is the claim's, not an
        // orphan of the close.
        fake.retire_closed("claude", durable)
            .await
            .expect("the close records");
        let snapshot = fake.kill_tombstone_at_ms("claude", durable);
        let committed = st.commit_session_claim(durable, snapshot, &[]).await;
        assert!(committed, "fixture: the newer claim committed");
        assert!(
            fake.kill_tombstone_at_ms("claude", durable).is_none(),
            "fixture: the commit cleared the fence"
        );

        st.sweep_late_claim_orphans(&[durable.to_string()]).await;

        assert!(
            st.sessions.lock().await.get(&placeholder).is_some(),
            "the re-committed claim's session is never the kill's sweep prey"
        );
        drop(env);
    }

    /// Retire-on-kill round 6 (focused-ep5-r5 Finding 3): the sweep's
    /// check-then-act race, pinned with the commit landing INSIDE the
    /// decision window (the accompanying round-5 test cleared the fence
    /// BEFORE invoking the sweep and therefore never exercised this
    /// interleaving). A claim whose COMMIT lands between the sweep's fence
    /// check and its session-map removal is a genuine post-close reopen:
    /// the sweep must NOT tear the session down (and must leave its revived
    /// row Bound alone). Staged deterministically without touching the
    /// sweep's clock: the test holds the sessions map, so the sweep provably
    /// parks AT its removal while the commit lands.
    #[tokio::test]
    async fn the_kill_sweep_never_destroys_a_claim_that_committed_mid_sweep() {
        let (st, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "d1d1d1d1-d1d1-4d18-8d18-d1d1d1d1d1d1";

        // The close: fence stands, row retired. The late claim already
        // registered its session (the shape Finding 1's sweep exists for).
        fake.seed(
            "claude",
            durable,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        fake.retire_closed("claude", durable)
            .await
            .expect("the close records");
        let fence = fake
            .kill_tombstone_at_ms("claude", durable)
            .expect("fixture: the fence stands");
        insert_fake_claude_session(&st, "placeholder-late").await;
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), "placeholder-late".to_string());

        // Hold the sessions map: the sweep passes its fence check (the fence
        // still stands) and parks AT its removal — so the commit below
        // provably lands inside the check→act window (the finding's exact
        // interleaving, no scheduling luck).
        let map_hold = st.sessions.lock().await;
        let st2 = st.clone();
        let ids = vec![durable.to_string()];
        let mut sweep = tokio::spawn(async move { st2.sweep_late_claim_orphans(&ids).await });
        // Drive the sweep to its park (the fence check and the key
        // resolution complete inline with uncontended locks; the removal
        // then waits on this test's map hold).
        for _ in 0..4 {
            tokio::task::yield_now().await;
        }
        assert!(
            !sweep.is_finished(),
            "fixture: the sweep is parked at its removal (the fence pre-filter passed)"
        );

        // The claim COMMITS mid-sweep — the genuine reopen the comment
        // promises to spare: its snapshot IS the kill's stamp, so the
        // conditional commit accepts, clearing the fence and reviving the
        // row.
        let committed = st.commit_session_claim(durable, Some(fence), &[]).await;
        assert!(committed, "fixture: the claim committed mid-sweep");
        assert!(
            fake.kill_tombstone_at_ms("claude", durable).is_none(),
            "fixture: the commit cleared the fence"
        );

        drop(map_hold);
        tokio::time::timeout(std::time::Duration::from_secs(15), &mut sweep)
            .await
            .expect("the sweep completes")
            .expect("sweep task completed");

        assert!(
            st.sessions.lock().await.contains_key("placeholder-late"),
            "the committed reopen is never the sweep's prey"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), durable.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Bound),
            "the committed claim's revived row is never re-retired"
        );
    }

    /// Finding 3's second half: when the sweep DOES destroy a session (the
    /// fence still stands — the late orphan case), it re-retires the row if
    /// the destroyed session's claim revived it. Pinned with the durable
    /// split state directly: fence standing + row reading Bound (the close
    /// whose row-write half failed, or a revive whose claim is being
    /// destroyed here).
    #[tokio::test]
    async fn the_kill_sweep_re_retires_the_row_of_the_session_it_destroys() {
        let (st, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "d2d2d2d2-d2d2-4d28-8d28-d2d2d2d2d2d2";

        fake.seed(
            "claude",
            durable,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        fake.retire_closed("claude", durable)
            .await
            .expect("the close records");
        assert!(
            fake.kill_tombstone_at_ms("claude", durable).is_some(),
            "fixture: the fence stands"
        );
        // The split remnant the sweep must heal: the fence stands but the
        // row reads Bound.
        fake.states.lock().unwrap().insert(
            ("claude".into(), durable.into()),
            crate::identity_sink::FakeRowState::Bound,
        );
        insert_fake_claude_session(&st, "placeholder-orphan").await;
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), "placeholder-orphan".to_string());

        st.sweep_late_claim_orphans(&[durable.to_string()]).await;

        assert!(
            st.sessions.lock().await.get("placeholder-orphan").is_none(),
            "the late orphan is torn down"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), durable.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the revived row is re-retired with the late orphan (never a Bound ghost)"
        );
        assert!(
            fake.kill_tombstone_at_ms("claude", durable).is_some(),
            "the fence still stands (the close was never legitimately claimed)"
        );
    }

    // ── retire-on-kill round 6 (focused-ep5-r5 Finding 2): durable alias tombstones ──

    /// Finding 2's headline: the kill's alias consult reaches the DURABLE
    /// record — the post-restart shape directly: this process's in-memory
    /// store, `cli_index`, and sessions map are ALL empty (a restarted server
    /// is exactly that), yet the placeholder→durable mapping survives in the
    /// persisted alias tombstones, so the close names the bare placeholder
    /// and still fences + retires the durable row.
    #[tokio::test]
    async fn a_kill_naming_a_bare_placeholder_resolves_the_persisted_alias_record_into_the_retire_set(
    ) {
        let (st, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "e1e1e1e1-e1e1-4e18-8e18-e1e1e1e1e1e1";
        fake.seed(
            "claude",
            durable,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        // The durable alias record outlived the restart (the ledger
        // subtree); every process-local map is empty.
        fake.record_alias_tombstone("claude", "placeholder-stale", durable, 1_000)
            .await
            .expect("the persisted record");
        assert!(
            st.cli_index.lock().await.is_empty() && st.sessions.lock().await.is_empty(),
            "fixture: no process-local mapping anywhere (the restart)"
        );

        st.handle_kill(kill_msg("placeholder-stale")).await;

        let retires = fake.retires.lock().unwrap().clone();
        assert!(
            retires.contains(&("claude".to_string(), durable.to_string())),
            "the close resolves the persisted alias: the durable id retires — got {retires:?}"
        );
        assert!(
            fake.kill_tombstone_at_ms("claude", durable).is_some(),
            "the durable close fence landed"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), durable.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the durable row is retired Closed (never offered again)"
        );
    }

    /// Finding 2's commit half at helper level: a claim whose identity
    /// resolves through a placeholder with a standing close fence is REFUSED
    /// with zero side effects (no consumption, no clears, no revive); the
    /// same claim over a CLEAN seat commits (and consumes the durable
    /// store's stale records for the durable, clearing their fences).
    #[tokio::test]
    async fn a_claim_is_refused_when_the_seat_it_rides_carries_a_close_fence_and_commits_over_a_clean_seat(
    ) {
        let (st, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "e2e2e2e2-e2e2-4e28-8e28-e2e2e2e2e2e2";
        fake.seed(
            "claude",
            durable,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );

        // The close fenced only the one-shot seat (the finding's pre-repair
        // miss — nothing resolved the placeholder to the durable at kill
        // time, so the durable identity is untouched).
        st.handle_kill(kill_msg("seat-closed")).await;
        assert!(
            fake.kill_tombstone_at_ms("claude", "seat-closed").is_some(),
            "fixture: the seat's fence stands"
        );
        assert!(
            fake.kill_tombstone_at_ms("claude", durable).is_none(),
            "fixture: the durable identity never saw the close"
        );

        // The claim RIDING the fenced seat refuses, side-effect-free.
        assert!(
            !st.commit_session_claim(durable, None, &["seat-closed".to_string()])
                .await,
            "a fence under the placeholder blocks the commit exactly like one under the durable"
        );
        assert!(
            fake.claim_refusals
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), durable.to_string())),
            "the refusal is positively logged"
        );
        assert!(
            fake.kill_tombstone_at_ms("claude", "seat-closed").is_some(),
            "the seat's fence was never cleared"
        );
        assert!(
            fake.alias_clears.lock().unwrap().is_empty(),
            "a refused claim consumes nothing (the durable store is untouched)"
        );
        assert!(
            fake.tombstone_clears.lock().unwrap().is_empty(),
            "no alias fence clear was even attempted"
        );

        // The CLEAN-seat control commits: an older persisted alias record for
        // the same durable is consumed (durable store + its ledger fence),
        // and the durable commit itself lands.
        fake.record_alias_tombstone("claude", "seat-old", durable, 1_000)
            .await
            .expect("the older persisted record");
        assert!(
            st.commit_session_claim(durable, None, &["seat-clean".to_string()])
                .await,
            "the unfenced seat commits"
        );
        assert!(
            fake.alias_tombstone_records("claude", "seat-old")
                .is_empty(),
            "the older persisted records were consumed"
        );
        assert!(
            fake.alias_clears
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), durable.to_string())),
            "the durable-store consumption ran"
        );
        assert!(
            fake.claim_commits
                .lock()
                .unwrap()
                .contains(&("claude".to_string(), durable.to_string())),
            "the durable commit landed"
        );
    }

    /// Finding 2 through the REAL attach lane: a post-restart attach whose
    /// PANE SEAT carries a close fence (the pane the user closed while the
    /// reconnect's resume slowly redeemed) is refused before registration —
    /// the phantom shape the finding describes — while the durable identity's
    /// own state stays exactly as the close left EVERYTHING.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_attach_whose_seat_carries_a_close_fence_is_refused_and_nothing_registers() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "e3e3e3e3-e3e3-4e38-8e38-e3e3e3e3e3e3";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "claude",
            DURABLE,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        state.set_identity_sink(fake.clone());

        // The close fenced only the one-shot seat (the pre-repair miss).
        state.handle_kill(kill_msg("seat-closed")).await;
        assert!(
            fake.kill_tombstone_at_ms("claude", "seat-closed").is_some(),
            "fixture: the seat's fence stands"
        );
        assert!(
            fake.kill_tombstone_at_ms("claude", DURABLE).is_none(),
            "fixture: no durable fence (the close resolved nothing at kill time)"
        );

        // The reconnect's late attach RIDES the fenced seat to the durable.
        state
            .attach_for_test(attach_msg_with_resume("seat-closed", DURABLE))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let mut saw_resume_failed = false;
        while let Ok(raw) = rx.try_recv() {
            if raw.contains("SESSION_CLOSED") {
                saw_resume_failed = true;
            }
        }
        assert!(
            saw_resume_failed,
            "the phantom attach must fail, never register a session over the closed seat"
        );
        assert!(state.sessions.lock().await.is_empty(), "nothing registers");
        assert!(
            state.cli_index.lock().await.get(DURABLE).is_none(),
            "no registration alias survives"
        );
        assert!(
            fake.claim_commits.lock().unwrap().is_empty(),
            "the closed pane never commits a launch claim"
        );
        assert!(
            fake.kill_tombstone_at_ms("claude", DURABLE).is_none(),
            "the durable identity is untouched — no fence invented, none cleared"
        );
        assert!(
            fake.alias_tombstone_records("claude", "seat-closed")
                .is_empty()
                && fake
                    .alias_record_writes
                    .lock()
                    .unwrap()
                    .iter()
                    .all(|(_, ph, _)| ph != "seat-closed"),
            "a refused claim never persists or consumes an alias record"
        );
        drop(env);
    }

    /// The mint-registration half of Finding 2 through the REAL create-resume
    /// lane: the registration's alias mapping hits the durable store
    /// (placeholder → durable), so a restart can never lose it before any
    /// exit-eviction would demote it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_create_resume_uses_its_durable_id_without_writing_a_self_alias() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());
        let durable = "e4e4e4e4-e4e4-4e48-8e48-e4e4e4e4e4e4";

        let mut msg = dedup_create_msg("req-alias-persist");
        msg.session_ref = Some(freshell_protocol::SessionLocator {
            provider: "claude".to_string(),
            session_id: durable.to_string(),
        });
        st.handle_create(msg, None).await;
        let created = await_claude_created(&mut rx, "req-alias-persist").await;
        let placeholder = created["sessionId"].as_str().unwrap().to_string();

        assert_eq!(placeholder, durable);
        st.handle_send(send_msg(durable, "__emit_assistant__"))
            .await;
        await_frame_of_inner_type(&mut rx, "freshAgent.assistant").await;
        assert!(fake.alias_tombstone_records("claude", durable).is_empty());
        assert!(
            fake.alias_record_writes.lock().unwrap().is_empty(),
            "a create and its confirming init need no alias when both ids are the UUID"
        );
        drop(env);
    }

    /// The attach lane's own mint half (Finding 2) + its claim consumption:
    /// a clean-seat attach of a killed durable commits, persists the NEW
    /// seat's alias record, and consumes the durable's older persisted
    /// records (their ledger fences too — the reopened identity's every
    /// known alias reopens together).
    #[tokio::test(flavor = "multi_thread")]
    async fn an_attach_over_a_clean_seat_commits_persists_its_alias_and_consumes_the_older_records()
    {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "e5e5e5e5-e5e5-4e58-8e58-e5e5e5e5e5e5";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "claude",
            DURABLE,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        state.set_identity_sink(fake.clone());

        // The OLD epoch: the durable was closed, its old placeholder's alias
        // record persisted (a demotion that happened before the restart).
        fake.record_alias_tombstone("claude", "seat-old", DURABLE, 1_000)
            .await
            .expect("the older persisted record");
        state.handle_kill(kill_msg(DURABLE)).await;
        let durable_fence = fake
            .kill_tombstone_at_ms("claude", DURABLE)
            .expect("the durable fence");

        // The NEW pane (a fresh seat) genuinely reopens the session.
        state
            .attach_for_test(attach_msg_with_resume("seat-new", DURABLE))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        assert!(
            state.sessions.lock().await.contains_key(DURABLE),
            "the clean-seat attach registers under the durable id"
        );
        assert!(
            fake.kill_tombstone_at_ms("claude", DURABLE).is_none(),
            "the durable fence is cleared by the commit (snapshot {durable_fence})"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), DURABLE.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Bound),
            "the closed row revived"
        );
        assert!(
            fake.alias_tombstone_records("claude", "seat-new")
                .is_empty(),
            "the canonical runtime needs no new placeholder alias record"
        );
        assert!(
            fake.alias_tombstone_records("claude", "seat-old")
                .is_empty(),
            "the durable's older persisted records were consumed"
        );
        drop(env);
    }

    /// Retire-on-kill round 5 (focused-ep5-r4 Finding 5), the claude
    /// ATTACH-resume lane: the claim commit's `Err` left the durable close
    /// untouched — the lane must fail the resume (no registration, no revive)
    /// instead of running a live session over a Closed row.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_claim_commit_error_stops_the_attach_resume_and_leaves_the_close_standing() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "edededed-eded-4ede-8ede-edededededed";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "claude",
            DURABLE,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        state.set_identity_sink(fake.clone());
        state.handle_kill(kill_msg(DURABLE)).await;
        assert!(
            fake.kill_tombstone_at_ms("claude", DURABLE).is_some(),
            "fixture: the fence is durable"
        );

        // The commit's io failure knob (Finding 5's shape).
        fake.set_fail_writes(true);
        state
            .attach_for_test(attach_msg_with_resume("client-commit-error", DURABLE))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let mut saw_resume_failed = false;
        while let Ok(raw) = rx.try_recv() {
            if raw.contains("CLAUDE_ATTACH_RESUME_FAILED") {
                saw_resume_failed = true;
            }
        }
        assert!(
            saw_resume_failed,
            "a commit error must FAIL the resume, never register a live session over a Closed row"
        );
        assert!(
            state.sessions.lock().await.is_empty(),
            "nothing registers when the commit could not run"
        );
        assert!(
            state.cli_index.lock().await.get(DURABLE).is_none(),
            "no registration alias survives the failed commit"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), DURABLE.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the close stands: the row stays Retired"
        );
        assert!(
            fake.kill_tombstone_at_ms("claude", DURABLE).is_some(),
            "the close stands: the fence was never cleared"
        );
        drop(env);
    }

    /// The CREATE-resume lane twin of Finding 5: the commit error answers the
    /// create failed and registers nothing.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_claim_commit_error_stops_the_resumed_create_and_leaves_the_close_standing() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        let durable = "f5f5f5f5-f5f5-4f55-8f55-f5f5f5f5f5f5";
        fake.seed(
            "claude",
            durable,
            crate::identity_sink::FreshAgentSettings {
                cwd: Some("/w".into()),
                ..crate::identity_sink::FreshAgentSettings::default()
            },
        );
        state.set_identity_sink(fake.clone());
        state.handle_kill(kill_msg(durable)).await;
        assert!(
            fake.kill_tombstone_at_ms("claude", durable).is_some(),
            "fixture: the fence is durable"
        );

        fake.set_fail_writes(true);
        let mut msg = dedup_create_msg("req-commit-error");
        msg.resume_session_id = Some(durable.to_string());
        msg.cwd = Some("/tmp".to_string());
        state.handle_create(msg, None).await;

        let frame = {
            let mut last = None;
            while let Ok(raw) = rx.try_recv() {
                let v: Value = serde_json::from_str(&raw).unwrap();
                if (v["type"] == "freshAgent.created" || v["type"] == "freshAgent.create.failed")
                    && v["requestId"] == "req-commit-error"
                {
                    last = Some(v);
                }
            }
            last.expect("the create answers")
        };
        assert_eq!(
            frame["type"], "freshAgent.create.failed",
            "a commit error must FAIL the create, never a live orphan over a Closed row: {frame}"
        );
        assert!(
            state.sessions.lock().await.is_empty(),
            "nothing registers when the commit could not run"
        );
        assert!(
            state.cli_index.lock().await.get(durable).is_none(),
            "no registration alias survives the failed commit"
        );
        assert_eq!(
            fake.states
                .lock()
                .unwrap()
                .get(&("claude".to_string(), durable.to_string()))
                .copied(),
            Some(crate::identity_sink::FakeRowState::Closed),
            "the close stands: the row stays Retired"
        );
        drop(env);
    }

    // ── freshAgent.approval.respond / question.respond / compact (Task 2) ─────────

    fn approval_respond_msg(
        session_id: &str,
        session_type: SessionType,
        request_id: &str,
        decision: Value,
    ) -> FreshAgentApprovalRespond {
        FreshAgentApprovalRespond {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type,
            decision,
            request_id: freshell_protocol::StringOrNumber::Str(request_id.to_string()),
            cwd: None,
        }
    }

    fn question_respond_msg(
        session_id: &str,
        request_id: &str,
        answers: &[(&str, &str)],
    ) -> FreshAgentQuestionRespond {
        FreshAgentQuestionRespond {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            answers: answers
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            request_id: freshell_protocol::StringOrNumber::Str(request_id.to_string()),
            cwd: None,
        }
    }

    fn compact_msg(session_id: &str, instructions: Option<&str>) -> FreshAgentCompact {
        FreshAgentCompact {
            request_id: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
            instructions: instructions.map(str::to_string),
            observed_epoch: None,
            observed_generation: None,
        }
    }

    /// Read the session's folded pending request ids (permissions, questions).
    async fn pending_request_ids(
        st: &FreshClaudeState,
        session_id: &str,
    ) -> (Vec<String>, Vec<String>) {
        let guard = st.sessions.lock().await;
        let session = guard.get(session_id).expect("session tracked");
        let pending = session.pending.lock().expect("pending lock");
        (
            pending
                .permissions
                .iter()
                .map(|p| p.request_id.clone())
                .collect(),
            pending
                .questions
                .iter()
                .map(|q| q.request_id.clone())
                .collect(),
        )
    }

    /// Bounded-wait until the consumer has folded a pending `requestId` permission for
    /// the session (the respond handlers refuse ids outside the pending set, so the
    /// fold MUST be observed before responding).
    async fn await_pending_permission(st: &FreshClaudeState, session_id: &str, request_id: &str) {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let (permissions, _) = pending_request_ids(st, session_id).await;
            if permissions.iter().any(|id| id == request_id) {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "pending permission {request_id} never folded into the session"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
    }

    /// A sidecar stdin on which EVERY write fails (EPIPE), no matter what other processes
    /// hold: one end of a Unix socket pair, shut down for writing.
    ///
    /// Not the stdin pipe of an exited child: a pipe write fails only while NO process
    /// holds the read end, and this test binary spawns children from many tests at once.
    /// A sibling test's spawn that forks between this pipe's creation and its own `exec`
    /// inherits the read end (O_CLOEXEC closes it only at `exec`), so the "dead" pipe can
    /// still have a reader and silently accept the write. Shutdown is state of the socket
    /// itself, so no inherited copy of either end can make a write succeed.
    #[cfg(unix)]
    fn write_closed_sidecar_stdin() -> ChildStdin {
        let (stdin_end, _peer) = std::os::unix::net::UnixStream::pair().expect("socket pair");
        stdin_end
            .shutdown(std::net::Shutdown::Write)
            .expect("shut down the write side");
        let fd = std::os::fd::OwnedFd::from(stdin_end);
        ChildStdin::from_std(std::process::ChildStdin::from(fd)).expect("register stdin")
    }

    /// Insert a fake session for an already-exited sidecar whose stdin write fails
    /// DETERMINISTICALLY without racing the stdout consumer's eviction path (a real dead
    /// sidecar's consumer would evict the record out from under the assertion; this record
    /// carries a no-op consumer, so nothing evicts it).
    async fn insert_dead_stdin_session(
        st: &FreshClaudeState,
        session_id: &str,
        pending: ClaudePending,
    ) {
        #[cfg(unix)]
        let mut child = tokio::process::Command::new("true")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn true");
        #[cfg(not(unix))]
        let mut child = tokio::process::Command::new("true")
            .stdin(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn true");
        #[cfg(not(unix))]
        let stdin = child.stdin.take().expect("piped stdin");
        child.wait().await.expect("true exits");
        #[cfg(unix)]
        let stdin = write_closed_sidecar_stdin();
        let consumer = tokio::spawn(async {});
        st.sessions.lock().await.insert(
            session_id.to_string(),
            ClaudeSession {
                session_type: "freshclaude".into(),
                quiet: Default::default(),
                configuration: ClaudeConfiguration::default(),
                stdin: stdin.into(),
                child,
                tree_guard: crate::claude_spawn::SidecarTreeGuard::unguarded(),
                ownership_id: format!("test-{session_id}"),
                consumer,
                sidecar_session_id: session_id.to_string(),
                cli_session_id: None,
                owning_operation: None,
                owning_generation: None,
                broadcast_id: Arc::new(std::sync::Mutex::new(session_id.to_string())),
                pending: Arc::new(std::sync::Mutex::new(pending)),
                ledger: crate::claude_turns::SharedLedger::default(),
                clock: crate::attention::AttentionClock::default(),
                turn_lock: Arc::new(TokioMutex::new(())),
                launch_genesis: None,
            },
        );
    }

    /// Task 2 (a): approve/deny resolves the parked permission — the handler writes the
    /// exact `permission.respond` stdin frame (sidecar-keyed sessionId, VERBATIM
    /// decision — a defined updatedInput is forwarded untouched, never synthesized) and
    /// removes the entry from the pending set.
    #[tokio::test]
    async fn approval_respond_writes_the_frame_and_removes_the_pending_entry() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-approval-respond"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-approval-respond").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Raise the pending permission through the fake's canUseTool stand-in; the
        // consumer folds it into the session's pending set.
        st.handle_send(send_msg(&session_id, "__raise_permission__"))
            .await;
        await_pending_permission(&st, &session_id, "req-1").await;

        let decision = json!({ "behavior": "allow", "updatedInput": { "command": "ls -la" } });
        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Freshclaude,
            "req-1",
            decision.clone(),
        ))
        .await;

        let frames = env.respond_log_frames(1).await;
        let respond = frames
            .iter()
            .find(|f| f["type"] == "permission.respond")
            .expect("permission.respond frame written to the sidecar");
        assert_eq!(
            respond["sessionId"],
            json!(session_id),
            "sidecar-keyed sessionId"
        );
        assert_eq!(respond["requestId"], "req-1");
        assert_eq!(
            respond["decision"], decision,
            "the decision payload is a VERBATIM passthrough"
        );
        let (permissions, _) = pending_request_ids(&st, &session_id).await;
        assert!(
            !permissions.iter().any(|id| id == "req-1"),
            "the resolved entry leaves the pending set"
        );
        drop(env);
    }

    /// Task 2 (a2, fresh-eyes F3 regression pin): write-then-remove ordering — when the
    /// sidecar stdin write FAILS, the pending entry MUST stay (the card stays; the user
    /// can retry) and the failure surfaces via the nested freshAgent.error envelope.
    /// Never clear-then-fail.
    #[tokio::test]
    async fn approval_respond_write_failure_keeps_the_pending_entry_and_emits_the_error() {
        let (st, mut rx) = state_with_bus();
        let pending = ClaudePending {
            permissions: vec![PendingApprovalEntry {
                request_id: "req-9".to_string(),
                tool_name: Some("Bash".to_string()),
                tool_use_id: None,
                blocked_path: None,
                decision_reason: None,
                input: None,
                suggestions: None,
            }],
            questions: Vec::new(),
        };
        insert_dead_stdin_session(&st, "dead-stdin-approval", pending).await;

        st.handle_approval_respond(approval_respond_msg(
            "dead-stdin-approval",
            SessionType::Freshclaude,
            "req-9",
            json!({ "behavior": "deny", "message": "no", "interrupt": false }),
        ))
        .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(frame["sessionId"], "dead-stdin-approval");
        let (permissions, _) = pending_request_ids(&st, "dead-stdin-approval").await;
        assert_eq!(
            permissions,
            vec!["req-9".to_string()],
            "a failed write leaves the entry pending (never clear-then-fail)"
        );
    }

    /// D2-M3 (delta-review round 2): the shared protocol requires the decision to be a
    /// RECORD (`Record<string, unknown>`) and the sidecar resolves it VERBATIM — a
    /// null/array/scalar decision forwarded and REMOVED would leave the SDK permission
    /// promise permanently parked (the sidecar treats a null decision as a no-op) while
    /// the card vanishes from the pane. A non-object decision must be refused LOUDLY
    /// (nested `freshAgent.error{INTERNAL_ERROR}`), the pending entry MUST stay (the
    /// card stays actionable), and NOTHING reaches the sidecar stdin.
    #[tokio::test]
    async fn approval_respond_with_a_non_object_decision_is_refused_and_keeps_the_pending_entry() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-approval-null-decision"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-approval-null-decision").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Raise the pending permission through the fake's canUseTool stand-in; the
        // consumer folds it into the session's pending set.
        st.handle_send(send_msg(&session_id, "__raise_permission__"))
            .await;
        await_pending_permission(&st, &session_id, "req-1").await;

        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Freshclaude,
            "req-1",
            json!(null),
        ))
        .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(frame["sessionId"], json!(session_id));
        let (permissions, _) = pending_request_ids(&st, &session_id).await;
        assert_eq!(
            permissions,
            vec!["req-1".to_string()],
            "a refused non-object decision leaves the entry pending (never hide-then-wedge)"
        );
        assert!(
            env.respond_log_frames(0).await.is_empty(),
            "a refused non-object decision is never forwarded to the sidecar"
        );
        drop(env);
    }

    /// Client-alerts G20 (D4): a decision whose `updatedPermissions` is not a list of
    /// well-formed permission updates is refused with `INVALID_APPROVAL_DECISION`
    /// before anything reaches the sidecar, and the request stays pending; a retry
    /// with well-formed updates is written VERBATIM and resolves it.
    #[tokio::test]
    async fn approval_respond_refuses_malformed_updated_permissions_until_a_valid_retry() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-approval-bad-updates"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-approval-bad-updates").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        st.handle_send(send_msg(&session_id, "__raise_permission__"))
            .await;
        await_pending_permission(&st, &session_id, "req-1").await;

        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Freshclaude,
            "req-1",
            json!({ "behavior": "allow", "updatedPermissions": [
                { "type": "grantEverything", "destination": "session" },
            ] }),
        ))
        .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INVALID_APPROVAL_DECISION");
        assert_eq!(frame["sessionId"], json!(session_id));
        let (permissions, _) = pending_request_ids(&st, &session_id).await;
        assert_eq!(
            permissions,
            vec!["req-1".to_string()],
            "a refused decision leaves the request pending"
        );
        assert!(
            env.respond_log_frames(0).await.is_empty(),
            "a refused decision never reaches the sidecar"
        );

        let decision = json!({ "behavior": "allow", "updatedPermissions": [
            { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm test *" }],
              "behavior": "allow", "destination": "localSettings" },
            { "type": "setMode", "mode": "acceptEdits", "destination": "session" },
        ] });
        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Freshclaude,
            "req-1",
            decision.clone(),
        ))
        .await;
        let frames = env.respond_log_frames(1).await;
        let respond = frames
            .iter()
            .find(|f| f["type"] == "permission.respond")
            .expect("the valid retry reaches the sidecar");
        assert_eq!(respond["decision"], decision, "forwarded verbatim");
        let (permissions, _) = pending_request_ids(&st, &session_id).await;
        assert!(
            permissions.is_empty(),
            "the valid retry resolves the request"
        );
        drop(env);
    }

    /// Client-alerts G20 (D4): the refusal of a malformed `updatedPermissions` is
    /// logged and reported by the failing update's position and variant only. A
    /// rule's content (a Bash command, a path) is user content, which claude logs
    /// never carry, and the refused update is never echoed back.
    #[tokio::test]
    async fn a_refused_decision_names_the_update_by_position_and_variant_never_its_content() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        // Another test reaches the same `warn!` (under this lock), and tracing
        // caches a callsite's interest from the first thread that reaches it, so
        // that thread (no capture) can leave it cached as "never". Rebuild the
        // cache once this thread's capture is installed.
        let (events, _capture_guard) = info_capture_for_test::capture();
        tracing::callsite::rebuild_interest_cache();
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-approval-refusal-log"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-approval-refusal-log").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        st.handle_send(send_msg(&session_id, "__raise_permission__"))
            .await;
        await_pending_permission(&st, &session_id, "req-1").await;

        const SECRET: &str = "deploy --token s3cr3t-value";
        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Freshclaude,
            "req-1",
            json!({ "behavior": "allow", "updatedPermissions": [
                { "type": "setMode", "mode": "acceptEdits", "destination": "session" },
                { "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": SECRET }],
                  "behavior": "allow", "destination": "session", "extra": 1 },
            ] }),
        ))
        .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INVALID_APPROVAL_DECISION");
        assert!(
            !frame.to_string().contains("s3cr3t"),
            "the error frame never echoes the refused update: {frame}"
        );
        let events = events.lock().expect("capture lock");
        // The capture records every field through `Debug`, so a string field
        // keeps its quotes.
        let field = |fields: &std::collections::BTreeMap<String, String>, key: &str| {
            fields
                .get(key)
                .map(|value| value.trim_matches('"').to_string())
        };
        let (_, fields) = events
            .iter()
            .find(|(_, fields)| {
                field(fields, "event").as_deref()
                    == Some("freshagent.claude.approval_decision_refused")
            })
            .expect("the refusal is logged");
        assert_eq!(field(fields, "update_index").as_deref(), Some("1"));
        assert_eq!(field(fields, "update_type").as_deref(), Some("addRules"));
        for (key, value) in fields {
            assert!(
                !value.contains("s3cr3t"),
                "the refusal log never carries rule content (`{key}` = {value})"
            );
        }
        drop(env);
    }

    /// Task 2 (b): a requestId outside the pending set is refused LOUDLY with the parity
    /// message on the nested hub-frame — and NOTHING is written to the sidecar (Rust
    /// validates against its pending set first; the sidecar's unknown-id path is
    /// stderr-log-only and must never be reached).
    #[tokio::test]
    async fn approval_respond_unknown_request_id_emits_parity_error_and_writes_nothing() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-approval-unknown"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-approval-unknown").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Freshclaude,
            "req-nope",
            json!({ "behavior": "allow" }),
        ))
        .await;

        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(
            frame["event"]["message"],
            "Claude approval req-nope is not available"
        );
        assert_eq!(frame["sessionType"], "freshclaude");
        assert_eq!(frame["sessionId"], json!(session_id));
        assert!(
            env.respond_log_frames(0).await.is_empty(),
            "a refused respond must never reach the sidecar"
        );
        drop(env);
    }

    /// Task 2 (c): question.respond writes the `question.respond` stdin frame with the
    /// answers object (Map → JSON object) and removes the pending question.
    #[tokio::test]
    async fn question_respond_writes_the_frame_with_the_answers_object() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-question-respond"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-question-respond").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Seed the pending question directly (the consumer fold itself is pinned by
        // consumer_folds_permission_and_question_frames_into_the_pending_set below).
        {
            let guard = st.sessions.lock().await;
            guard
                .get(&session_id)
                .unwrap()
                .pending
                .lock()
                .unwrap()
                .questions
                .push(PendingQuestionEntry {
                    request_id: "q-1".to_string(),
                    questions: json!([{ "question": "Continue?" }]),
                });
        }

        st.handle_question_respond(question_respond_msg(
            &session_id,
            "q-1",
            &[("choice", "yes"), ("note", "ship it")],
        ))
        .await;

        let frames = env.respond_log_frames(1).await;
        let respond = frames
            .iter()
            .find(|f| f["type"] == "question.respond")
            .expect("question.respond frame written to the sidecar");
        assert_eq!(respond["sessionId"], json!(session_id));
        assert_eq!(respond["requestId"], "q-1");
        assert_eq!(
            respond["answers"],
            json!({ "choice": "yes", "note": "ship it" }),
            "answers arrive as a JSON object (Map → object)"
        );
        let (_, questions) = pending_request_ids(&st, &session_id).await;
        assert!(
            questions.is_empty(),
            "the answered question leaves the pending set"
        );
        drop(env);
    }

    /// C16: every send line carries a uuid minted for it: v4, different per send,
    /// with a checkpointed send's attempt correlation beside it (the attempt
    /// binds under that uuid). `freshAgent.send.accepted.submittedTurnId` is that
    /// uuid, and so is the turn id the caller gets back.
    #[tokio::test]
    async fn a_send_line_carries_its_uuid_and_the_acceptance_names_it() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-uuid"), None).await;
        let created = await_claude_created(&mut rx, "req-uuid").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        let mut checkpointed = send_msg(&session_id, "first");
        checkpointed.request_id = Some("send-1".to_string());
        checkpointed.checkpoint_intent = Some(freshell_protocol::FreshAgentCheckpointIntent {
            logical_attempt_id: "attempt-1".to_string(),
            workspace: None,
        });
        let first = st.handle_send(checkpointed).await;
        let mut plain = send_msg(&session_id, "second");
        plain.request_id = Some("send-2".to_string());
        let second = st.handle_send(plain).await;

        let sends: Vec<Value> = env
            .respond_log_frames(2)
            .await
            .into_iter()
            .filter(|frame| frame["type"] == "send")
            .collect();
        assert_eq!(sends.len(), 2, "{sends:?}");
        let uuids: Vec<String> = sends
            .iter()
            .map(|send| {
                send["uuid"]
                    .as_str()
                    .expect("the send carries a uuid")
                    .to_string()
            })
            .collect();
        for uuid in &uuids {
            let parsed = uuid::Uuid::parse_str(uuid).expect("a uuid");
            assert_eq!(parsed.get_version_num(), 4);
        }
        assert_ne!(uuids[0], uuids[1], "each send has its own uuid");
        assert_eq!(
            sends[0]["checkpointAttempt"],
            json!({ "requestId": "send-1", "logicalAttemptId": "attempt-1" })
        );
        assert!(sends[1].get("checkpointAttempt").is_none());

        for (outcome, uuid) in [(first, &uuids[0]), (second, &uuids[1])] {
            assert_eq!(
                outcome,
                ClaudeSendOutcome::Accepted {
                    session_key: session_id.clone(),
                    submitted_turn_id: uuid.clone(),
                    ownership_id: st.sessions.lock().await[&session_id].ownership_id.clone(),
                }
            );
        }
        let mut accepted = Vec::new();
        while accepted.len() < 2 {
            let frame: Value = serde_json::from_str(
                &tokio::time::timeout(Duration::from_secs(15), rx.recv())
                    .await
                    .expect("send.accepted in time")
                    .expect("bus open"),
            )
            .unwrap();
            if frame["type"] == "freshAgent.send.accepted" {
                accepted.push(
                    frame["submittedTurnId"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                );
            }
        }
        assert_eq!(accepted, uuids);
        drop(env);
    }

    /// Task 2 (d): compact forwards to the sidecar as a plain `send` of `/compact`
    /// (empty/absent instructions) or `/compact <instructions trimmed>` — the legacy
    /// adapter's shape (`adapter.ts:168-174`) — with NO send.accepted ack frame.
    #[tokio::test]
    async fn compact_writes_send_frames_with_the_compact_command() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-compact"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-compact").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_compact(compact_msg(&session_id, None)).await;
        st.handle_compact(compact_msg(&session_id, Some("  focus the diff  ")))
            .await;

        let frames = env.respond_log_frames(2).await;
        let sends: Vec<&Value> = frames.iter().filter(|f| f["type"] == "send").collect();
        assert_eq!(sends.len(), 2);
        assert_eq!(sends[0]["sessionId"], json!(session_id));
        assert_eq!(sends[0]["text"], "/compact");
        assert_eq!(
            sends[1]["text"], "/compact focus the diff",
            "instructions are trimmed and appended"
        );

        // No ack: compact must not reuse handle_send's send.accepted broadcast.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        while let Ok(frame) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&frame).unwrap();
            assert_ne!(
                frame["type"], "freshAgent.send.accepted",
                "compact emits no ack frame: {frame}"
            );
        }
        drop(env);
    }

    /// Task 2 (e, AGENT-24): kilroy rides the claude provider path — every error
    /// envelope from these handlers keeps the `kilroy` sessionType flavour (never the
    /// freshclaude default), so the client routes the lost/error frame to the kilroy pane.
    #[tokio::test]
    async fn respond_error_envelopes_keep_the_kilroy_session_type() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let mut create = dedup_create_msg("req-kilroy-respond");
        create.session_type = SessionType::Kilroy;
        st.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "req-kilroy-respond").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Unknown pending id on a LIVE kilroy session → INTERNAL_ERROR, kilroy flavour.
        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Kilroy,
            "req-nope",
            json!({ "behavior": "allow" }),
        ))
        .await;
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["sessionType"], "kilroy");
        assert_eq!(frame["provider"], "claude");
        assert_eq!(frame["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(
            frame["event"]["message"],
            "Claude approval req-nope is not available"
        );

        // Unknown kilroy SESSION → the nested INVALID_SESSION_ID lost-session shape,
        // still kilroy-flavoured (engages markSessionLost on the right pane).
        st.handle_approval_respond(approval_respond_msg(
            "kilroy-gone",
            SessionType::Kilroy,
            "req-1",
            json!({ "behavior": "allow" }),
        ))
        .await;
        let lost = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(lost["sessionType"], "kilroy");
        assert_eq!(lost["event"]["code"], "INVALID_SESSION_ID");
        assert_eq!(lost["sessionId"], "kilroy-gone");
        assert!(env.respond_log_frames(0).await.is_empty());
        drop(env);
    }

    /// Task 7 (AGENT-24 ride-through): a KILROY session's approval respond LANDS —
    /// the happy path is identical to the freshclaude case
    /// (`approval_respond_writes_the_frame_and_removes_the_pending_entry`): the handler
    /// writes the exact `permission.respond` stdin frame (sidecar-keyed sessionId,
    /// VERBATIM decision) and removes the pending entry. Kilroy rides the claude
    /// provider path; this pins that the respond is not freshclaude-only.
    #[tokio::test]
    async fn kilroy_approval_respond_lands_and_removes_the_pending_entry() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let mut create = dedup_create_msg("req-kilroy-approval-lands");
        create.session_type = SessionType::Kilroy;
        st.handle_create(create, None).await;
        let created = await_claude_created(&mut rx, "req-kilroy-approval-lands").await;
        assert_eq!(
            created["sessionType"], "kilroy",
            "the created frame keeps the kilroy flavour"
        );
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Raise the pending permission through the fake's canUseTool stand-in; the
        // consumer folds it into the kilroy session's pending set.
        st.handle_send(send_msg(&session_id, "__raise_permission__"))
            .await;
        await_pending_permission(&st, &session_id, "req-1").await;

        let decision =
            json!({ "behavior": "deny", "message": "Denied by user", "interrupt": false });
        st.handle_approval_respond(approval_respond_msg(
            &session_id,
            SessionType::Kilroy,
            "req-1",
            decision.clone(),
        ))
        .await;

        let frames = env.respond_log_frames(1).await;
        let respond = frames
            .iter()
            .find(|f| f["type"] == "permission.respond")
            .expect("permission.respond frame written to the sidecar");
        assert_eq!(
            respond["sessionId"],
            json!(session_id),
            "sidecar-keyed sessionId"
        );
        assert_eq!(respond["requestId"], "req-1");
        assert_eq!(
            respond["decision"], decision,
            "the decision payload is a VERBATIM passthrough"
        );
        let (permissions, _) = pending_request_ids(&st, &session_id).await;
        assert!(
            !permissions.iter().any(|id| id == "req-1"),
            "the resolved entry leaves the pending set"
        );
        drop(env);
    }

    /// Task 2 (f): the stdout consumer folds the sidecar's pending-state frames into the
    /// per-session pending set BEFORE normalize/broadcast: request frames push (resend of
    /// the same requestId REPLACES), cancelled frames remove.
    #[tokio::test]
    async fn consumer_folds_permission_and_question_frames_into_the_pending_set() {
        let lines = [
            json!({ "type": "sdk.permission.request", "sessionId": "s", "requestId": "req-1",
                    "subtype": "can_use_tool", "tool": { "name": "Bash", "input": { "command": "ls" } },
                    "toolUseID": "toolu_1" }),
            json!({ "type": "sdk.question.request", "sessionId": "s", "requestId": "q-1",
                    "questions": [{ "question": "Continue?" }] }),
            json!({ "type": "sdk.permission.request", "sessionId": "s", "requestId": "req-2",
                    "subtype": "can_use_tool", "tool": { "name": "Read", "input": { "file_path": "/a" } },
                    "toolUseID": "toolu_2" }),
            json!({ "type": "sdk.permission.cancelled", "sessionId": "s", "requestId": "req-1" }),
            json!({ "type": "sdk.question.cancelled", "sessionId": "s", "requestId": "q-1" }),
            // Resend of req-2 REPLACES the entry (de-dupe by requestId).
            json!({ "type": "sdk.permission.request", "sessionId": "s", "requestId": "req-2",
                    "subtype": "can_use_tool", "tool": { "name": "Read", "input": { "file_path": "/b" } },
                    "toolUseID": "toolu_2" }),
        ];
        let dir = tempfile::tempdir().unwrap();
        let lines_path = dir.path().join("fold-lines.jsonl");
        // Terminated final line: `Lines::next_line` holds an unterminated tail in its
        // buffer until EOF (which never comes — the child sleeps with the pipe open).
        let mut script = lines
            .iter()
            .map(|l| l.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        script.push('\n');
        std::fs::write(&lines_path, script).unwrap();
        // Keep the pipe OPEN after the lines (sleep) so the consumer can't hit EOF and
        // evict mid-test; kill_on_drop reaps the child at test end.
        let mut child = tokio::process::Command::new("sh")
            .arg("-c")
            .arg(format!("cat {}; sleep 30", lines_path.display()))
            .stdout(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn scripted stdout child");
        let stdout = child.stdout.take().expect("piped stdout");
        let reader = BufReader::new(stdout).lines();

        let st = state();
        insert_fake_claude_session(&st, "fold-session").await;
        let pending = st.sessions.lock().await["fold-session"].pending.clone();
        let quiet = st.sessions.lock().await["fold-session"].quiet.state.clone();
        let consumer = st.spawn_consumer(
            reader,
            "fold-session".to_string(),
            "test-fold-session".to_string(),
            "freshclaude".to_string(),
            "fold-session".to_string(),
            None,
            Arc::new(std::sync::Mutex::new("fold-session".to_string())),
            Arc::clone(&pending),
            crate::claude_turns::SharedLedger::default(),
            quiet,
            crate::attention::AttentionClock::default(),
            None, // provenance: test lane is conn-less (D8)
            false,
        );

        // The replace-resend is the LAST scripted line: observing its input proves the
        // whole stream has been folded (consumer lines are processed in order).
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            {
                let p = pending.lock().expect("pending lock");
                if p.permissions.len() == 1
                    && p.questions.is_empty()
                    && p.permissions[0].input == Some(json!({ "file_path": "/b" }))
                {
                    break;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the pending fold never converged on the scripted final state"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }
        let p = pending.lock().expect("pending lock");
        assert_eq!(
            p.permissions.len(),
            1,
            "cancelled + replaced ids leave ONE permission entry"
        );
        assert_eq!(p.permissions[0].request_id, "req-2");
        assert_eq!(p.permissions[0].tool_name.as_deref(), Some("Read"));
        assert_eq!(p.permissions[0].tool_use_id.as_deref(), Some("toolu_2"));
        assert_eq!(
            p.permissions[0].input,
            Some(json!({ "file_path": "/b" })),
            "resend REPLACES the prior entry (de-dupe by requestId)"
        );
        assert!(p.questions.is_empty(), "the cancelled question is removed");
        drop(p);
        consumer.abort();
    }

    /// Delta-review round 5 (AGENT-06): the snapshot-bound copy of an
    /// `sdk.question.request` is NORMALIZED at fold time to the strict wire contract
    /// (`shared/fresh-agent-contract.ts` `FreshAgentQuestionDefinitionSchema`): per
    /// question exactly `{question, header?, options?, multiSelect?}`, per option
    /// exactly `{label, description}`. SDK-valid extras (e.g. the documented `preview`
    /// option field, preserved by `permission-channel.mjs`'s `...o`) are dropped — a
    /// preview-carrying question relayed raw would fail the client's strict snapshot
    /// parse and the question card would never render. Malformed members (no coercible
    /// `question`/`label`/`description` text) are dropped rather than poisoning the
    /// whole parse. The WS broadcast of the same frame stays verbatim — see
    /// `question_request_broadcast_keeps_the_verbatim_payload`.
    #[test]
    fn fold_normalizes_question_definitions_to_the_strict_contract_shape() {
        let pending = std::sync::Mutex::new(ClaudePending::default());
        let frame = json!({
            "type": "sdk.question.request",
            "sessionId": "s",
            "requestId": "q-prev",
            "questions": [
                {
                    "question": "Pick one",
                    "header": "Choice",
                    "multiSelect": true,
                    "options": [
                        { "label": "Yes", "description": "go ahead", "preview": "diff…" },
                        { "label": "No", "description": "stop", "preview": 42, "markdown": true }
                    ],
                    "extraTop": "drop-me",
                    "nested": { "also": "dropped" }
                },
                // Malformed members DROP (they can never satisfy the strict parse):
                { "header": "no question text" },
                {
                    "question": "Only well-formed options survive",
                    "options": [
                        { "label": "Fine", "description": "kept" },
                        { "label": "missing description" },
                        "not-an-object"
                    ]
                }
            ]
        });
        fold_pending_frame(&pending, &frame);

        let p = pending.lock().expect("pending lock");
        assert_eq!(p.questions.len(), 1);
        assert_eq!(
            p.questions[0].questions,
            json!([
                {
                    "question": "Pick one",
                    "header": "Choice",
                    "multiSelect": true,
                    "options": [
                        { "label": "Yes", "description": "go ahead" },
                        { "label": "No", "description": "stop" }
                    ]
                },
                {
                    "question": "Only well-formed options survive",
                    "options": [{ "label": "Fine", "description": "kept" }]
                }
            ]),
            "extras dropped at BOTH nesting levels — the pending copy parses against the strict contract"
        );
        drop(p);

        // A non-array `questions` never reaches the snapshot as a parse-breaking
        // scalar/null — the entry stays (respond-membership) with an empty array.
        fold_pending_frame(
            &pending,
            &json!({
                "type": "sdk.question.request",
                "sessionId": "s",
                "requestId": "q-scalar",
                "questions": "not-an-array"
            }),
        );
        fold_pending_frame(
            &pending,
            &json!({
                "type": "sdk.question.request",
                "sessionId": "s",
                "requestId": "q-missing"
            }),
        );
        let p = pending.lock().expect("pending lock");
        let scalar = p
            .questions
            .iter()
            .find(|q| q.request_id == "q-scalar")
            .unwrap();
        assert_eq!(scalar.questions, json!([]));
        let missing = p
            .questions
            .iter()
            .find(|q| q.request_id == "q-missing")
            .unwrap();
        assert_eq!(missing.questions, json!([]));
    }

    // ── cliSessionId recording (restart-parity plan §2.8 item 2) ──────────────────

    /// The stdout consumer must record `sdk.session.init`'s durable `cliSessionId` in
    /// [`FreshClaudeState::cli_index`] (durable id → sessions-map key), and an explicit
    /// kill must evict the index entry along with the session.
    #[tokio::test]
    async fn session_init_records_cli_session_id_in_the_index() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-cli-idx-1"), None)
            .await;
        let created_frame = await_claude_created(&mut rx, "req-cli-idx-1").await;
        let created = created_frame["sessionId"].as_str().unwrap().to_string();

        st.handle_send(send_msg(&created, "__emit_assistant__"))
            .await;
        // The fake emits sdk.session.init with the durable uuid; poll until the
        // consumer has recorded it (bounded).
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            {
                let idx = st.cli_index.lock().await;
                if idx.get(created.as_str()) == Some(&created) {
                    break;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "cli_index never recorded the durable id"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        // The session carries the best-effort copy of the durable id.
        assert_eq!(
            st.sessions
                .lock()
                .await
                .get(&created)
                .unwrap()
                .cli_session_id
                .as_deref(),
            Some(created.as_str())
        );
        // Kill evicts the index entry.
        st.handle_kill(FreshAgentKill {
            observed_epoch: None,
            observed_generation: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: created.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;
        assert!(st.cli_index.lock().await.is_empty());
        drop(env);
    }

    /// P1.13 (Task 9): the `sdk.session.init` arm must record ONE fresh-agent binding
    /// row through the identity sink — keyed by the DURABLE cliSessionId, carrying the
    /// FULL create-settings snapshot and the sessionType flavour — AWAITED before the
    /// init-driven broadcast proceeds (durable-before-answer, V8/A11).
    #[tokio::test(flavor = "multi_thread")]
    async fn fresh_claude_plugins_reach_the_sidecar_and_kilroy_keeps_its_legacy_flavor() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let mut claude = dedup_create_msg("req-provider-plugin-claude");
        claude.plugins = Some(vec!["/workspace/.claude/plugins/local".into()]);
        state.handle_create(claude, None).await;
        await_claude_created(&mut rx, "req-provider-plugin-claude").await;

        let mut kilroy = dedup_create_msg("req-provider-plugin-kilroy");
        kilroy.session_type = SessionType::Kilroy;
        state.handle_create(kilroy, None).await;
        let created = await_claude_created(&mut rx, "req-provider-plugin-kilroy").await;
        assert_eq!(created["sessionType"], "kilroy");

        let creates: Vec<Value> = std::fs::read_to_string(env.spawn_log_path())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(creates.len(), 2);
        assert_eq!(
            creates[0]["plugins"],
            json!(["/workspace/.claude/plugins/local"])
        );
        assert_eq!(creates[1]["plugins"], Value::Null);
        assert_eq!(creates[1]["boot"], json!({ "kind": "fresh" }));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn session_init_records_binding_with_create_settings() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        // Drive freshAgent.create with sessionType kilroy + explicit settings.
        let mut msg = dedup_create_msg("req-binding-init");
        msg.session_type = SessionType::Kilroy;
        msg.model = Some("opus-x".to_string());
        msg.permission_mode = Some("plan".to_string());
        msg.effort = Some("high".to_string());
        msg.cwd = Some(env.dir.to_string_lossy().to_string());
        state.handle_create(msg, None).await;
        // The frame broadcasts unconditionally after `adopt_session_init`
        // returns (including its `Deferred` arm, claude.rs:8046-8062), so
        // the frame orders nothing about the row; the row BARRIER below is
        // what proves the row landed.
        let created = await_claude_created(&mut rx, "req-binding-init").await;
        let b =
            await_claude_session_init_binding_row(&fake, created["sessionId"].as_str().unwrap())
                .await;
        assert_eq!(b.provider, "claude");
        assert_eq!(b.mode, "kilroy", "sessionType flavour preserved in the row");
        assert_eq!(
            b.session_id,
            created["sessionId"].as_str().unwrap(),
            "keyed by the create-time UUID"
        );
        assert_eq!(b.settings.model.as_deref(), Some("opus-x"));
        assert_eq!(b.settings.permission_mode.as_deref(), Some("plan"));
        assert_eq!(b.settings.effort.as_deref(), Some("high"));
        assert!(b.settings.cwd.is_some());
    }

    /// G15: the create's plugins are part of the settings the session records
    /// at `sdk.session.init`, so every later launch of the session can restore
    /// them. An empty plugin list is no plugins: it records nothing, so a
    /// create that names none keeps the lineage-only row shape.
    #[tokio::test(flavor = "multi_thread")]
    async fn session_init_records_the_create_plugins_and_an_empty_list_as_none() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        let mut msg = dedup_create_msg("req-binding-plugins");
        msg.plugins = Some(vec!["/workspace/.claude/plugins/local".to_string()]);
        state.handle_create(msg, None).await;
        let created = await_claude_created(&mut rx, "req-binding-plugins").await;
        let row =
            await_claude_session_init_binding_row(&fake, created["sessionId"].as_str().unwrap())
                .await;
        assert_eq!(
            row.settings.plugins,
            Some(vec!["/workspace/.claude/plugins/local".to_string()])
        );

        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());
        let mut msg = dedup_create_msg("req-binding-no-plugins");
        msg.plugins = Some(Vec::new());
        state.handle_create(msg, None).await;
        let created = await_claude_created(&mut rx, "req-binding-no-plugins").await;
        let row =
            await_claude_session_init_binding_row(&fake, created["sessionId"].as_str().unwrap())
                .await;
        assert_eq!(
            row.settings,
            crate::identity_sink::FreshAgentSettings::default(),
            "an empty plugin list records nothing"
        );
        drop(env);
    }

    /// b8ke ext r27 F4 reshape (was
    /// `session_init_with_all_blank_settings_records_no_binding`): an
    /// all-blank settings snapshot now records a LINEAGE-ONLY row — the
    /// binding write is UNCONDITIONAL inside the coordinator operation
    /// (pre-r27 default-settings sessions skipped the binding entirely,
    /// leaving no authoritative recovery registration). The Task 3
    /// keying (the fake mirrors the production sink) keeps the
    /// legitimately-default session from ever arming a false
    /// SETTINGS_RESET on a later resume: the row exists, records blank
    /// settings verbatim, and answers neither `was_recorded` nor
    /// `load_settings`.
    #[tokio::test(flavor = "multi_thread")]
    async fn session_init_with_all_blank_settings_records_the_lineage_row() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        // dedup_create_msg carries no model/permissionMode/effort/cwd — the
        // all-blank snapshot shape.
        state
            .handle_create(dedup_create_msg("req-binding-blank"), None)
            .await;
        // The frame broadcasts unconditionally after `adopt_session_init`
        // returns (including its `Deferred` arm, claude.rs:8046-8062), so
        // the frame orders nothing about the row; the row BARRIER below is
        // what proves the row landed.
        let created = await_claude_created(&mut rx, "req-binding-blank").await;
        let fresh_create_durable_id = created["sessionId"].as_str().unwrap();
        let b =
            await_claude_session_init_binding_row(&fake, created["sessionId"].as_str().unwrap())
                .await;

        // THE r27 F4 CONTRACT: the lineage row IS recorded (blank settings
        // verbatim) — the no-skip truth.
        assert_eq!(
            b.settings,
            crate::identity_sink::FreshAgentSettings::default(),
            "blank settings recorded verbatim"
        );
        // ...but a lineage-only row is NOT a settings-bearing record: the
        // Task 3 keying keeps a later resume from arming a FALSE
        // SETTINGS_RESET for this legitimately-default session.
        assert!(
            fake.load_settings("claude", fresh_create_durable_id)
                .is_none(),
            "lineage-only row answers no settings snapshot"
        );
        assert!(
            !fake.was_recorded("claude", fresh_create_durable_id),
            "lineage-only row must not count as recorded (false SETTINGS_RESET)"
        );
        drop(env);
    }

    /// b8ke ext r27 F4: the session-init adoption's durable binding write
    /// runs BEFORE the commit-Live (after the alias publication, which a
    /// concurrent kill's tombstone fold resolves through) — while the
    /// write is parked (the sink's binding stall), the coordinator
    /// operation still COVERS the session: the key holds the adoption's
    /// `Starting` claim, so a competing handoff BEGIN is refused typed
    /// (Blocked). Pre-r27 the commit had already released the operation at
    /// this point — the key read Live and a handoff could begin while the
    /// binding was blocked.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_session_init_binding_write_precedes_the_commit_and_holds_the_operation() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(Arc::clone(&registry));
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        let mut msg = dedup_create_msg("req-r27-f4-order");
        msg.model = Some("opus-x".to_string());
        st.handle_create(msg, None).await;
        let created = await_claude_created(&mut rx, "req-r27-f4-order").await;
        let map_key = created["sessionId"].as_str().unwrap().to_string();
        prepare_legacy_init(&st, &map_key).await;
        let fresh_create_durable_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        let stall = fake.arm_binding_stall("claude", fresh_create_durable_id);
        let st2 = st.clone();
        let identity = st.identity_sink();
        let create_task = tokio::spawn(async move {
            st2.adopt_session_init(
                fresh_create_durable_id,
                &map_key,
                "freshclaude",
                None,
                identity,
                None,
            )
            .await;
        });
        stall
            .entered
            .recv_timeout(std::time::Duration::from_secs(15))
            .expect("the adoption reached its binding write");

        // THE r27 F4 CONTRACT: the write is parked BEFORE the commit — the
        // coordinator operation still covers the session. Pre-r27 the key
        // read Live here (the commit preceded the write) and a handoff
        // could BEGIN while the binding was blocked.
        assert!(
            matches!(
                registry.observe("claude", fresh_create_durable_id).state,
                freshell_ownership::OwnershipState::Starting { .. }
            ),
            "the binding write runs INSIDE the coordinator operation (the \
             pre-commit Starting claim) — got {:?}",
            registry.observe("claude", fresh_create_durable_id).state
        );
        assert!(
            matches!(
                registry.begin_handoff(
                    "claude",
                    fresh_create_durable_id,
                    freshell_ownership::RuntimeOwnerKind::Terminal,
                    "competing-mid-write",
                    None,
                    "test",
                    crate::session_lease::now_epoch_ms(),
                ),
                freshell_ownership::BeginOutcome::Blocked { .. }
            ),
            "a competing handoff cannot begin while the binding write is \
             still inside the coordinator operation"
        );
        // Restore the key for the release (the probe handoff never entered).
        let _ = registry.fail(
            "claude",
            fresh_create_durable_id,
            "competing-mid-write",
            u64::MAX,
            false,
        );

        // Release: the publish + commit complete, the create answers green.
        let _ = stall.release.send(());
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        while !matches!(
            registry.observe("claude", fresh_create_durable_id).state,
            freshell_ownership::OwnershipState::Live { .. }
        ) {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the adoption never committed after the release"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        let _ = create_task.await;
        drop(env);
    }

    /// b8ke ext r27 F4: a session-init adoption whose binding write FAILS
    /// tears the freshly adopted runtime down and lands the TYPED
    /// recoverable state — BEFORE the commit-Live (no owner broadcast, no
    /// Live; the ticket's RAII drop settles the claim typed). Pre-r27 the
    /// commit had already made the owner authoritative (and broadcast it)
    /// before the failed write tore the runtime down underneath it.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_failed_session_init_binding_write_abandons_before_the_commit() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (mut st, mut rx) = state_with_bus();
        let registry = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
        st.set_ownership(Arc::clone(&registry));
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(fake.clone());

        // The ledger refuses every write (disk-full/permission shape).
        let mut msg = dedup_create_msg("req-r27-f4-fail");
        msg.model = Some("opus-x".to_string());
        st.handle_create(msg, None).await;
        let created = await_claude_created(&mut rx, "req-r27-f4-fail").await;
        let fresh_create_durable_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        assert_eq!(created["type"], "freshAgent.created", "{created}");

        prepare_legacy_init(&st, created["sessionId"].as_str().unwrap()).await;
        while rx.try_recv().is_ok() {}
        fake.set_fail_writes(true);
        st.adopt_session_init(
            fresh_create_durable_id,
            created["sessionId"].as_str().unwrap(),
            "freshclaude",
            None,
            st.identity_sink(),
            None,
        )
        .await;

        // The adoption runs on the sidecar's init event: the binding write
        // fails → the runtime is torn down and the adoption ABANDONS
        // BEFORE the publish/commit. Bounded-poll for the settled state.
        let created_session_id = created["sessionId"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let settled = matches!(
                registry.observe("claude", fresh_create_durable_id).state,
                freshell_ownership::OwnershipState::Vacant
            );
            let session_gone = !st.has_live_session(&created_session_id).await;
            if settled && session_gone {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the failed binding write never settled (state {:?})",
                registry.observe("claude", fresh_create_durable_id).state
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        // NO owner broadcast was ever made (the commit never ran).
        let mut saw_owner = false;
        while let Ok(raw) = rx.try_recv() {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "session.runtimeOwner"
                && frame["sessionId"] == json!(fresh_create_durable_id)
            {
                saw_owner = true;
            }
        }
        assert!(
            !saw_owner,
            "the failed binding write never broadcast a committed owner"
        );
        drop(env);
    }

    /// D8 lane-reach (restore-open-sessions-only, review round 3): the
    /// WS-dispatched connection provenance threaded into `handle_create` must
    /// reach the identity-sink write at `sdk.session.init`. The ledger schema
    /// fields are all optional, so without this pin the freshclaude/kilroy
    /// lane could keep writing `None` silently — and the recovery judgment
    /// that consumes the stamps would then drop genuinely-open sessions.
    #[tokio::test(flavor = "multi_thread")]
    async fn session_init_binding_carries_the_creates_connection_provenance() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        // cwd set so the settings snapshot is recordable (the V7/A10
        // no-laundering gate); the provenance rides the same create.
        let mut msg = dedup_create_msg("req-binding-prov");
        msg.cwd = Some(env.dir.to_string_lossy().to_string());
        let provenance = crate::BindProvenance::for_create(
            Some("client-claude"),
            Some("device-claude"),
            Some("tab-claude"),
            7_777,
        );
        state.handle_create(msg, Some(provenance)).await;
        // The frame broadcasts unconditionally after `adopt_session_init`
        // returns (including its `Deferred` arm, claude.rs:8046-8062), so
        // the frame orders nothing about the row; the row BARRIER below is
        // what proves the row landed.
        let created = await_claude_created(&mut rx, "req-binding-prov").await;
        let b =
            await_claude_session_init_binding_row(&fake, created["sessionId"].as_str().unwrap())
                .await;
        assert_eq!(
            b.asserted_stamps().client_instance_id.as_deref(),
            Some("client-claude")
        );
        assert_eq!(
            b.asserted_stamps().device_id.as_deref(),
            Some("device-claude")
        );
        assert_eq!(
            b.asserted_stamps().tab_key.as_deref(),
            Some("device-claude:tab-claude")
        );
        drop(env);
    }

    // ── resume settings-from-ledger (P1.13, Task 10) ─────────────────────────────

    /// P1.13 (Task 10): resume-in-place must reapply the pane's recorded
    /// model/permissionMode/effort from the ledger record instead of sending Nulls —
    /// the known defect where a restarted freshclaude/kilroy pane silently reverted
    /// its settings. The fake sidecar logs the WHOLE create-request JSON per spawn,
    /// so the wire itself is the assertion surface.
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_for_attach_reapplies_settings_from_ledger() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, _rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        fake.seed(
            "claude",
            DURABLE,
            crate::identity_sink::FreshAgentSettings {
                model: Some("opus-x".into()),
                sandbox: None,
                permission_mode: Some("plan".into()),
                effort: Some("high".into()),
                cwd: None,
                plugins: None,
            },
        );
        state.set_identity_sink(fake);

        // Drive the donor resume flow (attach to DURABLE with a transcript on disk).
        state
            .attach_for_test(attach_msg_with_resume("client-nanoid-settings", DURABLE))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        let create_req: serde_json::Value =
            serde_json::from_str(log.lines().next().expect("one spawn-logged create request"))
                .unwrap();
        assert_eq!(create_req["model"], "opus-x");
        assert_eq!(create_req["permissionMode"], "plan");
        assert_eq!(create_req["effort"], "high");
        drop(env);
    }

    /// G14: a sidecar spawned to resume a session on attach logs under the
    /// attached session (its stderr log is bound to the envelope id the
    /// client addresses), joined to the sidecar's ownership id.
    #[tokio::test]
    async fn an_attach_resumed_sidecar_logs_under_the_attached_session() {
        use crate::claude_sidecar_io::test_capture::{capture, with_message};
        let (events, _log_guard) = capture();
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "d1d1d1d1-dddd-4ddd-8ddd-d1d1d1d1d1d1";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, _rx) = state_with_bus();
        let mut msg = attach_msg_with_resume("client-nanoid-logs", DURABLE);
        msg.session_type = SessionType::Kilroy;
        state.attach_for_test(msg).await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let ownership_id = state
            .sessions
            .lock()
            .await
            .get(DURABLE)
            .map(|session| session.ownership_id.clone())
            .expect("the attach resumed the canonical session");
        let bound = with_message(&events, "freshagent.claude.sidecar_bound");
        assert_eq!(bound.len(), 1, "{bound:?}");
        assert_eq!(bound[0].field("session_id"), Some(DURABLE));
        assert_eq!(bound[0].field("session_type"), Some("kilroy"));
        assert_eq!(bound[0].field("ownership_id"), Some(ownership_id.as_str()));
        drop(env);
    }

    /// A restarted server has the transcript and settings record, but its
    /// ownership coordinator has no live entry yet. Attach must claim that
    /// vacant key and resume the sidecar before it can publish a live owner.
    #[tokio::test(flavor = "multi_thread")]
    async fn cold_attach_with_fresh_coordinator_resumes_transcript_and_settings() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "abababab-aaaa-4aaa-8aaa-abababababab";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (mut state, mut rx) = state_with_bus();
        let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::with_epoch(2));
        state.set_ownership(Arc::clone(&ownership));
        let settings = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        settings.seed(
            "claude",
            DURABLE,
            crate::identity_sink::FreshAgentSettings {
                model: Some("opus-x".into()),
                permission_mode: Some("plan".into()),
                ..Default::default()
            },
        );
        state.set_identity_sink(settings);

        state
            .attach_for_test(attach_msg_with_resume("client-after-restart", DURABLE))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        assert_eq!(
            env.spawn_count(),
            1,
            "cold attach must spawn one resumed sidecar"
        );
        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        let create_req: serde_json::Value =
            serde_json::from_str(log.lines().next().unwrap()).unwrap();
        assert_eq!(
            create_req["boot"],
            json!({ "kind": "resume", "resume": DURABLE })
        );
        assert_eq!(create_req["model"], "opus-x");
        assert_eq!(create_req["permissionMode"], "plan");
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], DURABLE);
        assert!(matches!(
            ownership.observe("claude", DURABLE).state,
            freshell_ownership::OwnershipState::Live { .. }
        ));
        drop(env);
    }

    /// Unified agent names (zero-turn recovery): a fresh pane's pre-restart
    /// create TOUCHES its transcript (the file exists with zero records).
    /// After a restart, attach's resume lane finds that empty transcript —
    /// its cwd lookup answers nothing — and the path-based resume fallback
    /// must NOT fire: the create line's resume boot names a SESSION
    /// ID (the real sidecar forwards it verbatim to the SDK's `resume`
    /// option), and a transcript PATH there makes the recovered session
    /// write its conversation under a path-flattened phantom file (observed
    /// `<slug>/<abs-path>.jsonl.jsonl` in the discovery index — a duplicate
    /// session row that steals the generation name). An empty transcript
    /// resumes by id; the sidecar continues the same `<id>.jsonl`.
    #[tokio::test(flavor = "multi_thread")]
    async fn an_empty_zero_turn_transcript_resumes_by_id_not_by_path() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "abababab-abab-4bab-8bab-abababababab";
        // TOUCH ONLY — the zero-turn pre-restart transcript: present, empty.
        let dir = home.path().join("projects").join("-t");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{DURABLE}.jsonl")), "").unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, _rx) = state_with_bus();
        state.set_identity_sink(std::sync::Arc::new(
            crate::identity_sink::FakeIdentitySink::default(),
        ));

        state
            .attach_for_test(attach_msg_with_resume(
                "client-nanoid-empty-resume",
                DURABLE,
            ))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        let create_req: serde_json::Value =
            serde_json::from_str(log.lines().next().expect("one spawn-logged create request"))
                .unwrap();
        assert_eq!(
            create_req["boot"]["resume"]
                .as_str()
                .expect("the resume on the wire"),
            DURABLE,
            "an empty zero-turn transcript must resume by session id, never by transcript path"
        );
        drop(env);
    }

    /// V7/A10: record misses are ROUTINE — `resume_for_attach` exists precisely to
    /// serve never-tracked transcripts (every claude-CLI-created and pre-ship session
    /// in the shared `~/.claude/projects` store). They resume silently with nulls
    /// exactly as today (the preserved fallback).
    /// b8ke ext r27 F4 reshape: the session-init adoption's binding write is
    /// UNCONDITIONAL now, so a never-recorded resume records a LINEAGE-ONLY
    /// row under the new cliSessionId (blank settings verbatim) — the
    /// Task 3 keying (was_recorded/load_settings) is what actually guards the
    /// no-laundering contract: the row answers NEITHER, so a later resume
    /// stays silent and never false-alarms SETTINGS_RESET. The pre-r27
    /// "record NOTHING" wording was the pre-keying guard.
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_without_record_is_silent_and_sends_nulls() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, mut rx) = state_with_bus();
        // Deliberately empty: no record, no snapshot.
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        state
            .attach_for_test(attach_msg_with_resume("client-nanoid-norec", DURABLE))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        // Today's behavior preserved as the silent fallback: nulls on the wire.
        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        let create_req: serde_json::Value =
            serde_json::from_str(log.lines().next().expect("one spawn-logged create request"))
                .unwrap();
        assert_eq!(create_req["model"], Value::Null);
        assert_eq!(create_req["permissionMode"], Value::Null);
        assert_eq!(create_req["effort"], Value::Null);

        // Bounded bus drain (pattern from Task 5): NO SETTINGS_RESET frame may appear.
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(1), rx.recv()).await
        {
            let Ok(text) = frame else { break };
            assert!(
                !text.contains("SETTINGS_RESET"),
                "never-recorded resume must stay silent"
            );
        }
        // r27 F4: the lineage-only row IS recorded (blank settings verbatim)
        // — and it launders NOTHING: the Task 3 keying keeps the row from
        // counting as a settings-bearing record (no false SETTINGS_RESET on
        // any later resume) and `load_settings` answers None.
        {
            let bindings = fake.bindings.lock().unwrap();
            let row = bindings
                .iter()
                .rev()
                .find(|b| b.provider == "claude" && b.session_id == DURABLE)
                .expect("the never-recorded resume's lineage-only row (r27 F4)");
            assert_eq!(
                row.settings,
                crate::identity_sink::FreshAgentSettings::default(),
                "blank settings recorded verbatim — no invented values"
            );
        }
        assert!(
            !fake.was_recorded("claude", DURABLE),
            "a lineage-only row must not count as recorded (no laundered \
             settings-bearing record)"
        );
        assert!(
            fake.load_settings("claude", DURABLE).is_none(),
            "a lineage-only row answers no settings snapshot"
        );
        drop(env);
    }

    /// The genuine anomaly (V7/A10): the ledger PROVES prior fresh-agent recording,
    /// yet no snapshot is recoverable — the only resume case that alarms.
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_with_prior_record_but_unrecoverable_settings_alarms() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        const DURABLE: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        write_fake_transcript(home.path(), DURABLE);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());

        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // was_recorded=true, load_settings=None — the SETTINGS_RESET-positive fixture.
        fake.seed_recorded_only("claude", DURABLE);
        state.set_identity_sink(fake);

        state
            .attach_for_test(attach_msg_with_resume("client-nanoid-alarm", DURABLE))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let mut found = false;
        while let Ok(frame) =
            tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv()).await
        {
            let Ok(text) = frame else { break };
            let frame: Value = serde_json::from_str(&text).unwrap();
            if frame["event"]["code"] == "SETTINGS_RESET" {
                // Top-level sessionType/provider (locator resolution) + a
                // user-facing message (the banner shows the message, never the code).
                assert_eq!(frame["event"]["type"], "freshAgent.error");
                assert_eq!(frame["sessionType"], "freshclaude");
                assert_eq!(frame["provider"], "claude");
                assert!(frame["event"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("Reconfirm your settings"));
                found = true;
                break;
            }
        }
        assert!(
            found,
            "recorded-but-unrecoverable resume must broadcast SETTINGS_RESET"
        );
        drop(env);
    }

    /// Ledger A9: consumer exit (== sidecar death) must evict the dead session AND its
    /// `cli_index` entries — kill/shutdown are NOT the only eviction paths. Without this,
    /// a dead-but-tracked session makes the tracked⇒no-op attach row strand panes forever.
    #[tokio::test]
    async fn consumer_exit_evicts_dead_session_and_index() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-evict-1"), None)
            .await;
        let created_frame = await_claude_created(&mut rx, "req-evict-1").await;
        let created = created_frame["sessionId"].as_str().unwrap().to_string();
        // Kill the sidecar through the public API (fake exits on text "__exit__"),
        // then poll (bounded) until the consumer-exit eviction clears BOTH maps.
        st.handle_send(send_msg(&created, "__exit__")).await;
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if st.sessions.lock().await.is_empty() && st.cli_index.lock().await.is_empty() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "consumer exit must evict the dead session and its cli_index entries"
            );
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        drop(env);
    }

    // ── freshAgent.interrupt (parity gap fix -- see terminal.rs's dispatch arm) ────

    /// An unknown interrupt is a visible session error, including for an
    /// older client that supplies no request id.
    #[tokio::test]
    async fn handle_interrupt_errors_for_unknown_session() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_interrupt(FreshAgentInterrupt {
            request_id: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: "does-not-exist".to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        let frame: Value = serde_json::from_str(&rx.try_recv().unwrap()).unwrap();
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID", "{frame}");
    }

    /// A known session's interrupt is forwarded to the sidecar (the Rust-side half of
    /// the parity fix -- mirrors `adapters/claude/adapter.ts:163-168`'s
    /// `sdkBridge.interrupt(sessionId)` -> `sp.query.interrupt()`), observed via the
    /// fake sidecar's interrupt log since a successful interrupt broadcasts NOTHING
    /// (fire-and-forget, matching legacy exactly -- there is no confirmation frame to
    /// assert on instead).
    #[tokio::test]
    async fn handle_interrupt_forwards_the_request_to_the_sidecar_for_a_known_session() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-interrupt"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-claude-interrupt").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        // C18: a Stop reaches the sidecar only while something runs. The fake
        // answers no plain send, so the turn stays owed until the Stop.
        st.handle_send(send_msg(&session_id, "a turn to stop"))
            .await;
        await_ledger_busy(&st, &session_id, true).await;

        st.handle_interrupt(FreshAgentInterrupt {
            request_id: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;

        // Bounded poll for the fake sidecar's interrupt log (it's an OS-level pipe
        // write, not synchronous with `handle_interrupt`'s `write_line` await).
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            if env.interrupt_log_contents().contains(&session_id) {
                break;
            }
            if std::time::Instant::now() >= deadline {
                panic!(
                    "sidecar never logged the interrupt for {session_id}: {:?}",
                    env.interrupt_log_contents()
                );
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        // The stopped turn's own (aborted) result settles it, silently: no
        // `error` frame, no banner and no edge for the user's own Stop.
        await_ledger_busy(&st, &session_id, false).await;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(300);
        while let Ok(Ok(raw)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.send.accepted" {
                continue;
            }
            assert_eq!(
                frame["type"], "freshAgent.event",
                "a successful interrupt must not broadcast: {frame}"
            );
            assert_ne!(
                frame["event"]["type"], "freshAgent.error",
                "a successful interrupt must not broadcast an error: {frame}"
            );
            assert_ne!(
                frame["event"]["type"], "freshAgent.turn.complete",
                "the user's own Stop never rings: {frame}"
            );
        }
        // The interrupt carried the latched Stop's id.
        let stops = env.interrupt_log_contents();
        assert_eq!(stops.lines().count(), 1, "{stops:?}");
    }

    /// C18 (design §5.4): an idle session has nothing to stop, so nothing is
    /// sent to the sidecar, and the next turn still rings.
    #[tokio::test]
    async fn handle_interrupt_of_an_idle_session_sends_nothing() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (log_events, _log_guard) = crate::claude_sidecar_io::test_capture::capture();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-idle-stop"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-claude-idle-stop").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_interrupt(FreshAgentInterrupt {
            request_id: None,
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.clone(),
            session_type: SessionType::Freshclaude,
            cwd: None,
        })
        .await;
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(
            env.interrupt_log_contents(),
            "",
            "an idle Stop must not reach the sidecar"
        );
        let stops = crate::claude_sidecar_io::test_capture::with_message(
            &log_events,
            "freshagent.claude.stop",
        );
        assert_eq!(stops.len(), 1, "{stops:?}");
        assert_eq!(stops[0].field("outcome"), Some("idle"));

        // The next turn rings (no stray latch silences it).
        while rx.try_recv().is_ok() {}
        st.handle_send(send_msg(&session_id, "a turn")).await;
        await_ledger_busy(&st, &session_id, true).await;
        inject_raw_send(&st, &session_id, "__emit_result__").await;
        let edge = await_frame_of_inner_type(&mut rx, "freshAgent.turn.complete").await;
        assert!(edge["event"]["at"].as_i64().is_some(), "{edge}");
    }

    /// Adapter-asymmetry fix (bug-hunt pbh-20260807): an UNREQUESTED sidecar death
    /// (crash/OOM/kill -9, never `freshAgent.kill`) must broadcast a pane-unwedging
    /// `freshAgent.error` after the consumer-exit eviction. The codex sibling broadcasts
    /// its crash self-heal `exited` status (`codex.rs spawn_exit_watcher`) and opencode's
    /// turn task emits an unconditional `idle` (`opencode_ws.rs run_turn`); claude was the
    /// only provider whose death edge was TOTAL SILENCE, leaving the pane stuck
    /// busy/"working" forever (the reference bridge broadcasts an explicit idle for
    /// exactly this reason -- `server/sdk-bridge.ts:344-353`). The client folds this frame
    /// into a visible banner AND drops the stuck running/streaming state
    /// (`fresh-agent-ws.ts:333-342`, `freshAgentSlice.sessionError`).
    #[tokio::test]
    async fn unrequested_sidecar_death_broadcasts_a_pane_unwedging_error() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let st = FreshClaudeState::new(Arc::new(tx));

        st.handle_create(dedup_create_msg("req-claude-death-unwedge"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-claude-death-unwedge").await;
        assert_eq!(created["type"], "freshAgent.created", "sanity: {created}");
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Simulate the crash: SIGKILL the sidecar child directly (NOT handle_kill, which
        // removes the map entry first and must stay silent).
        {
            let mut guard = st.sessions.lock().await;
            let session = guard.get_mut(&session_id).expect("live session in map");
            let _ = session.child.start_kill();
        }

        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            let raw = tokio::time::timeout(remaining, rx.recv())
                .await
                .expect(
                    "no SIDECAR_EXITED freshAgent.error was broadcast after an unrequested \
                     sidecar death -- the pane stays wedged busy forever",
                )
                .expect("broadcast bus closed");
            let frame: Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] == "freshAgent.event"
                && frame["event"]["type"] == "freshAgent.error"
                && frame["event"]["code"] == "SIDECAR_EXITED"
            {
                // Stamped with the session's broadcast id so the frozen client routes it
                // to the right pane (fresh-agent-ws.ts:190-201).
                assert_eq!(frame["sessionId"], json!(session_id), "{frame}");
                assert_eq!(frame["event"]["sessionId"], json!(session_id), "{frame}");
                assert_eq!(frame["provider"], "claude", "{frame}");
                assert_eq!(frame["sessionType"], "freshclaude", "{frame}");
                assert!(
                    !frame["event"]["message"].as_str().unwrap_or("").is_empty(),
                    "user-facing message required: {frame}"
                );
                break;
            }
        }
        // The pre-existing consumer-exit eviction (ledger A9) still happened.
        assert!(
            !st.sessions.lock().await.contains_key(&session_id),
            "dead session must still be evicted from the sessions map"
        );
    }

    /// C09: crash the session's sidecar (an unrequested death, not `handle_kill`)
    /// and wait for its exit report. Returns the session's map key.
    async fn crash_a_new_session(
        st: &FreshClaudeState,
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        request_id: &str,
    ) -> String {
        st.handle_create(dedup_create_msg(request_id), None).await;
        let created = await_claude_created(rx, request_id).await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();
        st.sessions
            .lock()
            .await
            .get_mut(&session_id)
            .expect("live session in map")
            .child
            .start_kill()
            .expect("kill the sidecar");
        tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let frame: Value = match rx.recv().await {
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(err) => panic!("broadcast recv failed: {err}"),
                    Ok(raw) => serde_json::from_str(&raw).unwrap(),
                };
                if frame["event"]["code"] == "SIDECAR_EXITED" {
                    return;
                }
            }
        })
        .await
        .expect("the death is reported");
        session_id
    }

    /// C09: once an ended session is resumed (here by an attach, the reload and
    /// reconnect path) it is live again, so none of its ids may still read as
    /// ended — not even the old pane id the resumed session no longer uses.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_resumed_dead_session_no_longer_reads_as_ended() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let old_pane_id = crash_a_new_session(&st, &mut rx, "req-dead-resume").await;
        let durable = old_pane_id.as_str();
        for id in [old_pane_id.as_str(), durable] {
            assert_eq!(
                st.live_snapshot_overlay(id).await["status"],
                "exited",
                "{id} reads as ended after the crash"
            );
        }

        let home = tempfile::tempdir().unwrap();
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        st.attach_for_test(attach_msg_with_resume("pane-after-reload", durable))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert!(st.has_live_session(durable).await, "the attach resumed it");

        assert_ne!(st.live_snapshot_overlay(durable).await["status"], "exited");
        assert_ne!(
            st.live_snapshot_overlay(&old_pane_id).await["status"],
            "exited"
        );
        assert!(
            st.dead_sessions.find(&old_pane_id).is_none(),
            "resuming forgets the old death under every id"
        );
    }

    /// Design §3.1 and §5.5 (C18): a session's attention clock survives its
    /// death and the resume that follows, so an edge the resumed session rings
    /// lands strictly above the death's edge even within one millisecond.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_resumed_session_keeps_the_attention_clock_of_its_death() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-clock-carry"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-clock-carry").await;
        let pane_id = created["sessionId"].as_str().unwrap().to_string();
        let durable = pane_id.as_str();
        // A turn in flight (the fake answers no plain send), so the death rings.
        st.handle_send(send_msg(&pane_id, "a turn the death cuts off"))
            .await;
        await_ledger_busy(&st, &pane_id, true).await;
        st.sessions
            .lock()
            .await
            .get_mut(&pane_id)
            .expect("live session in map")
            .child
            .start_kill()
            .expect("kill the sidecar");
        let death = await_frame_of_inner_type(&mut rx, "freshAgent.turn.complete").await;
        let death_at = death["event"]["at"].as_i64().expect("a numeric at");

        let home = tempfile::tempdir().unwrap();
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        st.attach_for_test(attach_msg_with_resume("pane-after-reload", durable))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert!(st.has_live_session(durable).await, "the attach resumed it");

        let key = st.resolve_session_key(durable).await.expect("live key");
        let floor = st
            .sessions
            .lock()
            .await
            .get(&key)
            .map(|session| session.clock.floor());
        assert_eq!(
            floor,
            Some(Some(death_at)),
            "the resumed session continues the dead one's clock"
        );
    }

    /// Review PRB-C09: an attach that resumes the session under its own pane id
    /// while the dead sidecar is still being reaped (the reload and reconnect
    /// path) makes that id live again, so the dead incarnation's exit report —
    /// the `exited` status and the SIDECAR_EXITED banner, which also resets the
    /// pane to idle — must not reach it. The turn the death cut short still
    /// rings, once: it ended, and nobody saw it end.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_resume_during_the_reap_gets_no_exit_report_but_the_lost_turn_rings() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        // The fake sidecar's session reports this durable id.
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-reap-resume"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-reap-resume").await;
        let pane_id = created["sessionId"].as_str().unwrap().to_string();
        let durable = pane_id.as_str();
        // The fake never answers a plain send: the turn stays in flight.
        st.handle_send(send_msg(&pane_id, "a turn the sidecar dies in"))
            .await;
        assert!(ledger_busy_of(&st, &pane_id).await);

        let hold = st.hold_exit_reports();
        st.sessions
            .lock()
            .await
            .get_mut(&pane_id)
            .expect("live session in map")
            .child
            .start_kill()
            .expect("kill the sidecar");
        tokio::time::timeout(Duration::from_secs(15), hold.parked())
            .await
            .expect("the end-of-output path reached the exit report");

        let home = tempfile::tempdir().unwrap();
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        st.attach_for_test(attach_msg_with_resume(&pane_id, durable))
            .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        assert!(st.has_live_session(durable).await, "the attach resumed it");
        while rx.try_recv().is_ok() {}

        hold.release();
        let mut frames = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while let Ok(Ok(raw)) = tokio::time::timeout_at(deadline, rx.recv()).await {
            frames.push(serde_json::from_str::<Value>(&raw).unwrap());
        }
        let about_the_pane: Vec<&Value> = frames
            .iter()
            .filter(|frame| frame["sessionId"] == pane_id.as_str())
            .collect();
        assert!(
            about_the_pane
                .iter()
                .all(|frame| frame["event"]["status"] != "exited"
                    && frame["event"]["code"] != "SIDECAR_EXITED"),
            "no exit report reaches the resumed session: {about_the_pane:?}"
        );
        assert_eq!(
            about_the_pane
                .iter()
                .filter(|frame| frame["event"]["type"] == "freshAgent.turn.complete")
                .count(),
            1,
            "the lost turn rings once: {about_the_pane:?}"
        );
        assert_ne!(st.live_snapshot_overlay(&pane_id).await["status"], "exited");
    }

    /// Closing an ended session forgets its process state. With neither a
    /// transcript nor a retained genesis, a later send is visibly lost and must
    /// never recreate it as a new conversation.
    #[tokio::test(flavor = "multi_thread")]
    async fn closing_a_dead_session_forgets_it() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let _env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        let pane_id = crash_a_new_session(&st, &mut rx, "req-dead-close").await;
        assert_eq!(st.live_snapshot_overlay(&pane_id).await["status"], "exited");

        st.handle_kill(kill_msg(&pane_id)).await;
        assert_eq!(st.live_snapshot_overlay(&pane_id).await, json!({}));

        while rx.try_recv().is_ok() {}
        let mut send = send_msg(&pane_id, "after the close");
        send.request_id = Some("send-after-close".into());
        st.handle_send(send).await;
        let mut frames = Vec::new();
        while let Ok(raw) = rx.try_recv() {
            frames.push(serde_json::from_str::<Value>(&raw).unwrap());
        }
        assert!(
            frames
                .iter()
                .any(|frame| frame["event"]["code"] == "INVALID_SESSION_ID"),
            "a cleanly missing closed conversation is lost: {frames:?}"
        );
        assert!(
            frames.iter().any(|frame| frame["type"] == "error"
                && frame["requestId"] == "send-after-close"
                && frame["message"]
                    .as_str()
                    .is_some_and(|m| m.contains("could not be found"))),
            "the unsent prompt is returned with the missing conversation: {frames:?}"
        );
    }

    // ── kata 1wxv Task 4: claude/kilroy undo/redo (fork-at-point emulation) ──

    use crate::identity_sink::PaneIdentitySink as _;
    use crate::rollback_record::{
        RollbackDirection, RollbackEntry, RollbackModeReq, RollbackRecord, RollbackRequest,
        LEDGER_WRITE_REFUSAL_COPY, REDO_EMPTY_MESSAGE, REDO_REMOVED_HISTORY_COPY,
        ROLLBACK_BUSY_MESSAGE,
    };

    /// The FrameSink that records every delivered requesting-sink frame (codex.rs's
    /// `capturing_sink` idiom — `conn_sink` in terminal.rs).
    fn capturing_sink() -> (
        freshell_terminal::FrameSink,
        Arc<std::sync::Mutex<Vec<ServerMessage>>>,
    ) {
        let captured = Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink: freshell_terminal::FrameSink = {
            let captured = captured.clone();
            Arc::new(move |msg| captured.lock().expect("captured mutex").push(msg))
        };
        (sink, captured)
    }

    fn captured_json(captured: &Arc<std::sync::Mutex<Vec<ServerMessage>>>) -> Vec<Value> {
        captured
            .lock()
            .expect("captured mutex")
            .iter()
            .map(|m| serde_json::to_value(m).expect("frame serializes"))
            .collect()
    }

    fn rollback_op(
        session_id: &str,
        request_id: &str,
        direction: RollbackDirection,
    ) -> RollbackRequest {
        RollbackRequest {
            direction,
            mode: RollbackModeReq::Step,
            turn_id: None,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            provider: freshell_protocol::AgentProvider::Claude,
            request_id: request_id.to_string(),
            cwd: None,
            observed_epoch: None,
            observed_generation: None,
        }
    }

    /// u1/a1/u2/a2 chain (uuid + parentUuid linked): the rollback fixture corpus.
    fn two_turn_transcript() -> String {
        [
            json!({"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"text","text":"answer one"}]}}),
            json!({"type":"user","uuid":"u2","parentUuid":"a1","timestamp":"t3","message":{"role":"user","content":[{"type":"text","text":"prompt two"}]}}),
            json!({"type":"assistant","uuid":"a2","parentUuid":"u2","timestamp":"t4","message":{"role":"assistant","content":[{"type":"text","text":"answer two"}]}}),
        ]
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n")
    }

    /// Write the durable transcript under `<home>/projects/-t/<durable>.jsonl`
    /// (the layout `find_transcript` scans) — the rollback handler's disk truth.
    /// Every parsed line gains `cwd: "/tmp"` (ledger A15: the CLI's resume lookup
    /// is scoped to the transcript's ORIGINAL cwd, so the durable-id resume form
    /// only survives when the recorded cwd exists on disk — `/tmp` always does).
    fn write_rollback_transcript(home: &std::path::Path, durable: &str, text: &str) {
        let dir = home.join("projects").join("-t");
        std::fs::create_dir_all(&dir).unwrap();
        let mut out: Vec<String> = Vec::new();
        for line in text.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(line) {
                Ok(mut v) => {
                    if v.get("cwd").is_none() {
                        v["cwd"] = json!("/tmp");
                    }
                    out.push(v.to_string());
                }
                Err(_) => out.push(line.to_string()),
            }
        }
        std::fs::write(dir.join(format!("{durable}.jsonl")), out.join("\n")).unwrap();
    }

    /// A rollback-fixture live session: a `tee <stdin_log>` child stands in for the
    /// sidecar — every byte the handler writes to its stdin lands in stdin_log (the
    /// "no sidecar churn" oracle for the refusal legs) — registered with
    /// `cli_session_id` = durable and the cli_index alias, exactly like a
    /// fully-initialized live session.
    async fn insert_rollback_fixture_session(
        st: &FreshClaudeState,
        map_key: &str,
        durable: &str,
    ) -> PathBuf {
        let stdin_log = std::env::temp_dir().join(format!(
            "freshell-claude-rollback-stdin-{}",
            uuid::Uuid::new_v4()
        ));
        // A live child standing in for the sidecar: every raw stdin line lands
        // verbatim in stdin_log, and an `interrupt` request is answered with
        // the sidecar's settled receipt. A live consumer folds its output.
        const FIXTURE_CHILD_SCRIPT: &str = r#"
const fs = require('node:fs')
const readline = require('node:readline')
const stdinLog = process.argv[1]
const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on('line', (line) => {
  fs.appendFileSync(stdinLog, `${line}\n`)
  try {
    const msg = JSON.parse(line)
    if (msg && msg.type === 'interrupt') {
      process.stdout.write(JSON.stringify({
        type: 'sdk.interrupt_settled',
        sessionId: msg.sessionId,
        ok: true,
      }) + '\n')
    }
  } catch {}
})
"#;
        let mut child = tokio::process::Command::new("node")
            .arg("-e")
            .arg(FIXTURE_CHILD_SCRIPT)
            .arg(&stdin_log)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn fixture probe child");
        let stdin = child.stdin.take().expect("piped stdin");
        let stdout = child.stdout.take().expect("piped stdout");
        let reader = BufReader::new(stdout).lines();
        let ledger = crate::claude_turns::SharedLedger::default();
        let pending = Arc::new(std::sync::Mutex::new(ClaudePending::default()));
        let clock = crate::attention::AttentionClock::default();
        let turn_lock = Arc::new(TokioMutex::new(()));
        let quiet = deadman::QuietWatch::default();
        let broadcast_id = Arc::new(std::sync::Mutex::new(map_key.to_string()));
        let consumer = st.spawn_consumer(
            reader,
            map_key.to_string(),
            format!("test-{map_key}"),
            "freshclaude".to_string(),
            map_key.to_string(),
            None,
            Arc::clone(&broadcast_id),
            Arc::clone(&pending),
            Arc::clone(&ledger),
            quiet.state.clone(),
            clock.clone(),
            None, // provenance: test lane is conn-less (D8)
            false,
        );
        st.sessions.lock().await.insert(
            map_key.to_string(),
            ClaudeSession {
                session_type: "freshclaude".into(),
                quiet,
                configuration: ClaudeConfiguration::default(),
                stdin: stdin.into(),
                child,
                tree_guard: crate::claude_spawn::SidecarTreeGuard::unguarded(),
                ownership_id: format!("test-{map_key}"),
                consumer,
                sidecar_session_id: map_key.to_string(),
                cli_session_id: Some(durable.to_string()),
                owning_operation: None,
                owning_generation: None,
                broadcast_id,
                pending,
                ledger,
                clock,
                turn_lock,
                launch_genesis: None,
            },
        );
        st.cli_index
            .lock()
            .await
            .insert(durable.to_string(), map_key.to_string());
        stdin_log
    }

    /// Poll until the session `map_key` names (C13: the rollback's
    /// replacement, which the map key resolves to once it took the original's
    /// place) has a `cli_session_id` other than `prior` (the replacement's
    /// durable id), or the budget dies.
    async fn await_adopted_durable(st: &FreshClaudeState, map_key: &str, prior: &str) -> String {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let key = st.resolve_session_key(map_key).await;
            let current = match key {
                Some(key) => st
                    .sessions
                    .lock()
                    .await
                    .get(&key)
                    .and_then(|s| s.cli_session_id.clone()),
                None => None,
            };
            if let Some(current) = current {
                if current != prior {
                    return current;
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the session's cli_session_id never moved off {prior}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    async fn ledger_busy_of(st: &FreshClaudeState, map_key: &str) -> bool {
        st.sessions
            .lock()
            .await
            .get(map_key)
            .map(|s| s.ledger.lock().expect("turn ledger lock").busy())
            .unwrap_or(false)
    }

    async fn await_ledger_busy(st: &FreshClaudeState, map_key: &str, want: bool) {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            if ledger_busy_of(st, map_key).await == want {
                return;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the turn ledger never became {}",
                if want { "busy" } else { "idle" }
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// Focused ep1-r1 F1 test rig: write a `send` frame to the session's
    /// sidecar stdin DIRECTLY (bypassing `handle_send`) — the fake sidecar's
    /// magic texts then emit their canned sdk.* frame IN-STREAM with NO
    /// freshCode-side set edge, emulating the provider's asynchronous
    /// turn-terminal frames (the busy flag was set when the turn was
    /// SUBMITTED, not when its result arrives).
    async fn inject_raw_send(st: &FreshClaudeState, map_key: &str, text: &str) {
        let mut guard = st.sessions.lock().await;
        let session = guard.get_mut(map_key).expect("tracked session");
        let frame =
            json!({ "type": "send", "sessionId": session.sidecar_session_id, "text": text });
        session.stdin.write(&frame).await.expect("raw stdin write");
    }

    /// Mark a fixture session mid-turn: a send the CLI started, armed in the
    /// session's turn ledger the way `handle_send` and the stdout consumer
    /// would have left it.
    async fn prime_fixture_running_turn(st: &FreshClaudeState, map_key: &str) {
        let guard = st.sessions.lock().await;
        let mut ledger = guard
            .get(map_key)
            .expect("tracked session")
            .ledger
            .lock()
            .expect("turn ledger lock");
        ledger.arm(
            "fixture-turn".to_string(),
            None,
            crate::claude_turns::SendKind::Turn,
        );
        ledger.fold(&crate::claude_turns::TurnFact::Command {
            uuid: "fixture-turn".to_string(),
            state: crate::claude_turns::CommandState::Started,
        });
    }

    #[tokio::test]
    async fn handle_rollback_mid_turn_is_busy_and_never_touches_the_sidecar() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, _rx) = state_with_bus();
        let stdin_log = insert_rollback_fixture_session(&st, "rb-busy", "dur-busy").await;
        prime_fixture_running_turn(&st, "rb-busy").await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-busy", "rb-busy-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(
            frames.len(),
            1,
            "exactly one requesting-sink frame: {frames:?}"
        );
        let frame = &frames[0];
        assert_eq!(frame["type"], "freshAgent.event");
        assert_eq!(frame["event"]["type"], "freshAgent.error");
        assert_eq!(frame["event"]["code"], "BUSY_TURN");
        assert_eq!(frame["event"]["message"], ROLLBACK_BUSY_MESSAGE);
        assert_eq!(frame["event"]["rollback"], json!(true));
        assert_eq!(frame["event"]["requestId"], "rb-busy-1");
        // THE SAFETY GATE: a refused attempt emits NO sidecar traffic — no stdin
        // bytes, no sidecar spawn/kill, the session record never torn down.
        assert_eq!(
            std::fs::read_to_string(&stdin_log).unwrap_or_default(),
            "",
            "no line was written to the session's stdin"
        );
        assert_eq!(
            env.spawn_count(),
            0,
            "no sidecar was spawned/killed for a refused attempt"
        );
        assert!(
            st.sessions.lock().await.contains_key("rb-busy"),
            "the session was never torn down"
        );
        drop(env);
    }

    #[tokio::test]
    async fn rollback_during_a_compact_turn_is_refused_busy_turn_with_zero_teardown_traffic() {
        // handle_compact arms the turn ledger UNDER the session turn lock BEFORE
        // writing the /compact send to the sidecar (C17) — the check-then-set
        // window against handle_rollback's busy gate is closed. The compact ends
        // at its own `sdk.result` (any subtype): WHILE it runs, a rollback refuses
        // BUSY_TURN with zero teardown/spawn traffic; AFTER it, the gate reopens.
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (st, mut rx) = state_with_bus();
        st.handle_create(dedup_create_msg("req-compact-rb"), None)
            .await;
        let created = await_claude_created(&mut rx, "req-compact-rb").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        st.handle_compact(compact_msg(&session_id, None)).await;
        assert!(
            ledger_busy_of(&st, &session_id).await,
            "a compact arms the ledger BEFORE the sidecar write"
        );

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-compact-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "BUSY_TURN");
        assert_eq!(frames[0]["event"]["message"], ROLLBACK_BUSY_MESSAGE);
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(
            env.spawn_count(),
            1,
            "only the original create spawned — the refused rollback produced zero teardown/spawn traffic"
        );
        assert!(
            st.sessions.lock().await.contains_key(&session_id),
            "no teardown"
        );

        // The compact turn ends at its result frame (any subtype — here an
        // ERRORED one), and the busy gate reopens (a follow-up rollback leaves
        // the window for its true verdict — NOTHING_TO_UNDO on this
        // transcript-less session). The fake reports no command lifecycle, so
        // the result settles the oldest command (the compact) by the head
        // fallback. inject_raw_send: the compact's own result, not a second
        // command.
        inject_raw_send(&st, &session_id, "__emit_result_error__").await;
        await_ledger_busy(&st, &session_id, false).await;
        let (sink2, captured2) = capturing_sink();
        st.handle_rollback(
            rollback_op(&session_id, "rb-compact-2", RollbackDirection::Undo),
            sink2,
        )
        .await;
        let frames2 = captured_json(&captured2);
        assert_eq!(
            frames2[0]["event"]["code"], "NOTHING_TO_UNDO",
            "the busy gate reopened once the compact turn's sdk.result landed: {frames2:?}"
        );
        drop(env);
    }

    #[tokio::test]
    async fn handle_rollback_redo_without_a_record_is_redo_unavailable() {
        let (st, _rx) = state_with_bus();
        let stdin_log = insert_rollback_fixture_session(&st, "rb-redo-none", "dur-redo-none").await;
        // No identity sink at all => no record can exist.
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-redo-none", "rb-r-1", RollbackDirection::Redo),
            sink,
        )
        .await;
        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "REDO_UNAVAILABLE");
        assert_eq!(frames[0]["event"]["message"], REDO_EMPTY_MESSAGE);
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(frames[0]["event"]["requestId"], "rb-r-1");
        assert_eq!(std::fs::read_to_string(&stdin_log).unwrap_or_default(), "");
        assert!(st.sessions.lock().await.contains_key("rb-redo-none"));
    }

    #[tokio::test]
    async fn handle_rollback_record_write_failure_refuses_before_any_sidecar_churn() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), "dur-nowrite", &two_turn_transcript());
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        sink_impl.set_fail_writes(true);
        st.set_identity_sink(sink_impl.clone());
        let stdin_log = insert_rollback_fixture_session(&st, "rb-nowrite", "dur-nowrite").await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-nowrite", "rb-nw-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(frames[0]["event"]["message"], LEDGER_WRITE_REFUSAL_COPY);
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(frames[0]["event"]["requestId"], "rb-nw-1");
        // Durable-BEFORE-mutation: a pre-write failure REFUSES — the provider history
        // is NEVER mutated: no stdin bytes, no sidecar spawn/kill, session intact.
        assert_eq!(std::fs::read_to_string(&stdin_log).unwrap_or_default(), "");
        assert_eq!(env.spawn_count(), 0);
        assert!(st.sessions.lock().await.contains_key("rb-nowrite"));
        assert!(
            sink_impl.rollbacks.lock().unwrap().is_empty(),
            "no durable row landed"
        );
        drop(env);
    }

    #[tokio::test]
    async fn handle_rollback_redo_with_a_moved_original_tip_is_redo_unavailable() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        // The original MOVED since the undo: a third turn (u3 chaining off a2) now tips it.
        let moved = format!(
            "{}\n{}",
            two_turn_transcript(),
            json!({"type":"user","uuid":"u3","parentUuid":"a2","timestamp":"t5","message":{"role":"user","content":[{"type":"text","text":"prompt three"}]}})
        );
        write_rollback_transcript(home.path(), "orig-moved", &moved);
        // The current (post-undo) transcript is the prefix only.
        write_rollback_transcript(
            home.path(),
            "dur-moved-tip",
            &two_turn_transcript()
                .lines()
                .take(2)
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        sink_impl
            .record_rollback("claude", "dur-moved-tip", {
                let mut r = RollbackRecord::empty(100);
                r.original_session_id = Some("orig-moved".to_string());
                r.original_tip_uuid = Some("a2".to_string()); // the tip observed at undo time
                r.set_can_redo(true, 100);
                r
            })
            .await
            .expect("seed write");
        st.set_identity_sink(sink_impl.clone());
        let stdin_log = insert_rollback_fixture_session(&st, "rb-moved", "dur-moved-tip").await;
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-moved-tip", "rb-mt-1", RollbackDirection::Redo),
            sink,
        )
        .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "REDO_UNAVAILABLE");
        assert_eq!(frames[0]["event"]["message"], REDO_REMOVED_HISTORY_COPY);
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(std::fs::read_to_string(&stdin_log).unwrap_or_default(), "");
        assert_eq!(
            env.spawn_count(),
            0,
            "nothing is forked over a moved original"
        );
        drop(env);
    }

    #[tokio::test]
    async fn emit_pending_cancellations_maps_every_parked_entry() {
        let (st, mut rx) = state_with_bus();
        insert_fake_claude_session_with_pending(
            &st,
            "rb-pending",
            Some("dur-pending"),
            &[
                json!({"type":"sdk.permission.request","sessionId":"rb-pending","requestId":"req-1","tool":{"name":"Bash","input":{"command":"ls"}},"toolUseID":"toolu_1"}),
                json!({"type":"sdk.question.request","sessionId":"rb-pending","requestId":"q-1","questions":[{"question":"Continue?"}]}),
            ],
        )
        .await;
        st.emit_pending_cancellations("rb-pending", "dur-pending", "freshclaude")
            .await;
        let perm = await_frame_of_inner_type(&mut rx, "freshAgent.permission.cancelled").await;
        assert_eq!(perm["event"]["requestId"], json!("req-1"), "{perm}");
        let question = await_frame_of_inner_type(&mut rx, "freshAgent.question.cancelled").await;
        assert_eq!(question["event"]["requestId"], json!("q-1"), "{question}");
        let (permissions, questions) = pending_request_ids(&st, "rb-pending").await;
        assert!(
            permissions.is_empty() && questions.is_empty(),
            "decision 6: cancelled means cancelled — pending cards are never silently resolved"
        );
    }

    /// The r3 epoch rule end-to-end on the claude lane (undo→send→undo↔redo): the
    /// new undo re-roots the chain state to the CURRENT durable id while markers
    /// accumulate as the UNION of both epochs.
    #[tokio::test]
    async fn handle_rollback_after_a_resend_re_roots_the_chain_and_redo_restores_the_new_epoch() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        // Original O: retained on disk, chain tip a2 — the OLD epoch's fork-chain root.
        write_rollback_transcript(home.path(), "orig-epoch", &two_turn_transcript());
        // S' (the CURRENT live session): a fork of O (u1/a1 prefix) whose user
        // RESENT an edited prompt — its own u-prime/a-prime turn.
        let s_prime_transcript = [
            json!({"type":"user","uuid":"u1","parentUuid":null,"timestamp":"t1","message":{"role":"user","content":[{"type":"text","text":"prompt one"}]}}),
            json!({"type":"assistant","uuid":"a1","parentUuid":"u1","timestamp":"t2","message":{"role":"assistant","content":[{"type":"text","text":"answer one"}]}}),
            json!({"type":"user","uuid":"uq","parentUuid":"a1","timestamp":"t5","message":{"role":"user","content":[{"type":"text","text":"prompt two edited"}]}}),
            json!({"type":"assistant","uuid":"aq","parentUuid":"uq","timestamp":"t6","message":{"role":"assistant","content":[{"type":"text","text":"answer two edited"}]}}),
        ]
        .iter()
        .map(|v| v.to_string())
        .collect::<Vec<_>>()
        .join("\n");
        write_rollback_transcript(home.path(), "s-prime", &s_prime_transcript);
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        // The old-epoch record keyed by S': the resend already destroyed redo
        // (redo_destroyed) while the u2/a2 marker entry survives (decision 6 union).
        sink_impl
            .record_rollback("claude", "s-prime", {
                let mut r = RollbackRecord::empty(100);
                r.original_session_id = Some("orig-epoch".to_string());
                r.original_tip_uuid = Some("a2".to_string());
                r.push_entry(
                    RollbackEntry {
                        removed_turns: vec![
                            json!({"id":"u2","turnId":"u2","role":"user","summary":"prompt two","items":[]}),
                            json!({"id":"a2","turnId":"a2","role":"assistant","summary":"answer two","items":[]}),
                        ],
                        prompt_text: "prompt two".to_string(),
                        at_ms: 100,
                        epoch: 0,
                    },
                    100,
                );
                r.set_can_redo(true, 100);
                r.destroy_redo(110); // the resend destroyed the old epoch's redo (markers survive)
                r
            })
            .await
            .expect("seed write");
        st.set_identity_sink(sink_impl.clone());
        insert_rollback_fixture_session(&st, "epoch-live", "s-prime").await;

        // Undo the edited turn: lands while redo_destroyed == true ⇒ a NEW epoch.
        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("s-prime", "rb-epoch-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let adopted = await_adopted_durable(&st, "epoch-live", "s-prime").await;

        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["type"], "freshAgent.rolledBack");
        assert_eq!(
            frames[0]["event"]["removedPromptText"],
            json!("prompt two edited")
        );
        assert_eq!(frames[0]["event"]["canRedo"], json!(true));
        assert_eq!(frames[0]["event"]["newSessionId"], json!(adopted));

        // The fork-at-point create landed with the computed options: resume the
        // CURRENT durable id (S'), keep through a1 (uq's raw parent), guard = the
        // first-to-discard prompt uuid uq.
        let creates: Vec<Value> = std::fs::read_to_string(env.spawn_log_path())
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("spawn log line is JSON"))
            .collect();
        assert_eq!(
            creates.len(),
            1,
            "exactly the rollback's fork create: {creates:?}"
        );
        assert_eq!(creates[0]["boot"]["resume"], json!("s-prime"));
        assert_eq!(creates[0]["boot"]["resumeSessionAt"], json!("a1"));
        assert_eq!(creates[0]["boot"]["kind"], json!("fork"));
        assert_eq!(
            creates[0]["boot"]["dropsTurn"],
            json!("uq"),
            "the guard is the first-to-discard turn's prompt uuid (brief/SDK semantics)"
        );

        // Re-rooted chain state on the record (re-keyed old→new by adoption):
        let record = sink_impl
            .load_rollback("claude", &adopted)
            .expect("record re-keyed to the adopted id");
        assert_eq!(
            record.original_session_id.as_deref(),
            Some("s-prime"),
            "the new epoch re-roots to the CURRENT durable id — O's chain is never reused for redo"
        );
        assert_eq!(
            record.original_tip_uuid.as_deref(),
            Some("aq"),
            "S' chain tip"
        );
        assert!(
            !record.redo_destroyed,
            "the new epoch's redo fields describe the NEW chain"
        );
        assert!(
            record.can_redo(),
            "redo source exists beyond the new live prefix"
        );
        assert_eq!(
            record.entries.len(),
            2,
            "the marker bucket is the UNION of both epochs"
        );
        let first_entry_ids: Vec<&str> = record.entries[0]
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(
            first_entry_ids,
            vec!["u2", "a2"],
            "the frozen prior-epoch markers stay first (decision 6; r3)"
        );
        let second_entry_ids: Vec<&str> = record.entries[1]
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(
            second_entry_ids,
            vec!["uq", "aq"],
            "the newest epoch's removed slice"
        );
        // Delta-r1 F8 case (a): the destroy bit at load opened a NEW epoch — the
        // frozen prior-epoch entry KEEPS its epoch (0), the new op records the
        // bumped counter (1); positions never read timestamps.
        assert_eq!(record.current_epoch, 1);
        assert_eq!(record.entries[0].epoch, 0);
        assert_eq!(record.entries[1].epoch, 1);
        assert!(
            sink_impl.load_rollback("claude", "s-prime").is_none(),
            "the rollback row MOVED old→new (never a stale duplicate)"
        );

        // The snapshot truth at the re-rooted boundary: read through
        // `get_claude_snapshot` (the staged CLAUDE_CONFIG_DIR transcripts make
        // locate_transcript resolve "s-prime"; the re-rooted chain's tip recheck
        // passes over its staged transcript) — the FROZEN prior-epoch markers
        // (u2/a2) are never restorable; the NEW epoch's (uq/aq) are.
        let snap =
            crate::claude_snapshot::get_claude_snapshot("freshclaude", "s-prime", Some(&record))
                .await
                .expect("snapshot builds over the staged s-prime transcript");
        let bucket = snap["rolledBackTurns"].as_array().expect("bucket");
        assert_eq!(bucket.len(), 4);
        assert_eq!(bucket[0]["turnId"], json!("u2"));
        assert_eq!(
            bucket[0]["restorable"],
            json!(false),
            "frozen prior-epoch USER marker"
        );
        assert_eq!(bucket[1]["turnId"], json!("a2"));
        assert_eq!(
            bucket[1]["restorable"],
            json!(false),
            "frozen prior-epoch ASSISTANT marker — ALL roles are stamped"
        );
        assert_eq!(bucket[2]["turnId"], json!("uq"));
        assert_eq!(
            bucket[2]["restorable"],
            json!(true),
            "current-epoch USER marker"
        );
        assert_eq!(bucket[3]["turnId"], json!("aq"));
        assert_eq!(
            bucket[3]["restorable"],
            json!(true),
            "current-epoch ASSISTANT marker — ALL roles are stamped"
        );

        // Simulated SDK write: the forked child's transcript on disk is the kept prefix.
        write_rollback_transcript(
            home.path(),
            &adopted,
            &two_turn_transcript()
                .lines()
                .take(2)
                .collect::<Vec<_>>()
                .join("\n"),
        );

        // Now the redo re-forks from S' (the re-rooted chain root) restoring EXACTLY
        // the newest epoch's removed tail — the frozen prior-epoch markers are not restorable.
        let (sink2, captured2) = capturing_sink();
        st.handle_rollback(
            rollback_op(&adopted, "rb-epoch-2", RollbackDirection::Redo),
            sink2,
        )
        .await;
        let adopted2 = await_adopted_durable(&st, "epoch-live", &adopted).await;
        let frames2 = captured_json(&captured2);
        assert_eq!(frames2.len(), 1, "{frames2:?}");
        assert_eq!(frames2[0]["event"]["type"], "freshAgent.redone");
        assert_eq!(
            frames2[0]["event"]["restoredThroughTurnId"],
            json!("aq"),
            "redone restores through the restored step's OWN last uuid (r3 boundary rule)"
        );
        assert_eq!(
            frames2[0]["event"]["canRedo"],
            json!(false),
            "nothing lies beyond the re-rooted tip"
        );
        let creates: Vec<Value> = std::fs::read_to_string(env.spawn_log_path())
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("spawn log line is JSON"))
            .collect();
        assert_eq!(creates.len(), 2, "{creates:?}");
        assert_eq!(
            creates[1]["boot"]["resume"],
            json!("s-prime"),
            "redo re-forks the re-rooted chain root"
        );
        assert_eq!(creates[1]["boot"]["resumeSessionAt"], json!("aq"));
        assert_eq!(creates[1]["boot"]["kind"], json!("fork"));
        assert!(
            creates[1]["boot"].get("dropsTurn").is_none(),
            "the guard is omitted when the discard range is empty (redo to the tip) — never fabricated"
        );
        let record2 = sink_impl
            .load_rollback("claude", &adopted2)
            .expect("record re-keyed again");
        assert_eq!(
            record2.entries.len(),
            1,
            "the restored turns left the CURRENT-epoch portion"
        );
        let remaining_ids: Vec<&str> = record2.entries[0]
            .removed_turns
            .iter()
            .filter_map(|t| t.get("turnId").and_then(Value::as_str))
            .collect();
        assert_eq!(
            remaining_ids,
            vec!["u2", "a2"],
            "only the frozen prior-epoch markers remain"
        );
        assert!(!record2.can_redo());
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        drop(env);
    }

    /// The r2 lock discipline on the claude lane: a send fired mid-rollback waits on
    /// the per-session turn lock (handle_send NEVER acquires rollback_in_flight),
    /// then proceeds against the POST-rollback session (the replacement took the
    /// lock over) and destroys redo.
    ///
    /// DETERMINISM (task 4 review C1): the fake sidecar's create ANSWER is deferred
    /// 750ms — the spawn-log gate observes the create request receipt while the
    /// rollback is PARKED inside `read_created` (the replacement's boot, the
    /// original still registered), so the send provably arrives while the rollback
    /// holds the lock; it serializes behind the rollback and lands on the
    /// replacement.
    #[tokio::test]
    async fn concurrent_send_plus_undo_serializes_on_the_turn_lock_without_deadlock() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install_with_knobs(Some(750), false);
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), "dur-serial", &two_turn_transcript());
        let (st, mut rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink_impl.clone());
        insert_rollback_fixture_session(&st, "serial-live", "dur-serial").await;

        let rollback = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_rollback(
                    rollback_op("dur-serial", "rb-serial-1", RollbackDirection::Undo),
                    capturing_sink().0,
                )
                .await
            })
        };
        // Wait until the rollback is parked INSIDE the respawn: the fork create
        // request has landed at the fake sidecar (spawn-log receipt) AND its answer
        // stays deferred for 750ms — the rollback already holds the session turn
        // lock and the map entry is already removed. The send fired below provably
        // arrives in the mid-rollback window.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        while env.spawn_count() < 1 {
            assert!(
                tokio::time::Instant::now() < deadline,
                "the rollback never reached its fork create"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let send = {
            let st = st.clone();
            tokio::spawn(async move {
                st.handle_send(send_msg("dur-serial", "edited followup"))
                    .await
            })
        };
        // Bounded completion == no deadlock between the two handlers' lock waits.
        tokio::time::timeout(Duration::from_secs(20), async {
            let (r, s) = tokio::join!(rollback, send);
            r.expect("rollback task");
            s.expect("send task");
        })
        .await
        .expect("send+rollback must serialize, never deadlock");

        let adopted = await_adopted_durable(&st, "serial-live", "dur-serial").await;
        // The send's sidecar write landed strictly AFTER the rollback's
        // kill+spawn+adoption completed: it targeted the NEW sidecar's id, never
        // the torn-down one.
        let sends = env.respond_log_frames(1).await;
        let send_frame = sends
            .iter()
            .find(|f| f["type"] == "send")
            .expect("the send eventually writes to the sidecar");
        assert_ne!(
            send_frame["sessionId"],
            json!("serial-live"),
            "the send waited, then ran against the POST-rollback session: {send_frame}"
        );
        assert!(
            send_frame["sessionId"] == adopted,
            "the send addressed the freshly-adopted sidecar: {send_frame}"
        );
        // SESSION_NOT_FOUND is structurally impossible on this lane: the send
        // parked while the rollback was in flight, never resolved-before-lock.
        while let Ok(raw) = rx.try_recv() {
            assert!(
                !raw.contains("SESSION_NOT_FOUND"),
                "no SESSION_NOT_FOUND frame may ever surface for a mid-rollback send: {raw}"
            );
        }
        // And destroy_redo_on_submit ran against the POST-rollback record —
        // keyed by the adopted durable id (the post-lock session state), never
        // the pre-MOVE id ("send waits, rollback wins, then destroys").
        let record = sink_impl
            .load_rollback("claude", &adopted)
            .expect("record under the adopted id");
        assert!(
            record.redo_destroyed,
            "the trailing send destroyed redo (decision 5)"
        );
        assert!(!record.can_redo());
        assert_eq!(
            record.entries.len(),
            1,
            "the marker bucket is NEVER touched by a destroy"
        );
        assert!(
            sink_impl.load_rollback("claude", "dur-serial").is_none(),
            "the rollback row MOVED old→new; nothing remains under the pre-rollback id"
        );
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        drop(env);
    }

    /// Task 4 review (Minor-2): a READ FAILURE on the redo's current transcript
    /// (locate succeeded, bytes unreadable) is a loud INTERNAL_ERROR — never the
    /// vacuous-empty leg (a silent false `redone` ack plus a pointless fork).
    #[tokio::test]
    async fn redo_current_transcript_read_failure_is_internal_error_with_no_fork_traffic() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        // Original: the recorded chain root (tip a2). Current (post-undo): the
        // u1/a1 prefix — located, then made UNREADABLE.
        write_rollback_transcript(home.path(), "dur-rf-orig", &two_turn_transcript());
        write_rollback_transcript(
            home.path(),
            "dur-rf",
            &two_turn_transcript()
                .lines()
                .take(2)
                .collect::<Vec<_>>()
                .join("\n"),
        );
        let current_path = home.path().join("projects/-t").join("dur-rf.jsonl");
        std::fs::set_permissions(
            &current_path,
            <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o000),
        )
        .unwrap();
        if std::fs::read_to_string(&current_path).is_ok() {
            // Root / CAP_DAC_OVERRIDE bypasses mode bits — restore + vacate.
            std::fs::set_permissions(
                &current_path,
                <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o644),
            )
            .unwrap();
            std::env::remove_var("CLAUDE_CONFIG_DIR");
            eprintln!("skipping: euid bypasses permission checks");
            return;
        }
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        sink_impl
            .record_rollback("claude", "dur-rf", {
                let mut r = RollbackRecord::empty(100);
                r.original_session_id = Some("dur-rf-orig".to_string());
                r.original_tip_uuid = Some("a2".to_string());
                r.set_can_redo(true, 100);
                r
            })
            .await
            .expect("seed write");
        st.set_identity_sink(sink_impl.clone());
        let stdin_log = insert_rollback_fixture_session(&st, "rb-rf", "dur-rf").await;

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-rf", "rb-rf-1", RollbackDirection::Redo),
            sink,
        )
        .await;

        std::fs::set_permissions(
            &current_path,
            <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o644),
        )
        .unwrap();
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(frames[0]["event"]["requestId"], "rb-rf-1");
        // NO fork traffic: the read failure refused BEFORE any spawn, pending
        // cancellation, or teardown.
        assert_eq!(env.spawn_count(), 0, "a read failure forks nothing");
        assert_eq!(std::fs::read_to_string(&stdin_log).unwrap_or_default(), "");
        assert!(
            st.sessions.lock().await.contains_key("rb-rf"),
            "the session was never torn down"
        );
        drop(env);
    }

    /// G31: an undo replaces the sidecar through the same graceful stop as
    /// every other teardown. The old sidecar reads its shutdown request
    /// (nothing kills it first) and the stop is logged as a graceful
    /// `freshagent.claude.teardown`.
    #[tokio::test]
    async fn an_undo_stops_the_old_sidecar_gracefully() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let (events, _capture) = super::teardown_tests::capture::install();
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), "dur-graceful", &two_turn_transcript());
        let (st, _rx) = state_with_bus();
        st.set_identity_sink(Arc::new(crate::identity_sink::FakeIdentitySink::default()));
        let old_stdin_log =
            insert_rollback_fixture_session(&st, "rb-graceful", "dur-graceful").await;

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-graceful", "rb-graceful-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        let adopted = await_adopted_durable(&st, "rb-graceful", "dur-graceful").await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["type"], "freshAgent.rolledBack");
        assert_eq!(frames[0]["event"]["newSessionId"], json!(adopted));
        let old_stdin = std::fs::read_to_string(&old_stdin_log).unwrap_or_default();
        assert!(
            old_stdin
                .lines()
                .any(|line| line == r#"{"type":"shutdown"}"#),
            "the old sidecar read its shutdown request before it stopped: {old_stdin:?}"
        );
        let stops: Vec<_> = super::teardown_tests::capture::teardown_events(&events)
            .into_iter()
            .filter(|(_, fields)| {
                fields.get("session_id").map(String::as_str) == Some("rb-graceful")
            })
            .collect();
        assert_eq!(
            stops.len(),
            1,
            "one logged stop of the old sidecar: {stops:?}"
        );
        assert_eq!(
            stops[0].1.get("graceful").map(String::as_str),
            Some("true"),
            "{stops:?}"
        );
        drop(env);
    }

    /// Task 4 review (Minor-3): a provably-rejected rollback (the fork create
    /// dies before `created`) on a session with NO pre-op record compensates by
    /// DELETING the pre-write row — never by fabricating an empty record.
    #[tokio::test]
    async fn rollback_spawn_rejection_compensates_by_deleting_a_fabricated_record_never_written() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install_with_knobs(None, true);
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path());
        write_rollback_transcript(home.path(), "dur-nocomp", &two_turn_transcript());
        let (st, _rx) = state_with_bus();
        let sink_impl = Arc::new(crate::identity_sink::FakeIdentitySink::default());
        st.set_identity_sink(sink_impl.clone());
        insert_rollback_fixture_session(&st, "rb-nocomp", "dur-nocomp").await;

        let (sink, captured) = capturing_sink();
        st.handle_rollback(
            rollback_op("dur-nocomp", "rb-nocomp-1", RollbackDirection::Undo),
            sink,
        )
        .await;
        std::env::remove_var("CLAUDE_CONFIG_DIR");

        let frames = captured_json(&captured);
        assert_eq!(frames.len(), 1, "{frames:?}");
        assert_eq!(frames[0]["event"]["code"], "INTERNAL_ERROR");
        assert_eq!(frames[0]["event"]["rollback"], json!(true));
        assert_eq!(frames[0]["event"]["requestId"], "rb-nocomp-1");
        assert_eq!(
            env.spawn_count(),
            1,
            "the fork create WAS attempted — the provable-rejection leg ran"
        );
        assert!(
            sink_impl.load_rollback("claude", "dur-nocomp").is_none(),
            "compensation deleted the pre-write row"
        );
        assert!(
            !sink_impl
                .rollbacks
                .lock()
                .unwrap()
                .contains_key(&("claude".to_string(), "dur-nocomp".to_string())),
            "the ledger holds NO row at all afterward — not even an empty record"
        );
        drop(env);
    }

    // ── freshAgent.configure: live model convergence ─────────────────────────

    fn configure_msg(
        session_id: &str,
        model: Option<&str>,
        effort: Option<&str>,
    ) -> FreshAgentConfigure {
        FreshAgentConfigure {
            provider: freshell_protocol::AgentProvider::Claude,
            session_id: session_id.to_string(),
            session_type: SessionType::Freshclaude,
            cwd: None,
            request_id: Some("req-configure".to_string()),
            settings: freshell_protocol::FreshAgentSendSettings {
                cwd: None,
                model: model.map(|m| m.to_string()),
                permission_mode: None,
                sandbox: None,
                effort: effort.map(|e| e.to_string()),
            },
        }
    }

    async fn drain(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Vec<Value> {
        let mut out = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            out.push(serde_json::from_str(&frame).expect("frames are JSON"));
        }
        out
    }

    /// A configure applies the settings to the LIVE sidecar session (the fake
    /// mirrors the real configure lane: setModel + the sdk.configured receipt)
    /// and broadcasts `freshAgent.session.metadata` so every device's model
    /// surfaces converge. The ledger row's settings re-snapshot through the
    /// existing adopt_session_init leg configure_for_send performs.
    #[tokio::test]
    async fn configure_applies_settings_and_broadcasts_session_metadata() {
        let _env_guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, rx) = state_with_bus();
        let mut rx = rx;
        state
            .handle_create(dedup_create_msg("configure-live"), None)
            .await;
        let created = await_claude_created(&mut rx, "configure-live").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        state
            .handle_configure(configure_msg(&session_id, Some("opus[1m]"), Some("high")))
            .await;

        // The configure lane reached the sidecar…
        let frames = env.respond_log_frames(1).await;
        assert_eq!(frames[0]["type"], json!("configure"));
        assert_eq!(frames[0]["settings"]["model"], json!("opus[1m]"));

        // …the session record holds the applied pair…
        let (record_model, record_effort) = {
            let guard = state.sessions.lock().await;
            let session = guard
                .values()
                .find(|s| s.sidecar_session_id == session_id)
                .expect("session");
            (
                session.configuration.settings.model.clone(),
                session.configuration.settings.effort.clone(),
            )
        };
        assert_eq!(record_model.as_deref(), Some("opus[1m]"));
        assert_eq!(record_effort.as_deref(), Some("high"));

        // …and the metadata broadcast converges every device's surfaces, keyed
        // at the CLIENT-ADDRESSED id.
        let frames = drain(&mut rx).await;
        let metadata = frames
            .iter()
            .find(|f| {
                f["type"] == "freshAgent.event"
                    && f["event"]["type"] == "freshAgent.session.metadata"
            })
            .expect("a metadata frame is broadcast");
        assert_eq!(metadata["provider"], json!("claude"));
        assert_eq!(metadata["sessionType"], json!("freshclaude"));
        assert_eq!(metadata["sessionId"], json!(session_id));
        assert_eq!(metadata["event"]["model"], json!("opus[1m]"));
        assert_eq!(metadata["event"]["effort"], json!("high"));
    }

    /// The fake sidecar's scripted refusal (model 'unavailable') surfaces on
    /// the pane-banner error channel with the session's flavour, and NO
    /// metadata converges a value the live session never took.
    #[tokio::test]
    async fn a_refused_configure_surfaces_the_banner_error_and_converges_nothing() {
        let _env_guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, rx) = state_with_bus();
        let mut rx = rx;
        state
            .handle_create(dedup_create_msg("configure-refused"), None)
            .await;
        let created = await_claude_created(&mut rx, "configure-refused").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        state
            .handle_configure(configure_msg(&session_id, Some("unavailable"), None))
            .await;
        let _ = env.respond_log_frames(1).await;

        let frames = drain(&mut rx).await;
        let error = frames
            .iter()
            .find(|f| f["type"] == "freshAgent.event" && f["event"]["type"] == "freshAgent.error")
            .expect("the refusal surfaces a freshAgent.error frame");
        assert_eq!(error["event"]["code"], json!("CLAUDE_SETTINGS_FAILED"));
        assert_eq!(error["sessionType"], json!("freshclaude"));
        assert_eq!(error["sessionId"], json!(session_id));
        assert!(
            !frames.iter().any(|f| f["type"] == "freshAgent.event"
                && f["event"]["type"] == "freshAgent.session.metadata"),
            "a refused configure never converges"
        );
    }

    /// An idempotent configure (the sidecar applied the same pair already in
    /// the record) stays silent on the bus.
    #[tokio::test]
    async fn an_idempotent_configure_broadcasts_no_metadata() {
        let _env_guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, rx) = state_with_bus();
        let mut rx = rx;
        state
            .handle_create(dedup_create_msg("configure-idem"), None)
            .await;
        let created = await_claude_created(&mut rx, "configure-idem").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        state
            .handle_configure(configure_msg(&session_id, Some("opus[1m]"), None))
            .await;
        let first = env.respond_log_frames(1).await;
        assert_eq!(first[0]["settings"]["model"], json!("opus[1m]"));
        let frames = drain(&mut rx).await;
        assert_eq!(
            frames
                .iter()
                .filter(|f| f["type"] == "freshAgent.event"
                    && f["event"]["type"] == "freshAgent.session.metadata")
                .count(),
            1,
            "the first (changing) configure broadcasts exactly one metadata frame"
        );

        state
            .handle_configure(configure_msg(&session_id, Some("opus[1m]"), None))
            .await;
        // The second configure is a pure no-op: configure_for_send
        // short-circuits before any sidecar write (the respond log stays at
        // one frame), and no metadata converges.
        let frames = drain(&mut rx).await;
        assert!(
            !frames.iter().any(|f| f["type"] == "freshAgent.event"
                && f["event"]["type"] == "freshAgent.session.metadata"),
            "an idempotent configure converges nothing"
        );
    }

    /// A settings-bearing send that CHANGES the live session converges the
    /// metadata broadcast too (the send-time configure_for_send leg): a
    /// device that missed the configure still lands here.
    #[tokio::test]
    async fn a_settings_changing_send_broadcasts_session_metadata() {
        let _env_guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, rx) = state_with_bus();
        let mut rx = rx;
        state
            .handle_create(dedup_create_msg("configure-send"), None)
            .await;
        let created = await_claude_created(&mut rx, "configure-send").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        let mut send = send_msg(&session_id, "carries a new model");
        send.settings = Some(freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            model: Some("opus[1m]".to_string()),
            effort: Some("high".to_string()),
            permission_mode: None,
            sandbox: None,
        });
        state.handle_send(send).await;
        let _ = env.respond_log_frames(1).await;

        let frames = drain(&mut rx).await;
        let metadata = frames
            .iter()
            .find(|f| {
                f["type"] == "freshAgent.event"
                    && f["event"]["type"] == "freshAgent.session.metadata"
            })
            .expect("a settings-changing send broadcasts metadata");
        assert_eq!(metadata["sessionId"], json!(session_id));
        assert_eq!(metadata["event"]["model"], json!("opus[1m]"));
        assert_eq!(metadata["event"]["effort"], json!("high"));
    }

    /// The send-time broadcast is DIFF-guarded: a send whose settings pair
    /// already matches the record converges NOTHING (the mirror of the
    /// idempotent configure). If the `settings_before != settings_after`
    /// guard were dropped, every settings-bearing send would broadcast a
    /// redundant metadata frame and nothing would catch it.
    #[tokio::test]
    async fn a_settings_unchanged_send_broadcasts_no_metadata() {
        let _env_guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, rx) = state_with_bus();
        let mut rx = rx;
        state
            .handle_create(dedup_create_msg("send-idem"), None)
            .await;
        let created = await_claude_created(&mut rx, "send-idem").await;
        let session_id = created["sessionId"].as_str().unwrap().to_string();

        // Send #1 carries a NEW pair: the configure leg reaches the sidecar
        // (the configure and the prompt both land in the respond log) and
        // exactly one metadata frame converges.
        let mut send = send_msg(&session_id, "carries a new model");
        send.settings = Some(freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            model: Some("opus[1m]".to_string()),
            effort: Some("high".to_string()),
            permission_mode: None,
            sandbox: None,
        });
        state.handle_send(send).await;
        let first = env.respond_log_frames(2).await;
        assert_eq!(first[0]["type"], json!("configure"));
        assert_eq!(first[0]["settings"]["model"], json!("opus[1m]"));
        let frames = drain(&mut rx).await;
        assert_eq!(
            frames
                .iter()
                .filter(|f| f["type"] == "freshAgent.event"
                    && f["event"]["type"] == "freshAgent.session.metadata")
                .count(),
            1,
            "the first (changing) send broadcasts exactly one metadata frame"
        );

        // Send #2 carries the SAME pair: `configure_for_send` short-circuits
        // before any sidecar write (the respond log gains ONLY the prompt —
        // no second configure), and the unchanged pair converges nothing.
        let mut resend = send_msg(&session_id, "same pair again");
        resend.settings = Some(freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            model: Some("opus[1m]".to_string()),
            effort: Some("high".to_string()),
            permission_mode: None,
            sandbox: None,
        });
        state.handle_send(resend).await;
        let second = env.respond_log_frames(3).await;
        assert_eq!(
            second[2]["type"],
            json!("send"),
            "the unchanged send reaches the sidecar as a bare prompt: {second:?}"
        );
        assert_eq!(
            second
                .iter()
                .filter(|f| f["type"] == json!("configure"))
                .count(),
            1,
            "the unchanged send writes NO second configure: {second:?}"
        );
        let frames = drain(&mut rx).await;
        assert!(
            !frames.iter().any(|f| f["type"] == "freshAgent.event"
                && f["event"]["type"] == "freshAgent.session.metadata"),
            "an unchanged send converges nothing"
        );
    }

    // ── b8ke focused round-3 R3-7: the condemned-prior recorded identity ──

    /// R3-7(b): the fenced-prior death probe must not FALSE-CONFIRM over a
    /// reparented descendant. The condemned record is armed while the
    /// sidecar lives (the ancestry chain intact, the ownership tags
    /// readable); by probe time the sidecar has exited and the tagged
    /// grandchild reparented to init — its environ is no longer readable
    /// (YAMA) — so a fresh tag scan alone finds NOTHING and answers
    /// `true` while the descendant still runs. The recorded identity (the
    /// original pid + start time and the tree discovered at kill time) is
    /// what still confirms and kills the reparented descendant.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_fenced_prior_probe_kills_a_reparented_descendant_from_the_recorded_identity() {
        let st = state();
        let sid = format!("r37-reparent-{}", uuid::Uuid::new_v4());
        // The condemned "sidecar" child holding a tagged "CLI grandchild".
        let child = tokio::process::Command::new("bash")
            .arg("-c")
            .arg("sleep 300 & wait")
            .env("R37_TEST_OWNERSHIP", &sid)
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the condemned child");
        let child_pid = child.id().expect("child pid");
        // Give bash a beat to spawn the grandchild, then discover the
        // grandchild's pid from the tagged /proc scan (the record's own
        // discovery mechanism, same as the production capture).
        let grandchild_pid = {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                let tree = std::fs::read_dir("/proc").expect("read /proc");
                let mut found: Option<i32> = None;
                for entry in tree.flatten() {
                    let name = entry.file_name();
                    let Some(name) = name.to_str() else { continue };
                    let Ok(p) = name.parse::<i32>() else { continue };
                    if p == child_pid as i32 {
                        continue;
                    }
                    let Ok(bytes) =
                        std::fs::read(std::path::Path::new("/proc").join(name).join("environ"))
                    else {
                        continue;
                    };
                    let needle = format!("R37_TEST_OWNERSHIP={sid}");
                    if bytes.split(|b| *b == 0).any(|kv| kv == needle.as_bytes()) {
                        found = Some(p);
                        break;
                    }
                }
                if let Some(p) = found {
                    break p as u32;
                }
                assert!(
                    std::time::Instant::now() < deadline,
                    "the tagged grandchild never appeared in the scan"
                );
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        };

        // The condemned record the interrupted kill armed (the fixture
        // seeds exactly what `record_condemned_prior` arms — captured
        // while the child and its tagged tree are still readable).
        let recorded = crate::session_lease::record_condemned_runtime_identity(
            child_pid,
            "R37_TEST_OWNERSHIP",
            &sid,
        );
        st.condemned_priors
            .lock()
            .expect("condemned priors lock")
            .insert(sid.clone(), recorded);

        // The child exits out-of-band (the interrupted teardown's partial
        // kill): the grandchild reparents to init and its tag becomes
        // unreadable — the fresh-scan-blindness window.
        let _ = tokio::process::Command::new("kill")
            .arg(child_pid.to_string())
            .status()
            .await
            .expect("kill the condemned child");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while crate::session_lease::proc_starttime(child_pid as i32).is_some() {
            assert!(
                std::time::Instant::now() < deadline,
                "the condemned child never died"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        // The reparenting is what makes the fresh scan blind — give it a
        // beat to land (the grandchild's environ is unreadable once bash
        // is gone from its ancestry chain).
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;

        // THE R3-7(b) regression: the probe must KILL the reparented
        // descendant (from the recorded tree) and confirm — never answer
        // `true` over a still-running descendant.
        let confirmed = st.confirm_fenced_prior_dead(&sid).await;
        assert!(
            confirmed,
            "the recorded identity must confirm the tree dead"
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while crate::session_lease::proc_starttime(grandchild_pid as i32).is_some() {
            assert!(
                std::time::Instant::now() < deadline,
                "the reparented tagged descendant was never killed — a false confirmation"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        // The record cleared with the confirmed kill.
        assert!(
            !st.condemned_priors
                .lock()
                .expect("condemned priors lock")
                .contains_key(&sid),
            "the confirmed kill clears the condemned record"
        );
    }

    /// R3-7(a): the fenced-prior death probe must verify the recorded pid's
    /// START TIME before signaling — a recycled pid belongs to an unrelated
    /// process (the original incarnation is gone). Pre-fix, the probe
    /// signals whatever currently holds the pid.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn the_fenced_prior_probe_never_signals_a_reused_pid() {
        let st = state();
        let sid = format!("r37-reuse-{}", uuid::Uuid::new_v4());
        // A live "unrelated replacement" process holding the recorded pid.
        let mut unrelated = tokio::process::Command::new("sleep")
            .arg("300")
            .kill_on_drop(true)
            .spawn()
            .expect("spawn the unrelated replacement");
        let pid = unrelated.id().expect("unrelated pid");

        // The condemned record: the pid with the ORIGINAL incarnation's
        // start time (forged to differ — the pid-reuse shape: the original
        // died, an unrelated process recycled the pid).
        let recorded = crate::session_lease::CondemnedRuntimeIdentity {
            pid,
            start_time: Some(u64::MAX / 2),
            tree: Vec::new(),
            ownership_id: sid.clone(),
            capture_complete: true,
        };
        st.condemned_priors
            .lock()
            .expect("condemned priors lock")
            .insert(sid.clone(), recorded);

        let confirmed = st.confirm_fenced_prior_dead(&sid).await;

        // THE R3-7(a) regression: the unrelated process was NEVER
        // signaled — it is still alive — while the probe honestly
        // confirms the original incarnation dead (its recorded tree is
        // empty and its pid was recycled).
        assert!(
            crate::session_lease::proc_starttime(pid as i32).is_some(),
            "the reused pid's unrelated process must never be signaled"
        );
        assert!(
            confirmed,
            "the original incarnation is gone (pid reused) — confirmed dead"
        );
        let _ = unrelated.kill().await;
    }
}
