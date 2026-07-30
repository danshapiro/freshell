use std::fs::{self, File, OpenOptions};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::PathBuf;

use crate::error::{DeployError, Result};
use crate::paths::StorePaths;

pub struct DeploymentLock {
    #[allow(dead_code)]
    file: File,
    path: PathBuf,
}

impl DeploymentLock {
    pub fn try_acquire(paths: &StorePaths) -> Result<Self> {
        let path = paths.lock_file().to_path_buf();
        match fs::symlink_metadata(&path) {
            Ok(metadata)
                if metadata.file_type().is_symlink()
                    || !metadata.is_file()
                    || metadata.uid() != unsafe { libc::geteuid() }
                    || metadata.mode() & 0o7777 != 0o600 =>
            {
                return Err(DeployError::UnsafeStorePath(path));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&path)?;
        let metadata = file.metadata()?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o7777 != 0o600
        {
            return Err(DeployError::UnsafeStorePath(path));
        }
        // SAFETY: `file` owns this valid descriptor for at least the lifetime
        // of the flock operation and the returned guard.
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if result != 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::EAGAIN)
                || error.raw_os_error() == Some(libc::EWOULDBLOCK)
            {
                return Err(DeployError::LockBusy(path));
            }
            return Err(error.into());
        }
        file.sync_all()?;
        File::open(paths.port_root())?.sync_all()?;
        Ok(Self { file, path })
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }
}
