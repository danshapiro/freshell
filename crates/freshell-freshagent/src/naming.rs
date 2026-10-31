//! Injected session-naming interface (unified-agent-names plan, Task 1).
//!
//! The name authority lives in `freshell-server`'s `SessionNames` store; this
//! crate (and `freshell-ws`, which already depends on it) consume the store
//! through this trait so fresh-agent/WS code never depends on the server
//! crate. Reuses the project's boxed-future style (the `SinkWrite` idiom in
//! `identity_sink.rs`, itself citing `freshell-opencode`/`freshell-codex`) —
//! no `async-trait` dependency.
//!
//! Acceptance/rank/persistence policy is owned by the implementing store; a
//! rename answer ALWAYS reports the actual accepted winner (including an
//! unchanged winner when an automatic suggestion loses).

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use freshell_protocol::native_location::{NativeAcquisition, NativePersistence};
use freshell_protocol::session_names::{
    NameIntent, NameRevision, NamedProvider, SessionNameRecord, SessionNameRef, SessionNameUpdate,
    MAX_NAME_REVISION,
};

/// Every naming operation's completion future.
pub type NameFuture<T> = Pin<Box<dyn Future<Output = Result<T, NameError>> + Send + 'static>>;

/// The naming authority surface consumed by WS/fresh-agent composition
/// (Task 2 wires the real store into `FreshAgentState`/`WsState`).
pub trait SessionNaming: Send + Sync {
    /// Resolve refs (following pending→durable redirects) to their current
    /// records. Unknown refs are omitted; this is a pure read.
    fn get(&self, refs: Vec<SessionNameRef>) -> NameFuture<Vec<SessionNameUpdate>>;

    /// Admit a pre-durable naming handle with an immediate fallback name
    /// (directory basename, else provider label) at directory rank.
    /// Idempotent: re-ensuring a bound handle resolves its durable record.
    fn ensure_pending(&self, input: PendingNameInput) -> NameFuture<SessionNameUpdate>;

    /// Admit a known session that has no name yet (for example immediately
    /// after an in-pane conversation switch). Existing records are unchanged.
    fn ensure_session(
        &self,
        _target: SessionNameRef,
        _cwd: Option<String>,
    ) -> NameFuture<SessionNameUpdate> {
        Box::pin(async { Err(naming_unavailable("durable session admission")) })
    }

    /// Seed an internal continuation once from its source's saved name.
    /// Durable identities remain independent: no redirect is created, an
    /// existing child is unchanged, and an unnamed source produces no name.
    /// Ordinary forks and new conversations must never call this operation.
    fn continue_session(
        &self,
        _source: SessionNameRef,
        _target: SessionNameRef,
    ) -> NameFuture<Option<SessionNameUpdate>> {
        Box::pin(async { Ok(None) })
    }

    /// Atomically transfer a pending record onto its verified durable
    /// provider/session identity (rejecting prospective evidence).
    fn bind_pending(&self, input: BindNameInput) -> NameFuture<SessionNameUpdate>;

    /// Rename with intent. `user` is the explicit human boundary (manual
    /// source, always applied); `automatic` is an agent suggestion recorded
    /// at provider_ai rank, refused over a protected name or for a default
    /// or derived label (classified with `cwd`). The answer's `outcome`
    /// says whether the rename applied. Optional `if_revision` is
    /// compare-and-set.
    fn rename(&self, input: RenameNameInput) -> NameFuture<SessionNameUpdate>;

    /// Fold server-side coding-agent session activity: first-message
    /// fallback upgrade plus generation-eligibility arming.
    fn activity(&self, input: NameActivity) -> NameFuture<SessionNameUpdate>;

    /// Fold a native provider title observation with its provenance.
    fn observe_native(&self, input: NativeNameObservation) -> NameFuture<SessionNameUpdate>;

    /// Retain native routing evidence (verified or prospective) for a target
    /// WITHOUT binding a pending handle to durable identity.
    fn record_acquisition(
        &self,
        target: SessionNameRef,
        acquisition: NativeAcquisition,
    ) -> NameFuture<SessionNameUpdate>;

    /// Unified agent names (Task 3): the store's CURRENT verified location
    /// revision for `target` (0 when none exists). Live provider lanes stamp
    /// their observations with this revision before folding them, so an
    /// old-location observation can never masquerade as current. Defaulted to
    /// the ceiling so test fakes answer "always current" (the default's 0
    /// would read as stale against a real location revision); the real store
    /// reads its adopted document.
    fn current_location_revision(&self, _target: &SessionNameRef) -> NameFuture<NameRevision> {
        Box::pin(async move { Ok(MAX_NAME_REVISION) })
    }
}

/// `ensure_pending` input: the pre-durable handle plus provider/cwd used for
/// the immediate directory-basename fallback.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingNameInput {
    pub handle: String,
    pub provider: NamedProvider,
    pub cwd: Option<String>,
}

/// `bind_pending` input. `acquisition` must carry `Verified` persistence —
/// prospective evidence (a bare thread/start ack) is rejected as ambiguous.
#[derive(Debug, Clone, PartialEq)]
pub struct BindNameInput {
    pub pending: SessionNameRef,
    pub target: SessionNameRef,
    pub acquisition: NativeAcquisition,
}

/// `rename` input. `cwd` (name-reliability Task 4) is the best-known folder
/// of the rename's target — the terminal row's cwd for the pane, tab and
/// terminal routes, the session index row's cwd for the session-key routes —
/// so an automation rename to the target's own folder name is classified as
/// a derived label and refused. `None` recognizes folder-free labels only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenameNameInput {
    pub target: SessionNameRef,
    pub name: String,
    pub intent: NameIntent,
    pub if_revision: Option<NameRevision>,
    pub cwd: Option<String>,
}

/// Why activity arrived. `AcceptedUserMessage`/`IndexUserMessage` may carry a
/// first user message (fallback upgrade input); `Opened`/`Resumed` arm an
/// unattempted generation series only when a first message exists.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NameActivityReason {
    AcceptedUserMessage,
    IndexUserMessage,
    Opened,
    Resumed,
}

