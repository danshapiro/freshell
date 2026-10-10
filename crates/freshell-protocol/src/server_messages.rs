//! Server → client messages (`ServerMessage`, 67 discriminants: 66 frozen
//! inventory types + the `durability.degraded` extension).
//!
//! These are TypeScript-typed (not runtime-validated) on the wire; their frozen
//! shape authority is `port/contract/ws-server-messages.schema.json`.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

use crate::common::{
    AgentProvider, AmplifierActivityRecord, ClaudeActivityRecord, CodexActivityRecord,
    CodexDurability, ErrorCode, OpencodeActivityRecord, SessionLocator, TerminalMetaRecord,
    TurnCompletionSnapshot,
};
use crate::session_names::{SessionNameRecord, SessionNameRef, SessionNameUpdated};
use crate::settings::ServerSettings;

/// A message sent from the server to a client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
    // Extension surface (not in the frozen T0 inventory — see
    // `EXTENSION_SERVER_MESSAGE_TYPES`): the amplifier activity family the
    // frozen client already consumes, mirroring the legacy zod schemas.
    #[serde(rename = "amplifier.activity.list.response")]
    AmplifierActivityListResponse(AmplifierActivityListResponse),
    #[serde(rename = "amplifier.activity.updated")]
    AmplifierActivityUpdated(AmplifierActivityUpdated),
    #[serde(rename = "claude.activity.list.response")]
    ClaudeActivityListResponse(ClaudeActivityListResponse),
    #[serde(rename = "claude.activity.updated")]
    ClaudeActivityUpdated(ClaudeActivityUpdated),
    #[serde(rename = "codex.activity.list.response")]
    CodexActivityListResponse(CodexActivityListResponse),
    #[serde(rename = "codex.activity.updated")]
    CodexActivityUpdated(CodexActivityUpdated),
    #[serde(rename = "codingcli.created")]
    CodingCliCreated(CodingCliCreated),
    #[serde(rename = "codingcli.event")]
    CodingCliEvent(CodingCliEvent),
    #[serde(rename = "codingcli.exit")]
    CodingCliExit(CodingCliExit),
    #[serde(rename = "codingcli.killed")]
    CodingCliKilled(CodingCliKilled),
    #[serde(rename = "codingcli.stderr")]
    CodingCliStderr(CodingCliStderr),
    #[serde(rename = "config.fallback")]
    ConfigFallback(ConfigFallback),
    // Extension surface (P1.8 pane-identity ledger, not in the frozen T0
    // inventory): live per-pane durability warning. See
    // `EXTENSION_SERVER_MESSAGE_TYPES`.
    #[serde(rename = "durability.degraded")]
    DurabilityDegraded(DurabilityDegraded),
    #[serde(rename = "error")]
    Error(ErrorMsg),
    #[serde(rename = "extension.server.error")]
    ExtensionServerError(ExtensionServerError),
    #[serde(rename = "extension.server.ready")]
    ExtensionServerReady(ExtensionServerReady),
    #[serde(rename = "extension.server.starting")]
    ExtensionServerStarting(ExtensionServerNamed),
    #[serde(rename = "extension.server.stopped")]
    ExtensionServerStopped(ExtensionServerNamed),
    #[serde(rename = "extensions.registry")]
    ExtensionsRegistry(ExtensionsRegistry),
    #[serde(rename = "freshAgent.create.failed")]
    FreshAgentCreateFailed(FreshAgentCreateFailed),
    #[serde(rename = "freshAgent.created")]
    FreshAgentCreated(FreshAgentCreated),
    #[serde(rename = "freshAgent.event")]
    FreshAgentEvent(FreshAgentEvent),
    #[serde(rename = "freshAgent.forked")]
    FreshAgentForked(FreshAgentForked),
    #[serde(rename = "freshAgent.killed")]
    FreshAgentKilled(FreshAgentKilled),
    #[serde(rename = "freshAgent.recovery.stopped")]
    FreshAgentRecoveryStopped(FreshAgentRecoveryStopped),
    #[serde(rename = "freshAgent.send.accepted")]
    FreshAgentSendAccepted(FreshAgentSendAccepted),
    #[serde(rename = "freshAgent.session.materialized")]
    FreshAgentSessionMaterialized(FreshAgentSessionMaterialized),
    #[serde(rename = "hoststats.refresh.response")]
    HostStatsRefreshResponse(HostStatsRefreshResponse),
    #[serde(rename = "hoststats.snapshot")]
    HostStatsSnapshot(Box<HostStatsSnapshot>),
    #[serde(rename = "opencode.activity.list.response")]
    OpencodeActivityListResponse(OpencodeActivityListResponse),
    #[serde(rename = "opencode.activity.updated")]
    OpencodeActivityUpdated(OpencodeActivityUpdated),
    #[serde(rename = "pane.reconcile.result")]
    PaneReconcileResult(PaneReconcileResult),
    #[serde(rename = "perf.logging")]
    PerfLogging(PerfLogging),
    #[serde(rename = "pong")]
    Pong(Pong),
    #[serde(rename = "ready")]
    Ready(Ready),
    // Durable-souls managed runtime (Phase 4): the web projection's two
    // server-authoritative edges. `runtime.inventory.changed` fires once per
    // reconciled supervisor inventory revision; `runtime.view.changed` fires
    // once per applied view-projection event. Emitted by
    // `crates/freshell-server/src/managed_runtime_api.rs`.
    #[serde(rename = "runtime.inventory.changed")]
    RuntimeInventoryChanged(RuntimeInventoryChanged),
    #[serde(rename = "runtime.view.changed")]
    RuntimeViewChanged(RuntimeViewChanged),
    #[serde(rename = "session.repair.activity")]
    SessionRepairActivity(SessionRepairActivity),
    // Unified agent names (Task 1): the canonical name broadcast — payload is
    // a `SessionNameUpdate`. Additive server→client only; the protocol
    // version deliberately stays 10 (pre-frame servers simply never send it).
    #[serde(rename = "session.name.updated")]
    SessionNameUpdated(SessionNameUpdated),
    // kata b8ke: the runtime-ownership broadcast (see [`SessionRuntimeOwner`]).
    // Additive via the frozen route — SERVER_MESSAGE_TYPES / the generated
    // inventory carry it; no protocol version bump (nothing awaits it).
    #[serde(rename = "session.runtimeOwner")]
    SessionRuntimeOwner(SessionRuntimeOwner),
    #[serde(rename = "session.status")]
    SessionStatus(SessionStatus),
    #[serde(rename = "sessions.changed")]
    SessionsChanged(SessionsChanged),
    #[serde(rename = "settings.updated")]
    SettingsUpdated(SettingsUpdated),
    #[serde(rename = "tabs.sync.ack")]
    TabsSyncAck(TabsSyncAck),
    #[serde(rename = "tabs.sync.snapshot")]
    TabsSyncSnapshot(TabsSyncSnapshot),
    #[serde(rename = "terminal.attach.ready")]
    TerminalAttachReady(TerminalAttachReady),
    #[serde(rename = "terminal.codex.durability.updated")]
    TerminalCodexDurabilityUpdated(TerminalCodexDurabilityUpdated),
    #[serde(rename = "terminal.created")]
    TerminalCreated(TerminalCreated),
    #[serde(rename = "terminal.detached")]
    TerminalDetached(TerminalIdOnly),
    #[serde(rename = "terminal.exit")]
    TerminalExit(TerminalExit),
    // Extension surface (TERM-16 follow-on, not in the frozen T0 inventory):
    // the NEW truly-idle edge — `{ terminalId, at, reason }`, emitted ONCE per
    // busy→truly-idle transition. See `EXTENSION_SERVER_MESSAGE_TYPES`.
    #[serde(rename = "terminal.idle")]
    TerminalIdle(TerminalIdle),
    #[serde(rename = "terminal.input.blocked")]
    TerminalInputBlocked(TerminalInputBlocked),
    #[serde(rename = "terminal.inventory")]
    TerminalInventory(TerminalInventory),
    // Additive (delta-r6-r3, focused-episode-6 round 2): the correlated
    // `terminal.kill` answer — see [`TerminalKilled`].
    #[serde(rename = "terminal.killed")]
    TerminalKilled(TerminalKilled),
    // Additive (delta-r7-r3, focused-episode-7 round 2): the correlated
    // `pane.closed` answer — see [`PaneClosedResult`]. Introduced WITH the
    // protocol version bump 8 → 9 (the client now depends on the answer —
    // see `shared/ws-version.ts`).
    #[serde(rename = "pane.closed.result")]
    PaneClosedResult(PaneClosedResult),
    // Additive (focused-episode-7 round 3, Finding F1): the correlated
    // `panes.closed` batch answer — see [`PanesClosedResult`]. Introduced
    // WITH the protocol version bump 9 → 10.
    #[serde(rename = "panes.closed.result")]
    PanesClosedResult(PanesClosedResult),
    // Additive (focused-episode-7 round 5, Finding F3): the correlated
    // `pane.opened` answer — see [`PaneOpenedResult`]. NO version bump: the
    // client never awaits it (the bounded non-blocking listen degrades to
    // the per-ready sweep's healing on a predated server).
    #[serde(rename = "pane.opened.result")]
    PaneOpenedResult(PaneOpenedResult),
    #[serde(rename = "terminal.meta.updated")]
    TerminalMetaUpdated(TerminalMetaUpdated),
    #[serde(rename = "terminal.modes.sync")]
    TerminalModesSync(TerminalModesSync),
    #[serde(rename = "terminal.output")]
    TerminalOutput(TerminalOutput),
    #[serde(rename = "terminal.output.batch")]
    TerminalOutputBatch(TerminalOutputBatch),
    #[serde(rename = "terminal.output.gap")]
    TerminalOutputGap(TerminalOutputGap),
    #[serde(rename = "terminal.replaced")]
    TerminalReplaced(TerminalReplaced),
    #[serde(rename = "terminal.session.associated")]
    TerminalSessionAssociated(TerminalSessionAssociated),
    #[serde(rename = "terminal.status")]
    TerminalStatus(TerminalStatus),
    #[serde(rename = "terminal.stream.changed")]
    TerminalStreamChanged(TerminalStreamChanged),
    // Wedge-backstop addition; joined the frozen inventory
    // (SERVER_MESSAGE_TYPES + regenerated contract) in this change:
    // the terminal-mode stuck edge — `{ terminalId, at, stuck }`, emitted ONCE
    // per stuck/unstuck transition by the stuck monitor, and once to a
    // freshly attaching subscriber while the row is flagged. The
    // terminal-mode analogue of freshcodex's `freshAgent.status:"stuck"` —
    // never a `terminal.turn.complete` fabrication. See
    // [`TerminalStuck`] and `spawn_stuck_monitor`.
    #[serde(rename = "terminal.stuck")]
    TerminalStuck(TerminalStuck),
    #[serde(rename = "terminal.title.updated")]
    TerminalTitleUpdated(TerminalTitleUpdated),
    #[serde(rename = "terminal.turn.complete")]
    TerminalTurnComplete(TerminalTurnComplete),
    #[serde(rename = "terminals.changed")]
    TerminalsChanged(TerminalsChanged),
    #[serde(rename = "ui.command")]
    UiCommand(UiCommand),
}

