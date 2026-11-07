//! Durable, provider-neutral ownership for one fresh-agent conversation.
//!
//! The actor lives in the per-soul session host. A web gateway owns only an
//! event cursor; dropping that cursor cannot drop the provider transport.

use async_trait::async_trait;
pub use freshell_runtime_protocol::{
    AgentEvent, AgentEventBatch as EventBatch, AgentJournalEvent as JournalEvent, FreshProvider,
    NativeDispatchIdentity,
};
use freshell_runtime_protocol::{
    CommandState, EvidenceStoreState, FreshAgentCapture, FreshAgentNativeNameError,
    FreshAgentNativeNameOperation, FreshAgentNativeNameReply, FreshAgentRollbackDirection,
    FreshAgentRollbackMode, FreshAgentTurnSettings, NativeIdentityLaunch,
    NativeIdentityObservation, NativeReadinessAbsenceEvidence, NativeReadinessFence,
    NativeReadinessReceipt, NativeReadinessRecoveryAuthorization, ProviderLaunchContext,
    ProviderModelSelection, ProviderSecretReference, ProviderSessionReference, RecoveryBlockReason,
    RequestId, ResumeSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::Mutex;

pub const DEFAULT_EVENT_BYTES: usize = 4 * 1024 * 1024;
pub const DEFAULT_EVENT_COUNT: usize = 4_096;

mod double_optional {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};

    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Ok(Some(Option::deserialize(deserializer)?))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreshAgentProfile {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub naming_handle: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collaboration_mode: Option<String>,
    pub provider: FreshProvider,
    pub runtime_variant: String,
    pub cwd: String,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub permission_mode: Option<String>,
    pub sandbox: Option<String>,
    pub provider_store_id: String,
    pub native_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plugins: Option<Vec<String>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_optional"
    )]
    pub model_selection: Option<Option<ProviderModelSelection>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<ProviderSessionReference>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_launch_context: Option<ProviderLaunchContext>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub provider_secret_references: Vec<ProviderSecretReference>,
}

impl FreshAgentProfile {
    pub fn effective_permission_mode(&self) -> Option<&str> {
        let permission_mode = self
            .permission_mode
            .as_deref()
            .filter(|permission| self.provider != FreshProvider::Codex || *permission != "default");
        permission_mode.or_else(|| {
            if self.provider != FreshProvider::Codex {
                return None;
            }
            match &self.provider_launch_context.as_ref()?.preparation {
                freshell_runtime_protocol::ProviderPreparation::Codex {
                    approval_default, ..
                } => approval_default
                    .as_ref()
                    .map(|default| default.policy.as_str()),
                _ => None,
            }
        })
    }

    /// Folds per-turn settings into the durable launch profile: every
    /// provided field replaces the stored one, absent fields keep it.
    pub fn apply_turn_settings(&mut self, settings: &FreshAgentTurnSettings) {
        if let Some(value) = &settings.collaboration_mode {
            self.collaboration_mode = Some(value.clone());
        }
        if let Some(value) = &settings.cwd {
            self.cwd = value.clone();
        }
        if let Some(value) = &settings.model {
            self.model = Some(value.clone());
        }
        if let Some(value) = &settings.effort {
            self.effort = value.clone();
        }
        if let Some(value) = &settings.permission_mode {
            self.permission_mode = Some(value.clone());
        }
        if let Some(value) = &settings.sandbox {
            self.sandbox = Some(value.clone());
        }
    }

    /// Folds a `freshAgent.configure` into the durable launch profile. It is
    /// the per-turn fold, except that an absent effort follows the
    /// provider's live configure rule
    /// ([`FreshAgentTurnSettings::effort_after_configure`]).
    pub fn apply_configure_settings(&mut self, settings: &FreshAgentTurnSettings) {
        let effort = settings.effort_after_configure(
            &self.provider,
            self.model.as_deref(),
            self.effort.as_deref(),
        );
        self.apply_turn_settings(settings);
        self.effort = effort;
    }

    pub fn validate(&self) -> Result<(), ActorError> {
        if self.runtime_variant.is_empty()
            || self
                .collaboration_mode
                .as_deref()
                .is_some_and(|mode| !matches!(mode, "default" | "plan"))
            || self.cwd.is_empty()
            || self.provider_store_id.is_empty()
            || self.native_session_id.as_deref().is_some_and(str::is_empty)
            || self.plugins.as_ref().is_some_and(|plugins| {
                plugins.len() > 64
                    || plugins.iter().any(|plugin| {
                        plugin.is_empty()
                            || plugin.len() > 1024
                            || plugin.chars().any(char::is_control)
                    })
            })
            || self.session_ref.as_ref().is_some_and(|reference| {
                reference.session_id.is_empty()
                    || self
                        .native_session_id
                        .as_ref()
                        .is_some_and(|native| native != &reference.session_id)
            })
            || (self.provider == FreshProvider::Codex
                && self
                    .session_ref
                    .as_ref()
                    .is_some_and(|reference| reference.provider != "codex"))
        {
            return Err(ActorError::InvalidProfile);
        }
        if self
            .provider_launch_context
            .as_ref()
            .is_some_and(|context| context.validate(self.provider.native_family()).is_err())
        {
            return Err(ActorError::InvalidProfile);
        }
        if [
            self.model.as_deref(),
            self.effort.as_deref(),
            self.permission_mode.as_deref(),
            self.sandbox.as_deref(),
        ]
        .into_iter()
        .flatten()
        .any(|value| value.len() > 256 || value.chars().any(char::is_control))
        {
            return Err(ActorError::InvalidProfile);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransportStart {
    /// Zero-turn Claude/OpenCode sessions may not have materialized a durable
    /// provider identity yet. The event pump records it before it is exposed
    /// as durable inventory.
    pub native_session_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeReadinessResumeStart {
    Resumed(TransportStart),
    PriorThreadNotFound,
}

/// Closed substep classification for provider startup during cold Codex
/// native-readiness recovery. These values are safe to retain in host
/// lifecycle diagnostics and never contain provider output.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeReadinessProviderStartCause {
    ExactResumeValidation,
    ExactResumeAppServerStart,
    ExactResumeRpc,
    ExactResumeCreateRejected,
    ExactResumeIdentity,
    ExactResumeSettingsReapply,
    ReplacementValidation,
    ReplacementAppServerStart,
    ReplacementThreadStart,
    ReplacementCreateFinalize,
    ReplacementCreateRejected,
    ReplacementIdentity,
    Unsupported,
}

impl NativeReadinessProviderStartCause {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ExactResumeValidation => "exact_resume_validation",
            Self::ExactResumeAppServerStart => "exact_resume_app_server_start",
            Self::ExactResumeRpc => "exact_resume_rpc",
            Self::ExactResumeCreateRejected => "exact_resume_create_rejected",
            Self::ExactResumeIdentity => "exact_resume_identity",
            Self::ExactResumeSettingsReapply => "exact_resume_settings_reapply",
            Self::ReplacementValidation => "replacement_validation",
            Self::ReplacementAppServerStart => "replacement_app_server_start",
            Self::ReplacementThreadStart => "replacement_thread_start",
            Self::ReplacementCreateFinalize => "replacement_create_finalize",
            Self::ReplacementCreateRejected => "replacement_create_rejected",
            Self::ReplacementIdentity => "replacement_identity",
            Self::Unsupported => "unsupported",
        }
    }
}

/// Safe provider-side classification paired with a recovery startup cause.
/// The underlying error string is intentionally discarded at this boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NativeReadinessProviderStartFailure {
    pub cause: NativeReadinessProviderStartCause,
    pub diagnostic: ProviderStartDiagnostic,
}

impl NativeReadinessProviderStartFailure {
    pub const fn new(
        cause: NativeReadinessProviderStartCause,
        diagnostic: ProviderStartDiagnostic,
    ) -> Self {
        Self { cause, diagnostic }
    }