/// One activity event. `event_id` is the existing provider/event message id
/// (duplicate delivery folds through the series' input fingerprint, never a
/// new event store).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NameActivity {
    pub target: SessionNameRef,
    pub mode: String,
    pub event_id: String,
    pub reason: NameActivityReason,
    pub first_user_message: Option<String>,
    pub cwd: Option<String>,
}

/// Provenance of a native title observation. `OwnWrite` is an echo of
/// Freshell's own supported write (provenance only — never promoted); the
/// provider-native surface carries no reliable human/AI intent, so
/// `Snapshot`/`ProviderAi` fold as automatic candidates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeNameOrigin {
    Snapshot,
    ProviderAi,
    OwnWrite,
}

/// One native title observation, carrying the store-assigned location
/// revision it was observed at (an old-location observation can never mark
/// the current location synchronized).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeNameObservation {
    pub target: SessionNameRef,
    pub title: String,
    pub origin: NativeNameOrigin,
    pub location_revision: NameRevision,
    pub event_id: Option<String>,
}

/// The naming failure classes with their HTTP mappings (plan "Name acceptance,
/// storage, and publication" §6): 400 / 404 / 409 / 409 / 503 / 503 / 503.
/// `Conflict` carries the current accepted record so editors can surface the
/// concurrent winner instead of an invisible overwrite.
#[derive(Debug)]
pub enum NameError {
    /// Blank/oversize name, or a malformed naming target (HTTP 400).
    InvalidName(String),
    /// Unknown rename/read target (HTTP 404).
    NotFound(String),
    /// Ambiguous acquisition/binding — e.g. prospective bind evidence
    /// (HTTP 409).
    IdentityAmbiguous(String),
    /// Compare-and-set revision mismatch (HTTP 409); carries the accepted
    /// record at the time of the check.
    Conflict {
        message: String,
        current: Option<SessionNameRecord>,
    },
    /// Durable document read/write/parse failure with old state intact
    /// (HTTP 503).
    Persistence(String),
    /// A replacement may or may not have committed; nothing is published
    /// until durability reconciliation succeeds (HTTP 503).
    CommitUncertain(String),
    /// The cross-process document lock stayed busy past its bounded retry
    /// budget, or failed in a non-contention way (HTTP 503).
    LockUnavailable(String),
}

impl NameError {
    /// The HTTP status the naming routes map this class to.
    pub fn http_status(&self) -> u16 {
        match self {
            Self::InvalidName(_) => 400,
            Self::NotFound(_) => 404,
            Self::IdentityAmbiguous(_) | Self::Conflict { .. } => 409,
            Self::Persistence(_) | Self::CommitUncertain(_) | Self::LockUnavailable(_) => 503,
        }
    }

    /// The revision a structured error log should attribute: the accepted
    /// record's revision for a compare-and-set conflict, else 0. Shared by
    /// this crate's `log_name_error` and the other crates' inline naming
    /// error logs (their `tracing` targets must be their own literals).
    pub fn log_revision(&self) -> NameRevision {
        match self {
            Self::Conflict { current, .. } => current.as_ref().map(|r| r.revision).unwrap_or(0),
            _ => 0,
        }
    }

    /// Stable machine-readable code for route payloads/logs.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidName(_) => "NAME_INVALID",
            Self::NotFound(_) => "NAME_NOT_FOUND",
            Self::IdentityAmbiguous(_) => "NAME_IDENTITY_AMBIGUOUS",
            Self::Conflict { .. } => "NAME_REVISION_CONFLICT",
            Self::Persistence(_) => "NAME_PERSISTENCE_FAILED",
            Self::CommitUncertain(_) => "NAME_COMMIT_UNCERTAIN",
            Self::LockUnavailable(_) => "NAME_LOCK_UNAVAILABLE",
        }
    }
}

impl std::fmt::Display for NameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidName(m) => write!(f, "invalid name: {m}"),
            Self::NotFound(m) => write!(f, "naming target not found: {m}"),
            Self::IdentityAmbiguous(m) => write!(f, "naming identity ambiguous: {m}"),
            Self::Conflict { message, .. } => write!(f, "naming revision conflict: {message}"),
            Self::Persistence(m) => write!(f, "naming persistence failure: {m}"),
            Self::CommitUncertain(m) => write!(f, "naming commit uncertain: {m}"),
            Self::LockUnavailable(m) => write!(f, "naming lock unavailable: {m}"),
        }
    }
}

impl std::error::Error for NameError {}

// ── Task 2: scope predicate, runtime transition classification, sink holder ──

/// The terminal modes in scope for unified naming.
const TERMINAL_UNIFIED_MODES: [&str; 3] = ["claude", "codex", "opencode"];
/// The fresh session types in scope for unified naming.
const FRESH_UNIFIED_SESSION_TYPES: [&str; 3] = ["freshclaude", "freshcodex", "freshopencode"];

/// Scope predicate — the Rust mirror of `isUnifiedAgentMode`
/// (`shared/session-names.ts`): terminal scope is `mode in {claude, codex,
/// opencode}`; fresh scope is `sessionType in {freshclaude, freshcodex,
/// freshopencode}` (fresh types also match when passed as the mode, since
/// fresh panes identify by session type). Kilroy is explicitly out of scope
/// even though it shares the Claude runtime — a `kilroy` session type is never
/// scoped, regardless of the mode it rides on.
pub fn is_unified_agent_mode(mode: Option<&str>, session_type: Option<&str>) -> bool {
    if session_type == Some("kilroy") {
        return false;
    }
    if let Some(st) = session_type {
        if FRESH_UNIFIED_SESSION_TYPES.contains(&st) {
            return true;
        }
    }
    mode.is_some_and(|m| {
        TERMINAL_UNIFIED_MODES.contains(&m) || FRESH_UNIFIED_SESSION_TYPES.contains(&m)
    })
}

/// The scoped provider for a pane content classification: the three terminal
/// CLI providers map to themselves; the three fresh session types map to their
/// runtime provider. `None` for kilroy, shells, and every excluded mode.
pub fn named_provider_for(mode: Option<&str>, session_type: Option<&str>) -> Option<NamedProvider> {
    if !is_unified_agent_mode(mode, session_type) {
        return None;
    }
    let provider = session_type
        .or(mode)
        .or(Some(""))
        .filter(|m| !m.is_empty())?;
    Some(match provider {
        "claude" | "freshclaude" => NamedProvider::Claude,
        "codex" | "freshcodex" => NamedProvider::Codex,
        "opencode" | "freshopencode" => NamedProvider::Opencode,
        _ => return None,
    })
}

