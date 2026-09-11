//! Transfer the trusted fresh-agent command and approval journal between
//! exact managed-runtime incarnations.
//!
//! Provider-native state lives in the per-soul provider volume. This module
//! deliberately copies only the host-owned actor state after the prior
//! enclosure has been verified empty and before the replacement starts.

use freshell_runtime_protocol::{RuntimeError, RuntimeErrorCode};
use std::{
    ffi::OsStr,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::Path,
};

const CONTROL_STATE_DIR: &str = "fresh-agent";
const WRITER_LOCK: &str = "fresh-agent-writer.lock";
const MAX_BYTES: u64 = 128 * 1024 * 1024;
const MAX_ENTRIES: usize = 16_384;
const MAX_DEPTH: usize = 32;

#[derive(Debug, Clone, Copy)]
struct CopyLimits {
    bytes: u64,
    entries: usize,
    depth: usize,
}

impl Default for CopyLimits {
    fn default() -> Self {
        Self {
            bytes: MAX_BYTES,
            entries: MAX_ENTRIES,
            depth: MAX_DEPTH,
        }
    }
}

#[derive(Debug)]
struct CopyBudget {
    limits: CopyLimits,
    bytes: u64,
    entries: usize,
}

impl CopyBudget {
    fn new(limits: CopyLimits) -> Self {
        Self {
            limits,
            bytes: 0,
            entries: 1,
        }
    }

    fn add_entry(&mut self) -> Result<(), RuntimeError> {
        self.entries = self
            .entries
            .checked_add(1)
            .ok_or_else(|| state_error("fresh-agent control state entry count overflow"))?;
        if self.entries > self.limits.entries {
            return Err(state_error(
                "fresh-agent control state exceeds the entry bound",
            ));
        }
        Ok(())
    }

    fn add_file(&mut self, length: u64) -> Result<(), RuntimeError> {
        self.bytes = self
            .bytes
            .checked_add(length)
            .ok_or_else(|| state_error("fresh-agent control state size overflow"))?;
        if self.bytes > self.limits.bytes {
            return Err(state_error(
                "fresh-agent control state exceeds the byte bound",
            ));
        }
        Ok(())
    }
}

/// Copy the protected actor state into a newly allocated incarnation runtime
/// directory. Returns `false` only when the prior state does not exist.
pub(crate) fn copy_protected_fresh_agent_state(
    prior_runtime_dir: &Path,
    replacement_runtime_dir: &Path,
) -> Result<bool, RuntimeError> {
    copy_with_limits(
        prior_runtime_dir,
        replacement_runtime_dir,
        CopyLimits::default(),
    )
}

