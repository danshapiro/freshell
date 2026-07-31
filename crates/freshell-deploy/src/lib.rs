//! Immutable Freshell deployment generations and legacy bootstrap capture.

mod activation;
mod bounded_http;
mod cli;
mod controller;
mod controller_command;
mod deployment;
mod durable;
mod error;
mod journal;
mod launch_receipt;
mod legacy;
mod lifecycle;
mod locks;
mod manifest;
mod paths;
mod probe;
mod process_containment;
mod process_control;
mod process_identity;
mod production_env;
mod real_driver;
mod receipts;
mod recovery;
mod rollback;
mod sandbox_interrupt;
mod store;

pub use activation::{
    publish_activation_authorization, publish_activation_cancellation, read_activation_receipt,
    read_cancellation_receipt, ActivationController, ActivationDriver, ActivationProgress,
    ActivationReceiptObservation, ActivationRequest, CancellationReceiptObservation,
    LaunchAttemptObservation, LaunchSpec, PortState, ServiceState,
};
pub use cli::{execute_capture, CaptureCommand};
pub use controller::{execute_controller, inspect_bootstrap_status, BootstrapStatus};
pub use controller_command::{ControllerCommand, DeployCommand, ServerAssemblySources};
pub use deployment::{assemble_generation, GenerationDescriptor};
pub use error::{DeployError, Result};
pub use journal::{
    ControlPaths, DurableTransactionJournal, LaunchAttempt, LaunchAttemptState, LaunchClaim,
    LaunchExecutorIdentity, LaunchLane, TransactionJournal, TransactionPhase, TransactionRecord,
    UpdateMode,
};
pub use launch_receipt::{LaunchAttemptReceipt, LaunchAttemptReceiptStore};
pub use legacy::{
    capture_legacy, LegacyCaptureReceipt, LegacyCaptureRequest, LegacyRuntimeSources,
    NodePrerequisite, NonSecretLaunchMetadata, RealScratchProbe, RuntimeBindings, ScratchProbe,
    ScratchProbeRequest,
};
pub use lifecycle::execute_lifecycle_launch_helper;
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
pub use real_driver::{execute_launch_helper, RealActivationDriver};
pub use receipts::LiveReceipt;
pub use recovery::RecoveryOutcome;
pub use store::{Generation, GenerationStage, LockedStore, Store};