/// Why a runtime identity transition happened (plan "Identity and scope" +
/// Task 2 interfaces) — carried SEPARATELY from the ledger's `supersedes`
/// edge, which cannot distinguish a rollback fork from a crash-recovery
/// mint-new from a deliberate new conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum NameTransitionReason {
    /// First verified durable materialization of a pre-durable handle
    /// (requires verified persistence — never a bare start ack).
    InitialMaterialization,
    /// Zero-turn/pre-persistence restart: the prospective runtime id never
    /// persisted, so recovery minted a new initial runtime/native thread.
    /// Retains the SAME pending handle/name; only acquisition evidence moves.
    InitialRecovery,
    /// A create/attach resuming an established durable identity — the pane
    /// adopts that session's existing name; never aliases durable keys.
    Resume,
    /// A genuine conversation switch (in-TUI /resume, /clear, fork-to-live):
    /// the pane adopts the new session's own name.
    Switch,
    /// Explicit internal continuation (Claude undo/redo rollback fork): the
    /// child may be seeded once with the source preserved; never redirects
    /// one durable identity to another.
    InternalContinuation,
    /// A deliberate new conversation (crash-recovery mint-new of an
    /// ESTABLISHED thread, or an explicit new-conversation action): a new
    /// session with a new name — the previous name never copies over.
    NewConversation,
}

/// The naming half of a runtime identity callback: the transition
/// classification plus the native routing evidence the store retains with
/// the record. `pending` is the pre-durable handle this transition resolves
/// (`None` on resume/switch of established identities).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NameTransition {
    pub reason: NameTransitionReason,
    pub acquisition: NativeAcquisition,
    pub pending: Option<String>,
}

pub const HOSTED_CODEX_NAMING_EVENT: &str = "freshAgent.host.naming";

/// Provider facts transported to the gateway's existing name authority.
/// These never contain accepted name records or native control answers.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum HostedCodexNamingFact {
    Activity(NameActivity),
    /// Exact persisted metadata for a current session without a pending
    /// handle. This admits that session's own name; it never transfers one.
    Acquisition {
        target: SessionNameRef,
        acquisition: NativeAcquisition,
        cwd: Option<String>,
    },
    Transition {
        target: SessionNameRef,
        transition: NameTransition,
    },
}

impl NameTransition {
    /// A verified transition resolving `pending` onto its durable identity.
    pub fn binding(
        reason: NameTransitionReason,
        acquisition: NativeAcquisition,
        pending: impl Into<String>,
    ) -> Self {
        Self {
            reason,
            acquisition,
            pending: Some(pending.into()),
        }
    }
}

/// The error answered by a scoped naming operation when no naming authority
/// was injected (tests outside scope may omit the sink; production always
/// wires the local store participant).
pub fn naming_unavailable(what: &str) -> NameError {
    NameError::Persistence(format!("session naming is unavailable: {what}"))
}

/// The 400 code for a scoped null/reset rename request: a protected saved
/// name is never cleared through any route.
pub const NAME_RESET_UNSUPPORTED: &str = "NAME_RESET_UNSUPPORTED";

/// Set-once holder for the injected naming authority (`Arc<dyn
/// SessionNaming>`), shared by value-cloneable states whose consumer tasks
/// hold clones (the `PaneIdentitySink` OnceLock-behind-Arc precedent in
/// `identity_sink.rs`). `Clone` clones the Arc, so every holder sees the one
/// wired sink; `Default` is the unwired state (scoped naming fails
/// unavailable, exactly like an unwired identity sink).
#[derive(Clone, Default)]
pub struct NamingSink(Arc<std::sync::OnceLock<Arc<dyn SessionNaming>>>);

impl NamingSink {
    /// Wire the authority (set-once; later calls are no-ops).
    pub fn set(&self, sink: Arc<dyn SessionNaming>) -> bool {
        self.0.set(sink).is_ok()
    }

    /// The wired authority, if any.
    pub fn get(&self) -> Option<Arc<dyn SessionNaming>> {
        self.0.get().cloned()
    }

    /// Whether a sink is wired.
    pub fn is_wired(&self) -> bool {
        self.0.get().is_some()
    }
}

impl std::fmt::Debug for NamingSink {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NamingSink")
            .field("wired", &self.is_wired())
            .finish()
    }
}

/// Structured error log for a naming operation's failure path (the
/// Global Constraints' severity/operation/name-reference/revision/failure-
/// class JSONL requirement — `tracing` is this server's JSONL channel; no
/// prompts, credentials, or native payloads are ever included).
///
/// `tracing` macro targets must be literals, so this fn logs under THIS
/// crate's own target (`freshell_freshagent::naming`) — call sites that live
/// in OTHER crates (`freshell-ws`' identity/signal lanes, `freshell-server`'s
/// route handlers) write their own inline `tracing::warn!` under their own
/// crate's target instead of calling this fn, sharing
/// [`NameError::log_revision`] and [`NameError::code`]; log filtering then
/// routes by the code that owns each call site.
pub fn log_name_error(op: &str, target: &SessionNameRef, error: &NameError) {
    tracing::warn!(
        target: "freshell_freshagent::naming",
        op = %op,
        name_ref = %name_ref_debug_key(target),
        revision = error.log_revision(),
        class = %error.code(),
        "session_names.operation_failed: {}",
        error
    );
}