fn copy_with_limits(
    prior_runtime_dir: &Path,
    replacement_runtime_dir: &Path,
    limits: CopyLimits,
) -> Result<bool, RuntimeError> {
    require_real_directory(prior_runtime_dir, "prior incarnation runtime directory")?;
    require_real_directory(
        replacement_runtime_dir,
        "replacement incarnation runtime directory",
    )?;

    let source = prior_runtime_dir.join(CONTROL_STATE_DIR);
    let source_metadata = match fs::symlink_metadata(&source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(io_error("inspect prior actor state", error)),
    };
    if source_metadata.file_type().is_symlink() || !source_metadata.is_dir() {
        return Err(state_error(
            "prior fresh-agent control state is not a private directory",
        ));
    }

    let target = replacement_runtime_dir.join(CONTROL_STATE_DIR);
    match fs::symlink_metadata(&target) {
        Ok(_) => {
            return Err(state_error(
                "replacement fresh-agent control state already exists",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("inspect replacement actor state", error)),
    }

    fs::create_dir(&target).map_err(|error| io_error("create actor state", error))?;
    set_private_directory_mode(&target).map_err(|error| io_error("protect actor state", error))?;
    let mut budget = CopyBudget::new(limits);
    if let Err(error) = copy_directory(&source, &target, 0, &mut budget) {
        let _ = fs::remove_dir_all(&target);
        let _ = sync_directory(replacement_runtime_dir);
        return Err(error);
    }
    sync_directory(&target).map_err(|error| io_error("sync actor state", error))?;
    sync_directory(replacement_runtime_dir)
        .map_err(|error| io_error("sync replacement runtime directory", error))?;
    Ok(true)
}

fn copy_directory(
    source: &Path,
    target: &Path,
    depth: usize,
    budget: &mut CopyBudget,
) -> Result<(), RuntimeError> {
    if depth >= budget.limits.depth {
        return Err(state_error(
            "fresh-agent control state exceeds the directory depth bound",
        ));
    }

    // Stream entries so a hostile or corrupted directory cannot allocate an
    // unbounded Vec before the entry limit is enforced.
    let children = fs::read_dir(source).map_err(|error| io_error("read actor state", error))?;
    for child in children {
        let child = child.map_err(|error| io_error("read actor state entry", error))?;
        budget.add_entry()?;
        let name = child.file_name();
        if depth == 0 && name == OsStr::new(WRITER_LOCK) {
            continue;
        }
        let source_path = child.path();
        if source_path
            .extension()
            .and_then(OsStr::to_str)
            .is_some_and(|extension| extension.starts_with("tmp-"))
        {
            continue;
        }

        let target_path = target.join(&name);
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|error| io_error("inspect actor state entry", error))?;
        if metadata.file_type().is_symlink() {
            return Err(state_error(
                "fresh-agent control state contains a symbolic link",
            ));
        }
        if metadata.is_dir() {
            fs::create_dir(&target_path)
                .map_err(|error| io_error("create actor state directory", error))?;
            set_private_directory_mode(&target_path)
                .map_err(|error| io_error("protect actor state directory", error))?;
            copy_directory(&source_path, &target_path, depth + 1, budget)?;
            sync_directory(&target_path)
                .map_err(|error| io_error("sync actor state directory", error))?;
            continue;
        }
        if !metadata.is_file() {
            return Err(state_error(
                "fresh-agent control state contains a special file",
            ));
        }
        budget.add_file(metadata.len())?;
        copy_private_regular_file(&source_path, &target_path, metadata.len())?;
    }
    Ok(())
}

fn copy_private_regular_file(
    source: &Path,
    target: &Path,
    expected_len: u64,
) -> Result<(), RuntimeError> {
    let mut source_options = OpenOptions::new();
    source_options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        source_options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut input = source_options
        .open(source)
        .map_err(|error| io_error("open actor state file", error))?;
    let opened = input
        .metadata()
        .map_err(|error| io_error("inspect opened actor state file", error))?;
    if !opened.is_file() || opened.len() != expected_len {
        return Err(state_error("fresh-agent control state changed during copy"));
    }

    let mut target_options = OpenOptions::new();
    target_options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        target_options.mode(0o600);
    }
    let mut output = target_options
        .open(target)
        .map_err(|error| io_error("create actor state file", error))?;
    let copied = io::copy(
        &mut Read::by_ref(&mut input).take(expected_len + 1),
        &mut output,
    )
    .map_err(|error| io_error("copy actor state file", error))?;
    if copied != expected_len {
        return Err(state_error("fresh-agent control state changed during copy"));
    }
    output
        .flush()
        .and_then(|_| output.sync_all())
        .map_err(|error| io_error("sync actor state file", error))
}

fn require_real_directory(path: &Path, label: &'static str) -> Result<(), RuntimeError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| io_error(label, error))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(state_error(&format!("{label} is not a real directory")));
    }
    Ok(())
}

fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

fn io_error(operation: &'static str, error: io::Error) -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::RegistryFailure,
        format!("{operation}: {error}"),
    )
}

fn state_error(message: &str) -> RuntimeError {
    RuntimeError::new(RuntimeErrorCode::RegistryFailure, message)
}

