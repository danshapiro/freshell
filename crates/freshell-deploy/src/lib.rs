//! Immutable Freshell deployment generations and legacy bootstrap capture.

mod activation;
mod cli;
mod durable;
mod error;
mod journal;
mod legacy;
mod locks;
mod manifest;
mod paths;
mod probe;
mod process_control;
mod process_identity;
mod receipts;
mod recovery;
mod rollback;
mod store;

pub use activation::{
    publish_activation_authorization, read_activation_receipt, ActivationController,
    ActivationDriver, ActivationProgress, ActivationReceiptObservation, ActivationRequest,
    PortState, ServiceState,
};
pub use cli::{execute_capture, CaptureCommand};
pub use error::{DeployError, Result};
pub use journal::{
    ControlPaths, DurableTransactionJournal, TransactionJournal, TransactionPhase,
    TransactionRecord, UpdateMode,
};
pub use legacy::{
    capture_legacy, LegacyCaptureReceipt, LegacyCaptureRequest, LegacyRuntimeSources,
    NodePrerequisite, NonSecretLaunchMetadata, RealScratchProbe, RuntimeBindings, ScratchProbe,
    ScratchProbeRequest,
};
pub use locks::DeploymentLock;
pub use manifest::{EntryKind, GenerationManifest, ManifestEntry};
pub use paths::{DeployPort, StorePaths};
pub use probe::{
    validate_client_only_entries, validate_compatibility_artifacts, CandidateEvidence,
    CompatibilityPair, DeploymentReadyReceipt, GenerationProbe, GenerationProbeRequest,
    GenerationProbeResult, ProbeBackend, ProbeCommand, ProbeCommandOutput, ProbeLaunch,
    RealProbeBackend,
};
pub use process_control::{LinuxPidfdBackend, PidfdBackend, Signal, StopPolicy, VerifiedProcess};
pub use process_identity::{
    FileIdentity, LinuxProcfs, ListenerIdentity, PinnedProcess, ProcessIdentity, ProcessInspector,
    RuntimeProvenance,
};
pub use receipts::LiveReceipt;
pub use recovery::RecoveryOutcome;
pub use store::{Generation, GenerationStage, LockedStore, Store};
