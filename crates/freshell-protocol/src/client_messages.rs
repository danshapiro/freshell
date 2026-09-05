//! Client → server messages (`ClientMessage`, 36 discriminants).
//!
//! These are the Zod-validated inbound surface. Deserialization is
//! accept-and-strip (no `deny_unknown_fields`), mirroring the runtime.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

use crate::common::{
    double_option, AgentProvider, CodexDurability, PermissionMode, Sandbox, SessionLocator,
    SessionType, Shell, StringOrNumber, TerminalAttachIntent, TerminalAttachPriority,
};

/// A message sent from a client to the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ClientMessage {
    #[serde(rename = "hello")]
    Hello(Hello),
    #[serde(rename = "ping")]
    Ping,
    #[serde(rename = "sessions.prefs")]
    SessionsPrefs(SessionsPrefs),
    #[serde(rename = "client.diagnostic")]
    ClientDiagnostic(ClientDiagnostic),
    #[serde(rename = "terminal.create")]
    TerminalCreate(TerminalCreate),
    #[serde(rename = "terminal.codex.candidate.persisted")]
    TerminalCodexCandidatePersisted(TerminalCodexCandidatePersisted),
    #[serde(rename = "terminal.attach")]
    TerminalAttach(TerminalAttach),
    #[serde(rename = "terminal.interest")]
    TerminalInterest(TerminalInterest),
    #[serde(rename = "terminal.autoResumeCancel")]
    TerminalAutoResumeCancel(TerminalAutoResumeCancel),
    #[serde(rename = "terminal.detach")]
    TerminalDetach(TerminalDetach),
    #[serde(rename = "terminal.input")]
    TerminalInput(TerminalInput),
    #[serde(rename = "terminal.resize")]
    TerminalResize(TerminalResize),
    #[serde(rename = "terminal.kill")]
    TerminalKill(TerminalKill),
    #[serde(rename = "codex.activity.list")]
    CodexActivityList(ActivityList),
    #[serde(rename = "opencode.activity.list")]
    OpencodeActivityList(ActivityList),
    #[serde(rename = "claude.activity.list")]
    ClaudeActivityList(ActivityList),
    // Extension surface (not in the frozen T0 inventory — see
    // `EXTENSION_CLIENT_MESSAGE_TYPES`): the frozen client already sends this
    // on connect (`src/App.tsx:696-701`), mirroring the legacy zod schema.
    #[serde(rename = "amplifier.activity.list")]
    AmplifierActivityList(ActivityList),
    #[serde(rename = "ui.layout.sync")]
    UiLayoutSync(UiLayoutSync),
    #[serde(rename = "ui.screenshot.result")]
    UiScreenshotResult(UiScreenshotResult),
    #[serde(rename = "codingcli.create")]
    CodingCliCreate(CodingCliCreate),
    #[serde(rename = "codingcli.input")]
    CodingCliInput(CodingCliInput),
    #[serde(rename = "codingcli.kill")]
    CodingCliKill(CodingCliKill),
    #[serde(rename = "freshAgent.create")]
    FreshAgentCreate(FreshAgentCreate),
    #[serde(rename = "freshAgent.attach")]
    FreshAgentAttach(FreshAgentAttach),
    #[serde(rename = "freshAgent.send")]
    FreshAgentSend(FreshAgentSend),
    #[serde(rename = "freshAgent.interrupt")]
    FreshAgentInterrupt(FreshAgentInterrupt),
    #[serde(rename = "freshAgent.compact")]
    FreshAgentCompact(FreshAgentCompact),
    #[serde(rename = "freshAgent.approval.respond")]
    FreshAgentApprovalRespond(FreshAgentApprovalRespond),
    #[serde(rename = "freshAgent.question.respond")]
    FreshAgentQuestionRespond(FreshAgentQuestionRespond),
    #[serde(rename = "freshAgent.kill")]
    FreshAgentKill(FreshAgentKill),
    #[serde(rename = "freshAgent.fork")]
    FreshAgentFork(FreshAgentFork),
    #[serde(rename = "freshAgent.undo")]
    FreshAgentUndo(FreshAgentUndo),
    #[serde(rename = "freshAgent.redo")]
    FreshAgentRedo(FreshAgentRedo),
    #[serde(rename = "pane.reconcile.request")]
    PaneReconcileRequest(PaneReconcileRequest),
    #[serde(rename = "hoststats.subscribe")]
    HostStatsSubscribe,
    #[serde(rename = "hoststats.unsubscribe")]
    HostStatsUnsubscribe,
    #[serde(rename = "hoststats.refresh")]
    HostStatsRefresh(HostStatsRefresh),
}