    pub fn from_provider_error(cause: NativeReadinessProviderStartCause, error: &str) -> Self {
        Self::new(cause, ProviderStartDiagnostic::from_provider_error(error))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchAck {
    pub provider_ack_id: Option<String>,
    /// Direct correlated provider acceptance, never an asynchronous Started
    /// frame. The previous identity fences a recovery result to its caller.
    pub native_identity: Option<NativeDispatchIdentity>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchResult {
    pub state: CommandState,
    /// The provider's exact correlated identity receipt. Persisted with the
    /// command so a retry after a lost host reply returns the same transition.
    pub native_identity: Option<NativeDispatchIdentity>,
    /// The exact retained Codex source used to accept the command. Returning
    /// this beside the durable identity lets the host finish its launch-state
    /// write after the provider process has exited, without inventing live
    /// evidence or replaying the provider input.
    pub codex_dispatch_recovery_source: Option<NativeIdentityObservation>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationAck {
    pub provider_ack_id: Option<String>,
    /// Some rollback implementations materialize a new provider-native
    /// conversation while retaining the Freshell presentation identity.
    pub native_session_id: Option<String>,
}

/// Private actor persistence. Only the body-free recipe crosses host/supervisor
/// acknowledgement; the existing Claude rollback record stays in owned storage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeForkState {
    pub native_session_id: String,
    pub recipe: Option<freshell_runtime_protocol::ClaudeForkRecipe>,
    pub rollback: Option<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DispatchFailure {
    pub message: String,
    /// True when the request crossed the transport's acceptance boundary or
    /// the transport cannot prove that it did not.
    pub acceptance_ambiguous: bool,
    /// Only an already-published, request-correlated provider receipt may be
    /// copied here. `message` itself is not safe for a control response.
    pub provider_diagnostic: Option<freshell_runtime_protocol::FreshAgentSendDiagnostic>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForkTransition {
    pub parent_session_id: String,
    pub child_session_id: String,
    /// True only after the provider-owned parent writer/session has been
    /// retired inside this same soul. This lets the web avoid translating a
    /// provider-native branch operation into a destructive whole-soul stop.
    pub parent_retired_by_runtime: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationFailureKind {
    Unsupported,
    Rejected,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OperationFailure {
    pub kind: OperationFailureKind,
    pub message: String,
    pub acceptance_ambiguous: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case")]
pub enum FreshAgentOperation {
    Compact {
        instructions: Option<String>,
        cwd: Option<String>,
    },
    Rollback {
        direction: FreshAgentRollbackDirection,
        mode: FreshAgentRollbackMode,
        turn_id: Option<String>,
        cwd: Option<String>,
    },
    /// Apply settings to the live provider session without a turn.
    Configure { settings: FreshAgentTurnSettings },
}

#[async_trait]
pub trait FreshAgentTransport: Send + Sync {
    async fn restore_claude_fork_state(&self, _state: ClaudeForkState) -> Result<(), String> {
        Ok(())
    }
    async fn claude_fork_state(&self) -> Option<ClaudeForkState> {
        None
    }
    async fn disable_claude_fork_recovery(
        &self,
        _destroys_redo: bool,
    ) -> Result<Option<ClaudeForkState>, String> {
        Ok(None)
    }
    async fn resume_native_permission_recovery(&self) -> Result<(), DispatchFailure> {
        Ok(())
    }
    async fn prepare_native_permission_recovery(
        &self,
        _checkpoints: Vec<Value>,
    ) -> Result<(), String> {
        Ok(())
    }
    async fn native_identity_evidence(&self) -> Option<Value> {
        None
    }
    /// Rebind a restarted provider bridge to the next launch in an accepted
    /// native-readiness receipt before the provider resumes its persisted
    /// conversation. Implementations without a launch-bound bridge can ignore
    /// this handoff.
    async fn restore_native_readiness_receipt(
        &self,
        _receipt: &NativeReadinessReceipt,
    ) -> Result<(), String> {
        Ok(())
    }
    /// Restore provider readiness without sending a user turn or releasing a
    /// retained permission/effect. The host revalidates native identity next.
    async fn prepare_native_readiness(
        &self,
        _expected_launch: &NativeIdentityLaunch,
    ) -> Result<Option<NativeDispatchIdentity>, String> {
        Ok(None)
    }
    /// Explicit Compact readiness may resume only the retained native root.
    /// Implementations that do not support this stricter path refuse it.
    async fn prepare_same_root_native_readiness(&self) -> Result<(), String> {
        Err("same-root native readiness is unsupported".into())
    }
    async fn start(&self, profile: &FreshAgentProfile) -> Result<TransportStart, String>;
    /// The replacement-only first phase: try the exact prior Codex root using
    /// the immutable ResumeSpec CWD. A typed missing-root result is returned
    /// separately so the actor can census the store and journal before minting.
    async fn start_native_readiness_resume(
        &self,
        _profile: &FreshAgentProfile,
        _resume_spec: &ResumeSpec,
    ) -> Result<NativeReadinessResumeStart, NativeReadinessProviderStartFailure> {
        Err(NativeReadinessProviderStartFailure::new(
            NativeReadinessProviderStartCause::Unsupported,
            ProviderStartDiagnostic::NoDiagnostic,
        ))
    }
    /// Inspect native provider storage through the transport's existing
    /// provider-identity boundary. Test transports may use the direct reader
    /// when their fixture storage belongs to the test process.
    async fn probe_native_store(
        &self,
        resume_spec: &ResumeSpec,
    ) -> Result<crate::ProviderStoreProbe, String> {
        Ok(crate::probe_provider_store(
            Path::new(&resume_spec.provider_home),
            resume_spec,
        ))
    }
    /// Mint a replacement root only after the actor has persisted its
    /// attempt-bound mint-in-progress journal.
    async fn start_native_readiness_replacement(
        &self,
        _profile: &FreshAgentProfile,
        _authorization: &NativeReadinessRecoveryAuthorization,
    ) -> Result<TransportStart, NativeReadinessProviderStartFailure> {
        Err(NativeReadinessProviderStartFailure::new(
            NativeReadinessProviderStartCause::Unsupported,
            ProviderStartDiagnostic::NoDiagnostic,
        ))
    }
    async fn dispatch(
        &self,
        request_id: &RequestId,
        text: &str,
        profile: &FreshAgentProfile,
    ) -> Result<DispatchAck, DispatchFailure>;
    /// Dispatches a send whose checkpoint attempt identity must reach the
    /// provider-native turn receipt. Legacy transports remain compatible and
    /// ignore the optional metadata by delegating to `dispatch`.
    async fn dispatch_with_checkpoint_identity(
        &self,
        request_id: &RequestId,
        text: &str,
        profile: &FreshAgentProfile,
        _logical_attempt_id: Option<&str>,
    ) -> Result<DispatchAck, DispatchFailure> {
        self.dispatch(request_id, text, profile).await
    }
    /// Carries the caller's partial settings separately from durable launch
    /// intent. Providers with native effective defaults must not restate an
    /// unchanged launch profile as new overrides on every send.
    async fn dispatch_with_turn_settings(
        &self,
        request_id: &RequestId,
        text: &str,
        profile: &FreshAgentProfile,
        _settings: Option<&FreshAgentTurnSettings>,
        logical_attempt_id: Option<&str>,
    ) -> Result<DispatchAck, DispatchFailure> {
        self.dispatch_with_checkpoint_identity(request_id, text, profile, logical_attempt_id)
            .await
    }
    /// Dispatches the single Codex send authorized by an exact retained native
    /// source. Other transports refuse this capability by default.
    async fn dispatch_with_codex_recovery_source(
        &self,
        request_id: &RequestId,
        text: &str,
        profile: &FreshAgentProfile,
        settings: Option<&FreshAgentTurnSettings>,
        logical_attempt_id: Option<&str>,
        source: Option<&NativeIdentityObservation>,
    ) -> Result<DispatchAck, DispatchFailure> {
        if source.is_some() {
            return Err(DispatchFailure {
                provider_diagnostic: Some(freshell_runtime_protocol::FreshAgentSendDiagnostic {
                    outcome: freshell_runtime_protocol::FreshAgentSendDiagnosticOutcome::Refused,
                    message: Some("Codex recovery send is unsupported by this transport".into()),
                }),
                message: "Codex recovery send is unsupported by this transport".into(),
                acceptance_ambiguous: false,
            });
        }
        self.dispatch_with_turn_settings(request_id, text, profile, settings, logical_attempt_id)
            .await
    }
    async fn resolve_permission(
        &self,
        decision_id: &str,
        decision: Value,
    ) -> Result<(), DispatchFailure>;
    async fn resolve_permission_with_attempt_id(
        &self,
        decision_id: &str,
        decision: Value,
        _operation_attempt_id: Option<&str>,
    ) -> Result<(), DispatchFailure> {
        self.resolve_permission(decision_id, decision).await
    }
    /// Branch the provider-native conversation inside this owned soul. Providers
    /// without a native fork surface return a deterministic unsupported error.
    async fn fork(
        &self,
        _request_id: &RequestId,
        _parent_session_id: &str,
        _input: Option<Value>,
    ) -> Result<ForkTransition, DispatchFailure> {
        Err(DispatchFailure {
            provider_diagnostic: None,
            message: "provider-native conversation fork is unsupported".into(),
            acceptance_ambiguous: false,
        })
    }
    async fn interrupt(&self) -> Result<(), String>;
    /// Preserve the public request id when a provider can publish a receipt.
    /// Existing transports may continue handling uncorrelated Stop requests.
    async fn interrupt_with_request_id(&self, _request_id: Option<&str>) -> Result<(), String> {
        self.interrupt().await
    }
    async fn supports_operation(&self, _operation: &FreshAgentOperation) -> Result<bool, String> {
        Ok(false)
    }
    async fn dispatch_operation(
        &self,
        _request_id: &RequestId,
        _operation: &FreshAgentOperation,
    ) -> Result<OperationAck, OperationFailure> {
        Err(OperationFailure {
            kind: OperationFailureKind::Unsupported,
            message: "provider does not support this operation".into(),
            acceptance_ambiguous: false,
        })
    }
    async fn capture(&self, _max_bytes: usize) -> Result<FreshAgentCapture, String> {
        Err("provider does not expose a hosted snapshot".into())
    }
    /// Optional authoritative in-memory source. No native RPC or runtime creation.
    async fn retained_state(&self) -> Result<Option<Value>, String> {
        Ok(None)
    }
    async fn snapshot(&self) -> Result<Value, String> {
        Err("provider does not expose a hosted snapshot".into())
    }
    async fn model_catalog(&self, _cwd: Option<&str>) -> Result<Value, String> {
        Err("provider does not expose a model catalog".into())
    }

    async fn native_name(
        &self,
        _native_session_id: &str,
        _codex_home: &str,
        _operation: &FreshAgentNativeNameOperation,
    ) -> FreshAgentNativeNameReply {
        FreshAgentNativeNameReply::Failed(FreshAgentNativeNameError::Unavailable {
            message: "provider has no live native naming authority".into(),
        })
    }

    async fn read_child(&self, _child_thread_id: &str) -> Result<Value, String> {
        Err("provider does not expose child observation".into())
    }

    /// A registered zero-turn identity is transport-owned, not a durable native identity.
    /// Only transports that can prove their current local registration opt in.
    async fn registered_snapshot_identity(&self) -> Option<String> {
        None
    }
    /// Whether this actor still owns a usable provider enclosure. Provider
    /// adapters may self-heal a child internally; they should report false
    /// only when no live owned session remains.
    async fn is_live(&self) -> bool {
        true
    }
    async fn stop(self: Arc<Self>) -> Result<(), String>;
    fn take_event_stream(&self) -> Option<tokio::sync::mpsc::Receiver<AgentEvent>>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeReadinessProbeFailureCause {
    ProviderRootNotDirectory,
    ProviderPathInspectionFailed,
    ProviderArtifactInspectionFailed,
    ProviderSymlinkUnresolved,
    ProviderTreeBoundExceeded,
    ProviderDirectoryReadFailed,
    ProviderDirectoryEntryFailed,
    ProviderArtifactNotRegular,
    ProviderArtifactMalformedOrOwnerMissing,
    ProviderArtifactUnreadableOrConflicting,
    ProviderHistoryIncomplete,
    NativeClassificationChanged,
    NativeGenerationUnreadable,
    NativeGenerationChanged,
    NativeCensusInvalid,
}

impl NativeReadinessProbeFailureCause {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ProviderRootNotDirectory => "provider_root_not_directory",
            Self::ProviderPathInspectionFailed => "provider_path_inspection_failed",
            Self::ProviderArtifactInspectionFailed => "provider_artifact_inspection_failed",
            Self::ProviderSymlinkUnresolved => "provider_symlink_unresolved",
            Self::ProviderTreeBoundExceeded => "provider_tree_bound_exceeded",
            Self::ProviderDirectoryReadFailed => "provider_directory_read_failed",
            Self::ProviderDirectoryEntryFailed => "provider_directory_entry_failed",
            Self::ProviderArtifactNotRegular => "provider_artifact_not_regular",
            Self::ProviderArtifactMalformedOrOwnerMissing => {
                "provider_artifact_malformed_or_owner_missing"
            }
            Self::ProviderArtifactUnreadableOrConflicting => {
                "provider_artifact_unreadable_or_conflicting"
            }
            Self::ProviderHistoryIncomplete => "provider_history_incomplete",
            Self::NativeClassificationChanged => "native_classification_changed",
            Self::NativeGenerationUnreadable => "native_generation_unreadable",
            Self::NativeGenerationChanged => "native_generation_changed",
            Self::NativeCensusInvalid => "native_census_invalid",
        }
    }

    fn from_probe_repair(repair: Option<&str>) -> Option<Self> {
        Some(match repair? {
            "provider store root is not a directory" => Self::ProviderRootNotDirectory,
            "selected provider store has no established absolute root"
            | "provider store path is not canonical"
            | "provider store path could not be inspected"
            | "repair provider-state volume permissions" => Self::ProviderPathInspectionFailed,
            "provider native artifact could not be inspected" => {
                Self::ProviderArtifactInspectionFailed
            }
            "provider native store contains an unresolved symlink" => {
                Self::ProviderSymlinkUnresolved
            }
            "provider native store exceeds the bounded directory inspection"
            | "provider store exceeded the bounded exact-identity probe" => {
                Self::ProviderTreeBoundExceeded
            }
            "provider native directory could not be read" => Self::ProviderDirectoryReadFailed,
            "provider native directory entry could not be inspected" => {
                Self::ProviderDirectoryEntryFailed
            }
            "provider native artifact is not a regular file" => Self::ProviderArtifactNotRegular,
            "the selected provider native root contains unreadable or conflicting records" => {
                Self::ProviderArtifactUnreadableOrConflicting
            }
            "provider native artifact has no readable unambiguous owner" => {
                Self::ProviderArtifactMalformedOrOwnerMissing
            }
            "provider native history contains companion or incompletely inspected artifacts; exact-root absence is unresolved" => {
                Self::ProviderHistoryIncomplete
            }
            "native storage classification changed during inspection" => {
                Self::NativeClassificationChanged
            }
            "complete native storage generation could not be inspected" => {
                Self::NativeGenerationUnreadable
            }
            "native storage changed during inspection" => Self::NativeGenerationChanged,
            "native absence census could not be bound to exact store selection" => {
                Self::NativeCensusInvalid
            }
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeReadinessRecoveryStage {
    Authorization,
    PersistedReceipt,
    MissingAuthorization,
    AbsenceCensus,
    AbsenceProbeWorker,
    AbsenceProbeReady,
    AbsenceProbeBlocked {
        reason: RecoveryBlockReason,
        store_state: EvidenceStoreState,
        failure_cause: Option<NativeReadinessProbeFailureCause>,
    },
    AbsenceProbeUnexpected,
    AbsenceCensusSelectionMismatch,
    AbsenceCensusEnvironmentMismatch,
    AbsenceCensusReferenceMissing,
    AbsenceEvidenceInvalid,
    ReplacementIdentity,
    BeforeRebindEvidence,
    ReboundReceipt,
    AfterRebindEvidence,
    StartupEvidence,
}

impl NativeReadinessRecoveryStage {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Authorization => "authorization",
            Self::PersistedReceipt => "persisted_receipt",
            Self::MissingAuthorization => "missing_authorization",
            Self::AbsenceCensus => "absence_census",
            Self::AbsenceProbeWorker => "absence_probe_worker",
            Self::AbsenceProbeReady => "absence_probe_ready",
            Self::AbsenceProbeBlocked { .. } => "absence_probe_blocked",
            Self::AbsenceProbeUnexpected => "absence_probe_unexpected",
            Self::AbsenceCensusSelectionMismatch => "absence_census_selection_mismatch",
            Self::AbsenceCensusEnvironmentMismatch => "absence_census_environment_mismatch",
            Self::AbsenceCensusReferenceMissing => "absence_census_reference_missing",
            Self::AbsenceEvidenceInvalid => "absence_evidence_invalid",
            Self::ReplacementIdentity => "replacement_identity",
            Self::BeforeRebindEvidence => "before_rebind_evidence",
            Self::ReboundReceipt => "rebound_receipt",
            Self::AfterRebindEvidence => "after_rebind_evidence",
            Self::StartupEvidence => "startup_evidence",
        }
    }

    pub const fn probe_kind(self) -> Option<&'static str> {
        match self {
            Self::AbsenceProbeReady => Some("ready"),
            Self::AbsenceProbeBlocked { .. } => Some("blocked"),
            Self::AbsenceProbeUnexpected => Some("unexpected"),
            _ => None,
        }
    }

    pub const fn probe_blocked_reason(self) -> Option<RecoveryBlockReason> {
        match self {
            Self::AbsenceProbeBlocked { reason, .. } => Some(reason),
            _ => None,
        }
    }

    pub const fn probe_store_state(self) -> Option<EvidenceStoreState> {
        match self {
            Self::AbsenceProbeReady => Some(EvidenceStoreState::PresentReadable),
            Self::AbsenceProbeBlocked { store_state, .. } => Some(store_state),
            _ => None,
        }
    }

    pub const fn probe_failure_cause(self) -> Option<NativeReadinessProbeFailureCause> {
        match self {
            Self::AbsenceProbeBlocked { failure_cause, .. } => failure_cause,
            _ => None,
        }
    }
}

impl std::fmt::Display for NativeReadinessRecoveryStage {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ActorError {
    #[error("fresh-agent profile is incomplete")]
    InvalidProfile,
    #[error("another writer owns this fresh-agent host state")]
    WriterBusy,
    #[error("fresh-agent native identity mismatch")]
    NativeIdentityMismatch,
    #[error("fresh-agent native readiness recovery failed during {stage}")]
    NativeReadinessRecoveryFailed { stage: NativeReadinessRecoveryStage },
    #[error("fresh-agent persisted profile identity mismatch")]
    NativeProfileMismatch(NativeProfileMismatchFacts),
    #[error("fresh-agent native session identity mismatch")]
    NativeSessionIdentityMismatch {
        expected_present: bool,
        observed_present: bool,
        matches: bool,
    },
    #[error("request id was reused with different content")]
    RequestConflict,
    #[error("command dispatch is ambiguous and will not be replayed")]
    AmbiguousDispatch,
    #[error("provider published a send diagnostic")]
    ProviderSendDiagnostic(freshell_runtime_protocol::FreshAgentSendDiagnostic),
    #[error("provider refused the input")]
    SendRefused,
    #[error("provider does not support this operation")]
    UnsupportedOperation,
    #[error("fresh-agent provider start failed (startup diagnostic: {diagnostic})")]
    ProviderStartFailed { diagnostic: ProviderStartDiagnostic },
    #[error("fresh-agent native-readiness provider start failed during {cause:?}")]
    NativeReadinessProviderStartFailed {
        cause: NativeReadinessProviderStartCause,
        diagnostic: ProviderStartDiagnostic,
    },
    #[error("permission request is unknown")]
    UnknownDecision,
    #[error("permission request is already resolved")]
    DecisionAlreadyResolved,
    #[error("provider transport failed: {0}")]
    Transport(String),
    #[error("durable fresh-agent state failed: {0}")]
    Persistence(String),
}

/// Closed classification for the two persisted-profile checks that run before
/// the provider transport starts. The values are safe to include in lifecycle
/// logs because they contain no profile data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeProfileMismatchReason {
    NonConfigurationSecretReferences,
    PersistedProfileFields,
}

impl NativeProfileMismatchReason {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::NonConfigurationSecretReferences => "non_configuration_secret_references",
            Self::PersistedProfileFields => "persisted_profile_fields",
        }
    }
}

/// Boolean equality facts for strict comparison of an incoming profile with
/// the persisted profile. Never place either profile itself in diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeProfileFieldMatches {
    pub naming_handle: bool,
    pub collaboration_mode: bool,
    pub provider: bool,
    pub runtime_variant: bool,
    pub cwd: bool,
    pub model: bool,
    pub effort: bool,
    pub permission_mode: bool,
    pub sandbox: bool,
    pub provider_store_id: bool,
    pub native_session_id: bool,
    pub plugins: bool,
    pub model_selection: bool,
    pub session_ref: bool,
    pub provider_launch_context: bool,
    pub provider_secret_references: bool,
}

impl NativeProfileFieldMatches {
    fn compare(candidate: &FreshAgentProfile, persisted: &FreshAgentProfile) -> Self {
        Self {
            naming_handle: candidate.naming_handle == persisted.naming_handle,
            collaboration_mode: candidate.collaboration_mode == persisted.collaboration_mode,
            provider: candidate.provider == persisted.provider,
            runtime_variant: candidate.runtime_variant == persisted.runtime_variant,
            cwd: candidate.cwd == persisted.cwd,
            model: candidate.model == persisted.model,
            effort: candidate.effort == persisted.effort,
            permission_mode: candidate.permission_mode == persisted.permission_mode,
            sandbox: candidate.sandbox == persisted.sandbox,
            provider_store_id: candidate.provider_store_id == persisted.provider_store_id,
            native_session_id: candidate.native_session_id == persisted.native_session_id,
            plugins: candidate.plugins == persisted.plugins,
            model_selection: candidate.model_selection == persisted.model_selection,
            session_ref: candidate.session_ref == persisted.session_ref,
            provider_launch_context: candidate.provider_launch_context
                == persisted.provider_launch_context,
            provider_secret_references: candidate.provider_secret_references
                == persisted.provider_secret_references,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeProfileMismatchFacts {
    pub reason: NativeProfileMismatchReason,
    pub non_configuration_secret_references_match: bool,
    pub profile_fields: Option<NativeProfileFieldMatches>,
}

impl NativeProfileMismatchFacts {
    fn changed_non_configuration_secret_references() -> Self {
        Self {
            reason: NativeProfileMismatchReason::NonConfigurationSecretReferences,
            non_configuration_secret_references_match: false,
            profile_fields: None,
        }
    }

    fn persisted_profile_fields(
        candidate: &FreshAgentProfile,
        persisted: &FreshAgentProfile,
    ) -> Self {
        Self {
            reason: NativeProfileMismatchReason::PersistedProfileFields,
            non_configuration_secret_references_match: non_configuration_secret_references_match(
                &candidate.provider_secret_references,
                &persisted.provider_secret_references,
            ),
            profile_fields: Some(NativeProfileFieldMatches::compare(candidate, persisted)),
        }
    }
}

fn non_configuration_secret_references_match(
    candidate: &[ProviderSecretReference],
    persisted: &[ProviderSecretReference],
) -> bool {
    candidate
        .iter()
        .filter(|reference| !reference.profile.is_configuration_file())
        .eq(persisted
            .iter()
            .filter(|reference| !reference.profile.is_configuration_file()))
}

fn native_readiness_receipt_matches_source_profile(
    source_profile: &FreshAgentProfile,
    persisted: &PersistedActorState,
) -> bool {
    let Some(receipt) = persisted.native_readiness_receipt.as_ref() else {
        return false;
    };
    let Some(expected_profile) =
        native_readiness_receipt_expected_source_profile(source_profile, receipt)
    else {
        return false;
    };
    expected_profile == persisted.profile
}

fn native_readiness_receipt_matches_persisted_source_except_cwd_and_name(
    source_profile: &FreshAgentProfile,
    persisted: &PersistedActorState,
    receipt: &NativeReadinessReceipt,
) -> bool {
    let Some(mut expected_profile) =
        native_readiness_receipt_expected_source_profile(source_profile, receipt)
    else {
        return false;
    };
    let mut persisted_profile = persisted.profile.clone();
    expected_profile.cwd.clear();
    persisted_profile.cwd.clear();
    // This checks that the prior actor profile is exactly the root-transition
    // target already recorded in `receipt`. The new DB-authorized source
    // profile may carry a newer accepted name; that name is copied into the
    // rebound receipt and actor profile only after the full profile/fence
    // checks below succeed.
    expected_profile.naming_handle = persisted_profile.naming_handle.clone();
    expected_profile == persisted_profile
}

fn native_readiness_receipt_expected_source_profile(
    source_profile: &FreshAgentProfile,
    receipt: &NativeReadinessReceipt,
) -> Option<FreshAgentProfile> {
    let source_native_session_id = source_profile.native_session_id.as_deref();
    let previous_native_session_id = receipt.identity.previous_native_session_id.as_str();
    if source_profile.provider != FreshProvider::Codex
        || !receipt.is_valid()
        || receipt.source_launch.execution_generation == 0
        || receipt
            .source_launch
            .requested_native_session_id
            .as_deref()
            .is_some_and(|requested| requested != previous_native_session_id)
        || source_native_session_id.is_some_and(|source| source != previous_native_session_id)
        || source_profile
            .session_ref
            .as_ref()
            .is_some_and(|reference| reference.session_id != previous_native_session_id)
    {
        return None;
    }

    let mut expected_profile = source_profile.clone();
    expected_profile.native_session_id = Some(receipt.identity.native_session_id.clone());
    expected_profile.naming_handle = receipt.identity.pending_naming_handle.clone();
    if let Some(reference) = expected_profile.session_ref.as_mut() {
        reference.session_id = receipt.identity.native_session_id.clone();
    }
    Some(expected_profile)
}

fn native_readiness_receipt_matches_next_profile(
    profile: &FreshAgentProfile,
    receipt: &NativeReadinessReceipt,
) -> bool {
    receipt.is_valid()
        && profile.provider == FreshProvider::Codex
        && receipt.absence_evidence.as_ref().is_none_or(|evidence| {
            evidence.provider == FreshProvider::Codex.as_str()
                && evidence.provider_store_id == profile.provider_store_id
        })
        && profile.native_session_id.as_deref() == Some(receipt.identity.native_session_id.as_str())
        && profile.naming_handle == receipt.identity.pending_naming_handle
        && profile.session_ref.as_ref().is_none_or(|reference| {
            reference.provider == FreshProvider::Codex.as_str()
                && reference.session_id == receipt.identity.native_session_id
        })
}

fn native_readiness_receipt_can_be_superseded(
    profile: &FreshAgentProfile,
    receipt: &NativeReadinessReceipt,
    recovery: Option<(&NativeReadinessRecoveryAuthorization, &ResumeSpec)>,
) -> bool {
    let Some(absence) = receipt.absence_evidence.as_ref() else {
        return false;
    };
    if !native_readiness_receipt_matches_next_profile(profile, receipt) {
        return false;
    }
    match recovery {
        None => true,
        Some((authorization, resume_spec)) => {
            authorization.prior_incarnation_id == receipt.next_launch.incarnation_id
                && authorization.source_launch.incarnation_id != receipt.next_launch.incarnation_id
                && authorization.source_launch.evidence_revision
                    == receipt.next_launch.evidence_revision
                && authorization
                    .source_launch
                    .requested_native_session_id
                    .as_deref()
                    == Some(receipt.identity.native_session_id.as_str())
                && absence.provider_store_id == resume_spec.provider_session.provider_store_id
                && valid_native_readiness_recovery_source(profile, authorization, resume_spec)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProviderStartDiagnostic {
    Authentication,
    Arguments,
    Listener,
    Configuration,
    Network,
    Unclassified,
    NoDiagnostic,
}

impl ProviderStartDiagnostic {
    pub fn from_provider_error(error: &str) -> Self {
        let Some((_, suffix)) = error.rsplit_once("startup diagnostic:") else {
            return Self::NoDiagnostic;
        };
        let category = suffix
            .trim_start()
            .split(|character: char| !character.is_ascii_lowercase() && character != '-')
            .next()
            .unwrap_or_default();
        match category {
            "authentication" => Self::Authentication,
            "arguments" => Self::Arguments,
            "listener" => Self::Listener,
            "configuration" => Self::Configuration,
            "network" => Self::Network,
            "no-diagnostic" => Self::NoDiagnostic,
            _ => Self::Unclassified,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Authentication => "authentication",
            Self::Arguments => "arguments",
            Self::Listener => "listener",
            Self::Configuration => "configuration",
            Self::Network => "network",
            Self::Unclassified => "unclassified",
            Self::NoDiagnostic => "no_diagnostic",
        }
    }
}

impl std::fmt::Display for ProviderStartDiagnostic {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Authentication => "authentication",
            Self::Arguments => "arguments",
            Self::Listener => "listener",
            Self::Configuration => "configuration",
            Self::Network => "network",
            Self::Unclassified => "unclassified",
            Self::NoDiagnostic => "no-diagnostic",
        })
    }
}

impl From<ProviderStartDiagnostic>
    for freshell_runtime_protocol::FreshAgentProviderStartDiagnostic
{
    fn from(diagnostic: ProviderStartDiagnostic) -> Self {
        use freshell_runtime_protocol::FreshAgentProviderStartDiagnostic as RuntimeDiagnostic;
        match diagnostic {
            ProviderStartDiagnostic::Authentication => RuntimeDiagnostic::Authentication,
            ProviderStartDiagnostic::Arguments => RuntimeDiagnostic::Arguments,
            ProviderStartDiagnostic::Listener => RuntimeDiagnostic::Listener,
            ProviderStartDiagnostic::Configuration => RuntimeDiagnostic::Configuration,
            ProviderStartDiagnostic::Network => RuntimeDiagnostic::Network,
            ProviderStartDiagnostic::Unclassified => RuntimeDiagnostic::Unclassified,
            ProviderStartDiagnostic::NoDiagnostic => RuntimeDiagnostic::NoDiagnostic,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedCommand {
    payload_digest: String,
    state: CommandState,
    provider_ack_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_identity: Option<NativeDispatchIdentity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    codex_dispatch_recovery_source: Option<NativeIdentityObservation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation_failure: Option<OperationFailureKind>,
}

fn validate_claude_fork_state(
    context: &ClaudeForkState,
    profile: &FreshAgentProfile,
) -> Result<(), ActorError> {
    if !matches!(
        profile.provider,
        FreshProvider::Claude | FreshProvider::Kilroy
    ) || profile.native_session_id.as_deref() != Some(&context.native_session_id)
        || serde_json::to_vec(context).map_err(persist)?.len() > 32 * 1024 * 1024
    {
        return Err(ActorError::NativeIdentityMismatch);
    }
    if let Some(recipe) = &context.recipe {
        recipe
            .validate(&context.native_session_id)
            .map_err(|_| ActorError::NativeIdentityMismatch)?;
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DecisionState {
    Pending,
    Dispatching,
    Resolved,
    Ambiguous,
    Interrupted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedDecision {
    payload: Value,
    state: DecisionState,
    response_digest: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    operation_attempt_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedActorState {
    schema_version: u32,
    #[serde(default = "new_actor_journal_id")]
    journal_id: String,
    profile: FreshAgentProfile,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_readiness_receipt: Option<NativeReadinessReceipt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    native_readiness_mint_in_progress: Option<NativeReadinessMintJournal>,
    #[serde(default)]
    initialization_state: Option<CommandState>,
    commands: BTreeMap<String, PersistedCommand>,
    #[serde(default)]
    completed_forks: BTreeMap<String, ForkTransition>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claude_fork_state: Option<ClaudeForkState>,
    decisions: BTreeMap<String, PersistedDecision>,
    events: VecDeque<JournalEvent>,
    event_bytes: usize,
    next_sequence: u64,
    retained_from: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NativeReadinessMintJournal {
    authorization: NativeReadinessRecoveryAuthorization,
    absence_evidence: NativeReadinessAbsenceEvidence,
}

impl PersistedActorState {
    fn new(profile: FreshAgentProfile) -> Self {
        Self {
            schema_version: 1,
            journal_id: new_actor_journal_id(),
            profile,
            native_readiness_receipt: None,
            native_readiness_mint_in_progress: None,
            initialization_state: None,
            commands: BTreeMap::new(),
            completed_forks: BTreeMap::new(),
            claude_fork_state: None,
            decisions: BTreeMap::new(),
            events: VecDeque::new(),
            event_bytes: 0,
            next_sequence: 1,
            retained_from: 1,
        }
    }
}

struct WriterLock {
    file: File,
}

impl WriterLock {
    fn acquire(path: &Path) -> Result<Self, ActorError> {
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(path)
            .map_err(persist)?;
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            if result != 0 {
                return Err(ActorError::WriterBusy);
            }
        }
        Ok(Self { file })
    }
}

impl Drop for WriterLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            use std::os::fd::AsRawFd;
            unsafe { libc::flock(self.file.as_raw_fd(), libc::LOCK_UN) };
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum NativeRecoveryRelease {
    Pending,
    Unsettled,
    Released,
}

pub struct FreshAgentHostActor {
    state_dir: PathBuf,
    transport: Arc<dyn FreshAgentTransport>,
    state: Mutex<PersistedActorState>,
    /// Ephemeral acknowledgement from this transport start. Saved profile
    /// identity remains a resume request and cannot populate this slot.
    observed_native_session_id: Mutex<Option<String>>,
    native_identity_transition: AtomicBool,
    stopped: AtomicBool,
    dispatch_lock: Mutex<()>,
    native_recovery_release: Mutex<NativeRecoveryRelease>,
    native_recovery_prepared: bool,
    event_byte_cap: usize,
    event_count_cap: usize,
    _writer_lock: WriterLock,
}

fn valid_native_readiness_recovery_source(
    profile: &FreshAgentProfile,
    authorization: &NativeReadinessRecoveryAuthorization,
    resume_spec: &ResumeSpec,
) -> bool {
    let Some(source_root) = authorization
        .source_launch
        .requested_native_session_id
        .as_deref()
    else {
        return false;
    };
    authorization.is_valid()
        && authorization.resume_spec_sha256
            == freshell_runtime_protocol::resume_spec_sha256(resume_spec)
        && profile.provider == FreshProvider::Codex
        && profile.native_session_id.as_deref() == Some(source_root)
        && profile.provider_store_id == resume_spec.provider_session.provider_store_id
        && resume_spec.provider_session.provider == FreshProvider::Codex.as_str()
        && resume_spec.provider_session.native_session_id == source_root
        && resume_spec.mode == "freshcodex"
        && resume_spec.runtime_variant == profile.runtime_variant
        && resume_spec.evidence_revision == authorization.source_fence.evidence_revision
        && profile.session_ref.as_ref().is_none_or(|reference| {
            reference.provider == FreshProvider::Codex.as_str()
                && reference.session_id == source_root
        })
}

async fn codex_native_absence_evidence(
    authorization: &NativeReadinessRecoveryAuthorization,
    resume_spec: &ResumeSpec,
    transport: &dyn FreshAgentTransport,
) -> Result<NativeReadinessAbsenceEvidence, NativeReadinessRecoveryStage> {
    if resume_spec.provider_session.provider != FreshProvider::Codex.as_str()
        || resume_spec.evidence_revision != authorization.source_fence.evidence_revision
    {
        return Err(NativeReadinessRecoveryStage::AbsenceCensusSelectionMismatch);
    }
    let source_root = authorization
        .source_launch
        .requested_native_session_id
        .as_deref()
        .ok_or(NativeReadinessRecoveryStage::AbsenceCensusSelectionMismatch)?;
    if resume_spec.provider_session.native_session_id != source_root {
        return Err(NativeReadinessRecoveryStage::AbsenceCensusSelectionMismatch);
    }
    let probe = transport
        .probe_native_store(resume_spec)
        .await
        .map_err(|_| NativeReadinessRecoveryStage::AbsenceProbeWorker)?;
    let (evidence, store_state) = match probe {
        crate::ProviderStoreProbe::DefinitivelyUnavailable {
            evidence,
            store_state,
            ..
        } => (evidence, store_state),
        crate::ProviderStoreProbe::Ready { .. } => {
            return Err(NativeReadinessRecoveryStage::AbsenceProbeReady);
        }
        crate::ProviderStoreProbe::Blocked {
            reason, retry_hint, ..
        } => {
            let store_state = match reason {
                RecoveryBlockReason::StoreMissing => EvidenceStoreState::Missing,
                _ => EvidenceStoreState::Unknown,
            };
            return Err(NativeReadinessRecoveryStage::AbsenceProbeBlocked {
                reason,
                store_state,
                failure_cause: NativeReadinessProbeFailureCause::from_probe_repair(
                    retry_hint.repair.as_deref(),
                ),
            });
        }
        crate::ProviderStoreProbe::ParentBackedClaudeFork { .. } => {
            return Err(NativeReadinessRecoveryStage::AbsenceProbeUnexpected);
        }
    };
    if !crate::native_absence_census_matches(
        FreshProvider::Codex.as_str(),
        &resume_spec.provider_session.provider_store_id,
        source_root,
        authorization.source_fence.evidence_revision,
        store_state,
        &evidence,
    ) {
        return Err(NativeReadinessRecoveryStage::AbsenceCensusSelectionMismatch);
    }
    if !crate::native_absence_census_environment_matches(resume_spec, &evidence) {
        return Err(NativeReadinessRecoveryStage::AbsenceCensusEnvironmentMismatch);
    }
    let census_reference = crate::canonical_native_absence_census_reference(&evidence)
        .ok_or(NativeReadinessRecoveryStage::AbsenceCensusReferenceMissing)?;
    let proof = NativeReadinessAbsenceEvidence {
        prior_incarnation_id: authorization.prior_incarnation_id.clone(),
        provider: FreshProvider::Codex.as_str().into(),
        provider_store_id: resume_spec.provider_session.provider_store_id.clone(),
        native_session_id: source_root.into(),
        evidence_revision: authorization.source_fence.evidence_revision,
        store_state,
        census_reference,
    };
    if !proof.is_valid_for(&authorization.source_launch) {
        return Err(NativeReadinessRecoveryStage::AbsenceEvidenceInvalid);
    }
    Ok(proof)
}

fn receipt_matches_startup_authorization(
    receipt: &NativeReadinessReceipt,
    authorization: &NativeReadinessRecoveryAuthorization,
    profile: &FreshAgentProfile,
    resume_spec: &ResumeSpec,
) -> bool {
    let Some(evidence) = receipt.absence_evidence.as_ref() else {
        return false;
    };
    if !valid_native_readiness_recovery_source(profile, authorization, resume_spec)
        || !receipt.is_valid()
        || !receipt
            .source_fence
            .is_covered_by(&authorization.source_fence)
        || receipt.source_launch != authorization.source_launch
        || evidence.prior_incarnation_id != authorization.prior_incarnation_id
        || evidence.provider_store_id != resume_spec.provider_session.provider_store_id
        || evidence.native_session_id != resume_spec.provider_session.native_session_id
        || evidence.evidence_revision != authorization.source_fence.evidence_revision
        || receipt.resume_spec_sha256.as_deref() != Some(authorization.resume_spec_sha256.as_str())
    {
        return false;
    }
    let census_references = std::slice::from_ref(&evidence.census_reference);
    crate::native_absence_census_matches(
        &evidence.provider,
        &evidence.provider_store_id,
        &evidence.native_session_id,
        evidence.evidence_revision,
        evidence.store_state,
        census_references,
    ) && crate::native_absence_census_environment_matches(resume_spec, census_references)
}

async fn rebound_cold_readiness_receipt(
    source_profile: &FreshAgentProfile,
    persisted: &PersistedActorState,
    receipt: &NativeReadinessReceipt,
    authorization: &NativeReadinessRecoveryAuthorization,
    resume_spec: &ResumeSpec,
    transport: &dyn FreshAgentTransport,
) -> Option<NativeReadinessReceipt> {
    let source_root = authorization
        .source_launch
        .requested_native_session_id
        .as_deref()?;
    let old_absence = receipt.absence_evidence.as_ref()?;
    let old_fence = &receipt.source_fence;
    let current_fence = &authorization.source_fence;
    if !valid_native_readiness_recovery_source(source_profile, authorization, resume_spec)
        || !receipt.is_valid()
        || !native_readiness_receipt_matches_next_profile(&persisted.profile, receipt)
        || !native_readiness_receipt_matches_persisted_source_except_cwd_and_name(
            source_profile,
            persisted,
            receipt,
        )
        || receipt.resume_spec_sha256.as_deref() != Some(authorization.resume_spec_sha256.as_str())
        || receipt.source_launch.incarnation_id != old_fence.active_incarnation_id
        || receipt.source_launch.incarnation_id == authorization.source_launch.incarnation_id
        || receipt.source_launch.requested_native_session_id.as_deref() != Some(source_root)
        || receipt.identity.previous_native_session_id != source_root
        || receipt.source_launch.evidence_revision != authorization.source_launch.evidence_revision
        || old_fence.control_epoch > current_fence.control_epoch
        || old_fence.intent_revision != current_fence.intent_revision
        || old_fence.identity_revision != current_fence.identity_revision
        || old_fence.evidence_revision != current_fence.evidence_revision
        || old_fence.native_import_revision != current_fence.native_import_revision
        || old_fence.recovery_attempt_id.is_none()
        || old_absence.provider != FreshProvider::Codex.as_str()
        || old_absence.provider_store_id != resume_spec.provider_session.provider_store_id
        || old_absence.native_session_id != source_root
        || old_absence.evidence_revision != current_fence.evidence_revision
        || !crate::native_absence_census_matches(
            &old_absence.provider,
            &old_absence.provider_store_id,
            &old_absence.native_session_id,
            old_absence.evidence_revision,
            old_absence.store_state,
            std::slice::from_ref(&old_absence.census_reference),
        )
        || !crate::native_absence_census_environment_matches(
            resume_spec,
            std::slice::from_ref(&old_absence.census_reference),
        )
    {
        return None;
    }

    // The original receipt proves that R1 was accepted after R0 went missing.
    // Re-census R0 under this attempt before rebinding the proof to its fence.
    let absence_evidence = codex_native_absence_evidence(authorization, resume_spec, transport)
        .await
        .ok()?;
    let mut next_launch = authorization.source_launch.clone();
    next_launch.evidence_revision = next_launch.evidence_revision.checked_add(1)?;
    next_launch.requested_native_session_id = Some(receipt.identity.native_session_id.clone());
    let mut identity = receipt.identity.clone();
    identity.pending_naming_handle = source_profile.naming_handle.clone();
    let rebound = NativeReadinessReceipt {
        source_fence: authorization.source_fence.clone(),
        source_launch: authorization.source_launch.clone(),
        next_launch,
        identity,
        absence_evidence: Some(absence_evidence),
        resume_spec_sha256: Some(authorization.resume_spec_sha256.clone()),
    };
    rebound.is_valid().then_some(rebound)
}

impl FreshAgentHostActor {
    /// The deterministic qualification transport persists its decision in its
    /// owned provider store. This opening path is selected only after the
    /// session host has admitted that typed fixture transport; it provides no
    /// evidence for native provider recovery.
    pub async fn open_deterministic_fixture(
        state_dir: impl Into<PathBuf>,
        profile: FreshAgentProfile,
        transport: Arc<dyn FreshAgentTransport>,
    ) -> Result<Arc<Self>, ActorError> {
        Self::open_with_callback_lifetime(
            state_dir,
            profile,
            transport,
            DEFAULT_EVENT_BYTES,
            DEFAULT_EVENT_COUNT,
            true,
            None,
        )
        .await
    }

    pub async fn resume_pending_native_permissions(&self) -> Result<(), ActorError> {
        let _serial = self.dispatch_lock.lock().await;
        if !self.native_recovery_prepared {
            eprintln!(
                "{}",
                serde_json::json!({"severity":"info", "event":"fresh_agent.native_checkpoint.release", "outcome":"not_prepared"})
            );
            return Ok(());
        }
        let mut release = self.native_recovery_release.lock().await;
        if *release == NativeRecoveryRelease::Unsettled {
            return Err(ActorError::AmbiguousDispatch);
        }
        let state = self.state.lock().await;
        if !matches!(
            state.profile.provider,
            FreshProvider::Claude | FreshProvider::Kilroy
        ) || (*release == NativeRecoveryRelease::Pending
            && native_recovery_checkpoints(&state).is_empty())
        {
            return Ok(());
        }
        let expected = state.profile.native_session_id.clone();
        drop(state);
        let observed = self.observed_native_session_id().await;
        let evidence = self
            .transport
            .native_identity_evidence()
            .await
            .ok_or(ActorError::NativeIdentityMismatch)?;
        let launch: NativeIdentityLaunch = serde_json::from_value(evidence["launch"].clone())
            .map_err(|_| ActorError::NativeIdentityMismatch)?;
        if expected.is_none()
            || observed != expected
            || launch.execution_generation == 0
            || evidence["queryGeneration"].as_u64().unwrap_or(0) == 0
            || launch
                .requested_native_session_id
                .as_ref()
                .is_some_and(|root| Some(root) != expected.as_ref())
                && !expected
                    .as_deref()
                    .is_some_and(|root| native_clear_matches_root(&evidence, root))
        {
            return Err(ActorError::NativeIdentityMismatch);
        }
        if *release == NativeRecoveryRelease::Released {
            return Ok(());
        }
        // This preparation belongs to this actor's transport. Cancellation or
        // any failed dispatch stays fenced; only a confirmed acknowledgement
        // permits later reattach to settle without another native continuation.
        *release = NativeRecoveryRelease::Unsettled;
        self.transport
            .resume_native_permission_recovery()
            .await
            .map_err(|failure| {
                if failure.acceptance_ambiguous {
                    ActorError::AmbiguousDispatch
                } else {
                    ActorError::Transport(failure.message)
                }
            })?;
        *release = NativeRecoveryRelease::Released;
        Ok(())
    }
    pub async fn open(
        state_dir: impl Into<PathBuf>,
        profile: FreshAgentProfile,
        transport: Arc<dyn FreshAgentTransport>,
    ) -> Result<Arc<Self>, ActorError> {
        Self::open_with_bounds(
            state_dir,
            profile,
            transport,
            DEFAULT_EVENT_BYTES,
            DEFAULT_EVENT_COUNT,
        )
        .await
    }

    pub async fn open_with_bounds(
        state_dir: impl Into<PathBuf>,
        profile: FreshAgentProfile,
        transport: Arc<dyn FreshAgentTransport>,
        event_byte_cap: usize,
        event_count_cap: usize,
    ) -> Result<Arc<Self>, ActorError> {
        Self::open_with_callback_lifetime(
            state_dir,
            profile,
            transport,
            event_byte_cap,
            event_count_cap,
            false,
            None,
        )
        .await
    }

    pub async fn open_with_native_readiness_recovery(
        state_dir: impl Into<PathBuf>,
        profile: FreshAgentProfile,
        transport: Arc<dyn FreshAgentTransport>,
        authorization: NativeReadinessRecoveryAuthorization,
        resume_spec: ResumeSpec,
    ) -> Result<Arc<Self>, ActorError> {
        Self::open_with_callback_lifetime(
            state_dir,
            profile,
            transport,
            DEFAULT_EVENT_BYTES,
            DEFAULT_EVENT_COUNT,
            false,
            Some((authorization, resume_spec)),
        )
        .await
    }

    async fn open_with_callback_lifetime(
        state_dir: impl Into<PathBuf>,
        profile: FreshAgentProfile,
        transport: Arc<dyn FreshAgentTransport>,
        event_byte_cap: usize,
        event_count_cap: usize,
        deterministic_fixture: bool,
        native_readiness_recovery: Option<(NativeReadinessRecoveryAuthorization, ResumeSpec)>,
    ) -> Result<Arc<Self>, ActorError> {
        profile.validate()?;
        if event_byte_cap == 0 || event_count_cap == 0 {
            return Err(ActorError::InvalidProfile);
        }
        let state_dir = state_dir.into();
        fs::create_dir_all(&state_dir).map_err(persist)?;
        let writer_lock = WriterLock::acquire(&state_dir.join("fresh-agent-writer.lock"))?;
        let state_path = state_dir.join("fresh-agent-state.json");
        let launch_profile = profile.clone();
        let mut startup_readiness_receipt = None;
        let (mut state, newly_initialized) = match fs::read(&state_path) {
            Ok(bytes) => {
                let mut loaded: PersistedActorState =
                    serde_json::from_slice(&bytes).map_err(persist)?;
                // A provider `thread/start` is not idempotent. If the actor
                // crashed after writing its mint journal but before writing
                // the receipt with the new root, never issue another start.
                if loaded.native_readiness_mint_in_progress.is_some() {
                    return Err(ActorError::AmbiguousDispatch);
                }
                // A successful transport start may still have returned no
                // identity. Reopening that durable actor must not create a
                // second conversation from missing metadata alone.
                if loaded.profile.native_session_id.is_none() {
                    return Err(ActorError::AmbiguousDispatch);
                }
                let mut source_profile = profile.clone();
                let mut expected_profile = profile.clone();
                if expected_profile.native_session_id.is_none() {
                    expected_profile.native_session_id = loaded.profile.native_session_id.clone();
                }
                // The host validates a fresh preparation for each incarnation.
                // Its grant and resource generation may change while the durable
                // conversation and every other launch setting remain the same.
                let current_preparation = expected_profile.provider_launch_context.take();
                let current_references = expected_profile.provider_secret_references.clone();
                if current_preparation.is_some() {
                    // Configuration-file references belong to the host-validated
                    // preparation. Legacy OneCLI grants remain durable settings.
                    if !non_configuration_secret_references_match(
                        &current_references,
                        &loaded.profile.provider_secret_references,
                    ) {
                        return Err(ActorError::NativeProfileMismatch(
                            NativeProfileMismatchFacts::changed_non_configuration_secret_references(
                            ),
                        ));
                    }
                    expected_profile.provider_secret_references =
                        loaded.profile.provider_secret_references.clone();
                    expected_profile.provider_launch_context =
                        loaded.profile.provider_launch_context.clone();
                    source_profile.provider_secret_references =
                        loaded.profile.provider_secret_references.clone();
                    source_profile.provider_launch_context =
                        loaded.profile.provider_launch_context.clone();
                }
                let persisted_profile_is_receipt_target = loaded
                    .native_readiness_receipt
                    .as_ref()
                    .is_some_and(|receipt| {
                        native_readiness_receipt_matches_next_profile(&loaded.profile, receipt)
                    });
                let persisted_cold_receipt_targets_launch = loaded
                    .native_readiness_receipt
                    .as_ref()
                    .is_some_and(|receipt| {
                        receipt.absence_evidence.is_some()
                            && persisted_profile_is_receipt_target
                            && loaded.profile.native_session_id
                                == expected_profile.native_session_id
                    });
                let rebound_startup_receipt =
                    if let (Some(receipt), Some((authorization, resume_spec))) = (
                        loaded.native_readiness_receipt.as_ref(),
                        native_readiness_recovery.as_ref(),
                    ) {
                        rebound_cold_readiness_receipt(
                            &source_profile,
                            &loaded,
                            receipt,
                            authorization,
                            resume_spec,
                            transport.as_ref(),
                        )
                        .await
                    } else {
                        None
                    };
                let authorized_codex_cwd_rebase = (loaded.native_readiness_receipt.is_none()
                    && native_readiness_recovery.as_ref().is_some_and(
                        |(authorization, resume_spec)| {
                            valid_native_readiness_recovery_source(
                                &expected_profile,
                                authorization,
                                resume_spec,
                            ) && loaded.profile.native_session_id.as_deref()
                                == authorization
                                    .source_launch
                                    .requested_native_session_id
                                    .as_deref()
                        },
                    ))
                    || persisted_cold_receipt_targets_launch;
                let authorized_codex_cwd_rebase = authorized_codex_cwd_rebase
                    && loaded.profile.provider == FreshProvider::Codex
                    && expected_profile.provider == FreshProvider::Codex
                    && loaded.profile.native_session_id == expected_profile.native_session_id
                    && loaded.profile.cwd != expected_profile.cwd
                    && {
                        let mut persisted_without_cwd = loaded.profile.clone();
                        let mut expected_without_cwd = expected_profile.clone();
                        persisted_without_cwd.cwd.clear();
                        expected_without_cwd.cwd.clear();
                        persisted_without_cwd == expected_without_cwd
                    };
                let source_profile_matches_receipt = loaded.profile != expected_profile
                    && native_readiness_receipt_matches_source_profile(&source_profile, &loaded);
                if loaded.profile != expected_profile
                    && !source_profile_matches_receipt
                    && rebound_startup_receipt.is_none()
                    && !authorized_codex_cwd_rebase
                {
                    return Err(ActorError::NativeProfileMismatch(
                        NativeProfileMismatchFacts::persisted_profile_fields(
                            &expected_profile,
                            &loaded.profile,
                        ),
                    ));
                }
                if rebound_startup_receipt.is_some() {
                    // The source receipt belongs to an earlier incarnation,
                    // while this DB-issued attempt still fences the same old
                    // root. Keep the accepted profile CWD and naming handle,
                    // but rebind the receipt only after a fresh census and
                    // exact R1 start.
                    loaded.profile.cwd = expected_profile.cwd.clone();
                    loaded.profile.naming_handle = expected_profile.naming_handle.clone();
                } else if authorized_codex_cwd_rebase {
                    // Keep the accepted launch CWD in the actor profile. For a
                    // first cold replacement the authorization binds the old
                    // resume proof; after a committed root replacement the
                    // persisted receipt binds the exact current root. The old
                    // ResumeSpec CWD remains immutable store-selection evidence.
                    loaded.profile.cwd = expected_profile.cwd.clone();
                }
                let can_supersede_receipt =
                    loaded
                        .native_readiness_receipt
                        .as_ref()
                        .is_some_and(|receipt| {
                            native_readiness_receipt_can_be_superseded(
                                &loaded.profile,
                                receipt,
                                native_readiness_recovery
                                    .as_ref()
                                    .map(|(authorization, spec)| (authorization, spec)),
                            ) && launch_profile.native_session_id.as_deref()
                                == Some(receipt.identity.native_session_id.as_str())
                                && loaded.profile == expected_profile
                        });
                if can_supersede_receipt {
                    // The previous root transition is already represented by
                    // the exact persisted profile. A later incarnation must
                    // perform its own strict resume/readiness check instead of
                    // replaying the previous incarnation's receipt.
                    loaded.native_readiness_receipt = None;
                } else if let Some(receipt) = rebound_startup_receipt {
                    loaded.native_readiness_receipt = Some(receipt.clone());
                    startup_readiness_receipt = Some(receipt);
                } else if persisted_profile_is_receipt_target
                    && (loaded.profile == expected_profile || source_profile_matches_receipt)
                {
                    startup_readiness_receipt = loaded.native_readiness_receipt.clone();
                }
                loaded.profile.provider_launch_context = current_preparation;
                loaded.profile.provider_secret_references = current_references;
                for command in loaded.commands.values_mut() {
                    if matches!(command.state, CommandState::Dispatching) {
                        command.state = CommandState::Ambiguous;
                    }
                }
                let claude_replacement = !deterministic_fixture
                    && matches!(
                        loaded.profile.provider,
                        FreshProvider::Claude | FreshProvider::Kilroy
                    );
                let mut interrupted_attempts = Vec::new();
                for (decision_id, decision) in &mut loaded.decisions {
                    if matches!(decision.state, DecisionState::Dispatching) {
                        decision.state = DecisionState::Ambiguous;
                        if let Some(attempt_id) = decision.operation_attempt_id.as_ref() {
                            interrupted_attempts.push((decision_id.clone(), attempt_id.clone()));
                        }
                    } else if claude_replacement && matches!(decision.state, DecisionState::Pending)
                    {
                        decision.state = DecisionState::Interrupted;
                    }
                }
                for (decision_id, attempt_id) in interrupted_attempts {
                    let event = control_attempt_event(
                        &loaded.profile,
                        &decision_id,
                        &attempt_id,
                        true,
                        None,
                    );
                    push_event_bounded(&mut loaded, event, event_byte_cap, event_count_cap)?;
                }
                (loaded, false)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                (PersistedActorState::new(profile), true)
            }
            Err(error) => return Err(persist(error)),
        };

        match native_readiness_recovery.as_ref() {
            Some((authorization, resume_spec)) => {
                if newly_initialized
                    || !valid_native_readiness_recovery_source(
                        &launch_profile,
                        authorization,
                        resume_spec,
                    )
                {
                    return Err(ActorError::NativeReadinessRecoveryFailed {
                        stage: NativeReadinessRecoveryStage::Authorization,
                    });
                }
                if let Some(receipt) = state.native_readiness_receipt.as_ref() {
                    if !receipt_matches_startup_authorization(
                        receipt,
                        authorization,
                        &launch_profile,
                        resume_spec,
                    ) {
                        return Err(ActorError::NativeReadinessRecoveryFailed {
                            stage: NativeReadinessRecoveryStage::PersistedReceipt,
                        });
                    }
                }
            }
            None if state
                .native_readiness_receipt
                .as_ref()
                .is_some_and(|receipt| receipt.absence_evidence.is_some()) =>
            {
                return Err(ActorError::NativeReadinessRecoveryFailed {
                    stage: NativeReadinessRecoveryStage::MissingAuthorization,
                });
            }
            None => {}
        }

        if let Some(context) = state.claude_fork_state.clone() {
            validate_claude_fork_state(&context, &state.profile)?;
            transport
                .restore_claude_fork_state(context)
                .await
                .map_err(ActorError::Transport)?;
        }
        let mut native_recovery_prepared = false;
        if matches!(
            state.profile.provider,
            FreshProvider::Claude | FreshProvider::Kilroy
        ) {
            let checkpoints = native_recovery_checkpoints(&state);
            native_recovery_prepared = !checkpoints.is_empty();
            eprintln!(
                "{}",
                serde_json::json!({"severity":"info", "event":"fresh_agent.native_checkpoint.prepared",
                "provider":state.profile.provider.as_str(), "checkpointCount":checkpoints.len(), "decisionCount":state.decisions.len(),
                "nativeSessionId":state.profile.native_session_id})
            );
            transport
                .prepare_native_permission_recovery(checkpoints)
                .await
                .map_err(ActorError::Transport)?;
        }
        if newly_initialized {
            // Publish intent before the first provider creation. A resumed
            // actor keeps its accepted preparation until exact identity is
            // verified below.
            state.initialization_state = Some(CommandState::Dispatching);
            write_state(&state_dir, &state)?;
        }
        if let Some(receipt) = startup_readiness_receipt.as_ref() {
            transport
                .restore_native_readiness_receipt(receipt)
                .await
                .map_err(ActorError::Transport)?;
        }
        let started = if startup_readiness_receipt.is_none() {
            if let Some((authorization, resume_spec)) = native_readiness_recovery.as_ref() {
                match transport
                    .start_native_readiness_resume(&state.profile, resume_spec)
                    .await
                    .map_err(|failure| ActorError::NativeReadinessProviderStartFailed {
                        cause: failure.cause,
                        diagnostic: failure.diagnostic,
                    })? {
                    NativeReadinessResumeStart::Resumed(started) => started,
                    NativeReadinessResumeStart::PriorThreadNotFound => {
                        let absence_evidence = codex_native_absence_evidence(
                            authorization,
                            resume_spec,
                            transport.as_ref(),
                        )
                        .await
                        .map_err(|stage| ActorError::NativeReadinessRecoveryFailed { stage })?;
                        state.native_readiness_mint_in_progress =
                            Some(NativeReadinessMintJournal {
                                authorization: authorization.clone(),
                                absence_evidence: absence_evidence.clone(),
                            });
                        write_state(&state_dir, &state)?;

                        let started = transport
                            .start_native_readiness_replacement(&state.profile, authorization)
                            .await
                            .map_err(|failure| ActorError::NativeReadinessProviderStartFailed {
                                cause: failure.cause,
                                diagnostic: failure.diagnostic,
                            })?;
                        let previous = authorization
                            .source_launch
                            .requested_native_session_id
                            .as_deref()
                            .ok_or(ActorError::NativeReadinessRecoveryFailed {
                                stage: NativeReadinessRecoveryStage::Authorization,
                            })?;
                        let Some(next_root) = started.native_session_id.as_deref() else {
                            return Err(ActorError::NativeReadinessRecoveryFailed {
                                stage: NativeReadinessRecoveryStage::ReplacementIdentity,
                            });
                        };
                        if next_root.is_empty()
                            || next_root == previous
                            || next_root.chars().any(char::is_control)
                        {
                            return Err(ActorError::NativeReadinessRecoveryFailed {
                                stage: NativeReadinessRecoveryStage::ReplacementIdentity,
                            });
                        }
                        let before_rebind = transport.native_identity_evidence().await.ok_or(
                            ActorError::NativeReadinessRecoveryFailed {
                                stage: NativeReadinessRecoveryStage::BeforeRebindEvidence,
                            },
                        )?;
                        let before_launch: NativeIdentityLaunch = serde_json::from_value(
                            before_rebind["launch"].clone(),
                        )
                        .map_err(|_| ActorError::NativeReadinessRecoveryFailed {
                            stage: NativeReadinessRecoveryStage::BeforeRebindEvidence,
                        })?;
                        if before_launch != authorization.source_launch
                            || before_rebind["nativeSessionId"].as_str() != Some(next_root)
                        {
                            return Err(ActorError::NativeReadinessRecoveryFailed {
                                stage: NativeReadinessRecoveryStage::BeforeRebindEvidence,
                            });
                        }
                        let mut next_launch = authorization.source_launch.clone();
                        next_launch.evidence_revision = next_launch
                            .evidence_revision
                            .checked_add(1)
                            .ok_or(ActorError::NativeIdentityMismatch)?;
                        next_launch.requested_native_session_id = Some(next_root.to_string());
                        let receipt = NativeReadinessReceipt {
                            source_fence: authorization.source_fence.clone(),
                            source_launch: authorization.source_launch.clone(),
                            next_launch: next_launch.clone(),
                            identity: NativeDispatchIdentity {
                                native_session_id: next_root.to_string(),
                                previous_native_session_id: previous.to_string(),
                                pending_naming_handle: state.profile.naming_handle.clone(),
                            },
                            absence_evidence: Some(absence_evidence),
                            resume_spec_sha256: Some(authorization.resume_spec_sha256.clone()),
                        };
                        if !receipt.is_valid() {
                            return Err(ActorError::NativeReadinessRecoveryFailed {
                                stage: NativeReadinessRecoveryStage::ReboundReceipt,
                            });
                        }
                        transport
                            .restore_native_readiness_receipt(&receipt)
                            .await
                            .map_err(ActorError::Transport)?;
                        let after_rebind = transport.native_identity_evidence().await.ok_or(
                            ActorError::NativeReadinessRecoveryFailed {
                                stage: NativeReadinessRecoveryStage::AfterRebindEvidence,
                            },
                        )?;
                        let after_launch: NativeIdentityLaunch = serde_json::from_value(
                            after_rebind["launch"].clone(),
                        )
                        .map_err(|_| ActorError::NativeReadinessRecoveryFailed {
                            stage: NativeReadinessRecoveryStage::AfterRebindEvidence,
                        })?;
                        if after_launch != next_launch
                            || after_rebind["nativeSessionId"].as_str() != Some(next_root)
                        {
                            return Err(ActorError::NativeReadinessRecoveryFailed {
                                stage: NativeReadinessRecoveryStage::AfterRebindEvidence,
                            });
                        }
                        state.profile.native_session_id = Some(next_root.to_string());
                        state.profile.naming_handle =
                            receipt.identity.pending_naming_handle.clone();
                        if let Some(reference) = state.profile.session_ref.as_mut() {
                            reference.session_id = next_root.to_string();
                        }
                        push_event_bounded(
                            &mut state,
                            AgentEvent::Started {
                                native_session_id: next_root.to_string(),
                            },
                            event_byte_cap,
                            event_count_cap,
                        )?;
                        state.native_readiness_receipt = Some(receipt);
                        state.native_readiness_mint_in_progress = None;
                        started
                    }
                }
            } else {
                transport.start(&state.profile).await.map_err(|error| {
                    ActorError::ProviderStartFailed {
                        diagnostic: ProviderStartDiagnostic::from_provider_error(&error),
                    }
                })?
            }
        } else {
            transport.start(&state.profile).await.map_err(|error| {
                ActorError::ProviderStartFailed {
                    diagnostic: ProviderStartDiagnostic::from_provider_error(&error),
                }
            })?
        };
        let observed_native_session_id = started.native_session_id.clone();
        if let Some(expected) = state.profile.native_session_id.as_deref() {
            let matches = started.native_session_id.as_deref() == Some(expected);
            if !matches {
                return Err(ActorError::NativeSessionIdentityMismatch {
                    expected_present: true,
                    observed_present: started.native_session_id.is_some(),
                    matches,
                });
            }
        } else if let Some(native_session_id) = started.native_session_id {
            state.profile.native_session_id = Some(native_session_id.clone());
            push_event_bounded(
                &mut state,
                AgentEvent::Started { native_session_id },
                event_byte_cap,
                event_count_cap,
            )?;
        }
        if let Some(receipt) = startup_readiness_receipt
            .as_ref()
            .filter(|receipt| receipt.absence_evidence.is_some())
        {
            let evidence = transport.native_identity_evidence().await.ok_or(
                ActorError::NativeReadinessRecoveryFailed {
                    stage: NativeReadinessRecoveryStage::StartupEvidence,
                },
            )?;
            let observed_launch: NativeIdentityLaunch =
                serde_json::from_value(evidence["launch"].clone()).map_err(|_| {
                    ActorError::NativeReadinessRecoveryFailed {
                        stage: NativeReadinessRecoveryStage::StartupEvidence,
                    }
                })?;
            if observed_launch != receipt.next_launch
                || evidence["nativeSessionId"].as_str()
                    != Some(receipt.identity.native_session_id.as_str())
                || state.profile.native_session_id.as_deref()
                    != Some(receipt.identity.native_session_id.as_str())
            {
                return Err(ActorError::NativeReadinessRecoveryFailed {
                    stage: NativeReadinessRecoveryStage::StartupEvidence,
                });
            }
            // Rebound receipts are written only after the fresh incarnation
            // proves the exact target root under its own launch binding.
            state.native_readiness_receipt = Some(receipt.clone());
        }
        state.initialization_state = Some(CommandState::Completed);
        if let Some(context) = transport.claude_fork_state().await {
            validate_claude_fork_state(&context, &state.profile)?;
            state.claude_fork_state = Some(context);
        }
        write_state(&state_dir, &state)?;
        let actor = Arc::new(Self {
            state_dir,
            transport: Arc::clone(&transport),
            state: Mutex::new(state),
            observed_native_session_id: Mutex::new(observed_native_session_id),
            native_identity_transition: AtomicBool::new(false),
            stopped: AtomicBool::new(false),
            dispatch_lock: Mutex::new(()),
            native_recovery_release: Mutex::new(NativeRecoveryRelease::Pending),
            native_recovery_prepared,
            event_byte_cap,
            event_count_cap,
            _writer_lock: writer_lock,
        });
        if let Some(mut events) = transport.take_event_stream() {
            let weak = Arc::downgrade(&actor);
            tokio::spawn(async move {
                while let Some(event) = events.recv().await {
                    let Some(actor) = weak.upgrade() else { break };
                    match event {
                        AgentEvent::Started { native_session_id } => {
                            let _ = actor.observe_native_identity(native_session_id).await;
                        }
                        AgentEvent::PermissionRequested {
                            decision_id,
                            payload,
                        } => {
                            let _ = actor.record_permission(decision_id, payload).await;
                        }
                        event => {
                            let _ = actor.record_event(event).await;
                        }
                    }
                }
            });
        }
        Ok(actor)
    }

    pub async fn profile(&self) -> FreshAgentProfile {
        self.state.lock().await.profile.clone()
    }

    pub async fn native_readiness_receipt(&self) -> Option<NativeReadinessReceipt> {
        self.state.lock().await.native_readiness_receipt.clone()
    }

    pub async fn prepare_native_readiness(
        &self,
        expected_launch: &NativeIdentityLaunch,
    ) -> Result<Option<NativeDispatchIdentity>, ActorError> {
        self.prepare_native_readiness_inner(expected_launch, None)
            .await
            .map(|(identity, _)| identity)
    }

    pub async fn prepare_native_readiness_with_receipt(
        &self,
        expected_launch: &NativeIdentityLaunch,
        source_fence: &NativeReadinessFence,
    ) -> Result<Option<NativeReadinessReceipt>, ActorError> {
        self.prepare_native_readiness_inner(expected_launch, Some(source_fence))
            .await
            .map(|(_, receipt)| receipt)
    }

    async fn prepare_native_readiness_inner(
        &self,
        expected_launch: &NativeIdentityLaunch,
        source_fence: Option<&NativeReadinessFence>,
    ) -> Result<
        (
            Option<NativeDispatchIdentity>,
            Option<NativeReadinessReceipt>,
        ),
        ActorError,
    > {
        let _dispatch_guard = self.dispatch_lock.lock().await;
        if self.stopped.load(Ordering::SeqCst) {
            return Err(ActorError::NativeIdentityMismatch);
        }
        if source_fence.is_some_and(|fence| {
            fence.active_incarnation_id != expected_launch.incarnation_id
                || fence.evidence_revision < expected_launch.evidence_revision
        }) {
            return Err(ActorError::NativeIdentityMismatch);
        }
        self.native_identity_transition
            .store(true, Ordering::SeqCst);
        let result = async {
            let (prior, persisted_receipt) = {
                let state = self.state.lock().await;
                (
                    state.profile.clone(),
                    state.native_readiness_receipt.clone(),
                )
            };
            if let (Some(source_fence), Some(receipt)) = (source_fence, persisted_receipt) {
                let profile_matches = prior.provider == FreshProvider::Codex
                    && prior.native_session_id.as_deref()
                        == Some(receipt.identity.native_session_id.as_str())
                    && prior.naming_handle == receipt.identity.pending_naming_handle
                    && prior.session_ref.as_ref().is_none_or(|reference| {
                        reference.session_id == receipt.identity.native_session_id
                    });
                if receipt.is_valid()
                    && receipt.source_launch == *expected_launch
                    && receipt.source_fence.is_covered_by(source_fence)
                    && profile_matches
                {
                    *self.observed_native_session_id.lock().await =
                        Some(receipt.identity.native_session_id.clone());
                    return Ok((Some(receipt.identity.clone()), Some(receipt)));
                }
            }
            if prior.provider == FreshProvider::Codex {
                let Some(previous_native_session_id) = prior.native_session_id.clone() else {
                    return Err(ActorError::NativeIdentityMismatch);
                };
                if expected_launch.launch_nonce.is_empty()
                    || expected_launch.execution_generation == 0
                    || expected_launch
                        .requested_native_session_id
                        .as_deref()
                        .is_some_and(|requested| requested != previous_native_session_id)
                {
                    return Err(ActorError::NativeIdentityMismatch);
                }
                let evidence = self
                    .transport
                    .native_identity_evidence()
                    .await
                    .ok_or(ActorError::NativeIdentityMismatch)?;
                let actual_launch: NativeIdentityLaunch =
                    serde_json::from_value(evidence["launch"].clone())
                        .map_err(|_| ActorError::NativeIdentityMismatch)?;
                if actual_launch != *expected_launch
                    || evidence["nativeSessionId"].as_str()
                        != Some(previous_native_session_id.as_str())
                {
                    return Err(ActorError::NativeIdentityMismatch);
                }
            }
            let transition = self
                .transport
                .prepare_native_readiness(expected_launch)
                .await
                .map_err(ActorError::Transport)?;
            if self.stopped.load(Ordering::SeqCst) {
                return Err(ActorError::NativeIdentityMismatch);
            }
            if prior.provider != FreshProvider::Codex {
                if transition.is_some() {
                    return Err(ActorError::NativeIdentityMismatch);
                }
                return Ok((None, None));
            }

            let evidence = self
                .transport
                .native_identity_evidence()
                .await
                .ok_or(ActorError::NativeIdentityMismatch)?;
            let actual_launch: NativeIdentityLaunch =
                serde_json::from_value(evidence["launch"].clone())
                    .map_err(|_| ActorError::NativeIdentityMismatch)?;
            let Some(previous_native_session_id) = prior.native_session_id.clone() else {
                return Err(ActorError::NativeIdentityMismatch);
            };
            match transition {
                Some(identity) => {
                    let mut expected_next = expected_launch.clone();
                    expected_next.evidence_revision = expected_next
                        .evidence_revision
                        .checked_add(1)
                        .ok_or(ActorError::NativeIdentityMismatch)?;
                    expected_next.requested_native_session_id =
                        Some(identity.native_session_id.clone());
                    if identity.previous_native_session_id != previous_native_session_id
                        || identity.native_session_id.is_empty()
                        || identity.native_session_id == previous_native_session_id
                        || identity.native_session_id.chars().any(char::is_control)
                        || identity
                            .pending_naming_handle
                            .as_ref()
                            .is_some_and(|handle| {
                                handle.is_empty() || handle.chars().any(char::is_control)
                            })
                        || actual_launch != expected_next
                        || evidence["nativeSessionId"].as_str()
                            != Some(identity.native_session_id.as_str())
                    {
                        return Err(ActorError::NativeIdentityMismatch);
                    }
                    let receipt = source_fence.map(|source_fence| NativeReadinessReceipt {
                        source_fence: source_fence.clone(),
                        source_launch: expected_launch.clone(),
                        next_launch: expected_next.clone(),
                        identity: identity.clone(),
                        absence_evidence: None,
                        resume_spec_sha256: None,
                    });
                    if receipt.as_ref().is_some_and(|receipt| !receipt.is_valid()) {
                        return Err(ActorError::NativeIdentityMismatch);
                    }
                    let mut state = self.state.lock().await;
                    if state.profile.provider != FreshProvider::Codex
                        || state.profile.native_session_id.as_deref()
                            != Some(identity.previous_native_session_id.as_str())
                    {
                        return Err(ActorError::NativeIdentityMismatch);
                    }
                    let mut updated = state.clone();
                    updated.native_readiness_receipt = receipt.clone();
                    updated.profile.native_session_id = Some(identity.native_session_id.clone());
                    updated.profile.naming_handle = identity.pending_naming_handle.clone();
                    if let Some(reference) = updated.profile.session_ref.as_mut() {
                        reference.session_id = identity.native_session_id.clone();
                    }
                    *self.observed_native_session_id.lock().await =
                        Some(identity.native_session_id.clone());
                    push_event_bounded(
                        &mut updated,
                        AgentEvent::Started {
                            native_session_id: identity.native_session_id.clone(),
                        },
                        self.event_byte_cap,
                        self.event_count_cap,
                    )?;
                    write_state(&self.state_dir, &updated)?;
                    *state = updated;
                    Ok((Some(identity), receipt))
                }
                None => {
                    if actual_launch != *expected_launch
                        || evidence["nativeSessionId"].as_str()
                            != Some(previous_native_session_id.as_str())
                    {
                        return Err(ActorError::NativeIdentityMismatch);
                    }
                    Ok((None, None))
                }
            }
        }
        .await;
        self.native_identity_transition
            .store(false, Ordering::SeqCst);
        result
    }

    pub async fn prepare_same_root_native_readiness(&self) -> Result<(), ActorError> {
        let _dispatch = self.dispatch_lock.lock().await;
        let profile = self.profile().await;
        if self.stopped.load(Ordering::SeqCst)
            || self.native_identity_transition.load(Ordering::SeqCst)
            || profile.provider != FreshProvider::Codex
            || profile.native_session_id.is_none()
            || *self.observed_native_session_id.lock().await != profile.native_session_id
        {
            return Err(ActorError::NativeIdentityMismatch);
        }
        let result = self.transport.prepare_same_root_native_readiness().await;
        if self.stopped.load(Ordering::SeqCst) {
            // Stop revokes authority immediately. Its first shutdown can run
            // before a held native resume registers; reap that late runtime too.
            Arc::clone(&self.transport)
                .stop()
                .await
                .map_err(ActorError::Transport)?;
            return Err(ActorError::NativeIdentityMismatch);
        }
        result.map_err(ActorError::Transport)?;
        if self.profile().await != profile || self.native_identity_transition.load(Ordering::SeqCst)
        {
            return Err(ActorError::NativeIdentityMismatch);
        }
        Ok(())
    }

    async fn prepare_claude_effect(
        &self,
        state: &mut PersistedActorState,
        destroys_redo: bool,
    ) -> Result<(), ActorError> {
        if let Some(context) = self
            .transport
            .disable_claude_fork_recovery(destroys_redo)
            .await
            .map_err(ActorError::Transport)?
        {
            validate_claude_fork_state(&context, &state.profile)?;
            state.claude_fork_state = Some(context);
        }
        if let Some(recipe) = state
            .claude_fork_state
            .as_mut()
            .and_then(|context| context.recipe.as_mut())
        {
            recipe.recovery_disabled = true;
        }
        Ok(())
    }

    pub async fn claude_fork_recipe(&self) -> Option<freshell_runtime_protocol::ClaudeForkRecipe> {
        let state = self.state.lock().await;
        state
            .claude_fork_state
            .as_ref()
            .and_then(|context| context.recipe.clone())
    }

    pub async fn observed_native_session_id(&self) -> Option<String> {
        if !self.is_live().await {
            return None;
        }
        let state = self.state.lock().await;
        if self.native_identity_transition.load(Ordering::SeqCst) {
            return None;
        }
        self.observed_native_session_id
            .lock()
            .await
            .clone()
            .filter(|observed| state.profile.native_session_id.as_ref() == Some(observed))
    }

    pub async fn observed_native_identity_evidence(&self) -> Option<Value> {
        self.observed_native_session_id().await?;
        self.transport.native_identity_evidence().await
    }

    /// Retain the original Codex source binding for its owned recovery send.
    /// This is past evidence, never a current native observation. The caller
    /// must bind it to its exact launch; dispatch still verifies the original
    /// writer's termination and supplies the typed replacement receipt.
    pub async fn codex_dispatch_recovery_evidence(&self) -> Option<Value> {
        if self.stopped.load(Ordering::SeqCst)
            || self.native_identity_transition.load(Ordering::SeqCst)
            || self.is_live().await
        {
            return None;
        }
        let original = {
            let state = self.state.lock().await;
            if state.profile.provider != FreshProvider::Codex
                || state.profile.runtime_variant != "codex-app-server"
            {
                return None;
            }
            state.profile.native_session_id.clone()?
        };
        let evidence = self.transport.native_identity_evidence().await?;
        let state = self.state.lock().await;
        (!self.stopped.load(Ordering::SeqCst)
            && !self.native_identity_transition.load(Ordering::SeqCst)
            && state.profile.native_session_id.as_deref() == Some(original.as_str())
            && evidence["nativeSessionId"].as_str() == Some(original.as_str()))
        .then_some(evidence)
    }

    /// The established Codex actor can attempt guarded recovery after its
    /// native exits. This is retained producer evidence, never live proof or
    /// authority derived from a saved resume profile.
    pub async fn retained_codex_native_identity_evidence(&self) -> Option<Value> {
        let _dispatch = self.dispatch_lock.try_lock().ok()?;
        if self.stopped.load(Ordering::SeqCst)
            || self.native_identity_transition.load(Ordering::SeqCst)
        {
            return None;
        }
        let state = self.state.lock().await;
        if state.profile.provider != FreshProvider::Codex {
            return None;
        }
        let observed = self.observed_native_session_id.lock().await.clone()?;
        if state.profile.native_session_id.as_ref() != Some(&observed) {
            return None;
        }
        let evidence = self.transport.native_identity_evidence().await?;
        (evidence["nativeSessionId"].as_str() == Some(observed.as_str())
            && !self.stopped.load(Ordering::SeqCst))
        .then_some(evidence)
    }

    pub async fn observe_native_identity(
        &self,
        native_session_id: String,
    ) -> Result<(), ActorError> {
        let evidence = self.transport.native_identity_evidence().await;
        self.observe_native_identity_with_evidence(native_session_id, evidence)
            .await
    }

    async fn observe_native_identity_with_evidence(
        &self,
        native_session_id: String,
        evidence: Option<Value>,
    ) -> Result<(), ActorError> {
        if native_session_id.is_empty() || native_session_id.chars().any(char::is_control) {
            return Err(ActorError::NativeIdentityMismatch);
        }
        let mut state = self.state.lock().await;
        if self.native_identity_transition.load(Ordering::SeqCst)
            || self.stopped.load(Ordering::SeqCst)
        {
            // Native operation acknowledgements settle a root transition. A
            // racing lifecycle event alone cannot adopt a child or revive its
            // retired parent while that operation is incomplete.
            return Err(ActorError::NativeIdentityMismatch);
        }
        match state.profile.native_session_id.as_deref() {
            Some(existing) if existing != native_session_id => {
                let proven_clear = matches!(
                    state.profile.provider,
                    FreshProvider::Claude | FreshProvider::Kilroy
                ) && evidence.as_ref().is_some_and(|evidence| {
                    evidence["nativeSessionId"].as_str() == Some(native_session_id.as_str())
                        && evidence["nativeClear"]["previousNativeSessionId"].as_str()
                            == Some(existing)
                        && evidence["nativeClear"]["nativeSessionId"].as_str()
                            == Some(native_session_id.as_str())
                });
                if !proven_clear {
                    return Err(ActorError::NativeIdentityMismatch);
                }
                state.profile.native_session_id = Some(native_session_id.clone());
                if let Some(reference) = state.profile.session_ref.as_mut() {
                    reference.session_id = native_session_id.clone();
                }
                // The transport publishes this marker only after an actual
                // native clear. The cleared conversation cannot use the old
                // parent's fork recipe or rollback history on recovery.
                state.claude_fork_state = None;
            }
            Some(_) => {
                *self.observed_native_session_id.lock().await = Some(native_session_id);
                return Ok(());
            }
            None => state.profile.native_session_id = Some(native_session_id.clone()),
        }
        *self.observed_native_session_id.lock().await = Some(native_session_id.clone());
        push_event_bounded(
            &mut state,
            AgentEvent::Started { native_session_id },
            self.event_byte_cap,
            self.event_count_cap,
        )?;
        write_state(&self.state_dir, &state)
    }

    pub async fn dispatch(
        &self,
        request_id: RequestId,
        text: String,
        settings: Option<FreshAgentTurnSettings>,
    ) -> Result<CommandState, ActorError> {
        self.dispatch_with_checkpoint_identity(request_id, text, settings, None)
            .await
    }

    pub async fn dispatch_with_checkpoint_identity(
        &self,
        request_id: RequestId,
        text: String,
        settings: Option<FreshAgentTurnSettings>,
        logical_attempt_id: Option<String>,
    ) -> Result<CommandState, ActorError> {
        self.dispatch_with_codex_recovery_source(
            request_id,
            text,
            settings,
            logical_attempt_id,
            None,
        )
        .await
        .map(|result| result.state)
    }

    /// Return the durable outcome for one retained Codex request ID. The
    /// supervisor binds that ID to its exact durable input row before asking;
    /// an absent or unfinished actor record is ambiguous, a cancelled record
    /// is a definite refusal, and this path never enters the provider
    /// transport or waits behind its dispatch lock.
    pub async fn codex_recovery_send_receipt(
        &self,
        request_id: RequestId,
    ) -> Result<DispatchResult, ActorError> {
        if self.native_identity_transition.load(Ordering::SeqCst)
            || self.stopped.load(Ordering::SeqCst)
        {
            return Err(ActorError::AmbiguousDispatch);
        }

        let state = self
            .state
            .try_lock()
            .map_err(|_| ActorError::AmbiguousDispatch)?;
        let Some(existing) = state.commands.get(request_id.as_str()) else {
            return Err(ActorError::AmbiguousDispatch);
        };
        let Some(source) = existing.codex_dispatch_recovery_source.as_ref() else {
            return Err(ActorError::AmbiguousDispatch);
        };
        match existing.state {
            CommandState::ProviderAcked | CommandState::Completed => {}
            CommandState::Cancelled => return Err(ActorError::SendRefused),
            CommandState::Ambiguous => {
                return Ok(DispatchResult {
                    state: CommandState::Ambiguous,
                    native_identity: None,
                    codex_dispatch_recovery_source: Some(source.clone()),
                });
            }
            _ => return Err(ActorError::AmbiguousDispatch),
        }
        let native_identity = existing
            .native_identity
            .clone()
            .filter(|identity| {
                state.profile.native_session_id.as_deref()
                    == Some(identity.native_session_id.as_str())
            })
            .ok_or(ActorError::AmbiguousDispatch)?;
        Ok(DispatchResult {
            state: existing.state,
            native_identity: Some(native_identity),
            codex_dispatch_recovery_source: Some(source.clone()),
        })
    }

    pub async fn dispatch_with_codex_recovery_source(
        &self,
        request_id: RequestId,
        text: String,
        settings: Option<FreshAgentTurnSettings>,
        logical_attempt_id: Option<String>,
        codex_dispatch_recovery_source: Option<NativeIdentityObservation>,
    ) -> Result<DispatchResult, ActorError> {
        // One provider conversation has one ordered input lane. Keep the
        // durability transition and provider acceptance boundary within the
        // same fence so concurrent gateways cannot become double writers.
        let _dispatch_guard = self.dispatch_lock.lock().await;
        if self.native_identity_transition.load(Ordering::SeqCst)
            || self.stopped.load(Ordering::SeqCst)
        {
            return Err(ActorError::NativeIdentityMismatch);
        }
        // Preserve the exact historical digest for legacy sends so a command
        // journal created before this field existed remains idempotent after
        // upgrade. The retained source and logical attempt fence recovery
        // sends into durable request-ID conflict detection.
        let payload_digest = fresh_agent_send_digest(
            &text,
            &settings,
            logical_attempt_id.as_deref(),
            codex_dispatch_recovery_source.as_ref(),
        )?;
        let dispatch_profile;
        {
            let mut state = self.state.lock().await;
            if let Some(existing) = state.commands.get(request_id.as_str()) {
                if existing.payload_digest != payload_digest {
                    return Err(ActorError::RequestConflict);
                }
                return match existing.state {
                    CommandState::Ambiguous | CommandState::Dispatching | CommandState::Queued => {
                        Err(ActorError::AmbiguousDispatch)
                    }
                    other => Ok(DispatchResult {
                        state: other,
                        native_identity: existing.native_identity.clone(),
                        codex_dispatch_recovery_source: existing
                            .codex_dispatch_recovery_source
                            .clone(),
                    }),
                };
            }
            if let Some(settings) = settings.as_ref() {
                state.profile.apply_turn_settings(settings);
                state.profile.validate()?;
            }
            dispatch_profile = state.profile.clone();
            state.commands.insert(
                request_id.as_str().to_string(),
                PersistedCommand {
                    payload_digest,
                    state: CommandState::Queued,
                    provider_ack_id: None,
                    native_identity: None,
                    codex_dispatch_recovery_source: codex_dispatch_recovery_source.clone(),
                    operation_failure: None,
                },
            );
            write_protected_payload(&self.state_dir, &request_id, text.as_bytes())?;
            write_state(&self.state_dir, &state)?;
            state
                .commands
                .get_mut(request_id.as_str())
                .expect("inserted")
                .state = CommandState::Dispatching;
            self.prepare_claude_effect(&mut state, true).await?;
            write_state(&self.state_dir, &state)?;
        }
        let result = self
            .transport
            .dispatch_with_codex_recovery_source(
                &request_id,
                &text,
                &dispatch_profile,
                settings.as_ref(),
                logical_attempt_id.as_deref(),
                codex_dispatch_recovery_source.as_ref(),
            )
            .await;
        let mut state = self.state.lock().await;
        if let Ok(ack) = &result {
            if let Some(identity) = &ack.native_identity {
                if identity.native_session_id.is_empty()
                    || identity.native_session_id.chars().any(char::is_control)
                    || dispatch_profile.native_session_id.as_deref()
                        != Some(identity.previous_native_session_id.as_str())
                    || state.profile.native_session_id != dispatch_profile.native_session_id
                    || state.profile.provider_store_id != dispatch_profile.provider_store_id
                    || state.profile.provider != dispatch_profile.provider
                    || identity
                        .pending_naming_handle
                        .as_ref()
                        .is_some_and(|handle| {
                            dispatch_profile.naming_handle.as_ref() != Some(handle)
                        })
                {
                    state
                        .commands
                        .get_mut(request_id.as_str())
                        .expect("durable command")
                        .state = CommandState::Ambiguous;
                    push_event_bounded(
                        &mut state,
                        AgentEvent::CommandOutcome {
                            request_id,
                            state: CommandState::Ambiguous,
                        },
                        self.event_byte_cap,
                        self.event_count_cap,
                    )?;
                    write_state(&self.state_dir, &state)?;
                    return Err(ActorError::AmbiguousDispatch);
                }
                let changed = state.profile.native_session_id.as_deref()
                    != Some(identity.native_session_id.as_str());
                state.profile.native_session_id = Some(identity.native_session_id.clone());
                state.profile.naming_handle = identity.pending_naming_handle.clone();
                *self.observed_native_session_id.lock().await =
                    Some(identity.native_session_id.clone());
                if changed {
                    if let Some(reference) = state.profile.session_ref.as_mut() {
                        reference.session_id = identity.native_session_id.clone();
                    }
                    push_event_bounded(
                        &mut state,
                        AgentEvent::Started {
                            native_session_id: identity.native_session_id.clone(),
                        },
                        self.event_byte_cap,
                        self.event_count_cap,
                    )?;
                }
            }
        }
        let command = state
            .commands
            .get_mut(request_id.as_str())
            .expect("durable command");
        match result {
            Ok(ack) => {
                command.provider_ack_id = ack.provider_ack_id;
                command.native_identity = ack.native_identity.clone();
                command.state = CommandState::ProviderAcked;
                push_event_bounded(
                    &mut state,
                    AgentEvent::CommandOutcome {
                        request_id,
                        state: CommandState::ProviderAcked,
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                write_state(&self.state_dir, &state)?;
                Ok(DispatchResult {
                    state: CommandState::ProviderAcked,
                    native_identity: ack.native_identity,
                    codex_dispatch_recovery_source,
                })
            }
            Err(failure) => {
                command.state = if failure.acceptance_ambiguous {
                    CommandState::Ambiguous
                } else {
                    CommandState::Cancelled
                };
                let outcome = command.state;
                push_event_bounded(
                    &mut state,
                    AgentEvent::CommandOutcome {
                        request_id,
                        state: outcome,
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                write_state(&self.state_dir, &state)?;
                if let Some(diagnostic) = failure.provider_diagnostic {
                    let diagnostic_is_ambiguous = matches!(
                        diagnostic.outcome,
                        freshell_runtime_protocol::FreshAgentSendDiagnosticOutcome::Ambiguous
                    );
                    if diagnostic_is_ambiguous == failure.acceptance_ambiguous {
                        return Err(ActorError::ProviderSendDiagnostic(diagnostic));
                    }
                }
                if failure.acceptance_ambiguous {
                    Err(ActorError::AmbiguousDispatch)
                } else {
                    Err(ActorError::SendRefused)
                }
            }
        }
    }

    pub async fn fork(
        &self,
        request_id: RequestId,
        parent_session_id: String,
        input: Option<Value>,
    ) -> Result<ForkTransition, ActorError> {
        let _dispatch_guard = self.dispatch_lock.lock().await;
        let command_material =
            serde_json::to_vec(&("provider_native_fork", &input)).map_err(persist)?;
        let payload_digest = digest(&command_material);
        {
            let mut state = self.state.lock().await;
            if let Some(existing) = state.commands.get(request_id.as_str()) {
                if existing.payload_digest != payload_digest {
                    return Err(ActorError::RequestConflict);
                }
                return match existing.state {
                    CommandState::Completed | CommandState::ProviderAcked => state
                        .completed_forks
                        .get(request_id.as_str())
                        .cloned()
                        .ok_or_else(|| {
                            ActorError::Persistence(
                                "completed fork is missing its durable transition".into(),
                            )
                        }),
                    CommandState::Ambiguous | CommandState::Dispatching | CommandState::Queued => {
                        Err(ActorError::AmbiguousDispatch)
                    }
                    _ => Err(ActorError::Transport(
                        "provider-native fork was previously rejected".into(),
                    )),
                };
            }
            if self.native_identity_transition.load(Ordering::SeqCst)
                || self.stopped.load(Ordering::SeqCst)
            {
                return Err(ActorError::NativeIdentityMismatch);
            }
            if state.profile.native_session_id.as_deref() != Some(parent_session_id.as_str()) {
                return Err(ActorError::NativeIdentityMismatch);
            }
            state.commands.insert(
                request_id.as_str().to_string(),
                PersistedCommand {
                    payload_digest,
                    state: CommandState::Dispatching,
                    provider_ack_id: None,
                    native_identity: None,
                    codex_dispatch_recovery_source: None,
                    operation_failure: None,
                },
            );
            // The input contains only provider branch position/settings, not a
            // prompt. It is still persisted under the protected command lane so
            // a lost acknowledgement cannot issue a second native fork.
            write_protected_payload(
                &self.state_dir,
                &request_id,
                serde_json::to_vec(&(parent_session_id.as_str(), &input))
                    .map_err(persist)?
                    .as_slice(),
            )?;
            write_state(&self.state_dir, &state)?;
            self.native_identity_transition
                .store(true, Ordering::SeqCst);
        }

        let result = self
            .transport
            .fork(&request_id, &parent_session_id, input)
            .await;
        let claude_context = if result.is_ok() {
            self.transport.claude_fork_state().await
        } else {
            None
        };
        let mut state = self.state.lock().await;
        match result {
            Ok(transition) => {
                if self.stopped.load(Ordering::SeqCst)
                    || transition.parent_session_id != parent_session_id
                    || transition.child_session_id.is_empty()
                    || transition.child_session_id == parent_session_id
                    || transition.child_session_id.chars().any(char::is_control)
                    || !transition.parent_retired_by_runtime
                {
                    if let Some(command) = state.commands.get_mut(request_id.as_str()) {
                        command.state = CommandState::Ambiguous;
                    }
                    write_state(&self.state_dir, &state)?;
                    return Err(ActorError::AmbiguousDispatch);
                }
                state.profile.native_session_id = Some(transition.child_session_id.clone());
                state.profile.naming_handle = None;
                if let Some(reference) = state.profile.session_ref.as_mut() {
                    reference.session_id = transition.child_session_id.clone();
                }
                if matches!(
                    state.profile.provider,
                    FreshProvider::Claude | FreshProvider::Kilroy
                ) {
                    if let Some(context) = claude_context.as_ref() {
                        validate_claude_fork_state(context, &state.profile)?;
                    }
                    state.claude_fork_state = claude_context;
                }
                if let Some(command) = state.commands.get_mut(request_id.as_str()) {
                    command.provider_ack_id = Some(transition.child_session_id.clone());
                    command.state = CommandState::Completed;
                }
                state
                    .completed_forks
                    .insert(request_id.as_str().to_string(), transition.clone());
                push_event_bounded(
                    &mut state,
                    AgentEvent::Started {
                        native_session_id: transition.child_session_id.clone(),
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                push_event_bounded(
                    &mut state,
                    AgentEvent::CommandOutcome {
                        request_id,
                        state: CommandState::Completed,
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                write_state(&self.state_dir, &state)?;
                *self.observed_native_session_id.lock().await =
                    Some(transition.child_session_id.clone());
                self.native_identity_transition
                    .store(false, Ordering::SeqCst);
                Ok(transition)
            }
            Err(failure) => {
                if let Some(command) = state.commands.get_mut(request_id.as_str()) {
                    command.state = if failure.acceptance_ambiguous {
                        CommandState::Ambiguous
                    } else {
                        CommandState::Cancelled
                    };
                }
                write_state(&self.state_dir, &state)?;
                if failure.acceptance_ambiguous {
                    Err(ActorError::AmbiguousDispatch)
                } else {
                    self.native_identity_transition
                        .store(false, Ordering::SeqCst);
                    Err(ActorError::Transport(failure.message))
                }
            }
        }
    }

    /// Changes this conversation's settings without a turn. The settings are
    /// persisted into the durable profile (so every later send carries them)
    /// in the same write that journals the command, before the provider is
    /// asked to apply them live. A refused live apply keeps that intent; a
    /// provider without live configure support only stages it.
    pub async fn configure(
        &self,
        request_id: RequestId,
        settings: FreshAgentTurnSettings,
    ) -> Result<CommandState, ActorError> {
        self.semantic_operation(request_id, FreshAgentOperation::Configure { settings })
            .await
    }

    pub async fn semantic_operation(
        &self,
        request_id: RequestId,
        operation: FreshAgentOperation,
    ) -> Result<CommandState, ActorError> {
        let _dispatch_guard = self.dispatch_lock.lock().await;
        let material = serde_json::to_vec(&operation).map_err(persist)?;
        let payload_digest = digest(&material);
        // A configure saves its settings before the live apply, so a refused
        // live apply is its answer (Cancelled), not a failed command: the
        // provider's own session-scoped error already tells every device why.
        let saved_before_dispatch = matches!(operation, FreshAgentOperation::Configure { .. });
        {
            let state = self.state.lock().await;
            if let Some(existing) = state.commands.get(request_id.as_str()) {
                if existing.payload_digest != payload_digest {
                    return Err(ActorError::RequestConflict);
                }
                return match (existing.state, existing.operation_failure) {
                    (CommandState::Cancelled, Some(_)) if saved_before_dispatch => {
                        Ok(CommandState::Cancelled)
                    }
                    (CommandState::Cancelled, Some(OperationFailureKind::Unsupported)) => {
                        Err(ActorError::UnsupportedOperation)
                    }
                    (CommandState::Cancelled, Some(OperationFailureKind::Rejected)) => Err(
                        ActorError::Transport("provider previously rejected operation".into()),
                    ),
                    (
                        CommandState::Ambiguous | CommandState::Dispatching | CommandState::Queued,
                        _,
                    ) => Err(ActorError::AmbiguousDispatch),
                    (other, _) => Ok(other),
                };
            }
        }
        if self.native_identity_transition.load(Ordering::SeqCst)
            || self.stopped.load(Ordering::SeqCst)
        {
            return Err(ActorError::NativeIdentityMismatch);
        }
        let live_supported = self
            .transport
            .supports_operation(&operation)
            .await
            .map_err(|_| ActorError::Transport("provider capability check failed".into()))?;
        // A configure is first the durable settings intent that every later
        // send carries; the live apply only converges the provider sooner.
        // Without live support the intent is still staged for the next send.
        let staged_settings = match &operation {
            FreshAgentOperation::Configure { settings } => Some(settings),
            _ => None,
        };
        if !live_supported && staged_settings.is_none() {
            return Err(ActorError::UnsupportedOperation);
        }
        {
            let mut state = self.state.lock().await;
            if let Some(settings) = staged_settings {
                let mut configured = state.profile.clone();
                configured.apply_configure_settings(settings);
                configured.validate()?;
                state.profile = configured;
            }
            state.commands.insert(
                request_id.as_str().to_string(),
                PersistedCommand {
                    payload_digest,
                    state: if live_supported {
                        CommandState::Queued
                    } else {
                        CommandState::Completed
                    },
                    provider_ack_id: None,
                    native_identity: None,
                    codex_dispatch_recovery_source: None,
                    operation_failure: None,
                },
            );
            write_protected_payload(&self.state_dir, &request_id, &material)?;
            if !live_supported {
                push_event_bounded(
                    &mut state,
                    AgentEvent::CommandOutcome {
                        request_id,
                        state: CommandState::Completed,
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                write_state(&self.state_dir, &state)?;
                return Ok(CommandState::Completed);
            }
            write_state(&self.state_dir, &state)?;
            state
                .commands
                .get_mut(request_id.as_str())
                .expect("inserted semantic operation")
                .state = CommandState::Dispatching;
            if matches!(operation, FreshAgentOperation::Compact { .. }) {
                self.prepare_claude_effect(&mut state, false).await?;
            }
            write_state(&self.state_dir, &state)?;
            self.native_identity_transition
                .store(true, Ordering::SeqCst);
        }

        let result = self
            .transport
            .dispatch_operation(&request_id, &operation)
            .await;
        let claude_context = if result.is_ok() {
            self.transport.claude_fork_state().await
        } else {
            None
        };
        let mut state = self.state.lock().await;
        let (outcome, native_session_id) = {
            let command = state
                .commands
                .get_mut(request_id.as_str())
                .expect("durable semantic operation");
            match result {
                Ok(_) if self.stopped.load(Ordering::SeqCst) => {
                    command.state = CommandState::Ambiguous;
                    (Err(ActorError::AmbiguousDispatch), None)
                }
                Ok(ack) => {
                    command.provider_ack_id = ack.provider_ack_id;
                    command.state = CommandState::ProviderAcked;
                    (Ok(CommandState::ProviderAcked), ack.native_session_id)
                }
                Err(failure) => {
                    command.state = if failure.acceptance_ambiguous {
                        CommandState::Ambiguous
                    } else {
                        CommandState::Cancelled
                    };
                    command.operation_failure = Some(failure.kind);
                    if saved_before_dispatch && !failure.acceptance_ambiguous {
                        (Ok(CommandState::Cancelled), None)
                    } else {
                        let error = if failure.acceptance_ambiguous {
                            ActorError::AmbiguousDispatch
                        } else if failure.kind == OperationFailureKind::Unsupported {
                            ActorError::UnsupportedOperation
                        } else {
                            ActorError::Transport(failure.message)
                        };
                        (Err(error), None)
                    }
                }
            }
        };
        let native_identity_changed = native_session_id.as_ref().is_some_and(|native| {
            state.profile.native_session_id.as_deref() != Some(native.as_str())
        });
        if let Some(native_session_id) = native_session_id.as_ref() {
            if native_session_id.is_empty() || native_session_id.chars().any(char::is_control) {
                state
                    .commands
                    .get_mut(request_id.as_str())
                    .expect("durable operation")
                    .state = CommandState::Ambiguous;
                write_state(&self.state_dir, &state)?;
                return Err(ActorError::AmbiguousDispatch);
            }
            if state.profile.native_session_id.as_deref() != Some(native_session_id) {
                state.profile.native_session_id = Some(native_session_id.clone());
                state.profile.naming_handle = None;
                if let Some(reference) = state.profile.session_ref.as_mut() {
                    reference.session_id = native_session_id.clone();
                }
                push_event_bounded(
                    &mut state,
                    AgentEvent::Started {
                        native_session_id: native_session_id.clone(),
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
            }
        }
        if outcome.is_ok() {
            if let Some(context) = claude_context {
                validate_claude_fork_state(&context, &state.profile)?;
                state.claude_fork_state = Some(context);
            } else if native_identity_changed
                && matches!(
                    state.profile.provider,
                    FreshProvider::Claude | FreshProvider::Kilroy
                )
            {
                state.claude_fork_state = None;
            }
        }
        let command_state = state
            .commands
            .get(request_id.as_str())
            .expect("durable semantic operation")
            .state;
        push_event_bounded(
            &mut state,
            AgentEvent::CommandOutcome {
                request_id,
                state: command_state,
            },
            self.event_byte_cap,
            self.event_count_cap,
        )?;
        write_state(&self.state_dir, &state)?;
        if outcome.is_ok() || command_state == CommandState::Cancelled {
            if let Some(native_session_id) = native_session_id {
                *self.observed_native_session_id.lock().await = Some(native_session_id);
            }
            self.native_identity_transition
                .store(false, Ordering::SeqCst);
        }
        outcome
    }

    pub async fn capture(&self, max_bytes: usize) -> Result<FreshAgentCapture, ActorError> {
        let max_bytes = max_bytes.clamp(1, 256 * 1024);
        self.transport
            .capture(max_bytes)
            .await
            .map_err(ActorError::Transport)
    }

    pub async fn snapshot(&self) -> Result<Value, ActorError> {
        if !self.transport.is_live().await {
            return Err(ActorError::Transport("provider is not live".into()));
        }
        let snapshot = self
            .transport
            .snapshot()
            .await
            .map_err(ActorError::Transport)?;
        if !self.transport.is_live().await {
            return Err(ActorError::Transport(
                "provider exited during snapshot read".into(),
            ));
        }
        let profile = self.profile().await;
        let provider = if profile.provider == freshell_runtime_protocol::FreshProvider::Kilroy {
            "claude"
        } else {
            profile.provider.as_str()
        };
        let session_type = match profile.provider {
            FreshProvider::Claude => "freshclaude",
            FreshProvider::Codex => "freshcodex",
            FreshProvider::Opencode => "freshopencode",
            FreshProvider::Kilroy => "kilroy",
        };
        let registered =
            if profile.native_session_id.is_none() && profile.provider == FreshProvider::Opencode {
                self.transport.registered_snapshot_identity().await
            } else {
                None
            };
        // Recheck after the registration read: materialization must win over a placeholder.
        let profile = self.profile().await;
        let expected = profile
            .native_session_id
            .as_deref()
            .or(registered.as_deref());
        if expected.is_none()
            || snapshot["threadId"].as_str() != expected
            || snapshot["provider"].as_str() != Some(provider)
            || snapshot["sessionType"].as_str() != Some(session_type)
        {
            return Err(ActorError::NativeIdentityMismatch);
        }
        // Snapshots use the existing native-history reply allowance, including envelope overhead.
        if serde_json::to_vec(&snapshot)
            .map_err(|error| ActorError::Transport(error.to_string()))?
            .len()
            > freshell_runtime_protocol::MAX_NATIVE_HISTORY_FRAME_BYTES - 4096
        {
            return Err(ActorError::Transport(
                "provider snapshot exceeds history reply frame limit".into(),
            ));
        }
        Ok(snapshot)
    }

    pub async fn model_catalog(&self, cwd: Option<&str>) -> Result<Value, ActorError> {
        let before = self.profile().await;
        if before.provider != FreshProvider::Codex
            || before.native_session_id.is_none()
            || !self.transport.is_live().await
        {
            return Err(ActorError::NativeIdentityMismatch);
        }
        let value = self
            .transport
            .model_catalog(cwd)
            .await
            .map_err(ActorError::Transport)?;
        let after = self.profile().await;
        if before.native_session_id != after.native_session_id
            || before.provider_store_id != after.provider_store_id
            || before.provider != after.provider
            || before.cwd != after.cwd
            || !self.transport.is_live().await
        {
            return Err(ActorError::NativeIdentityMismatch);
        }
        if serde_json::to_vec(&value)
            .map_err(|e| ActorError::Transport(e.to_string()))?
            .len()
            > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES - 4096
        {
            return Err(ActorError::Transport(
                "model catalog exceeds control reply frame limit".into(),
            ));
        }
        Ok(value)
    }

    pub async fn native_name(
        &self,
        native_session_id: &str,
        codex_home: &str,
        operation: &FreshAgentNativeNameOperation,
    ) -> FreshAgentNativeNameReply {
        let before = self.profile().await;
        if before.provider != FreshProvider::Codex
            || before.native_session_id.as_deref() != Some(native_session_id)
            || codex_home.is_empty()
            || !self.transport.is_live().await
        {
            return FreshAgentNativeNameReply::Failed(FreshAgentNativeNameError::Unavailable {
                message: "native naming target is no longer current".into(),
            });
        }
        let reply = self
            .transport
            .native_name(native_session_id, codex_home, operation)
            .await;
        let after = self.profile().await;
        if before.native_session_id != after.native_session_id
            || before.provider_store_id != after.provider_store_id
            || !self.transport.is_live().await
        {
            // A write may already have applied to the captured source.
            return FreshAgentNativeNameReply::Failed(FreshAgentNativeNameError::Closed);
        }
        if serde_json::to_vec(&reply).map_or(true, |bytes| {
            bytes.len() > freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES - 4096
        }) {
            return FreshAgentNativeNameReply::Failed(FreshAgentNativeNameError::InvalidResponse {
                detail: "native naming reply exceeds control frame limit".into(),
            });
        }
        reply
    }

    pub async fn read_child(&self, child_thread_id: &str) -> Result<Value, ActorError> {
        let before = self.profile().await;
        if before.provider != FreshProvider::Codex
            || before.native_session_id.is_none()
            || !self.transport.is_live().await
        {
            return Err(ActorError::NativeIdentityMismatch);
        }
        let value = self
            .transport
            .read_child(child_thread_id)
            .await
            .map_err(ActorError::Transport)?;
        let after = self.profile().await;
        if before.native_session_id != after.native_session_id
            || !self.transport.is_live().await
            || value["parentThreadId"].as_str() != before.native_session_id.as_deref()
            || value["childThreadId"].as_str() != Some(child_thread_id)
            || (value.get("snapshot").is_some()
                && (value["snapshot"]["threadId"].as_str() != Some(child_thread_id)
                    || value["snapshot"]["provider"] != "codex"))
        {
            return Err(ActorError::NativeIdentityMismatch);
        }
        if serde_json::to_vec(&value)
            .map_err(|error| ActorError::Transport(error.to_string()))?
            .len()
            > freshell_runtime_protocol::MAX_NATIVE_HISTORY_FRAME_BYTES - 4096
        {
            return Err(ActorError::Transport(
                "child observation exceeds history reply frame limit".into(),
            ));
        }
        Ok(value)
    }

    pub async fn record_event(&self, mut event: AgentEvent) -> Result<u64, ActorError> {
        // The provider owns retained bodies. The bounded journal keeps only the
        // invalidation edge; reads reconcile against the current source.
        if let AgentEvent::Provider { payload } = &mut event {
            if payload["event"]["type"] == "freshAgent.host.backpressure" {
                if let Some(event) = payload["event"].as_object_mut() {
                    event.remove("retainedState");
                }
            }
        }
        if let Some((native_session_id, evidence)) = self.admitted_clear_init(&event).await {
            // The transport's watch may already contain the next clear. Its
            // admitted init frames retain each actual clear in FIFO order.
            // Stop/native-operation refusal still leaves the provider frame
            // available to the existing journal and correlated ACK path.
            let _ = self
                .observe_native_identity_with_evidence(native_session_id, Some(evidence))
                .await;
        }
        let mut state = self.state.lock().await;
        if let AgentEvent::Provider { payload } = &mut event {
            let native = if payload.get("event").is_some() {
                &mut payload["event"]
            } else {
                payload
            };
            let kind = native
                .get("type")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let request_id = native
                .get("requestId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if matches!(
                kind.as_deref(),
                Some(
                    "freshAgent.permission.cancelled"
                        | "freshAgent.question.cancelled"
                        | "freshAgent.elicitation.cancelled"
                )
            ) {
                let attempt_id = request_id
                    .as_deref()
                    .and_then(|request| state.decisions.get_mut(request))
                    .and_then(|decision| {
                        if matches!(
                            kind.as_deref(),
                            Some(
                                "freshAgent.permission.cancelled" | "freshAgent.question.cancelled"
                            )
                        ) && matches!(
                            decision.state,
                            DecisionState::Pending | DecisionState::Dispatching
                        ) {
                            decision.state = DecisionState::Interrupted;
                        }
                        decision.operation_attempt_id.clone()
                    });
                native["operationJournalId"] = serde_json::json!(state.journal_id);
                native["operationJournalSequence"] = serde_json::json!(state.next_sequence);
                if let Some(attempt_id) = attempt_id {
                    native["operationAttemptId"] = serde_json::json!(attempt_id);
                }
            }
        }
        let sequence =
            push_event_bounded(&mut state, event, self.event_byte_cap, self.event_count_cap)?;
        write_state(&self.state_dir, &state)?;
        Ok(sequence)
    }

    async fn admitted_clear_init(&self, event: &AgentEvent) -> Option<(String, Value)> {
        let AgentEvent::Provider { payload } = event else {
            return None;
        };
        let init = payload.get("event").unwrap_or(payload);
        let proof = &init["nativeIdentityEvidence"];
        if init["type"] != "freshAgent.session.init" || proof["source"] != "clear" {
            return None;
        }
        let native = init["cliSessionId"].as_str()?;
        let previous = proof["previousNativeSessionId"].as_str()?;
        let launch: NativeIdentityLaunch = serde_json::from_value(proof["launch"].clone()).ok()?;
        let generation = proof["queryGeneration"]
            .as_u64()
            .filter(|value| *value > 0)?;
        let current = self.transport.native_identity_evidence().await?;
        let current_launch: NativeIdentityLaunch =
            serde_json::from_value(current["launch"].clone()).ok()?;
        if launch != current_launch
            || current["providerEvidence"]["launch"] != proof["launch"]
            || current["queryGeneration"]
                .as_u64()
                .is_none_or(|value| value < generation)
            || !current["nativeSessionId"]
                .as_str()
                .is_some_and(|root| native_clear_matches_root(&current, root))
        {
            return None;
        }
        Some((
            native.into(),
            serde_json::json!({
                "nativeSessionId":native, "providerEvidence":proof, "launch":launch,
                "nativeClear":{"previousNativeSessionId":previous,"nativeSessionId":native},
                "queryGeneration":generation,
            }),
        ))
    }

    pub async fn record_permission(
        &self,
        decision_id: String,
        payload: Value,
    ) -> Result<u64, ActorError> {
        let current_root = self.observed_native_session_id().await;
        let current_evidence = self.observed_native_identity_evidence().await;
        let verified_checkpoint =
            current_native_checkpoint(&payload, current_root.as_deref(), current_evidence.as_ref());
        if payload.get("nativeCheckpoint").is_some() && verified_checkpoint.is_none() {
            return Err(ActorError::NativeIdentityMismatch);
        }
        let mut state = self.state.lock().await;
        if let Some(existing) = state.decisions.get(&decision_id) {
            if matches!(existing.state, DecisionState::Interrupted)
                && verified_checkpoint.is_some()
                && existing.payload.get("nativeCheckpoint") == verified_checkpoint.as_ref()
            {
                let existing = state
                    .decisions
                    .get_mut(&decision_id)
                    .expect("checked decision");
                existing.payload = payload.clone();
                existing.state = DecisionState::Pending;
                existing.response_digest = None;
                existing.operation_attempt_id = None;
                let sequence = push_event_bounded(
                    &mut state,
                    AgentEvent::PermissionRequested {
                        decision_id,
                        payload,
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                write_state(&self.state_dir, &state)?;
                return Ok(sequence);
            }
            if existing.payload != payload {
                return Err(ActorError::RequestConflict);
            }
            return state
                .events
                .iter()
                .rev()
                .find_map(|entry| match &entry.event {
                    AgentEvent::PermissionRequested {
                        decision_id: existing_id,
                        ..
                    } if existing_id == &decision_id => Some(entry.sequence),
                    _ => None,
                })
                .ok_or_else(|| ActorError::Persistence("decision event is missing".into()));
        }
        let prospective = JournalEvent {
            sequence: state.next_sequence,
            event: AgentEvent::PermissionRequested {
                decision_id: decision_id.clone(),
                payload: payload.clone(),
            },
        };
        let pending_ids = pending_decision_ids(&state);
        let protected_bytes = state
            .events
            .iter()
            .filter(|entry| event_is_pending_decision(entry, &pending_ids))
            .map(|entry| serde_json::to_vec(entry).map(|bytes| bytes.len()))
            .collect::<Result<Vec<_>, _>>()
            .map_err(persist)?
            .into_iter()
            .sum::<usize>();
        let prospective_bytes = serde_json::to_vec(&prospective).map_err(persist)?.len();
        if pending_ids.len() >= self.event_count_cap
            || protected_bytes.saturating_add(prospective_bytes) > self.event_byte_cap
        {
            return Err(ActorError::Persistence(
                "pending decision journal capacity exceeded".into(),
            ));
        }
        state.decisions.insert(
            decision_id.clone(),
            PersistedDecision {
                payload: payload.clone(),
                state: DecisionState::Pending,
                response_digest: None,
                operation_attempt_id: None,
            },
        );
        let sequence = push_event_bounded(
            &mut state,
            AgentEvent::PermissionRequested {
                decision_id,
                payload,
            },
            self.event_byte_cap,
            self.event_count_cap,
        )?;
        write_state(&self.state_dir, &state)?;
        Ok(sequence)
    }

    async fn record_retained_permission(&self, decision_id: &str) -> Result<(), ActorError> {
        // A reconnect/snapshot can expose a native control before the
        // asynchronous event pump journals it. Reconcile only on the user
        // command, from the existing live source; reads stay side-effect free.
        let before = self.profile().await;
        if before.provider != FreshProvider::Codex || !self.transport.is_live().await {
            return Ok(());
        }
        let Some(retained) = self
            .transport
            .retained_state()
            .await
            .map_err(ActorError::Transport)?
        else {
            return Ok(());
        };
        let after = self.profile().await;
        if before.native_session_id.is_none()
            || before.native_session_id != after.native_session_id
            || before.provider_store_id != after.provider_store_id
            || before.provider != after.provider
            || !self.transport.is_live().await
            || retained["snapshot"]["threadId"].as_str() != before.native_session_id.as_deref()
            || retained["snapshot"]["provider"] != "codex"
            || retained["snapshot"]["sessionType"] != "freshcodex"
        {
            return Ok(());
        }
        let Some(payload) = retained["pendingControls"].as_array().and_then(|pending| {
            pending.iter().find(|payload| {
                payload["requestId"].as_str() == Some(decision_id)
                    && payload["sessionId"].as_str() == before.native_session_id.as_deref()
                    && matches!(
                        payload["type"].as_str(),
                        Some(
                            "freshAgent.permission.request"
                                | "freshAgent.question.request"
                                | "freshAgent.elicitation.request"
                        )
                    )
            })
        }) else {
            return Ok(());
        };
        self.record_permission(decision_id.to_owned(), payload.clone())
            .await?;
        tracing::info!(
            provider = "codex",
            request_id = decision_id,
            native_session_id = before.native_session_id.as_deref(),
            "freshagent.host.control_admitted_from_retained"
        );
        Ok(())
    }

    pub async fn resolve_permission(
        &self,
        decision_id: &str,
        decision: Value,
    ) -> Result<(), ActorError> {
        self.resolve_permission_with_attempt_id(decision_id, decision, None)
            .await
    }

    pub async fn resolve_permission_with_attempt_id(
        &self,
        decision_id: &str,
        decision: Value,
        operation_attempt_id: Option<&str>,
    ) -> Result<(), ActorError> {
        if !self.state.lock().await.decisions.contains_key(decision_id) {
            self.record_retained_permission(decision_id).await?;
        }
        let response_digest = digest(&serde_json::to_vec(&decision).map_err(persist)?);
        {
            let mut state = self.state.lock().await;
            let pending = state
                .decisions
                .get_mut(decision_id)
                .ok_or(ActorError::UnknownDecision)?;
            match pending.state {
                DecisionState::Pending => {}
                DecisionState::Interrupted => return Err(ActorError::UnknownDecision),
                DecisionState::Resolved
                    if pending.response_digest.as_deref() == Some(&response_digest) =>
                {
                    return Ok(());
                }
                DecisionState::Resolved => return Err(ActorError::DecisionAlreadyResolved),
                DecisionState::Dispatching | DecisionState::Ambiguous => {
                    return Err(ActorError::AmbiguousDispatch);
                }
            }
            pending.state = DecisionState::Dispatching;
            pending.response_digest = Some(response_digest);
            pending.operation_attempt_id = operation_attempt_id.map(str::to_owned);
            self.prepare_claude_effect(&mut state, false).await?;
            if let Some(attempt_id) = operation_attempt_id {
                let event = control_attempt_event(
                    &state.profile,
                    decision_id,
                    attempt_id,
                    false,
                    Some((&state.journal_id, state.next_sequence)),
                );
                push_event_bounded(&mut state, event, self.event_byte_cap, self.event_count_cap)?;
            }
            write_state(&self.state_dir, &state)?;
        }
        let result = self
            .transport
            .resolve_permission_with_attempt_id(decision_id, decision, operation_attempt_id)
            .await;
        let mut state = self.state.lock().await;
        let pending = state
            .decisions
            .get_mut(decision_id)
            .expect("pending decision");
        if matches!(pending.state, DecisionState::Interrupted) {
            return Err(ActorError::UnknownDecision);
        }
        match result {
            Ok(()) => {
                pending.state = DecisionState::Resolved;
                push_event_bounded(
                    &mut state,
                    AgentEvent::DecisionResolved {
                        decision_id: decision_id.to_string(),
                    },
                    self.event_byte_cap,
                    self.event_count_cap,
                )?;
                write_state(&self.state_dir, &state)
            }
            Err(failure) => {
                pending.state = if failure.acceptance_ambiguous {
                    DecisionState::Ambiguous
                } else {
                    DecisionState::Pending
                };
                if failure.acceptance_ambiguous {
                    if let Some(attempt_id) = operation_attempt_id {
                        let event = control_attempt_event(
                            &state.profile,
                            decision_id,
                            attempt_id,
                            true,
                            None,
                        );
                        push_event_bounded(
                            &mut state,
                            event,
                            self.event_byte_cap,
                            self.event_count_cap,
                        )?;
                    }
                }
                write_state(&self.state_dir, &state)?;
                if failure.acceptance_ambiguous {
                    Err(ActorError::AmbiguousDispatch)
                } else {
                    Err(ActorError::Transport(failure.message))
                }
            }
        }
    }

    pub async fn read_events(&self, after: u64, max_events: usize) -> EventBatch {
        let mut batch = {
            let state = self.state.lock().await;
            let max_events = max_events.clamp(1, self.event_count_cap);
            let mut events: Vec<JournalEvent> = state.events.iter()
                .filter(|event| event.sequence > after)
                .filter(|event| !matches!(&event.event, AgentEvent::Started {native_session_id}
                    if state.profile.native_session_id.as_deref() != Some(native_session_id.as_str())))
                .take(max_events).cloned().collect();
            for entry in &mut events {
                let pending = match &entry.event {
                    AgentEvent::Provider { payload }
                        if payload["event"]["type"] == "freshAgent.operation.started" =>
                    {
                        let event = &payload["event"];
                        event["requestId"]
                            .as_str()
                            .and_then(|id| state.decisions.get(id))
                            .is_some_and(|decision| {
                                matches!(decision.state, DecisionState::Dispatching)
                                    && decision.operation_attempt_id.as_deref()
                                        == event["operationAttemptId"].as_str()
                            })
                    }
                    _ => false,
                };
                if pending {
                    if let AgentEvent::Provider { payload } = &mut entry.event {
                        payload["event"]["operationPending"] = serde_json::json!(true);
                    }
                }
            }
            EventBatch {
                retained_state: None,
                retained_from: state.retained_from,
                head: state.next_sequence.saturating_sub(1),
                reset_required: after.saturating_add(1) < state.retained_from,
                events,
            }
        };
        if after == 0 || batch.reset_required || batch.events.iter().any(|entry|
            matches!(&entry.event, AgentEvent::Provider { payload } if payload["event"]["type"] == "freshAgent.host.backpressure")) {
            batch.retained_state = match self.transport.retained_state().await {
                Ok(retained) => retained,
                Err(error) => {
                    tracing::warn!(%error, "freshagent.host.retained_read_failed");
                    None
                }
            };
        }
        batch
    }

    pub async fn interrupt(&self) -> Result<(), ActorError> {
        self.interrupt_with_request_id(None).await
    }

    pub async fn interrupt_with_request_id(
        &self,
        request_id: Option<&str>,
    ) -> Result<(), ActorError> {
        self.transport
            .interrupt_with_request_id(request_id)
            .await
            .map_err(ActorError::Transport)?;
        self.record_event(AgentEvent::Interrupted).await?;
        Ok(())
    }

    pub async fn is_live(&self) -> bool {
        !self.stopped.load(Ordering::SeqCst) && self.transport.is_live().await
    }

    /// Only the session host's supervisor-controlled stop path may call this.
    pub async fn stop(self: Arc<Self>) -> Result<(), ActorError> {
        self.stopped.store(true, Ordering::SeqCst);
        Arc::clone(&self.transport)
            .stop()
            .await
            .map_err(ActorError::Transport)
    }
}

fn new_actor_journal_id() -> String {
    RequestId::new().as_str().to_owned()
}

fn control_attempt_event(
    profile: &FreshAgentProfile,
    decision_id: &str,
    attempt_id: &str,
    uncertain: bool,
    journal: Option<(&str, u64)>,
) -> AgentEvent {
    let (provider, session_type) = match &profile.provider {
        FreshProvider::Claude => ("claude", "freshclaude"),
        FreshProvider::Kilroy => ("claude", "kilroy"),
        FreshProvider::Codex => ("codex", "freshcodex"),
        FreshProvider::Opencode => ("opencode", "freshopencode"),
    };
    let mut event = serde_json::json!({
        "type":if uncertain {"freshAgent.operation.error"} else {"freshAgent.operation.started"},
        "requestId":decision_id, "operationAttemptId":attempt_id, "operationReceipt":true,
    });
    if uncertain {
        event["code"] = serde_json::json!("COMMAND_AMBIGUOUS");
        event["message"] = serde_json::json!("Sending the answer could not be confirmed. Check the conversation before trying again.");
        event["operationFallback"] = serde_json::json!(true);
        event["operationOutcomeUncertain"] = serde_json::json!(true);
    }
    if let Some((journal_id, sequence)) = journal {
        event["operationJournalId"] = serde_json::json!(journal_id);
        event["operationJournalSequence"] = serde_json::json!(sequence);
    }
    AgentEvent::Provider {
        payload: serde_json::json!({
            "type":"freshAgent.event", "provider":provider, "sessionType":session_type,
            "sessionId":profile.native_session_id.as_deref().unwrap_or_default(), "event":event,
        }),
    }
}

fn push_event_bounded(
    state: &mut PersistedActorState,
    event: AgentEvent,
    byte_cap: usize,
    count_cap: usize,
) -> Result<u64, ActorError> {
    let sequence = state.next_sequence;
    state.next_sequence = state.next_sequence.saturating_add(1);
    let entry = JournalEvent { sequence, event };
    let bytes = serde_json::to_vec(&entry).map_err(persist)?.len();
    state.event_bytes = state.event_bytes.saturating_add(bytes);
    state.events.push_back(entry);
    while state.events.len() > count_cap || state.event_bytes > byte_cap {
        let pending_ids = pending_decision_ids(state);
        let Some(index) = state
            .events
            .iter()
            .position(|entry| !event_is_pending_decision(entry, &pending_ids))
        else {
            break;
        };
        let removed = state.events.remove(index).expect("event index exists");
        state.event_bytes = state
            .event_bytes
            .saturating_sub(serde_json::to_vec(&removed).map_err(persist)?.len());
        state.retained_from = removed.sequence.saturating_add(1);
    }
    Ok(sequence)
}

fn pending_decision_ids(state: &PersistedActorState) -> BTreeSet<String> {
    state
        .decisions
        .iter()
        .filter(|(_, decision)| matches!(decision.state, DecisionState::Pending))
        .map(|(decision_id, _)| decision_id.clone())
        .collect()
}

fn native_recovery_checkpoints(state: &PersistedActorState) -> Vec<Value> {
    state.decisions.values().filter(|decision|
        matches!(decision.state, DecisionState::Pending | DecisionState::Interrupted))
        .filter_map(|decision| {
            let binding = decision.payload.get("nativeBinding")?;
            let evidence = serde_json::json!({"launch":binding["launch"],"queryGeneration":binding["queryGeneration"],
                "nativeSessionId":state.profile.native_session_id,"nativeClear":binding["nativeClear"]});
            current_native_checkpoint(&decision.payload, state.profile.native_session_id.as_deref(), Some(&evidence))
        }).collect()
}

fn native_clear_matches_root(evidence: &Value, root: &str) -> bool {
    evidence["nativeSessionId"].as_str() == Some(root)
        && evidence["nativeClear"]["nativeSessionId"].as_str() == Some(root)
        && evidence["nativeClear"]["previousNativeSessionId"]
            .as_str()
            .is_some_and(|prior| {
                !prior.is_empty() && prior != root && !prior.chars().any(char::is_control)
            })
}

fn current_native_checkpoint(
    payload: &Value,
    root: Option<&str>,
    evidence: Option<&Value>,
) -> Option<Value> {
    let checkpoint = payload.get("nativeCheckpoint")?;
    let binding = payload.get("nativeBinding")?;
    let evidence = evidence?;
    let launch: NativeIdentityLaunch = serde_json::from_value(binding["launch"].clone()).ok()?;
    let current_launch: NativeIdentityLaunch =
        serde_json::from_value(evidence["launch"].clone()).ok()?;
    let native = root?;
    let tool = checkpoint["toolUseID"]
        .as_str()
        .filter(|tool| tool.starts_with("toolu_") && tool.len() > 6)?;
    let request = payload["nativeRequestId"]
        .as_str()
        .filter(|request| !request.is_empty())?;
    let generation = binding["queryGeneration"]
        .as_u64()
        .filter(|generation| *generation > 0)?;
    let hash = |value: &Value| {
        value.as_str().is_some_and(|value| {
            value.len() == 64
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    };
    if launch != current_launch
        || launch.execution_generation == 0
        || launch
            .requested_native_session_id
            .as_deref()
            .is_some_and(|root| root != native)
            && !(native_clear_matches_root(evidence, native)
                && binding["nativeClear"] == evidence["nativeClear"])
        || evidence["queryGeneration"].as_u64() != Some(generation)
        || binding["nativeRequestId"] != request
        || checkpoint["nativeSessionId"] != native
        || payload["toolUseID"] != tool
        || checkpoint["toolName"] != "Bash"
        || payload["tool"]["name"] != "Bash"
        || checkpoint["nativeVersion"] != "2.1.237"
        || !["inputDigest", "profileDigest", "checkpointDigest"]
            .iter()
            .all(|key| hash(&checkpoint[key]))
        || !["checkpointUuid", "assistantUuid"]
            .iter()
            .all(|key| checkpoint[key].as_str().is_some_and(|id| !id.is_empty()))
        || checkpoint["inputDigest"] != native_input_digest(&payload["tool"]["input"])?
    {
        return None;
    }
    Some(checkpoint.clone())
}

fn native_input_digest(input: &Value) -> Option<String> {
    // Match nativeInputDigest in native-session-channel.mjs exactly: recursive
    // UTF-16 key ordering and ECMAScript Number formatting both affect bytes.
    let mut canonical = String::new();
    write_native_input_json(input, &mut canonical)?;
    Some(digest(canonical.as_bytes()))
}

fn write_native_input_json(input: &Value, output: &mut String) -> Option<()> {
    match input {
        Value::Null => output.push_str("null"),
        Value::Bool(value) => output.push_str(if *value { "true" } else { "false" }),
        Value::String(value) => output.push_str(&serde_json::to_string(value).ok()?),
        Value::Number(value) => {
            let value = value.as_f64().filter(|value| value.is_finite())?;
            output.push_str(ryu_js::Buffer::new().format_finite(value));
        }
        Value::Array(values) => {
            output.push('[');
            for (index, value) in values.iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                write_native_input_json(value, output)?;
            }
            output.push(']');
        }
        Value::Object(values) => {
            let mut entries: Vec<_> = values.iter().collect();
            entries.sort_unstable_by(|(left, _), (right, _)| {
                left.encode_utf16().cmp(right.encode_utf16())
            });
            output.push('{');
            for (index, (key, value)) in entries.into_iter().enumerate() {
                if index > 0 {
                    output.push(',');
                }
                output.push_str(&serde_json::to_string(key).ok()?);
                output.push(':');
                write_native_input_json(value, output)?;
            }
            output.push('}');
        }
    }
    Some(())
}

fn event_is_pending_decision(entry: &JournalEvent, pending_ids: &BTreeSet<String>) -> bool {
    matches!(
        &entry.event,
        AgentEvent::PermissionRequested { decision_id, .. } if pending_ids.contains(decision_id)
    )
}

fn write_state(state_dir: &Path, state: &PersistedActorState) -> Result<(), ActorError> {
    let bytes = serde_json::to_vec(state).map_err(persist)?;
    atomic_write(&state_dir.join("fresh-agent-state.json"), &bytes)
}

fn write_protected_payload(
    state_dir: &Path,
    request_id: &RequestId,
    bytes: &[u8],
) -> Result<(), ActorError> {
    let dir = state_dir.join("fresh-agent-commands");
    fs::create_dir_all(&dir).map_err(persist)?;
    let name = digest(request_id.as_str().as_bytes());
    atomic_write(&dir.join(format!("{name}.input")), bytes)
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ActorError> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut options = OpenOptions::new();
    options.create(true).write(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).map_err(persist)?;
    file.write_all(bytes).map_err(persist)?;
    file.sync_all().map_err(persist)?;
    fs::rename(&tmp, path).map_err(persist)?;
    if let Some(parent) = path.parent() {
        File::open(parent)
            .and_then(|dir| dir.sync_all())
            .map_err(persist)?;
    }
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn fresh_agent_send_digest(
    text: &str,
    settings: &Option<FreshAgentTurnSettings>,
    logical_attempt_id: Option<&str>,
    codex_dispatch_recovery_source: Option<&NativeIdentityObservation>,
) -> Result<String, ActorError> {
    // Preserve the historical digest shape for legacy sends while including
    // all authority and checkpoint identity on newer recovery sends.
    let command_material = match codex_dispatch_recovery_source {
        Some(source) => serde_json::to_vec(&(text, settings, logical_attempt_id, source)),
        None => match logical_attempt_id {
            Some(logical_attempt_id) => serde_json::to_vec(&(text, settings, logical_attempt_id)),
            None => serde_json::to_vec(&(text, settings)),
        },
    }
    .map_err(persist)?;
    Ok(digest(&command_material))
}

fn persist(error: impl std::fmt::Display) -> ActorError {
    ActorError::Persistence(error.to_string())
}

#[cfg(test)]
#[path = "host_actor_tests.rs"]
mod tests;
