//! Immutable Freshell deployment generations and legacy bootstrap capture.

mod cli;
mod durable;
mod error;
mod legacy;
mod locks;
mod manifest;
mod paths;
mod process_identity;
mod receipts;
mod store;

pub use cli::{execute_capture, CaptureCommand};
pub use error::{DeployError, Result};
pub use legacy::{
    capture_legacy, LegacyCaptureReceipt, LegacyCaptureRequest, LegacyRuntimeSources,
    NodePrerequisite, NonSecretLaunchMetadata, RealScratchProbe, RuntimeBindings, ScratchProbe,
    ScratchProbeRequest,
};
pub use locks::DeploymentLock;
pub use manifest::{EntryKind, GenerationManifest, ManifestEntry};
pub use paths::{DeployPort, StorePaths};
pub use process_identity::{
    FileIdentity, LinuxProcfs, ListenerIdentity, PinnedProcess, ProcessIdentity, ProcessInspector,
};
pub use receipts::LiveReceipt;
pub use store::{Generation, GenerationStage, LockedStore, Store};