/// The exact `type` discriminants of every client→server message, in the frozen
/// inventory's order. This is the T0 conformance checklist.
pub const CLIENT_MESSAGE_TYPES: [&str; 37] = [
    "amplifier.activity.list",
    "claude.activity.list",
    "client.diagnostic",
    "codex.activity.list",
    "codingcli.create",
    "codingcli.input",
    "codingcli.kill",
    "freshAgent.approval.respond",
    "freshAgent.attach",
    "freshAgent.compact",
    "freshAgent.create",
    "freshAgent.fork",
    "freshAgent.interrupt",
    "freshAgent.kill",
    "freshAgent.question.respond",
    "freshAgent.redo",
    "freshAgent.send",
    "freshAgent.undo",
    "hello",
    "hoststats.refresh",
    "hoststats.subscribe",
    "hoststats.unsubscribe",
    "opencode.activity.list",
    "pane.reconcile.request",
    "ping",
    "sessions.prefs",
    "terminal.attach",
    "terminal.autoResumeCancel",
    "terminal.codex.candidate.persisted",
    "terminal.create",
    "terminal.detach",
    "terminal.input",
    "terminal.interest",
    "terminal.kill",
    "terminal.resize",
    "ui.layout.sync",
    "ui.screenshot.result",
];

/// Extension client→server discriminants declared beyond the generated
/// inventory. Empty since the 2026-07-26 contract reconciliation folded
/// `amplifier.activity.list` into the frozen surface (it has been a
/// first-class `shared/ws-protocol.ts` union member since PR #498).
pub const EXTENSION_CLIENT_MESSAGE_TYPES: [&str; 0] = [];

// --- hello ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_output_batch_v1: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_interest_v1: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_screenshot_v1: Option<bool>,
    /// Reconciliation handshake opt-in (design §4.1). A client that sets this
    /// MAY send `pane.reconcile.request` once the `ready` it receives
    /// advertises the capability back (§4.2). Absent for the frozen client.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_reconcile_v1: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloClient {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mobile: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HelloSessions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    /// const `8`.
    pub protocol_version: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<HelloCapabilities>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client: Option<HelloClient>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sessions: Option<HelloSessions>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sidebar_open_sessions: Option<Vec<SessionLocator>>,
}

/// Full presentation-interest snapshot for this connection. Validation of
/// cardinality, safe revision range and focused-in-visible runs at dispatch.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInterest {
    pub revision: u64,
    pub focused_terminal_id: Option<String>,
    pub visible_terminal_ids: Vec<String>,
}

// --- client.diagnostic ------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientDiagnostic {
    /// const `"restore_unavailable"`.
    pub event: String,
    /// const `false`.
    pub has_session_ref: bool,
    pub mode: String,
    pub pane_id: String,
    /// const `"dead_live_handle"`.
    pub reason: String,
    pub tab_id: String,
    pub terminal_id: String,
}

// --- sessions.prefs ---------------------------------------------------------

/// The client's includeSubagents listing preference (amplifier watch
/// reduction). Per-connection, pushed mid-session and on (re)connect;
/// old servers never receive it (frozen client) and new servers ignore
/// it on connections that never send one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionsPrefs {
    pub include_subagents: bool,
}