#[cfg(unix)]
fn set_private_directory_mode(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn set_private_directory_mode(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_exact_state_and_omits_ephemeral_lock_and_temp_files() {
        #[cfg(unix)]
        use std::os::unix::fs::PermissionsExt;

        let root = tempfile::tempdir().unwrap();
        let prior = root.path().join("prior");
        let replacement = root.path().join("replacement");
        let source = prior.join(CONTROL_STATE_DIR);
        fs::create_dir_all(source.join("fresh-agent-commands")).unwrap();
        fs::create_dir_all(&replacement).unwrap();
        fs::write(
            source.join("fresh-agent-state.json"),
            b"durable actor state",
        )
        .unwrap();
        fs::write(
            source.join("fresh-agent-commands/abc.input"),
            b"protected input",
        )
        .unwrap();
        fs::write(source.join(WRITER_LOCK), b"stale lock").unwrap();
        fs::write(source.join("fresh-agent-state.tmp-dead"), b"partial").unwrap();

        assert!(copy_protected_fresh_agent_state(&prior, &replacement).unwrap());
        assert_eq!(
            fs::read(replacement.join("fresh-agent/fresh-agent-state.json")).unwrap(),
            b"durable actor state",
        );
        assert_eq!(
            fs::read(replacement.join("fresh-agent/fresh-agent-commands/abc.input")).unwrap(),
            b"protected input",
        );
        assert!(!replacement.join("fresh-agent").join(WRITER_LOCK).exists());
        assert!(!replacement
            .join("fresh-agent/fresh-agent-state.tmp-dead")
            .exists());
        #[cfg(unix)]
        {
            assert_eq!(
                fs::metadata(replacement.join("fresh-agent"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o700,
            );
            assert_eq!(
                fs::metadata(replacement.join("fresh-agent/fresh-agent-state.json"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600,
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn rejects_links_special_files_parent_links_and_overwrite() {
        use std::os::unix::fs::symlink;

        let root = tempfile::tempdir().unwrap();
        let prior = root.path().join("prior");
        let replacement = root.path().join("replacement");
        let source = prior.join(CONTROL_STATE_DIR);
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&replacement).unwrap();
        fs::write(root.path().join("outside"), b"outside").unwrap();
        symlink(root.path().join("outside"), source.join("escape")).unwrap();
        assert!(copy_protected_fresh_agent_state(&prior, &replacement).is_err());
        assert!(!replacement.join(CONTROL_STATE_DIR).exists());

        fs::remove_file(source.join("escape")).unwrap();
        fs::create_dir_all(replacement.join(CONTROL_STATE_DIR)).unwrap();
        assert!(copy_protected_fresh_agent_state(&prior, &replacement).is_err());
        fs::remove_dir(replacement.join(CONTROL_STATE_DIR)).unwrap();

        let linked_replacement = root.path().join("replacement-link");
        symlink(&replacement, &linked_replacement).unwrap();
        assert!(copy_protected_fresh_agent_state(&prior, &linked_replacement).is_err());

        let fifo = source.join("special");
        let status = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(status.success());
        assert!(copy_protected_fresh_agent_state(&prior, &replacement).is_err());
    }

    #[test]
    fn absence_is_valid_but_byte_entry_and_depth_limits_are_enforced() {
        let root = tempfile::tempdir().unwrap();
        let absent = root.path().join("absent");
        let replacement = root.path().join("replacement");
        fs::create_dir_all(&absent).unwrap();
        fs::create_dir_all(&replacement).unwrap();
        assert!(!copy_protected_fresh_agent_state(&absent, &replacement).unwrap());

        let prior = root.path().join("prior");
        let source = prior.join(CONTROL_STATE_DIR);
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("one"), b"12").unwrap();
        assert!(copy_with_limits(
            &prior,
            &replacement,
            CopyLimits {
                bytes: 1,
                entries: 10,
                depth: 10,
            },
        )
        .is_err());
        assert!(!replacement.join(CONTROL_STATE_DIR).exists());

        fs::write(source.join("two"), b"x").unwrap();
        assert!(copy_with_limits(
            &prior,
            &replacement,
            CopyLimits {
                bytes: 10,
                entries: 2,
                depth: 10,
            },
        )
        .is_err());
        assert!(!replacement.join(CONTROL_STATE_DIR).exists());

        fs::create_dir(source.join("nested")).unwrap();
        assert!(copy_with_limits(
            &prior,
            &replacement,
            CopyLimits {
                bytes: 10,
                entries: 10,
                depth: 1,
            },
        )
        .is_err());
        assert!(!replacement.join(CONTROL_STATE_DIR).exists());
    }
}
