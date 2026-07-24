//! Shared sub-types, enums, and serde helpers used by both the client→server and
//! server→client message families.
//!
//! Faithfully models the frozen contract (`port/contract/*.schema.json`,
//! `WS_PROTOCOL_VERSION = 7`). Modeling conventions:
//!
//! * All numeric wire fields are integers on the real wire, so they are typed
//!   `i64` (a few version discriminants are `u32`). Using `f64` would corrupt
//!   integer round-trips by emitting a trailing `.0`.
//! * Opaque blobs (`Record<string, unknown>`, `unknown`/`any`, SDK `event`
//!   payloads, `decision`, `input`, `payload`, layout content) are
//!   `serde_json::Value`, per `port/contract/nondeterministic-fields.md`.
//! * Inbound is accept-and-strip: no `deny_unknown_fields` anywhere (serde's
//!   default silently ignores unknown keys), matching the Zod runtime.
//! * Optional (`k?:`) fields are `Option<T>` with `skip_serializing_if` so an
//!   absent value omits the key (never emits `null`), preserving wire bytes.

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A JSON value that may arrive as a string or a number (`requestId` in the
/// freshAgent approval/question responses is `string | number`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StringOrNumber {
    Str(String),
    Num(i64),
}

/// `ToolResultBlock.content` is `string | unknown[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum StringOrArray {
    Str(String),
    Arr(Vec<Value>),
}

/// serde adapter for `T | null` fields that are *also* optional, so that
/// absent / explicit-null / value all round-trip distinctly.
///
/// * absent  -> `None`            (skipped on serialize)
/// * `null`  -> `Some(None)`      (serialized as `null`)
/// * `value` -> `Some(Some(v))`   (serialized as the value)
pub mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T, S>(value: &Option<Option<T>>, serializer: S) -> Result<S::Ok, S::Error>
    where
        T: Serialize,
        S: Serializer,
    {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        T: Deserialize<'de>,
        D: Deserializer<'de>,
    {
        Ok(Some(Option::deserialize(deserializer)?))
    }
}

// ---------------------------------------------------------------------------
// Enums (value set is contractual; member order is not).
// ---------------------------------------------------------------------------

/// Wire error codes (`ErrorCode`), carried by the `error` message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    NotAuthenticated,
    InvalidMessage,
    UnknownMessage,
    InvalidTerminalId,
    SessionIdentityMismatch,
    InvalidSessionId,
    RestoreUnavailable,
    InvalidCreateRequest,
    PtySpawnFailed,
    FileWatcherError,
    InternalError,
    RateLimited,
    Unauthorized,
    ProtocolMismatch,
}

/// The coding-agent providers (`claude | codex | opencode | amplifier`).
/// `amplifier` matches the legacy `TerminalTurnCompleteSchema.provider` enum
/// (`shared/ws-protocol.ts:192`) — required by the TERM-16 turn-complete
/// broadcast for amplifier terminal panes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentProvider {
    Claude,
    Codex,
    Opencode,
    Amplifier,
}

/// fresh-agent session flavour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionType {
    Freshclaude,
    Freshcodex,
    Kilroy,
    Freshopencode,
}

/// Sandbox policy shared by codingcli/freshAgent create/send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Sandbox {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

/// Permission mode enum (used by `codingcli.create`; freshAgent uses a free
/// string here, so it is *not* this type there).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    Plan,
    AcceptEdits,
    BypassPermissions,
}

/// Terminal shell selector (`terminal.create.shell`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Shell {
    System,
    Cmd,
    Powershell,
    Wsl,
}

/// `terminal.attach.intent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalAttachIntent {
    ViewportHydrate,
    KeepaliveDelta,
    TransportReconnect,
}

/// `terminal.attach.priority`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalAttachPriority {
    Foreground,
    Background,
}

// ---- session sub-record ----------------------------------------------------

/// `{ provider, sessionId }` (SessionLocator) — used for every `*sessionRef`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLocator {
    pub provider: String,
    pub session_id: String,
}

// ---- token usage -----------------------------------------------------------

/// freshell's normalized token usage (`TokenSummary` / `tokenUsage`), camelCase.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenSummary {
    pub cached_tokens: i64,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub total_tokens: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_percent: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_threshold_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model_context_window: Option<i64>,
}

