//! Canonical coding-agent session-name wire types (unified-agent-names plan,
//! Task 1), mirroring `shared/session-names.ts` exactly.
//!
//! * Wire enum strings are identical across TS/Rust.
//! * Rust fields are snake_case with camelCase Serde serialization.
//! * `NameRevision` is `u64` with a JS-safe integer ceiling
//!   ([`MAX_NAME_REVISION`]) — every revision/generation counter that crosses
//!   the wire to a JS client stays inside `Number.MAX_SAFE_INTEGER`.
//! * Serialization only, no logic: acceptance/rank rules live in the
//!   `freshell-server` store, not here.

use serde::{Deserialize, Serialize};

use crate::SessionLocator;

/// Monotonically allocated name revision — JS-safe on the wire.
pub type NameRevision = u64;

/// `Number.MAX_SAFE_INTEGER` (`2^53 - 1`): the hard ceiling for every
/// revision / document-generation counter serialized to a JS client.
pub const MAX_NAME_REVISION: NameRevision = 9_007_199_254_740_991;

/// The three scoped coding-agent providers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NamedProvider {
    Claude,
    Codex,
    Opencode,
}

impl NamedProvider {
    /// The exact wire string (`claude | codex | opencode`).
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Opencode => "opencode",
        }
    }

    /// Human-facing fallback label used when no directory basename exists.
    pub fn display_label(&self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Opencode => "OpenCode",
        }
    }
}

/// Who asked for a name change: a human (`user`) or automation
/// (`automatic`). Default omitted intents to `automatic` on every scoped
/// create/rename route — an agent suggestion must never acquire the
/// permanence of a user's explicit rename.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NameIntent {
    User,
    Automatic,
}

/// Provenance of an accepted name. Rank order for new operations is
/// `manual > legacy_protected > freshell_ai > provider_ai > first_message >
/// directory`; `legacy_protected` is assigned ONLY by the Task 7 migration
/// and never claims human origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NameSource {
    Manual,
    LegacyProtected,
    FreshellAi,
    ProviderAi,
    FirstMessage,
    Directory,
}

/// The single legal `legacyOrigin` value: the historic origin of a
/// migration-protected label is unknown.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LegacyOrigin {
    Unknown,
}

/// Naming target: a pre-durable pending handle (`pending`), or the durable
/// provider/session identity (`session`). The session variant reuses the
/// existing structured provider/session identity — no new restore identity.
/// Keys encode as a JSON discriminated tuple (see the store's `name_ref_key`)
/// and never colon-split opaque provider session IDs.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SessionNameRef {
    #[serde(rename_all = "camelCase")]
    Pending { id: String },
    #[serde(rename_all = "camelCase")]
    Session {
        provider: NamedProvider,
        session_id: String,
    },
}

/// Which session names a tab: the source pane's canonical session name
/// (`session`), or the existing non-agent derivation (`legacy`). A tab stores
/// the relationship, never a second name.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TabNameSource {
    #[serde(rename_all = "camelCase")]
    Session {
        pane_id: String,
    },
    Legacy,
}

/// One accepted name record. `manual_revision`/`renamed_at` are assigned only
/// by an actual explicit user rename; `legacy_origin` is required for (and
/// only legal on) `legacy_protected` records.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNameRecord {
    #[serde(rename = "ref")]
    pub name_ref: SessionNameRef,
    pub name: String,
    pub source: NameSource,
    pub revision: NameRevision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manual_revision: Option<NameRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub renamed_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub legacy_origin: Option<LegacyOrigin>,
}

/// Pending→durable redirect: late operations addressing a bound pending
/// handle resolve to the durable session record.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNameRedirect {
    pub from: SessionNameRef,
    pub to: SessionNameRef,
    pub revision: NameRevision,
}

/// Native synchronization status for a canonical name's provider writeback
/// (unified-agent-names plan, Task 3): `pending` (a bounded native series is
/// armed/underway), `synced` (a current-revision readback confirmed the
/// provider holds the exact desired name/location), `unsynced` (the finite
/// allowance is exhausted or an outcome is ambiguous/divergent), and
/// `unsupported` (a diagnosed capability failure — unsupported/archived/
/// ephemeral/missing). Display/status data only: never another name
/// authority, and never a public native path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NativeSyncStatus {
    Pending,
    Synced,
    Unsynced,
    Unsupported,
}