/// A stable human-readable ref key for logs (mirrors the store's
/// `name_ref_key` tuple encoding without importing the server crate here).
pub fn name_ref_debug_key(target: &SessionNameRef) -> String {
    match target {
        SessionNameRef::Pending { id } => format!(r#"["pending",{id}]"#),
        SessionNameRef::Session {
            provider,
            session_id,
        } => format!(r#"["session","{}",{session_id}]"#, provider.as_str()),
    }
}

/// The shared accepted-input callback (unified-agent-names plan, Task 4):
/// fold ONE accepted user send into the naming authority — the immediate
/// first-message fallback upgrade plus generation-eligibility arming happen
/// store-side from the message text (never raw keystrokes, ANSI, assistant
/// text, or tool output). Called at every scoped runtime's send-acceptance
/// point (claude's sidecar write, codex's `turn/start` ack, opencode's
/// accepted turn submission, and the REST send lanes). Never blocks the
/// send: errors log and the turn proceeds.
pub async fn report_accepted_input(
    sink: &Option<Arc<dyn SessionNaming>>,
    target: &SessionNameRef,
    mode: &str,
    event_id: &str,
    message: &str,
    cwd: Option<&str>,
) {
    let Some(sink) = sink.as_ref() else {
        return;
    };
    let message = message.trim();
    if message.is_empty() {
        return;
    }
    if let Err(error) = sink
        .activity(NameActivity {
            target: target.clone(),
            mode: mode.to_string(),
            event_id: event_id.to_string(),
            reason: NameActivityReason::AcceptedUserMessage,
            first_user_message: Some(message.to_string()),
            cwd: cwd.map(str::to_string),
        })
        .await
    {
        log_name_error("activity", target, &error);
    }
}

/// The shared open/resume/materialization transition fold (plan Task 4) —
/// the classification-driven consumer of [`NameTransition`] (the T2-M5
/// field's one reader): the sites that know WHY an identity edge happened
/// classify it, and this fold applies the naming policy each class carries.
///
/// * `InitialMaterialization` / `InternalContinuation` with VERIFIED
///   persistence bind the pending handle onto the durable identity (the
///   store's collision rules seed a rollback-fork child once with the source
///   preserved); PROSPECTIVE evidence cannot authorize a bind — the pending
///   handle and name are RETAINED (only the routing evidence moves), exactly
///   the zero-turn rule.
/// * `InitialRecovery` never binds: the pre-durable handle survives the
///   recovery remint and only its acquisition evidence is retained.
/// * `Resume` / `Switch` / `NewConversation` never transfer a name: the pane
///   ADOPTS the durable session's own record (the caller projects it).
///
/// Production declarers today (T2-M5 truthful trim): claude's init lane
/// (`InitialMaterialization` / `InternalContinuation`) and codex's
/// rollout-verified bind (`InitialMaterialization`) classify through this
/// fold; opencode's bind lane is behaviorally identical (verified
/// persistence at materialization) through its direct `bind_pending` call.
/// `InitialRecovery`, `Resume`, `Switch`, and `NewConversation` currently
/// have NO production declarer — those behaviors are implemented by the
/// Task 2 lanes through direct sink calls; these arms carry the shared
/// policy for when a lane begins declaring them.
pub async fn fold_identity_transition(
    sink: &Option<Arc<dyn SessionNaming>>,
    transition: &NameTransition,
    durable: SessionNameRef,
) -> Option<SessionNameUpdate> {
    let sink = sink.as_ref()?;
    let pending = transition
        .pending
        .as_ref()
        .map(|handle| SessionNameRef::Pending { id: handle.clone() });
    match transition.reason {
        NameTransitionReason::InitialMaterialization
        | NameTransitionReason::InternalContinuation => {
            let pending = pending?;
            match transition.acquisition.persistence {
                NativePersistence::Verified => {
                    match sink
                        .bind_pending(BindNameInput {
                            pending: pending.clone(),
                            target: durable,
                            acquisition: transition.acquisition.clone(),
                        })
                        .await
                    {
                        Ok(update) => Some(update),
                        Err(error) => {
                            log_name_error("bind_pending", &pending, &error);
                            // "On failed bind retain the handle": the caller
                            // keeps its stash entry for the visible retry.
                            None
                        }
                    }
                }
                NativePersistence::Prospective => {
                    // Zero-turn/pre-persistence: the name authority (and the
                    // handle) stay untouched until verified persistence
                    // exists; only the routing evidence moves.
                    if let Err(error) = sink
                        .record_acquisition(pending.clone(), transition.acquisition.clone())
                        .await
                    {
                        log_name_error("record_acquisition", &pending, &error);
                    }
                    None
                }
            }
        }
        NameTransitionReason::InitialRecovery => {
            // Retains the SAME pending handle/name; only the acquired
            // location evidence moves onto it.
            let pending = pending?;
            if let Err(error) = sink
                .record_acquisition(pending.clone(), transition.acquisition.clone())
                .await
            {
                log_name_error("record_acquisition", &pending, &error);
            }
            None
        }
        NameTransitionReason::Resume
        | NameTransitionReason::Switch
        | NameTransitionReason::NewConversation => {
            // Adoption, not transfer: answer the durable record's current
            // projection so the caller can broadcast the adopted name.
            match sink.get(vec![durable.clone()]).await {
                Ok(updates) => updates.into_iter().next(),
                Err(error) => {
                    log_name_error("get", &durable, &error);
                    None
                }
            }
        }
    }
}

/// Admit a pre-durable handle (idempotent) and answer the additive frame
/// projection (`nameRef` + last-known `sessionName`) for a
/// `freshAgent.created`/`terminal.created` acknowledgment. `None` when no
/// authority is wired (the out-of-scope degradation) or the admission
/// failed (the caller logs and proceeds unnamed — naming never blocks the
/// create).
pub async fn admit_pending_projection(
    sink: &Option<Arc<dyn SessionNaming>>,
    handle: &str,
    provider: NamedProvider,
    cwd: Option<&str>,
) -> Option<(SessionNameRef, SessionNameRecord)> {
    let sink = sink.as_ref()?;
    let update = sink
        .ensure_pending(PendingNameInput {
            handle: handle.to_string(),
            provider,
            cwd: cwd.map(str::to_string),
        })
        .await
        .inspect_err(|error| {
            log_name_error(
                "ensure_pending",
                &SessionNameRef::Pending { id: handle.into() },
                error,
            );
        })
        .ok()?;
    Some((update.record.name_ref.clone(), update.record))
}

/// Resolve a durable session's current projection for a frame (resume/adopt
/// answers). `None` when no authority is wired or the record is unknown —
/// the caller omits the fields (a missing binding shows a neutral fallback,
/// never retargets an edit).
pub async fn session_projection(
    sink: &Option<Arc<dyn SessionNaming>>,
    provider: NamedProvider,
    session_id: &str,
) -> Option<(SessionNameRef, SessionNameRecord)> {
    let sink = sink.as_ref()?;
    let target = SessionNameRef::Session {
        provider,
        session_id: session_id.to_string(),
    };
    let updates = sink
        .get(vec![target.clone()])
        .await
        .inspect_err(|error| log_name_error("get", &target, error))
        .ok()?;
    updates
        .into_iter()
        .next()
        .map(|update| (update.record.name_ref.clone(), update.record))
}

/// Fold a native title observation originating from the LIVE provider
/// connection this runtime owns (unified-agent-names Task 3): the lane
/// itself cannot know the store's location-revision counter, so the helper
/// stamps the observation with the store's CURRENT verified location
/// revision for the target before folding it — a genuinely stale observation
/// (from a superseded route) is then provenance-only, exactly the plan's
/// old-location rule. `None` when no authority is wired, the title is a
/// provider placeholder, or the inline attempt did not apply — an
/// observation never blocks or fails the provider lane.
///
/// Name-reliability Task 4: a provider placeholder ("New session - <ISO>")
/// never reaches the store, and the observation makes ONE inline attempt; a
/// busy or failing store hands it to the background retrier
/// ([`crate::native_observation_retry`]), so the relay never waits for a
/// retry and an older title can never land after a newer one.
pub async fn observe_native_live(
    sink: &Option<Arc<dyn SessionNaming>>,
    target: SessionNameRef,
    title: &str,
    origin: NativeNameOrigin,
    event_id: Option<String>,
) -> Option<SessionNameUpdate> {
    let sink = sink.as_ref()?;
    if is_placeholder_for_target(&target, title) {
        return None;
    }
    let ticket = crate::native_observation_retry::reserve(sink, &target);
    crate::native_observation_retry::submit(ticket, title.to_string(), origin, event_id).await
}

/// Whether `title` is a provider placeholder for the target's provider (a
/// pending target's provider is not known yet: any provider's placeholder).
pub fn is_placeholder_for_target(target: &SessionNameRef, title: &str) -> bool {
    match target {
        SessionNameRef::Session { provider, .. } => {
            freshell_sessions::is_provider_placeholder_title(provider.as_str(), title)
        }
        SessionNameRef::Pending { .. } => {
            freshell_sessions::is_provider_placeholder_title("opencode", title)
        }
    }
}

#[cfg(test)]
pub(crate) mod test_support {
    //! The in-crate naming sink for route/unit tests — a small store-like
    //! fake mirroring the real authority's semantics closely enough to
    //! exercise every consumer: `ensure_pending` fabricates the
    //! directory-basename fallback record, `bind_pending` transfers the
    //! pending record (registering the redirect), `get` follows redirects,
    //! and `rename` records its input verbatim before answering the accepted
    //! record. The activity/observation/acquisition seams fabricate a
    //! current-record answer (their acceptance policy is the real store's
    //! own, pinned in `freshell-server`).

    use std::sync::Mutex;

    use freshell_protocol::native_location::NativeAcquisition;
    use freshell_protocol::session_names::{
        NameIntent, NameSource, SessionNameRecord, SessionNameRef, SessionNameUpdate,
    };

    use super::{
        name_ref_debug_key, BindNameInput, NameActivity, NameError, NameFuture,
        NativeNameObservation, PendingNameInput, RenameNameInput, SessionNaming,
    };

    pub(crate) struct RecordingSink {
        pub renames: Mutex<Vec<RenameNameInput>>,
        pub activities: Mutex<Vec<NameActivity>>,
        /// Name-reliability Task 4: every `observe_native` call, in arrival
        /// order (failed ones included).
        pub observe_attempts: Mutex<Vec<NativeNameObservation>>,
        /// Name-reliability Task 4: the observations the sink ACCEPTED (an
        /// injected failure is not accepted), in the order their
        /// transactions finished.
        pub observed: std::sync::Arc<Mutex<Vec<NativeNameObservation>>>,
        /// Name-reliability Task 4 review: the next `observe_native` call
        /// waits on this before it finishes (a slow store transaction).
        observe_gate: Mutex<Option<tokio::sync::oneshot::Receiver<()>>>,
        /// Name-reliability Task 4: failures answered by the next
        /// `observe_native` calls, front first (a stalled store).
        pub observe_failures: Mutex<std::collections::VecDeque<NameError>>,
        /// Name-reliability Task 4: the answer of `current_location_revision`
        /// (the trait default's ceiling unless a test moves it).
        pub location_revision: std::sync::atomic::AtomicU64,
        records: Mutex<Vec<(SessionNameRef, SessionNameRecord)>>,
        redirects: Mutex<Vec<(SessionNameRef, SessionNameRef)>>,
    }

    impl RecordingSink {
        pub fn new() -> std::sync::Arc<Self> {
            std::sync::Arc::new(Self::default())
        }

        /// Make the next `count` observations fail with `LockUnavailable`.
        pub fn fail_next_observations(&self, count: usize) {
            let mut failures = self.observe_failures.lock().unwrap();
            for _ in 0..count {
                failures.push_back(NameError::LockUnavailable(
                    "injected: the document lock stayed busy".into(),
                ));
            }
        }

        /// Make the next `observe_native` call wait inside its transaction
        /// until the returned sender fires (or is dropped).
        pub fn block_next_observation(&self) -> tokio::sync::oneshot::Sender<()> {
            let (release, gate) = tokio::sync::oneshot::channel();
            *self.observe_gate.lock().unwrap() = Some(gate);
            release
        }

        /// The titles of the observations the sink accepted, in order.
        pub fn observed_titles(&self) -> Vec<String> {
            self.observed
                .lock()
                .unwrap()
                .iter()
                .map(|observation| observation.title.clone())
                .collect()
        }

        /// The titles of every attempted observation, in order.
        pub fn attempted_titles(&self) -> Vec<String> {
            self.observe_attempts
                .lock()
                .unwrap()
                .iter()
                .map(|observation| observation.title.clone())
                .collect()
        }

        fn resolve(&self, target: &SessionNameRef) -> Option<SessionNameRef> {
            let redirects = self.redirects.lock().unwrap();
            let mut current = target.clone();
            loop {
                let next = redirects
                    .iter()
                    .find(|(from, _)| from == &current)
                    .map(|(_, to)| to.clone());
                match next {
                    Some(to) if to != current => current = to,
                    Some(_) => break,
                    None => break,
                }
            }
            Some(current)
        }

        fn record_of(&self, target: &SessionNameRef) -> Option<SessionNameRecord> {
            let resolved = self.resolve(target)?;
            self.records
                .lock()
                .unwrap()
                .iter()
                .rev()
                .find(|(key, _)| key == &resolved)
                .map(|(_, record)| record.clone())
        }

        fn update_for(&self, record: SessionNameRecord, changed: bool) -> SessionNameUpdate {
            let document_generation = self.records.lock().unwrap().len() as u64 + 1;
            SessionNameUpdate {
                redirects: self
                    .redirects
                    .lock()
                    .unwrap()
                    .iter()
                    .map(
                        |(from, to)| freshell_protocol::session_names::SessionNameRedirect {
                            from: from.clone(),
                            to: to.clone(),
                            revision: record.revision,
                        },
                    )
                    .collect(),
                record,
                document_generation,
                changed,
                native_sync: None,
                outcome: None,
            }
        }

        fn set_record(&self, target: SessionNameRef, record: SessionNameRecord) {
            let mut records = self.records.lock().unwrap();
            records.retain(|(key, _)| key != &target);
            records.push((target, record));
        }
    }

    impl SessionNaming for RecordingSink {
        fn get(&self, refs: Vec<SessionNameRef>) -> NameFuture<Vec<SessionNameUpdate>> {
            let updates = refs
                .iter()
                .filter_map(|target| {
                    self.record_of(target)
                        .map(|record| self.update_for(record, false))
                })
                .collect();
            Box::pin(async move { Ok(updates) })
        }

        fn ensure_pending(&self, input: PendingNameInput) -> NameFuture<SessionNameUpdate> {
            let target = SessionNameRef::Pending {
                id: input.handle.clone(),
            };
            if let Some(existing) = self.record_of(&target) {
                let update = self.update_for(existing, false);
                return Box::pin(async move { Ok(update) });
            }
            // The directory-basename fallback the real store derives.
            let fallback = input
                .cwd
                .as_deref()
                .and_then(|cwd| {
                    cwd.rsplit('/')
                        .next()
                        .filter(|s| !s.is_empty())
                        .map(str::to_string)
                })
                .unwrap_or_else(|| input.provider.display_label().to_string());
            let record = SessionNameRecord {
                name_ref: target.clone(),
                name: fallback,
                source: NameSource::Directory,
                revision: 1,
                manual_revision: None,
                renamed_at: None,
                legacy_origin: None,
            };
            let update = self.update_for(record, true);
            self.set_record(target, update.record.clone());
            Box::pin(async move { Ok(update) })
        }

        fn bind_pending(&self, input: BindNameInput) -> NameFuture<SessionNameUpdate> {
            if input.acquisition.persistence
                != freshell_protocol::native_location::NativePersistence::Verified
            {
                return Box::pin(async move {
                    Err(NameError::IdentityAmbiguous(
                        "prospective evidence cannot bind".into(),
                    ))
                });
            }
            let pending = self.record_of(&input.pending);
            let record = match pending {
                Some(mut record) => {
                    // The transfer carries the accepted name onto the durable
                    // record (a manual pre-durable rename outranks the
                    // fallback).
                    record.name_ref = input.target.clone();
                    record.revision += 1;
                    record
                }
                None => SessionNameRecord {
                    name_ref: input.target.clone(),
                    name: "bound".into(),
                    source: NameSource::Directory,
                    revision: 1,
                    manual_revision: None,
                    renamed_at: None,
                    legacy_origin: None,
                },
            };
            {
                let mut redirects = self.redirects.lock().unwrap();
                redirects.push((input.pending.clone(), input.target.clone()));
            }
            self.set_record(input.target.clone(), record);
            let update =
                self.update_for(self.record_of(&input.target).expect("just written"), true);
            Box::pin(async move { Ok(update) })
        }

        fn rename(&self, input: RenameNameInput) -> NameFuture<SessionNameUpdate> {
            let current = self.record_of(&input.target);
            let mut renames = self.renames.lock().unwrap();
            renames.push(input.clone());
            drop(renames);
            let (revision, mut record) = match current {
                Some(record) => {
                    // The compare-and-set contract the real store enforces:
                    // a stale `ifRevision` answers the conflict with the
                    // CURRENT record (the editor's documented refresh input).
                    if let Some(expected) = input.if_revision {
                        if expected != record.revision {
                            let actual = record.revision;
                            return Box::pin(async move {
                                Err(NameError::Conflict {
                                    message: format!(
                                        "the record moved to revision {actual} while the editor held {expected}"
                                    ),
                                    current: Some(record),
                                })
                            });
                        }
                    }
                    (record.revision + 1, record)
                }
                None => {
                    return Box::pin(async move {
                        Err(NameError::NotFound(format!(
                            "no naming record for {}",
                            name_ref_debug_key(&input.target)
                        )))
                    })
                }
            };
            record.name = input.name.clone();
            record.source = if input.intent == NameIntent::User {
                NameSource::Manual
            } else {
                NameSource::ProviderAi
            };
            record.revision = revision;
            record.renamed_at = None;
            self.set_record(record.name_ref.clone(), record.clone());
            let update = self.update_for(record, true);
            Box::pin(async move { Ok(update) })
        }

        fn activity(&self, input: NameActivity) -> NameFuture<SessionNameUpdate> {
            self.activities.lock().unwrap().push(input.clone());
            let answer = match self.record_of(&input.target) {
                Some(record) => Ok(self.update_for(record, false)),
                None => Err(NameError::NotFound(format!(
                    "no naming record for {}",
                    name_ref_debug_key(&input.target)
                ))),
            };
            Box::pin(async move { answer })
        }

        fn observe_native(&self, input: NativeNameObservation) -> NameFuture<SessionNameUpdate> {
            self.observe_attempts.lock().unwrap().push(input.clone());
            if let Some(error) = self.observe_failures.lock().unwrap().pop_front() {
                return Box::pin(async move { Err(error) });
            }
            let answer = match self.record_of(&input.target) {
                Some(record) => Ok(self.update_for(record, false)),
                None => Err(NameError::NotFound(format!(
                    "no naming record for {}",
                    name_ref_debug_key(&input.target)
                ))),
            };
            let gate = self.observe_gate.lock().unwrap().take();
            let observed = std::sync::Arc::clone(&self.observed);
            Box::pin(async move {
                if let Some(gate) = gate {
                    let _ = gate.await;
                }
                if answer.is_ok() {
                    observed.lock().unwrap().push(input);
                }
                answer
            })
        }

        fn current_location_revision(
            &self,
            _target: &SessionNameRef,
        ) -> NameFuture<freshell_protocol::session_names::NameRevision> {
            let revision = self
                .location_revision
                .load(std::sync::atomic::Ordering::SeqCst);
            Box::pin(async move { Ok(revision) })
        }

        fn record_acquisition(
            &self,
            target: SessionNameRef,
            _acquisition: NativeAcquisition,
        ) -> NameFuture<SessionNameUpdate> {
            let answer = match self.record_of(&target) {
                Some(record) => Ok(self.update_for(record, false)),
                None => Err(NameError::NotFound(format!(
                    "no naming record for {}",
                    name_ref_debug_key(&target)
                ))),
            };
            Box::pin(async move { answer })
        }
    }

    impl Default for RecordingSink {
        fn default() -> Self {
            Self {
                renames: Mutex::new(Vec::new()),
                activities: Mutex::new(Vec::new()),
                observe_attempts: Mutex::new(Vec::new()),
                observed: std::sync::Arc::new(Mutex::new(Vec::new())),
                observe_gate: Mutex::new(None),
                observe_failures: Mutex::new(std::collections::VecDeque::new()),
                location_revision: std::sync::atomic::AtomicU64::new(
                    freshell_protocol::session_names::MAX_NAME_REVISION,
                ),
                records: Mutex::new(Vec::new()),
                redirects: Mutex::new(Vec::new()),
            }
        }
    }

    /// Seed a record directly (tests that observe a durable session the
    /// sink never admitted).
    impl RecordingSink {
        pub fn seed_record(&self, record: SessionNameRecord) {
            self.set_record(record.name_ref.clone(), record);
        }
    }

    /// A verified claude acquisition for bind tests.
    pub(crate) fn verified_claude_acquisition(
        session_id: &str,
    ) -> freshell_protocol::native_location::NativeAcquisition {
        freshell_protocol::native_location::NativeAcquisition {
            location: freshell_protocol::native_location::NativeLocation::Claude {
                config_root: "/h/.claude".into(),
                transcript_path: Some(format!("/h/.claude/projects/-p/{session_id}.jsonl")),
                project_directory_key: None,
                transcript_cwd: None,
                effective_project_key_override: None,
            },
            evidence: freshell_protocol::native_location::NativeEvidenceKind::SelectedTranscript,
            persistence: freshell_protocol::native_location::NativePersistence::Verified,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use freshell_protocol::native_location::{
        NativeEvidenceKind, NativeLocation, NativePersistence,
    };
    use freshell_protocol::session_names::{
        NameIntent, NameSource, NamedProvider, SessionNameRecord, SessionNameRef,
    };

    use super::test_support::{verified_claude_acquisition, RecordingSink};
    use super::{
        admit_pending_projection, is_unified_agent_mode, name_ref_debug_key, named_provider_for,
        session_projection, BindNameInput, NameError, PendingNameInput, RenameNameInput,
        SessionNaming, NAME_RESET_UNSUPPORTED,
    };

    // ── the scope predicate (the Rust mirror of isUnifiedAgentMode) ──────────

    /// The six unified modes scope; everything else — including kilroy, the
    /// Claude-runtime twin — does not.
    #[test]
    fn unified_agent_scope_matches_exactly_the_six_modes() {
        for mode in ["claude", "codex", "opencode"] {
            assert!(is_unified_agent_mode(Some(mode), None), "terminal {mode}");
        }
        for session_type in ["freshclaude", "freshcodex", "freshopencode"] {
            assert!(
                is_unified_agent_mode(None, Some(session_type)),
                "fresh {session_type}"
            );
            assert!(
                is_unified_agent_mode(Some(session_type), None),
                "fresh {session_type} as mode"
            );
        }
        for excluded in ["shell", "gemini", "kimi", "amplifier"] {
            assert!(
                !is_unified_agent_mode(Some(excluded), None),
                "{excluded} is out of scope"
            );
        }
        // Kilroy is NEVER scoped, regardless of the mode it rides on.
        assert!(!is_unified_agent_mode(None, Some("kilroy")));
        assert!(!is_unified_agent_mode(Some("claude"), Some("kilroy")));
        assert!(!is_unified_agent_mode(None, None));
    }

    /// `named_provider_for` answers the provider enum for the six modes and
    /// `None` for everything else (kilroy included).
    #[test]
    fn named_provider_answers_the_scoped_provider_only() {
        assert_eq!(
            named_provider_for(Some("claude"), None),
            Some(NamedProvider::Claude)
        );
        assert_eq!(
            named_provider_for(Some("codex"), None),
            Some(NamedProvider::Codex)
        );
        assert_eq!(
            named_provider_for(None, Some("freshopencode")),
            Some(NamedProvider::Opencode)
        );
        assert_eq!(named_provider_for(None, Some("kilroy")), None);
        assert_eq!(named_provider_for(Some("gemini"), None), None);
        assert_eq!(named_provider_for(None, None), None);
    }

    // ── the error contract (status + stable codes) ───────────────────────────

    /// The plan's mapped statuses and stable machine-readable codes.
    #[test]
    fn name_error_maps_statuses_and_codes() {
        let cases = [
            (
                NameError::InvalidName("blank".into()),
                400u16,
                "NAME_INVALID",
            ),
            (NameError::NotFound("gone".into()), 404, "NAME_NOT_FOUND"),
            (
                NameError::IdentityAmbiguous("prospective".into()),
                409,
                "NAME_IDENTITY_AMBIGUOUS",
            ),
            (
                NameError::Conflict {
                    message: "moved".into(),
                    current: Some(SessionNameRecord {
                        name_ref: SessionNameRef::Pending { id: "h".into() },
                        name: "current".into(),
                        source: NameSource::Manual,
                        revision: 3,
                        manual_revision: None,
                        renamed_at: None,
                        legacy_origin: None,
                    }),
                },
                409,
                "NAME_REVISION_CONFLICT",
            ),
            (
                NameError::Persistence("io".into()),
                503,
                "NAME_PERSISTENCE_FAILED",
            ),
            (
                NameError::CommitUncertain("uncertain".into()),
                503,
                "NAME_COMMIT_UNCERTAIN",
            ),
            (
                NameError::LockUnavailable("busy".into()),
                503,
                "NAME_LOCK_UNAVAILABLE",
            ),
        ];
        for (error, status, code) in cases {
            assert_eq!(error.http_status(), status, "{error}");
            assert_eq!(error.code(), code, "{error}");
        }
        // The conflict answer carries the accepted record (the editor's
        // surfaced winner), not just a message.
        assert!(matches!(
            NameError::Conflict {
                message: "m".into(),
                current: None
            },
            NameError::Conflict { .. }
        ));
        assert_eq!(NAME_RESET_UNSUPPORTED, "NAME_RESET_UNSUPPORTED");
    }

    // ── the debug key ─────────────────────────────────────────────────────────

    /// The log-field key is stable and distinguishes pending from session
    /// refs (never colon-splits opaque provider session ids).
    #[test]
    fn name_ref_debug_key_is_stable_and_ref_shaped() {
        let pending = SessionNameRef::Pending { id: "nh-1".into() };
        let session = SessionNameRef::Session {
            provider: NamedProvider::Codex,
            session_id: "ses/opencode:weird".into(),
        };
        assert_eq!(name_ref_debug_key(&pending), r#"["pending",nh-1]"#);
        assert_eq!(
            name_ref_debug_key(&session),
            r#"["session","codex",ses/opencode:weird]"#
        );
        assert_eq!(name_ref_debug_key(&pending), name_ref_debug_key(&pending));
    }

    // ── the frame projection helpers (over the recording sink) ───────────────

    /// `admit_pending_projection` admits the handle and answers the fallback
    /// record; `session_projection` resolves a bound durable record.
    #[tokio::test]
    async fn frame_projections_admit_and_resolve_through_the_sink() {
        let sink: Arc<dyn SessionNaming> = RecordingSink::new();
        let (name_ref, record) = admit_pending_projection(
            &Some(sink.clone()),
            "handle-x",
            NamedProvider::Codex,
            Some("/work/project"),
        )
        .await
        .expect("admission answers the projection");
        assert_eq!(
            name_ref,
            SessionNameRef::Pending {
                id: "handle-x".into()
            }
        );
        assert_eq!(record.name, "project", "the directory-basename fallback");

        // Unwired => None (the out-of-scope degradation, never an error).
        assert!(
            admit_pending_projection(&None, "handle-x", NamedProvider::Codex, None)
                .await
                .is_none()
        );
        // Unknown durable record => None (the caller omits the fields).
        assert!(
            session_projection(&Some(sink.clone()), NamedProvider::Codex, "unknown")
                .await
                .is_none()
        );

        // Bind the handle onto a durable session, then the session projection
        // resolves the same record the pending ref redirects to.
        sink.bind_pending(BindNameInput {
            pending: SessionNameRef::Pending {
                id: "handle-x".into(),
            },
            target: SessionNameRef::Session {
                provider: NamedProvider::Codex,
                session_id: "thread-1".into(),
            },
            acquisition: verified_claude_acquisition("thread-1"),
        })
        .await
        .expect("verified bind");
        let (durable_ref, durable_record) =
            session_projection(&Some(sink), NamedProvider::Codex, "thread-1")
                .await
                .expect("the bound record resolves");
        assert_eq!(
            durable_ref,
            SessionNameRef::Session {
                provider: NamedProvider::Codex,
                session_id: "thread-1".into()
            }
        );
        assert_eq!(
            durable_record.name, "project",
            "the name carried through the bind"
        );
    }

    /// The recording sink's own store-mirror semantics: a prospective bind is
    /// refused, a verified bind is idempotent, and a pre-durable MANUAL
    /// rename survives the transfer.
    #[tokio::test]
    async fn recording_sink_mirrors_the_bind_contract() {
        let sink: Arc<dyn SessionNaming> = RecordingSink::new();
        sink.ensure_pending(PendingNameInput {
            handle: "handle-m".into(),
            provider: NamedProvider::Claude,
            cwd: Some("/work".into()),
        })
        .await
        .unwrap();
        // A pre-durable MANUAL rename.
        sink.rename(RenameNameInput {
            target: SessionNameRef::Pending {
                id: "handle-m".into(),
            },
            name: "Named Before Identity".into(),
            intent: NameIntent::User,
            if_revision: None,
            cwd: None,
        })
        .await
        .unwrap();
        // A prospective bind is refused loudly.
        let refused = sink
            .bind_pending(BindNameInput {
                pending: SessionNameRef::Pending {
                    id: "handle-m".into(),
                },
                target: SessionNameRef::Session {
                    provider: NamedProvider::Claude,
                    session_id: "sess-m".into(),
                },
                acquisition: freshell_protocol::native_location::NativeAcquisition {
                    location: NativeLocation::Claude {
                        config_root: "/h/.claude".into(),
                        transcript_path: None,
                        project_directory_key: None,
                        transcript_cwd: None,
                        effective_project_key_override: None,
                    },
                    evidence: NativeEvidenceKind::InitializedRuntime,
                    persistence: NativePersistence::Prospective,
                },
            })
            .await;
        assert!(refused.is_err(), "prospective evidence cannot bind");
        // The verified bind carries the manual name.
        let bound = sink
            .bind_pending(BindNameInput {
                pending: SessionNameRef::Pending {
                    id: "handle-m".into(),
                },
                target: SessionNameRef::Session {
                    provider: NamedProvider::Claude,
                    session_id: "sess-m".into(),
                },
                acquisition: verified_claude_acquisition("sess-m"),
            })
            .await
            .unwrap();
        assert_eq!(bound.record.name, "Named Before Identity");
        assert_eq!(bound.record.source, NameSource::Manual);
    }
}