// --- terminal.* -------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTerminalRef {
    pub server_instance_id: String,
    pub terminal_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCreate {
    pub request_id: String,
    pub mode: String,
    pub shell: Shell,
    /// Legacy client repair hint (Codex durability state). Consumed by the
    /// legacy TS server (`server/ws-handler.ts:351-354`); deliberately ignored
    /// by the Rust server, superseded by `pane.reconcile` verdicts. Retained
    /// for frozen-wire compat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_durability: Option<CodexDurability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Legacy client repair hint (same-instance live-terminal reattach ref).
    /// Consumed by the legacy TS server; deliberately ignored by the Rust
    /// server, superseded by `pane.reconcile` verdicts. Retained for
    /// frozen-wire compat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_terminal: Option<LiveTerminalRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    /// const `"fresh_after_restore_unavailable"`. Legacy client repair hint;
    /// consumed by the legacy TS server; deliberately ignored by the Rust
    /// server, superseded by `pane.reconcile` verdicts (intent documented at
    /// `freshell-ws/src/terminal.rs:506-513`). Retained for frozen-wire
    /// compat.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_intent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore: Option<bool>,
    /// The spawn-time resume session id (`ws-handler.ts:656-658` — distinct from
    /// `sessionRef`; spec `cli-argv-fidelity.md` §3.3/U7: only the spawn-time id
    /// is modeled here, the binding/repair pipeline stays with coding-cli.md).
    /// Retained solely so the handler can detect-and-reject; see kata ejh6.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tab_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalCodexCandidatePersisted {
    pub candidate_thread_id: String,
    pub captured_at: i64,
    pub rollout_path: String,
    pub terminal_id: String,
}