/// The native writeback status projected alongside a record in
/// `SessionNameUpdate`/`SessionNameUpdated`. `desired_revision` is the
/// canonical record revision the native series is projecting; the provider is
/// `synced` only with that exact revision. `location_revision` is the routing
/// evidence revision the series attempted (0 when no verified location
/// exists). `observed_current` records that a readback observed the desired
/// name while an ambiguous outcome kept the status `unsynced`. `reason` is a
/// stable machine-facing diagnostic (never a prompt or native payload).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSyncProjection {
    pub status: NativeSyncStatus,
    pub desired_revision: NameRevision,
    pub location_revision: NameRevision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub observed_current: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Why a rename did not change the saved name (name-reliability Task 4).
/// `ProtectedName`: an automation rename never replaces a name a person
/// chose (manual), a migration-protected label, or an accepted Freshell AI
/// name. `DefaultLabel`: an automation rename never saves a default or
/// derived label ("Tab 3", a provider label, the target's own folder name).
/// `Unchanged`: the saved name already is the requested text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RenameOutcomeReason {
    ProtectedName,
    DefaultLabel,
    Unchanged,
}

/// Whether a rename applied (name-reliability Task 4). Additive and
/// optional: only rename RESPONSES carry it — broadcasts never do. `applied`
/// is true when the saved name now is the requested text (including the
/// `unchanged` case); false means the record kept its name for `reason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameOutcome {
    pub applied: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<RenameOutcomeReason>,
}

/// The common response/broadcast shape for every naming operation. `changed`
/// is true only when the accepted record (text/source/revision) changed vs
/// the store's previously established state — losing automatic offers and
/// pure reads answer `changed: false` with the actual accepted winner.
/// `native_sync` (Task 3) is the additive writeback status projection;
/// status-only updates (an unchanged record whose nativeSync moved) publish
/// with `changed: false` and fold on the client by `documentGeneration`.
/// `outcome` (name-reliability Task 4) rides rename responses only.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNameUpdate {
    pub record: SessionNameRecord,
    pub document_generation: NameRevision,
    pub redirects: Vec<SessionNameRedirect>,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_sync: Option<NativeSyncProjection>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<RenameOutcome>,
}

/// Rename request body (HTTP `PATCH /api/session-names` and the MCP-bridged
/// rename). Omitted `name_intent` defaults to `automatic`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameSessionNameRequest {
    pub target: SessionNameRef,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_intent: Option<NameIntent>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub if_revision: Option<NameRevision>,
}

/// `session.name.updated` server→client broadcast payload. Published only
/// after a successful store commit/adoption, in local generation order; the
/// client folds by record and redirect revision, never arrival time.
/// `native_sync` mirrors the Task 3 status projection on the wire.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNameUpdated {
    pub record: SessionNameRecord,
    pub document_generation: NameRevision,
    pub redirects: Vec<SessionNameRedirect>,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub native_sync: Option<NativeSyncProjection>,
}

// ---------------------------------------------------------------------------
// Task 7 — legacy-name migration envelope
// ---------------------------------------------------------------------------

/// Where a legacy candidate's label lived. The scope breaks total-order ties:
/// `session > pane > source_tab > terminal > derived`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyCandidateScope {
    Session,
    Pane,
    SourceTab,
    Terminal,
    Derived,
}

/// What protection the raw evidence claims for a legacy candidate.
/// `explicit_rename` is reliable explicit-rename evidence (only the old
/// durable session-rename ladder could produce it, and only server-side boot
/// evidence honors it); `legacy_flag` is an old manual/protected flag whose
/// human origin is UNRECOVERABLE (pane/tab user-set booleans, unsourced
/// title overrides); `none` is an unprotected label with a known automatic
/// origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyProtectionEvidence {
    ExplicitRename,
    LegacyFlag,
    None,
}

