//! Client → server messages (`ClientMessage`, 27 discriminants).
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
    #[serde(rename = "client.diagnostic")]
    ClientDiagnostic(ClientDiagnostic),
    #[serde(rename = "terminal.create")]
    TerminalCreate(TerminalCreate),
    #[serde(rename = "terminal.codex.candidate.persisted")]
    TerminalCodexCandidatePersisted(TerminalCodexCandidatePersisted),
    #[serde(rename = "terminal.attach")]
    TerminalAttach(TerminalAttach),
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
}

/// The exact `type` discriminants of every client→server message, in the frozen
/// inventory's order. This is the T0 conformance checklist.
pub const CLIENT_MESSAGE_TYPES: [&str; 27] = [
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
    "freshAgent.send",
    "hello",
    "opencode.activity.list",
    "ping",
    "terminal.attach",
    "terminal.codex.candidate.persisted",
    "terminal.create",
    "terminal.detach",
    "terminal.input",
    "terminal.kill",
    "terminal.resize",
    "ui.layout.sync",
    "ui.screenshot.result",
];

/// Extension client→server discriminants declared BEYOND the frozen T0
/// inventory — see `EXTENSION_SERVER_MESSAGE_TYPES` (server_messages.rs) for
/// the rationale; shapes pinned by `tests/activity_extension.rs`.
pub const EXTENSION_CLIENT_MESSAGE_TYPES: [&str; 1] = ["amplifier.activity.list"];

// --- hello ------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloCapabilities {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub terminal_output_batch_v1: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ui_screenshot_v1: Option<bool>,
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
    /// const `7`.
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub codex_durability: Option<CodexDurability>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_terminal: Option<LiveTerminalRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pane_id: Option<String>,
    /// const `"fresh_after_restore_unavailable"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_intent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub restore: Option<bool>,
    /// The spawn-time resume session id (`ws-handler.ts:656-658` — distinct from
    /// `sessionRef`; spec `cli-argv-fidelity.md` §3.3/U7: only the spawn-time id
    /// is modeled here, the binding/repair pipeline stays with coding-cli.md).
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalAttach {
    pub terminal_id: String,
    pub intent: TerminalAttachIntent,
    pub cols: i64,
    pub rows: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attach_request_id: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
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