/// The exact `type` discriminants of every server→client message, in the frozen
/// inventory's order. This is the T0 conformance checklist.
pub const SERVER_MESSAGE_TYPES: [&str; 69] = [
    "amplifier.activity.list.response",
    "amplifier.activity.updated",
    "claude.activity.list.response",
    "claude.activity.updated",
    "codex.activity.list.response",
    "codex.activity.updated",
    "codingcli.created",
    "codingcli.event",
    "codingcli.exit",
    "codingcli.killed",
    "codingcli.stderr",
    "config.fallback",
    "error",
    "extension.server.error",
    "extension.server.ready",
    "extension.server.starting",
    "extension.server.stopped",
    "extensions.registry",
    "freshAgent.create.failed",
    "freshAgent.created",
    "freshAgent.event",
    "freshAgent.forked",
    "freshAgent.killed",
    "freshAgent.send.accepted",
    "freshAgent.session.materialized",
    "hoststats.refresh.response",
    "hoststats.snapshot",
    "opencode.activity.list.response",
    "opencode.activity.updated",
    "pane.closed.result",
    "pane.opened.result",
    "pane.reconcile.result",
    "panes.closed.result",
    "perf.logging",
    "pong",
    "ready",
    "runtime.inventory.changed",
    "runtime.view.changed",
    "session.name.updated",
    "session.repair.activity",
    "session.runtimeOwner",
    "session.status",
    "sessions.changed",
    "settings.updated",
    "tabs.sync.ack",
    "tabs.sync.snapshot",
    "terminal.attach.ready",
    "terminal.codex.durability.updated",
    "terminal.created",
    "terminal.detached",
    "terminal.exit",
    "terminal.idle",
    "terminal.input.blocked",
    "terminal.inventory",
    "terminal.killed",
    "terminal.meta.updated",
    "terminal.modes.sync",
    "terminal.output",
    "terminal.output.batch",
    "terminal.output.gap",
    "terminal.replaced",
    "terminal.session.associated",
    "terminal.status",
    "terminal.stream.changed",
    "terminal.stuck",
    "terminal.title.updated",
    "terminal.turn.complete",
    "terminals.changed",
    "ui.command",
];

/// Supervisor startup-scan readiness carried by
/// [`ServerMessage::RuntimeInventoryChanged`]. Mirrors
/// `ManagedRuntimeInitialScanStateSchema` in `shared/managed-runtime.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManagedRuntimeInitialScanState {
    Pending,
    Scanning,
    Complete,
    Blocked,
}

/// How a view intent came to exist. `automatic_primary` is the one view the
/// supervisor mints for a soul that has none; `explicit` is operator-created.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedRuntimeViewKind {
    AutomaticPrimary,
    Explicit,
}

/// Whether a view intent is currently rendered, detached, or suppressed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ManagedRuntimeViewVisibility {
    Visible,
    Detached,
    Hidden,
}

/// Startup-scan readiness for the managed runtime inventory. Mirrors
/// `ManagedRuntimeReadinessSchema`; the four optional fields are absent (not
/// null) before the scan reaches the corresponding milestone.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeReadiness {
    pub inventory_revision: u64,
    pub initial_scan_state: ManagedRuntimeInitialScanState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_scan_started_at: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_scan_finished_at: Option<i64>,
    pub blocked_subsystems: Vec<String>,
    pub startup_recovery_concurrency_limit: u64,
    pub startup_recovery_peak: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub initial_scan_duration_ms: Option<u64>,
}

/// One durable view intent. Mirrors `ManagedRuntimeViewIntentSchema`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedRuntimeViewIntent {
    pub view_id: String,
    pub soul_id: String,
    pub owner_id: String,
    pub workspace_id: String,
    pub kind: ManagedRuntimeViewKind,
    pub preferred_tab_id: String,
    pub preferred_pane_id: String,
    pub title: String,
    pub placement_group: String,
    pub visibility: ManagedRuntimeViewVisibility,
    pub revision: u64,
    pub soul_intent_revision: u64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The supervisor inventory advanced to a new reconciled revision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInventoryChanged {
    pub revision: u64,
    pub readiness: ManagedRuntimeReadiness,
}

/// A single view-projection event was applied. `eventId` is the supervisor
/// outbox id the web projection acknowledges, so the edge stays replay-safe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeViewChanged {
    pub inventory_revision: u64,
    pub event_id: String,
    pub view: ManagedRuntimeViewIntent,
}

/// Extension server→client discriminants declared BEYOND the generated
/// inventory (`port/contract/ws-message-inventory.json`). Since the
/// 2026-07-26 reconciliation the only entry is `durability.degraded` — a
/// Rust-server-only frame (P1.8 pane-identity ledger, emitted by
/// `crates/freshell-ws/src/pane_ledger.rs`) with no TypeScript
/// counterpart: the inventory is generated from `shared/ws-protocol.ts`,
/// so it cannot carry it. NOT the same family as the frozen
/// `terminal.codex.durability.updated` (codex-sidecar durability); the
/// name collision is nearest-neighbor only. If the client ever grows a
/// consumer, add the Zod schema to `shared/ws-protocol.ts`, run
/// `pnpm run contract:generate`, and promote this into
/// [`SERVER_MESSAGE_TYPES`]. Shape pinned by `tests/activity_extension.rs`.
pub const EXTENSION_SERVER_MESSAGE_TYPES: [&str; 2] =
    ["durability.degraded", "freshAgent.recovery.stopped"];