/// A migration candidate's target: the canonical naming ref, or a legacy
/// identity that the server resolves through the existing canonical
/// identity/ledger — never a new key. `legacy_session` reuses the structured
/// provider/session restore identity (with the optional codex durability
/// evidence and original cwd); `legacy_terminal` names a terminal +
/// server instance for ledger resolution. The untagged representation
/// matches the TS `z.union`: the canonical ref carries its own `kind` tag
/// (`pending`/`session`) and the legacy variants carry `legacy_session`/
/// `legacy_terminal` through the flattened marker below. (The wire shape
/// is fixed by the plan's TS union — boxing the optional codex durability
/// evidence would buy nothing at this enum's call frequency.)
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
#[allow(clippy::large_enum_variant)]
pub enum LegacyNameTarget {
    Canonical(SessionNameRef),
    #[serde(rename_all = "camelCase")]
    LegacySession {
        #[serde(flatten)]
        kind: LegacySessionKind,
        session_ref: SessionLocator,
        #[serde(skip_serializing_if = "Option::is_none")]
        codex_durability: Option<crate::common::CodexDurability>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cwd: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    LegacyTerminal {
        #[serde(flatten)]
        kind: LegacyTerminalKind,
        terminal_id: String,
        server_instance_id: String,
    },
}

/// The `kind: "legacy_session"` discriminant (its own unit type so the
/// untagged variant above stays self-describing on the wire).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacySessionKind {
    #[serde(rename = "kind")]
    pub kind: LegacySessionKindTag,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacySessionKindTag {
    LegacySession,
}

/// The `kind: "legacy_terminal"` discriminant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct LegacyTerminalKind {
    #[serde(rename = "kind")]
    pub kind: LegacyTerminalKindTag,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LegacyTerminalKindTag {
    LegacyTerminal,
}

impl LegacyNameTarget {
    /// Convenience constructors matching the TS discriminated shapes.
    pub fn legacy_session(session_ref: SessionLocator) -> Self {
        Self::LegacySession {
            kind: LegacySessionKind {
                kind: LegacySessionKindTag::LegacySession,
            },
            session_ref,
            codex_durability: None,
            cwd: None,
        }
    }

    pub fn legacy_terminal(
        terminal_id: impl Into<String>,
        server_instance_id: impl Into<String>,
    ) -> Self {
        Self::LegacyTerminal {
            kind: LegacyTerminalKind {
                kind: LegacyTerminalKindTag::LegacyTerminal,
            },
            terminal_id: terminal_id.into(),
            server_instance_id: server_instance_id.into(),
        }
    }
}

/// The stable legacy-candidate id: the JSON encoding of the tuple
/// `[storageKey,deviceId,tabId,paneId,scope,provider,sessionId,name,source,
/// protectionEvidence,explicitRenameAt]` with absent entries `null`. Every
/// imported time must have evidence — never receipt/import time — so
/// `explicit_rename_at` is `None` unless the evidence carries a trustworthy
/// explicit-rename timestamp.
pub fn legacy_name_candidate_id(input: LegacyCandidateIdInput<'_>) -> String {
    let json = serde_json::json!([
        input.storage_key,
        input.device_id,
        input.tab_id,
        input.pane_id,
        input.scope,
        input.provider,
        input.session_id,
        input.name,
        input.source,
        input.protection_evidence,
        input.explicit_rename_at,
    ]);
    serde_json::to_string(&json).expect("the candidate id tuple serializes")
}

/// The identity fields of one legacy candidate for
/// [`legacy_name_candidate_id`].
#[derive(Debug, Clone, Copy)]
pub struct LegacyCandidateIdInput<'a> {
    pub storage_key: &'a str,
    pub device_id: Option<&'a str>,
    pub tab_id: Option<&'a str>,
    pub pane_id: Option<&'a str>,
    pub scope: LegacyCandidateScope,
    pub provider: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub name: &'a str,
    pub source: NameSource,
    pub protection_evidence: LegacyProtectionEvidence,
    pub explicit_rename_at: Option<i64>,
}

/// One legacy-name candidate. The stable candidate `id` is the JSON tuple
/// `[storageKey,deviceId,tabId,paneId,scope,provider,sessionId,name,source,
/// protectionEvidence,explicitRenameAt]` with absent entries `null`;
/// `explicit_rename_at` must carry evidence (never receipt/import time) and
/// is absent when no trustworthy explicit-rename time exists.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyNameCandidate {
    pub id: String,
    pub target: LegacyNameTarget,
    pub name: String,
    pub source: NameSource,
    pub scope: LegacyCandidateScope,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explicit_rename_at: Option<i64>,
    pub evidence_key: String,
    pub protection_evidence: LegacyProtectionEvidence,
}

/// One immutable raw evidence envelope: the bytes of one legacy storage
/// payload, preserved verbatim before any sanitization could clear it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyEvidenceEnvelope {
    pub storage_key: String,
    pub raw: String,
}

/// The Task 7 import envelope. `version` is fixed at 1; `import_id` is the
/// persisted retry-stable id of one captured raw envelope (the server derives
/// its immutable per-import backup filename from it). Clients batch at most
/// 100 candidates per import.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyNameImport {
    pub version: u32,
    pub import_id: String,
    pub evidence: Vec<LegacyEvidenceEnvelope>,
    pub candidates: Vec<LegacyNameCandidate>,
}

/// The import result: every acknowledged candidate id (per-candidate
/// acknowledgment, never an early whole-import shortcut) plus the updates for
/// the records the import touched (winners and unchanged winners alike).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyImportResult {
    pub acknowledged: Vec<String>,
    pub names: Vec<SessionNameUpdate>,
}
