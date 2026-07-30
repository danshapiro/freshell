use std::ffi::CString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{symlink, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use uuid::Uuid;

use crate::error::{DeployError, Result};

pub(crate) fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    atomic_write_with_sync(path, bytes, mode, sync_directory)
}

pub(crate) fn atomic_write_new(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    atomic_write_impl(path, bytes, mode, false, sync_directory)
}

fn atomic_write_with_sync(
    path: &Path,
    bytes: &[u8],
    mode: u32,
    sync_parent: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    atomic_write_impl(path, bytes, mode, true, sync_parent)
}

fn atomic_write_impl(
    path: &Path,
    bytes: &[u8],
    mode: u32,
    replace: bool,
    sync_parent: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| DeployError::UnsafeStorePath(path.to_path_buf()))?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(DeployError::UnsafeStorePath(path.to_path_buf()));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let temporary = temporary_path(path);
    let prepare_result: Result<()> = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(mode)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.set_permissions(fs::Permissions::from_mode(mode))?;
        file.sync_all()?;
        drop(file);
        if replace {
            fs::rename(&temporary, path)?;
        } else {
            rename_noreplace(&temporary, path)?;
        }
        Ok(())
    })();
    if prepare_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    prepare_result?;
    sync_parent(parent).map_err(|error| DeployError::StorageAmbiguous {
        operation: "atomic file parent sync",
        path: path.to_path_buf(),
        cause: error.to_string(),
    })
}

pub(crate) fn atomic_symlink(path: &Path, target: &Path) -> Result<()> {
    atomic_symlink_with_sync(path, target, sync_directory)
}

fn atomic_symlink_with_sync(
    path: &Path,
    target: &Path,
    sync_parent: impl FnOnce(&Path) -> Result<()>,
) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| DeployError::UnsafeStorePath(path.to_path_buf()))?;
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_symlink() => {
            return Err(DeployError::UnsafeStorePath(path.to_path_buf()));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let temporary = temporary_path(path);
    let prepare_result: Result<()> = (|| {
        symlink(target, &temporary)?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if prepare_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    prepare_result?;
    sync_parent(parent).map_err(|error| DeployError::StorageAmbiguous {
        operation: "atomic symlink parent sync",
        path: path.to_path_buf(),
        cause: error.to_string(),
    })
}

pub(crate) fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

pub(crate) fn rename_noreplace(source: &Path, destination: &Path) -> Result<()> {
    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|_| DeployError::UnsafeStorePath(source.to_path_buf()))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| DeployError::UnsafeStorePath(destination.to_path_buf()))?;
    // SAFETY: both C strings are NUL-terminated and remain alive for the
    // syscall. AT_FDCWD makes both paths relative to the current process just
    // as std::fs::rename would; callers pass absolute store paths.
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            destination.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error().into())
    }
}

pub(crate) fn temporary_path(destination: &Path) -> PathBuf {
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("publication");
    destination.with_file_name(format!(".{name}.tmp.{}", Uuid::new_v4()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_rename_file_sync_failure_is_distinct_and_leaves_reconcilable_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("receipt.json");

        let error = atomic_write_with_sync(&path, b"{\"ok\":true}\n", 0o600, |_| {
            Err(DeployError::Io(std::io::Error::other(
                "injected parent sync failure",
            )))
        })
        .unwrap_err();

        assert!(matches!(
            error,
            DeployError::StorageAmbiguous {
                operation: "atomic file parent sync",
                ..
            }
        ));
        assert_eq!(fs::read(&path).unwrap(), b"{\"ok\":true}\n");
    }

    #[test]
    fn post_rename_symlink_sync_failure_is_distinct_and_leaves_reconcilable_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("current");

        let error = atomic_symlink_with_sync(&path, Path::new("generations/id"), |_| {
            Err(DeployError::Io(std::io::Error::other(
                "injected parent sync failure",
            )))
        })
        .unwrap_err();

        assert!(matches!(
            error,
            DeployError::StorageAmbiguous {
                operation: "atomic symlink parent sync",
                ..
            }
        ));
        assert_eq!(fs::read_link(&path).unwrap(), Path::new("generations/id"));
    }
}
