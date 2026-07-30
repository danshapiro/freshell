use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum DeployError {
    #[error("invalid deployment port: {0}")]
    InvalidPort(String),
    #[error("unsafe checkout root: {0}")]
    UnsafeCheckout(PathBuf),
    #[error("unsafe deployment store path: {0}")]
    UnsafeStorePath(PathBuf),
    #[error("unsafe relative generation path: {0}")]
    UnsafeRelativePath(PathBuf),
    #[error("invalid generation manifest: {0}")]
    InvalidManifest(String),
    #[error("generation already exists: {0}")]
    GenerationExists(String),
    #[error("generation does not exist: {0}")]
    GenerationMissing(String),
    #[error("generation digest mismatch for {path}")]
    DigestMismatch {
        path: PathBuf,
        expected: String,
        actual: String,
    },
    #[error("generation mode mismatch for {path}: expected {expected:o}, got {actual:o}")]
    ModeMismatch {
        path: PathBuf,
        expected: u32,
        actual: u32,
    },
    #[error("generation entry type mismatch for {0}")]
    TypeMismatch(PathBuf),
    #[error("generation symlink target mismatch for {0}")]
    SymlinkTargetMismatch(PathBuf),
    #[error("refusing to clean unmanifested path: {0}")]
    UnmanifestedPath(PathBuf),
    #[error("deployment lock is already held: {0}")]
    LockBusy(PathBuf),
    #[error("invalid live receipt: {0}")]
    InvalidReceipt(String),
    #[error("cannot remove the selected generation: {0}")]
    SelectedGeneration(String),
    #[error("cannot remove the still-running server generation: {0}")]
    RunningGeneration(String),
    #[error("cannot remove the legacy recovery generation: {0}")]
    LegacyGeneration(String),
    #[error("cannot remove a generation retained by an unfinished transaction: {0}")]
    TransactionGeneration(String),
    #[error("storage state is ambiguous after {operation} at {path}: {cause}")]
    StorageAmbiguous {
        operation: &'static str,
        path: PathBuf,
        cause: String,
    },
    #[error("process identity could not be proven: {0}")]
    ProcessIdentity(String),
    #[error("pidfd process control failed closed: {0}")]
    ProcessControl(String),
    #[error("deployment probe failed: {0}")]
    Probe(String),
    #[error("deployment transaction journal is invalid: {0}")]
    Journal(String),
    #[error("deployment activation failed closed: {0}")]
    Activation(String),
    #[error("deployment recovery failed closed: {0}")]
    Recovery(String),
    #[error("legacy capture failed: {0}")]
    LegacyCapture(String),
    #[error("{0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, DeployError>;
