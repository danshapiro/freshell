use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::durable::{atomic_write, atomic_write_new, sync_directory};
use crate::error::{DeployError, Result};
use crate::journal::LaunchClaim;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum LaunchAttemptReceipt {
    Owned { claim: LaunchClaim },
    DefinitelyNotStarted { claim: LaunchClaim },
}

impl LaunchAttemptReceipt {
    fn claim(&self) -> &LaunchClaim {
        match self {
            Self::Owned { claim } | Self::DefinitelyNotStarted { claim } => claim,
        }
    }

    fn to_json(&self) -> Result<Vec<u8>> {
        let mut bytes =
            serde_json::to_vec(self).map_err(|error| DeployError::Journal(error.to_string()))?;
        bytes.push(b'\n');
        Ok(bytes)
    }
}

#[derive(Debug, Clone)]
pub struct LaunchAttemptReceiptStore {
    path: PathBuf,
}

impl LaunchAttemptReceiptStore {
    pub fn new(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        if !path.is_absolute()
            || path == Path::new("/")
            || path.components().any(|component| {
                matches!(
                    component,
                    Component::CurDir | Component::ParentDir | Component::Prefix(_)
                )
            })
        {
            return Err(DeployError::Journal(
                "launch receipt path must be absolute and normalized".to_string(),
            ));
        }
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    pub fn read(&self) -> Result<Option<LaunchAttemptReceipt>> {
        let mut file = match fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&self.path)
        {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o7777 != 0o600
        {
            return Err(DeployError::Journal(
                "launch receipt is not an owned private regular file".to_string(),
            ));
        }
        file.sync_all()?;
        let mut bytes = Vec::new();
        file.read_to_end(&mut bytes)?;
        sync_directory(
            self.path
                .parent()
                .expect("validated absolute receipt has a parent"),
        )?;
        let receipt: LaunchAttemptReceipt = serde_json::from_slice(&bytes)
            .map_err(|error| DeployError::Journal(format!("invalid launch receipt: {error}")))?;
        self.validate(&receipt)?;
        Ok(Some(receipt))
    }

    pub fn claim(&self, claim: &LaunchClaim) -> Result<LaunchAttemptReceipt> {
        let intended = LaunchAttemptReceipt::Owned {
            claim: claim.clone(),
        };
        self.validate(&intended)?;
        match atomic_write_new(&self.path, &intended.to_json()?, 0o600) {
            Ok(()) => Ok(intended),
            Err(DeployError::Io(error))
                if matches!(
                    error.raw_os_error(),
                    Some(libc::EEXIST) | Some(libc::ENOTEMPTY)
                ) =>
            {
                self.read()?.ok_or_else(|| {
                    DeployError::Journal(
                        "launch claim raced but no durable winner is readable".to_string(),
                    )
                })
            }
            Err(error) => {
                if let Some(existing) = self.read()? {
                    Ok(existing)
                } else {
                    Err(error)
                }
            }
        }
    }

    pub fn mark_definitely_not_started(&self, claim: &LaunchClaim) -> Result<LaunchAttemptReceipt> {
        let existing = self.read()?.ok_or_else(|| {
            DeployError::Journal("cannot resolve a missing launch ownership receipt".to_string())
        })?;
        match existing {
            LaunchAttemptReceipt::DefinitelyNotStarted {
                claim: existing_claim,
            } if existing_claim == *claim => Ok(LaunchAttemptReceipt::DefinitelyNotStarted {
                claim: existing_claim,
            }),
            LaunchAttemptReceipt::Owned {
                claim: existing_claim,
            } if existing_claim == *claim => {
                let terminal = LaunchAttemptReceipt::DefinitelyNotStarted {
                    claim: claim.clone(),
                };
                atomic_write(&self.path, &terminal.to_json()?, 0o600)?;
                Ok(terminal)
            }
            _ => Err(DeployError::Journal(
                "only the exact durable launch owner can publish a terminal outcome".to_string(),
            )),
        }
    }

    fn validate(&self, receipt: &LaunchAttemptReceipt) -> Result<()> {
        let claim = receipt.claim();
        crate::receipts::validate_generation_id(&claim.generation_id)?;
        if claim.schema_version != "1"
            || claim.claim_id.is_empty()
            || claim.claim_id.contains('/')
            || claim.transaction_id.is_empty()
            || claim.nonce.is_empty()
            || claim.attempt_id.is_empty()
            || claim.receipt_file != self.path
            || claim.executor.pid == 0
            || claim.executor.kernel_boot_id.is_empty()
            || claim.executor.start_time_ticks.is_empty()
            || !claim
                .executor
                .start_time_ticks
                .bytes()
                .all(|byte| byte.is_ascii_digit())
            || !Path::new(&claim.executor.cwd).is_absolute()
            || claim.executor.effective_uid != unsafe { libc::geteuid() }
        {
            return Err(DeployError::Journal(
                "launch receipt is not completely bound to its owner and path".to_string(),
            ));
        }
        Ok(())
    }
}