/// Terminal metadata record (`TerminalMetaRecord`) — shared by
/// `terminal.inventory.terminalMeta[]` and `terminal.meta.updated.upsert[]`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalMetaRecord {
    pub terminal_id: String,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkout_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_subdir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_dirty: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo_root: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_usage: Option<TokenSummary>,
}

// ---- codex durability ------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexDurabilitySource {
    ThreadStartResponse,
    ThreadStartedNotification,
    ThreadForkResponse,
    RestoredClientState,
    DurableResume,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexDurabilityState {
    IdentityPending,
    CapturedPreTurn,
    TurnInProgressUnproven,
    ProofChecking,
    Durable,
    DurableResuming,
    DurabilityUnprovenAfterCompletion,
    NonRestorable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CodexProofFailureReason {
    InvalidPath,
    Missing,
    NotRegularFile,
    Empty,
    MalformedJson,
    WrongRecordType,
    MissingPayloadId,
    MismatchedThreadId,
    ReadError,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexCandidate {
    pub candidate_thread_id: String,
    pub captured_at: i64,
    /// const `"codex"`.
    pub provider: String,
    pub rollout_path: String,
    pub source: CodexDurabilitySource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexProofFailure {
    pub checked_at: i64,
    pub message: String,
    pub reason: CodexProofFailureReason,
}

/// Codex durability reference (`CodexDurabilityRef`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexDurability {
    /// const `1`.
    pub schema_version: u32,
    pub state: CodexDurabilityState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidate: Option<CodexCandidate>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub durable_thread_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_proof_failure: Option<CodexProofFailure>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub non_restorable_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn_completed_at: Option<i64>,
}

// ---- activity records + turn completions -----------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClaudePhase {
    Idle,
    Busy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CodexPhase {
    Unknown,
    Idle,
    Pending,
    Busy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OpencodePhase {
    Busy,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeActivityRecord {
    pub terminal_id: String,
    pub phase: ClaudePhase,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexActivityRecord {
    pub terminal_id: String,
    pub phase: CodexPhase,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// `AmplifierActivityRecordSchema.phase` (`shared/ws-protocol.ts:169`) —
/// extension surface, see `tests/activity_extension.rs`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AmplifierPhase {
    Idle,
    Busy,
}

/// `AmplifierActivityRecordSchema` (`shared/ws-protocol.ts:166-171`) —
/// extension surface (the frozen T0 inventory predates the amplifier
/// provider's activity family; the frozen client already consumes it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AmplifierActivityRecord {
    pub terminal_id: String,
    pub phase: AmplifierPhase,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeActivityRecord {
    pub terminal_id: String,
    pub phase: OpencodePhase,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// `TerminalTurnCompletionSnapshot` — `latestTurnCompletions[]` element.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnCompletionSnapshot {
    pub terminal_id: String,
    pub at: i64,
    pub completion_seq: i64,
}

// ---------------------------------------------------------------------------
// Claude SDK content blocks (`ContentBlockSchema` and friends).
// These appear only inside opaque `event` payloads on the wire, but are part of
// the frozen exported-schema surface, so they are modeled here for reuse.
// NOTE: their fields are snake_case in the contract (`tool_use_id`, `is_error`,
// `input_tokens`, ...), so these structs deliberately do NOT rename_all.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextBlock {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ThinkingBlock {
    pub thinking: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolUseBlock {
    pub id: String,
    pub name: String,
    /// `Record<string, unknown>`.
    pub input: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolResultBlock {
    pub tool_use_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<StringOrArray>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

/// `ContentBlock` — discriminated on `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum ContentBlock {
    #[serde(rename = "text")]
    Text(TextBlock),
    #[serde(rename = "thinking")]
    Thinking(ThinkingBlock),
    #[serde(rename = "tool_use")]
    ToolUse(ToolUseBlock),
    #[serde(rename = "tool_result")]
    ToolResult(ToolResultBlock),
}

/// Anthropic SDK `Usage` — known counters plus an open passthrough. The known
/// fields are snake_case in the contract; the rest is captured verbatim.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Usage {
    pub input_tokens: i64,
    pub output_tokens: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_creation_input_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_input_tokens: Option<i64>,
    /// `additionalProperties` passthrough (excluded from byte-diffing).
    #[serde(flatten)]
    pub passthrough: serde_json::Map<String, Value>,
}
