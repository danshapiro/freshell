//! Server → client messages (`ServerMessage`, 52 discriminants).
//!
//! These are TypeScript-typed (not runtime-validated) on the wire; their frozen
//! shape authority is `port/contract/ws-server-messages.schema.json`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::common::{
    AgentProvider, ClaudeActivityRecord, CodexActivityRecord, CodexDurability, ErrorCode,
    OpencodeActivityRecord, SessionLocator, TerminalMetaRecord, TurnCompletionSnapshot,
};
use crate::settings::ServerSettings;

/// A message sent from the server to a client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ServerMessage {
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
    #[serde(rename = "freshAgent.send.accepted")]
    FreshAgentSendAccepted(FreshAgentSendAccepted),
    #[serde(rename = "freshAgent.session.materialized")]
    FreshAgentSessionMaterialized(FreshAgentSessionMaterialized),
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
    #[serde(rename = "session.repair.activity")]
    SessionRepairActivity(SessionRepairActivity),
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
    #[serde(rename = "terminal.input.blocked")]
    TerminalInputBlocked(TerminalInputBlocked),
    #[serde(rename = "terminal.inventory")]
    TerminalInventory(TerminalInventory),
    #[serde(rename = "terminal.meta.updated")]
    TerminalMetaUpdated(TerminalMetaUpdated),
    #[serde(rename = "terminal.output")]
    TerminalOutput(TerminalOutput),
    #[serde(rename = "terminal.output.batch")]
    TerminalOutputBatch(TerminalOutputBatch),
    #[serde(rename = "terminal.output.gap")]
    TerminalOutputGap(TerminalOutputGap),
    #[serde(rename = "terminal.session.associated")]
    TerminalSessionAssociated(TerminalSessionAssociated),
    #[serde(rename = "terminal.status")]
    TerminalStatus(TerminalStatus),
    #[serde(rename = "terminal.stream.changed")]
    TerminalStreamChanged(TerminalStreamChanged),
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
pub const SERVER_MESSAGE_TYPES: [&str; 53] = [
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
    "opencode.activity.list.response",
    "opencode.activity.updated",
    "pane.reconcile.result",
    "perf.logging",
    "pong",
    "ready",
    "session.repair.activity",
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
    "terminal.input.blocked",
    "terminal.inventory",
    "terminal.meta.updated",
    "terminal.output",
    "terminal.output.batch",
    "terminal.output.gap",
    "terminal.session.associated",
    "terminal.status",
    "terminal.stream.changed",
    "terminal.title.updated",
    "terminal.turn.complete",
    "terminals.changed",
    "ui.command",
];

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

/// Live terminal runtime status (`running | recovering`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeStatus {
    Running,
    Recovering,
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

/// Payloads carrying only `{ name }` (extension.server.starting / stopped).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ExtensionServerNamed {
    pub name: String,
}

// --- activity families ------------------------------------------------------

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_exit_code: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
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
    Retry,
    Invalid,
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
    /// fresh / dead_session / retry / invalid: machine-readable code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// retry only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<i64>,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boot_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_instance_id: Option<String>,
    /// Reconciliation-handshake advertisement (§4.2): `Some` only when the
    /// client's `hello` opted in via `capabilities.paneReconcileV1`. A client
    /// must not send `pane.reconcile.request` unless the `ready` it just
    /// received advertised the capability.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<ReadyCapabilities>,
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
    /// const `"geometry_authority_unknown"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub replay_reset_reason: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore_error: Option<TerminalRestoreError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionAssociated {
    pub session_ref: SessionLocator,
    pub terminal_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalStatus {
    pub status: RuntimeStatus,
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attempt: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
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