// ---------------------------------------------------------------------------
// Server-only enums.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ConfigFallbackReason {
    ParseError,
    VersionMismatch,
    ReadError,
    Enoent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionRepairEvent {
    Error,
    Scanned,
    Repaired,
}

/// Live terminal runtime status (`running | recovering | stopping`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus {
    Running,
    Recovering,
    /// A requested stop of the row's unit is in flight (Gone not confirmed
    /// yet): an inventory row reports it, with `stoppingSince`, so clients
    /// derive "Stopping…" from server state.
    Stopping,
    /// The auto-resume SETTLE frame (kata znhn item 3): broadcast with the
    /// OLD terminal id whenever a planned auto-resume settles without a
    /// replacement (guard-abort, retries exhausted, flap circuit breaker,
    /// user cancel) so the client clears the recovering notice on a FRAME,
    /// never on a timer.
    Exited,
}

/// Terminal lifecycle status in the inventory (`running | exited`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalRunStatus {
    Running,
    Exited,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalInputBlockedReason {
    CodexIdentityPending,
    CodexIdentityCaptureTimeout,
    CodexIdentityUnavailable,
    CodexRecoveryPending,
    CodexCleanExitDecisionPending,
    CodexLifecycleLossPending,
    /// The managed soul is fenced while its exact provider identity is being
    /// reattached or resurrected. No input reached either incarnation.
    ManagedRecoveryPending,
    /// Recovery reached an explicit blocked verdict and requires repair/retry.
    ManagedRecoveryBlocked,
    /// Silent-loss fix (kata dtfn): `terminal.input` named a terminalId the
    /// registry does not have (never created, killed, or pre-restart). The
    /// reference answers `error{INVALID_TERMINAL_ID}` (`ws-handler.ts:2991-3002`);
    /// the port uses this richer frame, which the client already renders as a
    /// visible xterm notice.
    UnknownTerminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalStreamChangedReason {
    NewPtySession,
    CodexPtyRecovery,
    RetentionLost,
    ServerRestartIncompatibleRetention,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalOutputGapReason {
    QueueOverflow,
    ReplayWindowExceeded,
    ReplayBudgetExceeded,
    /// Responsive-terminal-restore W1 (round-4, plan:146): the paced
    /// session's FIXED delivery boundary was reached with output staged
    /// beyond it — the connection missed the declared interval's sequenced
    /// output, but the ring RETAINED it (delivery loss, not retention
    /// loss). Emitted ONLY on connections that negotiated
    /// `pacedTerminalReplayV1` (the paced completion core is its only
    /// emitter). The client repairs from its surface cursor (the same
    /// checkpoint-cursor delta repair as `queue_overflow`): a finite
    /// delivery window cannot guarantee convergence against indefinitely
    /// faster output production, so the bounded session reports the exact
    /// interval and the client's bounded baseline recovery fetches it.
    HandoffBoundaryReached,
}

/// `terminal.attach.ready.replayResetReason` — why the attach's effective
/// replay position was reset instead of honoring the requested one
/// (responsive-terminal-restore shared contract).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalReplayResetReason {
    /// The geometry-authority check rejected the requested position (the
    /// only pre-restore-contract value; const on the wire).
    GeometryAuthorityUnknown,
    /// The requested position predates the retained replay window
    /// (retention loss). Emitted ONLY on connections that negotiated
    /// `pacedTerminalReplayV1` — task 3's negotiated retention-gap emission;
    /// this increment only extends the value space, no emitter sets it yet.
    RetentionLost,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OutputSource {
    Live,
    Replay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SegmentBarrier {
    Control,
    StartupProbe,
    Osc52,
    RequestMode,
    TurnComplete,
    Gap,
    Geometry,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeometryAuthority {
    SingleClient,
    ServerStream,
    MultiClientUnknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtensionCategory {
    Client,
    Server,
    Cli,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RestoreErrorReason {
    DeadLiveHandle,
    MissingCanonicalIdentity,
    InvalidLegacyRestoreTarget,
    ProviderRuntimeFailed,
    DurableArtifactMissing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScrollInputPolicy {
    Native,
    FallbackToCursorKeysWhenAltScreenMouseCapture,
}

// ---------------------------------------------------------------------------
// Small shared server payloads.
// ---------------------------------------------------------------------------

/// Payloads carrying only `{ terminalId }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdOnly {
    pub terminal_id: String,
}

/// The correlated `terminal.kill` answer (delta-r6-r3 / focused-episode-6
/// round 2): sent only when the kill carried `requestId`. `success: false`
/// (with `error`) = the durable close failed and the terminal was left
/// untouched — the closing client must not drop the pane; `success: true`
/// covers the already-gone terminal too (the close envelope was still
/// written — a missing registry entry is not a close failure).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalKilled {
    pub request_id: String,
    pub terminal_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// kata b8ke fence-heal (Task 4): stale-claim refusals only — the
    /// incumbent owner's kind ("terminal" | "fresh-agent"). Additive and
    /// omitted everywhere else, so every non-stale kill answer stays
    /// byte-identical on the wire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_kind: Option<String>,
    /// kata b8ke fence-heal (Task 4): the coordinator's generation at
    /// refusal time — with `owner_epoch`, lets the client refresh its
    /// observed fence from the refusal itself (the killed ack is the ONLY
    /// frame the client's correlated kill await resolves). Additive and
    /// omitted everywhere else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_generation: Option<u64>,
    /// kata b8ke fence-heal (Task 4): the emitting server's boot epoch for
    /// the owner fields (a fence pair from a different epoch is always
    /// stale). Additive and omitted everywhere else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_epoch: Option<u64>,
}

/// The correlated `pane.closed` answer (delta-r7-round-3, focused-episode-7
/// round 2, Finding F2): sent once per `pane.closed`, AFTER the durable
/// pane-close journal write resolved, so the closing client can await the
/// evidence's durability before dropping the pane (the kill lane's
/// close-ack rule). Correlated by the pane identity itself — the close is
/// keyed by `createRequestId` end to end, so no separate request id exists.
/// `terminalId` echoes the message's when present (absent on the
/// in-flight-create close shape). `success: false` (with `error`) means the
/// durable record could NOT be written — the pane must stay open and the
/// failure must surface on it; a persisted-despite-reported-error record
/// still answers `success: true` (the evidence IS durable).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneClosedResult {
    pub create_request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The correlated `panes.closed` answer (focused-episode-7 round 3, Finding
/// F1): sent ONCE per batch close, AFTER the ONE durable batch envelope
/// write resolved, so the closing client can await the whole tab's close
/// evidence before dropping the tab. Correlated by the close op's own
/// `requestId` (the batch answers the op, not a pane — terminal.kill's
/// precedent; a cross-device retry of the same tab is an idempotent
/// re-journal). `success: false` (with `error`) means NOTHING of the set is
/// durable — the client keeps the whole tab and shows the failure on every
/// gated pane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PanesClosedResult {
    pub request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The correlated `pane.opened` answer (focused-episode-7 round 5, Finding
/// F3): sent once per `pane.opened`, AFTER the durable consume/re-assert
/// resolved — correlated by the pane identity (the re-assertion is keyed by
/// `createRequestId` end to end, the `pane.closed.result` precedent).
/// `success: false` (with `error`) means the consume could NOT be journaled
/// durably: the standing close record is untouched (fail loud, never
/// pretend), the client marks the pane and retries on its next sweep tick.
/// Additive, no version bump — the client never awaits this answer (see
/// `shared/ws-version.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneOpenedResult {
    pub create_request_id: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Payloads carrying only `{ name }` (extension.server.starting / stopped).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionServerNamed {
    pub name: String,
}

// --- activity families ------------------------------------------------------

/// `AmplifierActivityListResponseSchema` (`shared/ws-protocol.ts:175-180`) —
/// extension surface, see [`EXTENSION_SERVER_MESSAGE_TYPES`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmplifierActivityListResponse {
    pub request_id: String,
    pub terminals: Vec<AmplifierActivityRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_turn_completions: Option<Vec<TurnCompletionSnapshot>>,
}

/// `AmplifierActivityUpdatedSchema` (`shared/ws-protocol.ts:182-186`) —
/// extension surface, see [`EXTENSION_SERVER_MESSAGE_TYPES`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmplifierActivityUpdated {
    pub remove: Vec<String>,
    pub upsert: Vec<AmplifierActivityRecord>,
}

/// `terminal.idle.reason` — why the server believes the terminal is truly
/// idle: `grace` = a grace window passed with no new activity after the turn
/// boundary; `queue-empty` = queued-prompt evidence was observed during the
/// turn (a boundary while busy, or a codex busy→pending re-arm) and the
/// queue has since drained.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TerminalIdleReason {
    #[serde(rename = "grace")]
    Grace,
    #[serde(rename = "queue-empty")]
    QueueEmpty,
}

/// `terminal.idle` — the NEW truly-idle edge (pinned wire contract:
/// `{ terminalId, at (server epoch ms), reason: 'grace' | 'queue-empty' }`),
/// emitted ONCE per busy→truly-idle transition. Subagent/tool completions
/// inside a running turn never produce it. Extension surface, see
/// [`EXTENSION_SERVER_MESSAGE_TYPES`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdle {
    pub terminal_id: String,
    pub at: i64,
    pub reason: TerminalIdleReason,
}

/// `terminal.stuck` — the agent-pane wedged flag (surface-only; the client
/// renders the "Agent appears stuck" card from it and offers kill/restart).
/// Pinned wire contract: `port/contract/ws-server-messages.schema.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStuck {
    pub terminal_id: String,
    pub at: i64,
    pub stuck: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeActivityListResponse {
    pub request_id: String,
    pub terminals: Vec<ClaudeActivityRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_turn_completions: Option<Vec<TurnCompletionSnapshot>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeActivityUpdated {
    pub remove: Vec<String>,
    pub upsert: Vec<ClaudeActivityRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexActivityListResponse {
    pub request_id: String,
    pub terminals: Vec<CodexActivityRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_turn_completions: Option<Vec<TurnCompletionSnapshot>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexActivityUpdated {
    pub remove: Vec<String>,
    pub upsert: Vec<CodexActivityRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeActivityListResponse {
    pub request_id: String,
    pub terminals: Vec<OpencodeActivityRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_turn_completions: Option<Vec<TurnCompletionSnapshot>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeActivityUpdated {
    pub remove: Vec<String>,
    pub upsert: Vec<OpencodeActivityRecord>,
}

// --- codingcli.* ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCliCreated {
    pub provider: String,
    pub request_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCliEvent {
    /// Provider-specific payload (opaque).
    pub event: Value,
    pub provider: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCliExit {
    pub exit_code: i64,
    pub provider: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCliKilled {
    pub session_id: String,
    pub success: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCliStderr {
    pub provider: String,
    pub session_id: String,
    pub text: String,
}

// --- config / error ---------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigFallback {
    pub backup_exists: bool,
    pub reason: ConfigFallbackReason,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorMsg {
    pub code: ErrorCode,
    pub message: String,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_session_ref: Option<SessionLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_session_ref: Option<SessionLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// D8 (`SESSION_RESERVED` only): how long the loser should wait before
    /// re-sending its create. Additive and omitted everywhere else, so every
    /// other error frame stays byte-identical on the wire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    /// D7 (`RESTORE_UNAVAILABLE` only): the live terminal that owns the refused
    /// session, so the client can reattach instead of dead-ending. Additive and
    /// omitted everywhere else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_terminal_id: Option<String>,
    /// kata b8ke: ownership-conflict refusals only — the owning kind
    /// ("terminal" | "fresh-agent"). Additive and omitted everywhere else, so
    /// every non-ownership error frame stays byte-identical on the wire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_kind: Option<String>,
    /// kata b8ke: the owner's generation at refusal time — with
    /// `owner_epoch`, lets the client refresh its observed fence from the
    /// refusal itself. Additive and omitted everywhere else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_generation: Option<u64>,
    /// kata b8ke: the emitting server's boot epoch for the owner fields (a
    /// fence pair from a different epoch is always stale). Additive and
    /// omitted everywhere else.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_epoch: Option<u64>,
}

// --- extension.* ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionServerError {
    pub error: String,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionServerReady {
    pub name: String,
    pub port: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionTerminalBehavior {
    /// const `"canvas"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_renderer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scroll_input_policy: Option<ScrollInputPolicy>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionCli {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_command_template: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_model: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_effort: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_permission_mode: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_resume: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supports_sandbox: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_behavior: Option<ExtensionTerminalBehavior>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionPicker {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shortcut: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientExtensionEntry {
    pub category: ExtensionCategory,
    pub description: String,
    pub label: String,
    pub name: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli: Option<ExtensionCli>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content_schema: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picker: Option<ExtensionPicker>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_port: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_running: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionsRegistry {
    pub extensions: Vec<ClientExtensionEntry>,
}

// --- freshAgent.* (server) --------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentCreateFailed {
    pub code: String,
    pub message: String,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retryable: Option<bool>,
    /// kata b8ke (carried finding): fresh-agent refusals ride THIS frame,
    /// not ErrorMessage — the typed owner fields appear here so the client's
    /// refusal fold sees them on the fresh-agent lane. Omitted everywhere
    /// else, so legacy refusal frames stay byte-identical.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentCreated {
    pub provider: String,
    pub request_id: String,
    pub runtime_provider: String,
    pub session_id: String,
    /// Free string on the server side (unlike the client enum).
    pub session_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
    /// Unified agent names (Task 1 wire / Task 2 Rust side): canonical
    /// session-name projection for this session's naming ref (last-known;
    /// the `session.name.updated` broadcast is the live authority).
    /// Additive optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<SessionNameRecord>,
    /// Unified agent names: the naming identity this session's name resolves
    /// through (the pending handle before durable materialization).
    /// Additive optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_ref: Option<SessionNameRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentEvent {
    /// Provider-specific payload (opaque).
    pub event: Value,
    pub provider: String,
    pub session_id: String,
    pub session_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentForked {
    pub parent_session_id: String,
    pub provider: String,
    pub runtime_provider: String,
    pub session_id: String,
    pub session_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    /// Managed runtimes set this only after the same soul has retired the old
    /// provider session. Legacy servers omit it, preserving legacy cleanup.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_retired_by_runtime: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentKilled {
    pub provider: String,
    pub session_id: String,
    pub session_type: String,
    pub success: bool,
    /// b8ke focused review FR9: the typed refusal code when `success` is
    /// false (e.g. `INVALID_FENCE` for a half-sent observed fence pair) —
    /// additive and optional so legacy servers' frames stay valid. Clients
    /// reduce THIS code instead of the generic `KILL_FAILED` default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// The typed refusal's human-readable message (rides with `code`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentRecoveryStopped {
    pub request_id: String,
    pub provider: String,
    pub session_id: String,
    pub session_type: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentSendAccepted {
    pub provider: String,
    pub request_id: String,
    pub session_id: String,
    pub session_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submitted_turn_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentSessionMaterialized {
    pub previous_session_id: String,
    pub provider: String,
    pub session_id: String,
    pub session_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
    /// Unified agent names (Task 1 wire / Task 2 Rust side): the canonical
    /// name record AFTER the materialization's pending→durable transfer (the
    /// commit happens BEFORE this frame publishes the identity). Additive
    /// optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<SessionNameRecord>,
    /// Unified agent names: the durable naming identity the materialized
    /// session's name now resolves through. Additive optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_ref: Option<SessionNameRef>,
}

// --- pane.reconcile.result ----------------------------------------------------

/// Authoritative per-pane verdict (reconciliation-handshake design §4.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconcileVerdict {
    Attach,
    Respawn,
    Fresh,
    DeadSession,
    Invalid,
    /// Terminal per-pane error state (replaces the deleted `retry`):
    /// reason is one of "index_warming" | "provider_unavailable".
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneVerdict {
    /// Echoed verbatim, 1:1 with request order.
    pub pane_key: String,
    pub verdict: ReconcileVerdict,
    /// `attach` only: the live terminal to attach to.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    /// attach: authoritative identity; respawn: THE identity to resume with;
    /// dead_session: the claimed-but-missing identity, for the error UI.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
    /// Present iff the server overrode a differing client claim.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corrected: Option<bool>,
    /// fresh / dead_session / error / invalid: machine-readable code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Row 2b (invariant I6): a newer duplicate generation exists for the same
    /// `createRequestId`; the client stays on its live attachment and this
    /// merely flags the duplicate `terminalId`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate: Option<String>,
}

/// Sent ONLY in response to `pane.reconcile.request` — the server never
/// volunteers it (frozen-client inertness gate 3, design §3).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneReconcileResult {
    /// Echoed from the request.
    pub reconcile_id: String,
    /// This server process's boot.
    pub boot_id: String,
    pub server_instance_id: String,
    /// Cardinality invariant: `verdicts.len() == panes.len()`, matched 1:1 by
    /// `paneKey` — a malformed entry gets `invalid`, never omission.
    pub verdicts: Vec<PaneVerdict>,
}

// --- lifecycle / misc -------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PerfLogging {
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Pong {
    pub timestamp: String,
}

/// Server capability advertisement on `ready` (reconciliation-handshake design
/// §4.2). Populated **iff** the connection's `hello` carried the matching
/// client capability — today's frozen client never opts in, so the emitted
/// clean-boot handshake stays byte-for-byte unchanged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadyCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_reconcile_v1: Option<bool>,
    /// Fresh-agent restart resilience: `Some(true)` iff the connection's
    /// `hello` opted in via `capabilities.paneReconcileFreshAgentV1` —
    /// omitted from the wire entirely otherwise (frozen-client inertness).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_reconcile_fresh_agent_v1: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_interest_v1: Option<bool>,
    /// Paced terminal restore (responsive-terminal-restore Workstream 1):
    /// `Some(true)` iff the connection's `hello` opted in via
    /// `capabilities.pacedTerminalReplayV1` — omitted from the wire entirely
    /// otherwise (frozen-client inertness).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub paced_terminal_replay_v1: Option<bool>,
    /// Hidden-pane lifetime claims (responsive-terminal-restore Workstream 1):
    /// `Some(true)` iff the connection's `hello` opted in via
    /// `capabilities.terminalLifetimeClaimV1` — omitted from the wire entirely
    /// otherwise (frozen-client inertness). Present iff the client may send
    /// `terminal.interest.claimedTerminalIds`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_lifetime_claim_v1: Option<bool>,
    /// Phase 2 durable runtime acknowledgement. Present only when the client
    /// opted in and this server boot has an installed managed controller.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub managed_runtime_v1: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_instance_id: Option<String>,
    /// The git commit this server binary was built from (`"unknown"`
    /// fallback), stamped so the browser client can detect a client/server
    /// build mismatch and reload once. Omitted from the wire entirely when
    /// `None` (frozen-client inertness — same rule as `boot_id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub build_id: Option<String>,
    /// Reconciliation-handshake advertisement (§4.2): `Some` only when the
    /// client's `hello` opted in via `capabilities.paneReconcileV1`. A client
    /// must not send `pane.reconcile.request` unless the `ready` it just
    /// received advertised the capability.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ReadyCapabilities>,
    /// kata b8ke reconnect-owner discovery: current runtime-owner state for
    /// every recorded (provider, sessionId), so a device that missed a
    /// handoff broadcast (offline, lag-4008, page reload) learns the
    /// authoritative owner from the handshake alone. Omitted when `None`
    /// (frozen-client inertness — same rule as `boot_id`/`build_id`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_owners: Option<Vec<RuntimeOwnerReplay>>,
}

/// One `ready.runtimeOwners` replay record (kata b8ke reconnect-owner
/// discovery). `owner_kind` is the free wire string "terminal" |
/// "fresh-agent" | "vacant"; the emission site converts from
/// `freshell_ownership::RuntimeOwnerReplayRecord` (this crate stays
/// serde-only with no workspace deps).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeOwnerReplay {
    pub provider: String,
    pub session_id: String,
    /// The emitting server's boot epoch (round-2 review) — the client resets
    /// its generation state on epoch change instead of ignoring newer
    /// generations.
    pub epoch: u64,
    pub generation: u64,
    /// "terminal" | "fresh-agent" | "vacant"
    pub owner_kind: String,
    /// "live" | "fenced" (b8ke focused round-3 review R3-5): "fenced" marks
    /// a record whose `owner_kind` names the FENCED PRIOR — not a live
    /// owner. The client folds a fenced record as the typed recovery state
    /// (handoff-failed + reason), never as a committed owner.
    pub state: String,
    /// The typed fence reason (fenced records only):
    /// "watcher-failed" | "platform-limited".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    /// b8ke focused episode-2 post-cap F5 (wire-additive): for an
    /// ALIASED (re-keyed) key, the CANONICAL id the server resolved —
    /// the record's owner_kind/state/generation are the canonical
    /// record's truth, and `aliasOf` carries the navigation so an
    /// old-key pane converges on the authoritative owner.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_of: Option<String>,
}

/// `session.runtimeOwner` — kata b8ke: one server-authoritative runtime
/// owner per canonical `(provider, sessionId)`, broadcast at every ownership
/// transition (handoff started/committed/failed, release) so every device
/// holding a matching sessionRef pane converges on the same owner. The
/// client folds these reactively (like `freshAgent.turn.complete`);
/// nothing awaits an answer, so no protocol version bump. `owner_kind` /
/// `transition` are free wire strings ("terminal" | "fresh-agent" |
/// "vacant"; "handoff-started" | "handoff-committed" | "handoff-failed" |
/// "released") — the emission site converts from `freshell_ownership`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRuntimeOwner {
    pub provider: String,
    pub session_id: String,
    /// The emitting server's boot epoch (round-2 review): fenced
    /// comparisons use (epoch, generation), and a client that sees a
    /// different epoch resets its generation state.
    pub epoch: u64,
    pub generation: u64,
    /// "terminal" | "fresh-agent" | "vacant"
    pub owner_kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_kind: Option<String>,
    /// The owning terminal runtime (terminal-owner frames only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    /// The coordinator operation that produced this transition.
    pub operation_id: String,
    /// "handoff-started" | "handoff-committed" | "handoff-failed" | "released"
    pub transition: String,
    /// b8ke focused episode-2 post-cap F5 (wire-additive): the CANONICAL id
    /// this frame's session id was re-keyed to. Set on the rekey
    /// transition's OLD-key mirror frame so a device holding the pre-rekey
    /// id folds the canonical owner state and can navigate to the
    /// canonical key — never a permanent "vacant".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alias_of: Option<String>,
    /// Machine-readable failure reason (handoff-failed frames).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// b8ke focused round-4 review R4-5: `Some(true)` on a FENCED
    /// failure frame — the prior is still the FENCED owner (no live
    /// writer exists), so an online same-kind pane keeps the typed
    /// recovery state instead of resuming polling as a healthy owner.
    /// Omitted on every non-fenced frame (additive; pre-R4-5 servers never
    /// set it — their clients degrade to the pre-existing fold).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fenced: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRepairActivity {
    pub event: SessionRepairEvent,
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_depth: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orphan_count: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orphans_fixed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub session_id: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chain_depth: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub orphans_fixed: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionsChanged {
    pub revision: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SettingsUpdated {
    pub settings: ServerSettings,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsSyncAck {
    pub accepted: bool,
    pub closed_records: i64,
    pub open_records: i64,
    /// `false` when the accepted push was NOT durably persisted (fail-loud
    /// honesty, campaign P2.17). Omitted when persisted normally or when
    /// persistence was skipped by design (empty push, persistence disabled),
    /// keeping pre-change acks byte-identical on the wire.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persisted: Option<bool>,
    /// Machine-readable reason accompanying `persisted:false`
    /// (e.g. "oversize"). Serializes as `persistReason`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub persist_reason: Option<String>,
}

// --- tabs.sync.snapshot -----------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabDevice {
    pub device_id: String,
    pub device_label: String,
    pub last_seen_at: i64,
}

/// Open tab record — an open object; unknown keys are preserved verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabOpenRecord {
    pub client_instance_id: String,
    pub device_id: String,
    pub device_label: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

/// Closed tab record — an open object; unknown keys are preserved verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabClosedRecord {
    pub device_id: String,
    pub device_label: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsSyncData {
    pub closed: Vec<TabClosedRecord>,
    pub devices: Vec<TabDevice>,
    pub local_open: Vec<TabOpenRecord>,
    pub remote_open: Vec<TabOpenRecord>,
    pub same_device_open: Vec<TabOpenRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabsSyncSnapshot {
    pub data: TabsSyncData,
    pub request_id: String,
}

// --- terminal.* (server) ----------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttachReady {
    pub head_seq: i64,
    pub replay_from_seq: i64,
    pub replay_to_seq: i64,
    pub stream_id: String,
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effective_since_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_authority: Option<GeometryAuthority>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geometry_epoch: Option<i64>,
    /// Restore contract (responsive-terminal-restore): the earliest sequence
    /// position still available for replay — the retained ring's front
    /// `seqStart`, or `head_seq + 1` when nothing older than the head is
    /// retained. Emitted ONLY on connections that negotiated
    /// `pacedTerminalReplayV1`; omitted otherwise so the frozen client's
    /// frame stays byte-identical.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_retained_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_reset_reason: Option<TerminalReplayResetReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requested_since_seq: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCodexDurabilityUpdated {
    pub durability: CodexDurability,
    pub terminal_id: String,
}

/// P1.8 write-failure policy (spec §4.2): pushed LIVE at ledger-write
/// failure time so the warning arrives BEFORE the restart it warns about —
/// never a posthumous verdict flag. Frozen clients ignore unknown frame
/// types; rendering lands with the Phase 3 client adoption lane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurabilityDegraded {
    pub terminal_id: String,
    /// Machine-readable, e.g. "ledger_write_failed".
    pub reason: String,
    /// Human-readable pane warning.
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRestoreError {
    /// const `"RESTORE_UNAVAILABLE"`.
    pub code: String,
    pub reason: RestoreErrorReason,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreated {
    pub created_at: i64,
    pub request_id: String,
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clear_codex_durability: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Resume-validation feature: operator-visible notice set when the server
    /// dropped a stale resume id and spawned fresh. The client writes it into
    /// the pane's xterm. Optional/additive — Node never sets it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_error: Option<TerminalRestoreError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
    /// Unified agent names (Task 1 wire / Task 2 Rust side): canonical
    /// session-name projection for this terminal's naming ref (last-known;
    /// the `session.name.updated` broadcast is the live authority).
    /// Additive optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<SessionNameRecord>,
    /// Unified agent names: the naming identity this terminal's name
    /// resolves through (the pending handle before durable materialization).
    /// Additive optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_ref: Option<SessionNameRef>,
    /// b8ke fence-heal: the committed owner pair when THIS create's claim
    /// committed Live{Terminal} under a wired coordinator (additive,
    /// skip-None frozen-client parity — omitted fields keep the frame
    /// byte-identical to the pre-feature shape). Lets the creating client
    /// fold the fresh fence before its queued attach fires.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_epoch: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_generation: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExit {
    pub exit_code: i64,
    pub terminal_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInputBlocked {
    pub reason: TerminalInputBlockedReason,
    pub terminal_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryTerminal {
    pub created_at: i64,
    pub last_activity_at: i64,
    pub mode: String,
    pub status: TerminalRunStatus,
    pub terminal_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_durability: Option<CodexDurability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime_status: Option<RuntimeStatus>,
    /// When the stop of a `stopping` row began (epoch ms).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopping_since: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
    /// Unified agent names (Task 1 wire / Task 2 Rust side): canonical
    /// session-name projection (last-known display cache; never an accepted
    /// name input). Additive optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_name: Option<SessionNameRecord>,
    /// Unified agent names: the naming identity this terminal's name
    /// resolves through. Additive optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_ref: Option<SessionNameRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInventory {
    pub boot_id: String,
    pub terminals: Vec<InventoryTerminal>,
    pub terminal_meta: Vec<TerminalMetaRecord>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMetaUpdated {
    pub remove: Vec<String>,
    pub upsert: Vec<TerminalMetaRecord>,
}

/// Control-plane emulator-mode preamble emitted once per surface-fresh
/// attach, ordered ready < sync < replay < live on the requesting socket.
/// Carries the attach's request id and the CURRENT stream id so the client
/// can fold it through the same generation gates as replay content. `data`
/// holds the synthesized DEC private mode bytes projected
/// from the retained output stream (empty data => not emitted).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalModesSync {
    pub terminal_id: String,
    pub attach_request_id: String,
    pub stream_id: String,
    pub data: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutput {
    pub data: String,
    pub seq_end: i64,
    pub seq_start: i64,
    pub stream_id: String,
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach_request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<OutputSource>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputSegment {
    pub end_offset: i64,
    pub raw_frame_count: i64,
    pub seq_end: i64,
    pub seq_start: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub barrier: Option<SegmentBarrier>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputBatch {
    pub attach_request_id: String,
    pub data: String,
    pub segments: Vec<OutputSegment>,
    pub seq_end: i64,
    pub seq_start: i64,
    pub serialized_bytes: i64,
    pub source: OutputSource,
    pub stream_id: String,
    pub terminal_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOutputGap {
    pub from_seq: i64,
    pub reason: TerminalOutputGapReason,
    pub stream_id: String,
    pub terminal_id: String,
    pub to_seq: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach_request_id: Option<String>,
    /// Restore contract (responsive-terminal-restore): the terminal's current
    /// `headSeq` at gap-emission time. Emitted ONLY on connections that
    /// negotiated `pacedTerminalReplayV1`; omitted otherwise so the frozen
    /// client's gap frame stays byte-identical.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_seq: Option<i64>,
    /// Restore contract (responsive-terminal-restore): the earliest sequence
    /// position still available for replay (the retained ring's front
    /// `seqStart`, or `head_seq + 1` when the ring is empty) at
    /// gap-emission time. Emitted ONLY on negotiated connections.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub oldest_retained_seq: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReplaced {
    pub old_terminal_id: String,
    pub new_terminal_id: String,
    pub exit_code: i64,
    pub attempt: u32,
    pub max_attempts: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionAssociated {
    pub session_ref: SessionLocator,
    pub terminal_id: String,
    /// Present only on a server-authoritative mid-session rebind; names the
    /// session id this association supersedes. Optional+additive on the wire
    /// (WS_PROTOCOL_VERSION deliberately not bumped -- see plan
    /// 2026-07-28-stale-resume-identity.md, Task 1).
    #[serde(
        rename = "previousSessionId",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub previous_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatus {
    pub status: RuntimeStatus,
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<i64>,
    /// Auto-resume `recovering` frames only: the bounded retry budget. The
    /// client renders attempt/maxAttempts from these FIELDS — `reason` prose
    /// is purely presentational and must never be parsed (council 7w4h/xkhx).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_attempts: Option<i64>,
    /// Auto-resume `recovering` frames only: the crashed generation's exit code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Flap-circuit-breaker settle frames only: successful auto-resumes
    /// inside the rolling window. The client renders the "crashed N times"
    /// banner from this FIELD — `reason` prose is presentational and must
    /// never be parsed (council 7w4h/xkhx).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_cycles: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStreamChanged {
    pub reason: TerminalStreamChangedReason,
    pub stream_id: String,
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach_request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTitleUpdated {
    pub terminal_id: String,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTurnComplete {
    pub at: i64,
    pub completion_seq: i64,
    pub provider: AgentProvider,
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalsChanged {
    pub revision: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recoverable_terminal_ids: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiCommand {
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

// --- hoststats.* -----------------------------------------------------------
//
// Shape authority: the zod schemas in `shared/ws-protocol.ts`
// (`HostStats*Schema`). Serde discipline: zod `.nullable()` (required-but-may
// -be-null) fields map to `Option<T>` that ALWAYS serialize (null allowed);
// zod `.optional()` (may-be-absent) fields map to `Option<T>` PLUS
// `#[serde(skip_serializing_if = "Option::is_none", default)]` — never
// serialized as explicit null. Pinned by `tests/hoststats_shape.rs`.

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsMachine {
    pub cores: u64,
    pub mem_total_bytes: u64,
    pub platform: String,
    pub wsl: bool,
    pub kernel: Option<String>,
    pub hostname: Option<String>,
    pub psi: bool,
    pub cgroup: String,
    pub thermal_count: u64,
    pub battery_present: bool,
    pub gpu: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsCpu {
    pub available: bool,
    pub usage_pct: f64,
    pub steal_pct: Option<f64>,
    pub per_core_pct: Vec<f64>,
    pub freq_m_hz: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsLoad {
    pub available: bool,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub cores: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsMemory {
    pub available: bool,
    pub source: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub cgroup_limit_bytes: Option<u64>,
    pub swap_total_bytes: Option<u64>,
    pub swap_used_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsPaging {
    pub available: bool,
    pub swap_in_kbps: f64,
    pub swap_out_kbps: f64,
    pub maj_faults_per_sec: f64,
    pub oom_kills_delta: u64,
    pub oom_kills_total: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsPsi {
    pub available: bool,
    pub cpu_some10: Option<f64>,
    pub mem_some10: Option<f64>,
    pub mem_full10: Option<f64>,
    pub io_some10: Option<f64>,
    pub io_full10: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsDiskIo {
    pub available: bool,
    pub read_bps: f64,
    pub write_bps: f64,
    pub util_pct: Option<f64>,
    pub weighted_await_ms: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsNetwork {
    pub available: bool,
    pub rx_bps: f64,
    pub tx_bps: f64,
    pub rx_errors_total: u64,
    pub tx_errors_total: u64,
    pub rx_dropped_total: u64,
    pub tx_dropped_total: u64,
    pub rx_errors_delta: u64,
    pub tx_errors_delta: u64,
    pub rx_dropped_delta: u64,
    pub tx_dropped_delta: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsLimits {
    pub available: bool,
    pub fds_used: Option<u64>,
    pub fds_max: Option<u64>,
    pub pids_used: Option<u64>,
    pub pids_max: Option<u64>,
    pub time_wait: Option<u64>,
    pub ephemeral_ports: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsFreshell {
    pub available: bool,
    pub source: String,
    pub ptys_running: u64,
    pub ptys_max: u64,
    pub ws_clients: u64,
    pub ws_clients_max: u64,
    pub event_loop_lag_p99_ms: Option<f64>,
    pub rss_bytes: Option<u64>,
    pub uptime_sec: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsLive {
    pub machine: HostStatsMachine,
    pub cpu: HostStatsCpu,
    pub load: HostStatsLoad,
    pub memory: HostStatsMemory,
    pub paging: HostStatsPaging,
    pub psi: HostStatsPsi,
    pub disk_io: HostStatsDiskIo,
    pub network: HostStatsNetwork,
    pub limits: HostStatsLimits,
    pub freshell: HostStatsFreshell,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsTopProcess {
    pub pid: u64,
    pub name: String,
    pub cpu_pct: f64,
    pub rss_bytes: u64,
    pub state: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsTopProcesses {
    pub available: bool,
    pub dwell_ms: u64,
    pub list: Vec<HostStatsTopProcess>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsProcessHealth {
    pub available: bool,
    pub zombies: u64,
    pub d_state: u64,
    pub total: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsInotify {
    pub available: bool,
    pub instances: Option<u64>,
    pub watches: Option<u64>,
    pub max_user_watches: Option<u64>,
    pub max_user_instances: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsDisk {
    pub mount: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
    pub used_pct: f64,
    pub inodes_total: Option<u64>,
    pub inodes_free: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsDisks {
    pub available: bool,
    pub list: Vec<HostStatsDisk>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsThermalZone {
    pub label: String,
    pub celsius: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsBattery {
    pub pct: f64,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsThermals {
    pub available: bool,
    pub zones: Vec<HostStatsThermalZone>,
    pub battery: Option<HostStatsBattery>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsManual {
    pub top_processes: HostStatsTopProcesses,
    pub process_health: HostStatsProcessHealth,
    pub inotify: HostStatsInotify,
    pub disks: HostStatsDisks,
    pub thermals: HostStatsThermals,
    pub section_errors: HashMap<String, String>,
}

/// `HostStatsSnapshotSchema` (`shared/ws-protocol.ts`).
/// `manual_at`/`manual` are zod `.nullable()` (required, may be null) — they
/// serialize explicitly as `null`, never skipped.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsSnapshot {
    pub at: u64,
    pub live: HostStatsLive,
    pub manual_at: Option<u64>,
    pub manual: Option<HostStatsManual>,
}

/// `HostStatsRefreshResponseSchema` (`shared/ws-protocol.ts`).
/// `at`/`manual`/`error` are zod `.optional()` (may be absent) — they are
/// omitted from the wire when `None`, never serialized as explicit null.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostStatsRefreshResponse {
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub manual: Option<HostStatsManual>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_runtime_owner_frame_round_trips_with_the_frozen_tag() {
        let msg = ServerMessage::SessionRuntimeOwner(SessionRuntimeOwner {
            provider: "codex".into(),
            session_id: "01a0828d".into(),
            epoch: 41,
            generation: 7,
            owner_kind: "terminal".into(),
            previous_kind: Some("fresh-agent".into()),
            terminal_id: Some("t-91".into()),
            operation_id: "handoff-abc".into(),
            transition: "handoff-committed".into(),
            reason: None,
            fenced: None,
            alias_of: None,
        });
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(
            json.contains(r#""type":"session.runtimeOwner""#),
            "wire tag must be exact: {json}"
        );
        assert!(
            json.contains(r#""sessionId":"01a0828d""#),
            "fields must be camelCase: {json}"
        );
        let back: ServerMessage = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, msg);
    }

    /// b8ke focused round-4 review R4-5: the fenced failure frame carries
    /// the additive `fenced: true` marker (camelCase, omitted when absent)
    /// — the client's same-kind panes keep the typed recovery state
    /// instead of resuming polling as a healthy owner.
    #[test]
    fn session_runtime_owner_fenced_failure_frame_carries_the_marker() {
        let msg = ServerMessage::SessionRuntimeOwner(SessionRuntimeOwner {
            provider: "codex".into(),
            session_id: "sid-fenced-failure".into(),
            epoch: 41,
            generation: 7,
            owner_kind: "terminal".into(),
            previous_kind: Some("terminal".into()),
            terminal_id: Some("t-91".into()),
            operation_id: "handoff-abc".into(),
            transition: "handoff-failed".into(),
            reason: Some("REAP_TIMEOUT".into()),
            fenced: Some(true),
            alias_of: None,
        });
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(
            json.contains(r#""fenced":true"#),
            "the fenced failure frame must carry the marker: {json}"
        );
        assert!(
            json.contains(r#""reason":"REAP_TIMEOUT""#),
            "the typed failure reason rides along: {json}"
        );
        let back: ServerMessage = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, msg);
    }

    #[test]
    fn session_runtime_owner_non_fenced_frames_omit_the_marker() {
        let msg = ServerMessage::SessionRuntimeOwner(SessionRuntimeOwner {
            provider: "codex".into(),
            session_id: "sid-plain".into(),
            epoch: 41,
            generation: 7,
            owner_kind: "terminal".into(),
            previous_kind: None,
            terminal_id: None,
            operation_id: "handoff-abc".into(),
            transition: "handoff-started".into(),
            reason: None,
            fenced: None,
            alias_of: None,
        });
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(
            !json.contains(r#""fenced""#),
            "a non-fenced frame omits the marker (additive wire): {json}"
        );
    }

    /// b8ke fence-heal (fix c): `terminal.created` carries the create's
    /// committed owner pair additively — camelCase, omitted when None so
    /// legacy frames stay byte-identical on the wire (frozen-client
    /// parity, the Error-frame owner-triple discipline).
    #[test]
    fn terminal_created_round_trips_the_additive_owner_pair_and_omits_it_when_none() {
        let with_owner = ServerMessage::TerminalCreated(TerminalCreated {
            created_at: 1_700_000_000_000,
            request_id: "req-fenceheal-1".into(),
            terminal_id: "t-91".into(),
            clear_codex_durability: None,
            cwd: Some("/tmp".into()),
            notice: None,
            restore_error: None,
            session_ref: None,
            session_name: None,
            name_ref: None,
            owner_kind: Some("terminal".into()),
            owner_epoch: Some(7),
            owner_generation: Some(3),
        });
        let json = serde_json::to_string(&with_owner).expect("serialize");
        assert!(
            json.contains(r#""type":"terminal.created""#),
            "wire tag must be exact: {json}"
        );
        assert!(json.contains(r#""ownerKind":"terminal""#), "{json}");
        assert!(json.contains(r#""ownerEpoch":7"#), "{json}");
        assert!(json.contains(r#""ownerGeneration":3"#), "{json}");
        let back: ServerMessage = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, with_owner);

        let legacy = ServerMessage::TerminalCreated(TerminalCreated {
            created_at: 1_700_000_000_000,
            request_id: "req-fenceheal-1".into(),
            terminal_id: "t-91".into(),
            clear_codex_durability: None,
            cwd: None,
            notice: None,
            restore_error: None,
            session_ref: None,
            session_name: None,
            name_ref: None,
            owner_kind: None,
            owner_epoch: None,
            owner_generation: None,
        });
        let legacy_json = serde_json::to_string(&legacy).expect("serialize");
        assert!(
            !legacy_json.contains("ownerKind"),
            "omit-when-absent keeps legacy created frames byte-identical: {legacy_json}"
        );
        assert!(
            !legacy_json.contains("ownerEpoch"),
            "omit-when-absent keeps legacy created frames byte-identical: {legacy_json}"
        );
        assert!(
            !legacy_json.contains("ownerGeneration"),
            "omit-when-absent keeps legacy created frames byte-identical: {legacy_json}"
        );
    }

    /// b8ke fence-heal (Task 4, review N-1): `terminal.killed`'s additive
    /// stale-claim trio round-trips — camelCase, present when Some, omitted
    /// when None so every non-stale kill answer stays byte-identical on the
    /// wire (frozen-client parity, the created-frame pair discipline).
    #[test]
    fn terminal_killed_round_trips_the_additive_owner_trio_and_omits_it_when_none() {
        let with_trio = ServerMessage::TerminalKilled(TerminalKilled {
            request_id: "req-fenceheal-kill-1".into(),
            terminal_id: "t-91".into(),
            success: false,
            error: Some("stale claim".into()),
            owner_kind: Some("terminal".into()),
            owner_epoch: Some(7),
            owner_generation: Some(3),
        });
        let json = serde_json::to_string(&with_trio).expect("serialize");
        assert!(
            json.contains(r#""type":"terminal.killed""#),
            "wire tag must be exact: {json}"
        );
        assert!(json.contains(r#""ownerKind":"terminal""#), "{json}");
        assert!(json.contains(r#""ownerEpoch":7"#), "{json}");
        assert!(json.contains(r#""ownerGeneration":3"#), "{json}");
        let back: ServerMessage = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, with_trio);

        let legacy = ServerMessage::TerminalKilled(TerminalKilled {
            request_id: "req-fenceheal-kill-1".into(),
            terminal_id: "t-91".into(),
            success: true,
            error: None,
            owner_kind: None,
            owner_epoch: None,
            owner_generation: None,
        });
        let legacy_json = serde_json::to_string(&legacy).expect("serialize");
        assert!(
            !legacy_json.contains("ownerKind"),
            "omit-when-absent keeps legacy killed frames byte-identical: {legacy_json}"
        );
        assert!(
            !legacy_json.contains("ownerEpoch"),
            "omit-when-absent keeps legacy killed frames byte-identical: {legacy_json}"
        );
        assert!(
            !legacy_json.contains("ownerGeneration"),
            "omit-when-absent keeps legacy killed frames byte-identical: {legacy_json}"
        );
    }

    #[test]
    fn error_message_accepts_additive_owner_fields_without_changing_the_frozen_text() {
        // The REAL repo type is `ErrorMsg` with its existing required +
        // optional fields — `timestamp` is REQUIRED (no skip_serializing_if);
        // fill the full real field set plus the three new additive ones
        // (round-1 review: the earlier `Error` sketch did not compile
        // against the repo type).
        let msg = ServerMessage::Error(ErrorMsg {
            code: ErrorCode::RestoreUnavailable,
            message: "Session 01a0828d is still running on the server.".into(),
            timestamp: "2026-09-09T00:00:00Z".into(),
            actual_session_ref: None,
            expected_session_ref: None,
            request_id: Some("req-1".into()),
            retry_after_ms: None,
            terminal_exit_code: None,
            terminal_id: None,
            live_terminal_id: None,
            owner_kind: Some("fresh-agent".into()),
            owner_generation: Some(7),
            owner_epoch: Some(41),
        });
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""ownerKind":"fresh-agent""#), "{json}");
        assert!(json.contains(r#""ownerEpoch":41"#), "{json}");
        assert!(json.contains("is still running on the server."));
        let back: ServerMessage = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, msg);
        // Additive-optional: a legacy error frame with no owner fields stays
        // byte-identical on the wire (the frozen refusal surface).
        let legacy = ServerMessage::Error(ErrorMsg {
            code: ErrorCode::InternalError,
            message: "unrelated".into(),
            timestamp: "2026-09-09T00:00:00Z".into(),
            actual_session_ref: None,
            expected_session_ref: None,
            request_id: None,
            retry_after_ms: None,
            terminal_exit_code: None,
            terminal_id: None,
            live_terminal_id: None,
            owner_kind: None,
            owner_generation: None,
            owner_epoch: None,
        });
        let legacy_json = serde_json::to_string(&legacy).expect("serialize");
        assert!(
            !legacy_json.contains("ownerKind"),
            "omit-when-absent keeps legacy error frames byte-identical: {legacy_json}"
        );
    }

    #[test]
    fn fresh_agent_create_failed_accepts_additive_owner_fields() {
        // Carried finding (independent plan review): fresh-agent refusals
        // ride `freshAgent.create.failed`, not ErrorMessage — the typed
        // owner fields must appear on THIS frame for the client's refusal
        // fold to see them. The terminal lane's refusal stays ErrorMessage
        // (covered above).
        let msg = ServerMessage::FreshAgentCreateFailed(FreshAgentCreateFailed {
            code: "RESTORE_UNAVAILABLE".into(),
            message: "Session 01a0828d is still running on the server.".into(),
            request_id: "req-9".into(),
            retryable: Some(true),
            owner_kind: Some("terminal".into()),
            owner_generation: Some(7),
            owner_epoch: Some(41),
        });
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""ownerKind":"terminal""#), "{json}");
        assert!(json.contains(r#""ownerEpoch":41"#), "{json}");
        let back: ServerMessage = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, msg);
        // Additive-optional: the legacy refusal shape stays byte-identical.
        let legacy = ServerMessage::FreshAgentCreateFailed(FreshAgentCreateFailed {
            code: "RESTORE_UNAVAILABLE".into(),
            message: "boom".into(),
            request_id: "req-10".into(),
            retryable: None,
            owner_kind: None,
            owner_generation: None,
            owner_epoch: None,
        });
        let legacy_json = serde_json::to_string(&legacy).expect("serialize");
        assert!(
            !legacy_json.contains("ownerKind"),
            "omit-when-absent keeps legacy refusals byte-identical: {legacy_json}"
        );
    }

    #[test]
    fn ready_frame_round_trips_additive_runtime_owners() {
        // kata b8ke reconnect-owner discovery (T1 rec A2): the ready frame
        // replays current runtime-owner state; omit-when-empty keeps legacy
        // frames byte-identical. Matches `Ready`'s real field set.
        // b8ke focused round-3 R3-5: every replay record carries its state
        // truth ("live" | "fenced") — a fenced record adds the typed reason.
        let msg = ServerMessage::Ready(Ready {
            timestamp: "2026-09-09T00:00:00Z".into(),
            boot_id: Some("boot-1".into()),
            server_instance_id: Some("inst-1".into()),
            build_id: None,
            capabilities: None,
            runtime_owners: Some(vec![
                RuntimeOwnerReplay {
                    provider: "codex".into(),
                    session_id: "01a0828d".into(),
                    epoch: 41,
                    generation: 4,
                    owner_kind: "terminal".into(),
                    state: "live".into(),
                    reason: None,
                    terminal_id: Some("t-91".into()),
                    alias_of: None,
                },
                RuntimeOwnerReplay {
                    provider: "claude".into(),
                    session_id: "fenced-1".into(),
                    epoch: 41,
                    generation: 7,
                    owner_kind: "terminal".into(),
                    state: "fenced".into(),
                    reason: Some("platform-limited".into()),
                    terminal_id: None,
                    alias_of: None,
                },
            ]),
        });
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(
            json.contains(r#""runtimeOwners":"#),
            "wire field must be camelCase: {json}"
        );
        assert!(
            json.contains(r#""state":"fenced""#) && json.contains(r#""reason":"platform-limited""#),
            "a fenced replay record carries its typed truth: {json}"
        );
        let back: ServerMessage = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, msg);
        let legacy = ServerMessage::Ready(Ready {
            timestamp: "2026-09-09T00:00:00Z".into(),
            boot_id: Some("boot-1".into()),
            server_instance_id: Some("inst-1".into()),
            build_id: None,
            capabilities: None,
            runtime_owners: None,
        });
        let legacy_json = serde_json::to_string(&legacy).expect("serialize");
        assert!(
            !legacy_json.contains("runtimeOwners"),
            "omit-when-empty keeps legacy ready frames byte-identical: {legacy_json}"
        );
    }
}