/// znhn item 2: the user opts out of an in-flight auto-resume ("stop
/// trying, leave it dead"). Carries the OLD (crashed) terminal id — the
/// same id the recovering `terminal.status` frame was broadcast with.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAutoResumeCancel {
    pub terminal_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttach {
    pub terminal_id: String,
    pub intent: TerminalAttachIntent,
    pub cols: i64,
    pub rows: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach_request_id: Option<String>,
    /// Positive marker: the attaching xterm surface is freshly constructed
    /// (page load / renderer recreation / user reset) and needs an
    /// emulator-mode preamble. Accept-and-strip on older servers; the wire
    /// field is camelCase `surfaceReset`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub surface_reset: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_session_ref: Option<SessionLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_replay_bytes: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<TerminalAttachPriority>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since_seq: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDetach {
    pub terminal_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInput {
    pub data: String,
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_session_ref: Option<SessionLocator>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResize {
    pub cols: i64,
    pub rows: i64,
    pub terminal_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_session_ref: Option<SessionLocator>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalKill {
    pub terminal_id: String,
}

// --- *.activity.list --------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityList {
    pub request_id: String,
}

// --- ui.* -------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLayoutTab {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_session_ref: Option<SessionLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiLayoutSync {
    pub tabs: Vec<UiLayoutTab>,
    /// `Record<string, PaneLayout>` (opaque).
    pub layouts: Value,
    /// `Record<string, string>` — pane id -> active content key.
    pub active_pane: BTreeMap<String, String>,
    pub timestamp: i64,
    /// `string | null`, optional (absent / null / value all preserved).
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub active_tab_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_title_set_by_user: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_titles: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiScreenshotResult {
    pub request_id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub changed_focus: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_base64: Option<String>,
    /// const `"image/png"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restored_focus: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
}

// --- pane.reconcile.request ---------------------------------------------------

/// One pane's identity claims, as presented by a reconciling client
/// (reconciliation-handshake design §4.3). Every field is a HINT to be
/// validated, never trusted. All fields are parse-tolerant: a malformed entry
/// must still deserialize so the server can answer it with an `invalid`
/// verdict (total cardinality, §8) instead of failing the whole frame.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcilePane {
    /// OPAQUE to the server; echoed verbatim on the verdict. `""` when the
    /// client omitted it (the entry is then `invalid`).
    #[serde(default)]
    pub pane_key: String,
    /// v1: `"terminal"`; `"fresh-agent"` is answered on connections that
    /// negotiated `paneReconcileFreshAgentV1` (campaign §4.3) — otherwise it
    /// keeps the frozen-client `invalid{unsupported_kind}` contract.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `TerminalMode` string as persisted (`"shell"`, `"claude"`, …).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    /// The pane's stable creation key — required by contract (§5.5); an entry
    /// without one is `invalid`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub create_request_id: Option<String>,
    /// Last known live handle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub terminal_id: Option<String>,
    /// Locality hint, informational only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_instance_id: Option<String>,
    /// Optional identity claim.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
    /// Optional legacy single-key claim. PERMANENT compat door (kata ejh6):
    /// `pane.reconcile` is the SOLE ingress where a legacy
    /// `resumeSessionId` remains honored — old persisted pane content can
    /// carry a legacy-only claim indefinitely, so the server-side promotion
    /// in `crates/freshell-ws/src/reconcile.rs` (`promoted_legacy_claim`)
    /// stays forever with NO later-removal plan. Every create-class door
    /// rejects this field outright; this one alone promotes it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
    /// Informational only — never trusted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneReconcileRequest {
    /// Client-minted, echoed verbatim; correlation only.
    pub reconcile_id: String,
    /// Flat list — no tree, no tab structure. Cap: 200 entries (an over-cap
    /// request is answered with `error{RECONCILE_TOO_LARGE}`).
    pub panes: Vec<ReconcilePane>,
}

// --- codingcli.* ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCliCreate {
    pub prompt: String,
    /// Free-form provider string (`CodingCliProvider`).
    pub provider: String,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    /// Retained solely so the handler can detect-and-reject; see kata ejh6.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
    /// Canonical identity carrier (kata ejh6). Parity with the TS
    /// `CodingCliCreateSchema.sessionRef`. The spec
    /// (`port/machine/specs/cli-argv-fidelity.md` section 3.3/U7) governs
    /// `TerminalCreate.resume_session_id` (the spawn-time id) and is silent
    /// on `CodingCliCreate`; adding the canonical carrier here preserves the
    /// shared-contract invariant without violating the spec.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<Sandbox>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCliInput {
    pub data: String,
    pub session_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCliKill {
    pub session_id: String,
}

// --- freshAgent.* -----------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyRestoreContext {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSelection {
    pub kind: String,
    pub model_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentCreate {
    pub request_id: String,
    pub session_type: SessionType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_restore_context: Option<LegacyRestoreContext>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// `{ kind, modelId } | null`, optional.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub model_selection: Option<Option<ModelSelection>>,
    /// Free string here (unlike `codingcli.create`, which uses the enum).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugins: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<AgentProvider>,
    /// Retained solely so the handler can detect-and-reject; see kata ejh6.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<Sandbox>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentAttach {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Retained solely so the handler can detect-and-reject; see kata ejh6.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentImage {
    pub data: String,
    pub media_type: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentSendSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Free string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<Sandbox>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentSend {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub images: Option<Vec<FreshAgentImage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<FreshAgentSendSettings>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentInterrupt {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentCompact {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instructions: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentApprovalRespond {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    /// `Record<string, unknown>`.
    pub decision: Value,
    /// `string | number`.
    pub request_id: StringOrNumber,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentQuestionRespond {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    /// `Record<string, string>`.
    pub answers: BTreeMap<String, String>,
    /// `string | number`.
    pub request_id: StringOrNumber,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentKill {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentFork {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    /// `Record<string, unknown>`, optional.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RollbackMode {
    Step,
    ToTurn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentUndo {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    pub request_id: String,
    /// absent => step.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<RollbackMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentRedo {
    pub provider: AgentProvider,
    pub session_id: String,
    pub session_type: SessionType,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mode: Option<RollbackMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
}

// --- hoststats.* -----------------------------------------------------------

/// `HostStatsRefreshSchema` (`shared/ws-protocol.ts`) — client-minted
/// `requestId`, echoed verbatim by `hoststats.refresh.response`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HostStatsRefresh {
    #[serde(rename = "requestId")]
    pub request_id: String,
}
