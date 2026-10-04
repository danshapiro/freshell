//! Durable, private staging for bounded OpenCode history bundles.
//!
//! Staging stores only the exact files described by the transfer descriptor.
//! It never accepts a caller-selected path, and it does not expose a bundle
//! until every file and the bundle digest have been revalidated.

use freshell_runtime_protocol::{
    opencode_transfer_bundle_digest, valid_opencode_transfer_attempt_id, OpenCodeTransferChunk,
    OpenCodeTransferDescriptor, OpenCodeTransferFile, MAX_OPENCODE_TRANSFER_CHUNK_BYTES,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};

const TRANSFER_ROOT_MODE: u32 = 0o700;
const PRIVATE_FILE_MODE: u32 = 0o600;
const READY_FILE_MODE: u32 = 0o400;
const READY_DIR_MODE: u32 = 0o500;
const PARTIAL_ACTIVITY_FILE: &str = ".activity";
const PARTIAL_ATTEMPT_FILE: &str = ".attempt";
/// A partial transfer with no durable progress for an hour is abandoned.
/// Normal retries resume it before this lease expires; failed live requests
/// also send Abort, leaving this as the process-crash fallback.
const ABANDONED_PARTIAL_AGE: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StagingLimits {
    pub max_bundle_bytes: u64,
    pub max_total_bytes: u64,
}

impl StagingLimits {
    pub const fn production() -> Self {
        Self {
            max_bundle_bytes: 8 * 1024 * 1024 * 1024,
            max_total_bytes: 16 * 1024 * 1024 * 1024,
        }
    }

    #[cfg(test)]
    pub const fn for_test(max_bundle_bytes: u64, max_total_bytes: u64) -> Self {
        Self {
            max_bundle_bytes,
            max_total_bytes,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StagingStart {
    Started {
        next_sequence: u64,
        file_offsets: Vec<freshell_runtime_protocol::OpenCodeTransferFileOffset>,
    },
    Queued,
}

#[derive(Debug, thiserror::Error)]
pub enum StagingError {
    #[error("transfer descriptor rejected: {0}")]
    InvalidDescriptor(String),
    #[error("transfer staging state is invalid: {0}")]
    InvalidState(String),
    #[error("transfer staging quota or available space is insufficient: {0}")]
    Capacity(String),
    #[error("transfer staging I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("transfer staging metadata is invalid: {0}")]
    Metadata(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StagingMetadata {
    descriptor: OpenCodeTransferDescriptor,
}

/// Owns a persistent private spool rooted beneath the supervisor runtime root.
pub struct OpenCodeTransferStaging {
    root: PathBuf,
    limits: StagingLimits,
    lock: Mutex<()>,
}

impl OpenCodeTransferStaging {
    pub fn new(root: impl AsRef<Path>, limits: StagingLimits) -> Result<Self, StagingError> {
        let root = root.as_ref().join("opencode-transfers");
        if root.exists() {
            let metadata = fs::symlink_metadata(&root)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StagingError::InvalidState(
                    "transfer root must be a real directory".into(),
                ));
            }
            let canonical = fs::canonicalize(&root)?;
            if canonical != root {
                return Err(StagingError::InvalidState(
                    "transfer root escaped the runtime root".into(),
                ));
            }
            if metadata.permissions().mode() & 0o777 != TRANSFER_ROOT_MODE {
                return Err(StagingError::InvalidState(
                    "transfer root permissions changed".into(),
                ));
            }
        } else {
            fs::create_dir_all(&root)?;
            fs::set_permissions(&root, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
            sync_parent(&root)?;
        }
        Ok(Self {
            root,
            limits,
            lock: Mutex::new(()),
        })
    }

    pub fn available_space_bytes(&self) -> Result<u64, StagingError> {
        let mut stats = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
        let path = std::ffi::CString::new(self.root.as_os_str().as_encoded_bytes())
            .map_err(|_| StagingError::InvalidState("invalid staging path".into()))?;
        let result = unsafe { libc::statvfs(path.as_ptr(), stats.as_mut_ptr()) };
        if result != 0 {
            return Err(StagingError::Io(std::io::Error::last_os_error()));
        }
        let stats = unsafe { stats.assume_init() };
        Ok(statvfs_available_bytes(&stats))
    }

    /// Begin or resume staging. `available_bytes` is measured by the
    /// supervisor from the filesystem that owns this spool; tests inject it.
    pub fn begin(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
        attempt_id: &str,
        available_bytes: u64,
    ) -> Result<StagingStart, StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        validate_attempt_id(attempt_id)?;
        descriptor
            .validate()
            .map_err(|error| StagingError::InvalidDescriptor(error.message))?;
        if descriptor.total_bytes > self.limits.max_bundle_bytes {
            return Err(StagingError::Capacity(
                "bundle exceeds the configured per-bundle limit".into(),
            ));
        }
        self.reclaim_stale_partials_unlocked(SystemTime::now())?;
        let partial = self.partial_path(&descriptor.transfer_id);
        let queued = self.queued_path(&descriptor.transfer_id);
        let ready = self.ready_path(&descriptor.transfer_id);
        if ready.exists() {
            let existing = self.read_descriptor(&ready)?;
            ensure_same_descriptor(&existing, descriptor)?;
            self.verify_ready_unlocked(descriptor)?;
            return Ok(StagingStart::Started {
                next_sequence: total_chunks(&descriptor.files),
                file_offsets: complete_offsets(&descriptor.files),
            });
        }
        if partial.exists() || queued.exists() {
            let existing_dir = if partial.exists() { &partial } else { &queued };
            let existing = if partial.exists() {
                self.recover_partial_initialization(existing_dir, descriptor)?
            } else {
                self.read_descriptor(existing_dir)?
            };
            ensure_same_descriptor(&existing, descriptor)?;
            // Claim this resume attempt before changing the queued/partial
            // state. Its failure path can then clean up with this same token,
            // and every superseded request is fenced as soon as Begin holds
            // the staging mutex.
            write_attempt_owner(existing_dir, attempt_id)?;
            if queued.exists() {
                if !self.has_capacity(descriptor.total_bytes)? {
                    return Ok(StagingStart::Queued);
                }
                if available_bytes < descriptor.total_bytes {
                    return Err(StagingError::Capacity(
                        "filesystem free space is below the remaining bundle size".into(),
                    ));
                }
                fs::rename(&queued, &partial)?;
                fs::set_permissions(&partial, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
                self.create_partial_files(&partial, descriptor)?;
                sync_parent(&partial)?;
            } else {
                self.create_partial_files(&partial, descriptor)?;
                let required = self.remaining_bytes(descriptor, &partial)?;
                if available_bytes < required {
                    return Err(StagingError::Capacity(
                        "filesystem free space is below the remaining bundle size".into(),
                    ));
                }
            }
            let resumed = self.resume_offsets(descriptor, &partial)?;
            record_partial_activity(&partial, SystemTime::now())?;
            return Ok(resumed);
        }

        if available_bytes < descriptor.total_bytes {
            return Err(StagingError::Capacity(
                "filesystem free space is below the bundle size".into(),
            ));
        }

        if !self.has_capacity(descriptor.total_bytes)? {
            fs::create_dir(&queued)?;
            fs::set_permissions(&queued, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
            self.write_descriptor(&queued, descriptor)?;
            write_attempt_owner(&queued, attempt_id)?;
            sync_parent(&queued)?;
            return Ok(StagingStart::Queued);
        }

        fs::create_dir(&partial)?;
        fs::set_permissions(&partial, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
        sync_parent(&partial)?;
        self.write_descriptor(&partial, descriptor)?;
        for file in &descriptor.files {
            let path = part_file(&partial, file.index);
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(PRIVATE_FILE_MODE)
                .open(path)?
                .sync_all()?;
        }
        File::open(&partial)?.sync_all()?;
        sync_parent(&partial)?;
        write_attempt_owner(&partial, attempt_id)?;
        record_partial_activity(&partial, SystemTime::now())?;
        Ok(StagingStart::Started {
            next_sequence: 0,
            file_offsets: descriptor
                .files
                .iter()
                .map(
                    |file| freshell_runtime_protocol::OpenCodeTransferFileOffset {
                        file_index: file.index,
                        next_offset: 0,
                    },
                )
                .collect(),
        })
    }

    pub fn write_chunk(&self, chunk: &OpenCodeTransferChunk) -> Result<(), StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        chunk
            .validate()
            .map_err(|error| StagingError::InvalidDescriptor(error.message))?;
        let partial = self.partial_path(&chunk.transfer_id);
        if !partial.is_dir() {
            return Err(StagingError::InvalidState(
                "transfer is not in a writable staging state".into(),
            ));
        }
        require_attempt_owner(&partial, &chunk.attempt_id)?;
        let descriptor = self.read_descriptor(&partial)?;
        let coordinates = chunk_coordinates(&descriptor.files);
        let (file, offset, size) = coordinates
            .get(chunk.sequence as usize)
            .ok_or_else(|| StagingError::InvalidState("chunk sequence is outside bundle".into()))?;
        if *file != chunk.file_index || *offset != chunk.offset || *size != chunk.data.len() as u64
        {
            return Err(StagingError::InvalidState(
                "chunk does not match canonical file order, offset, or bounded size".into(),
            ));
        }

        let next_sequence = self.recover_next_sequence(&descriptor, &partial)?;
        if chunk.sequence < next_sequence {
            let path = staged_file(&partial, chunk.file_index)?;
            let mut existing = File::open(path)?;
            existing.seek(SeekFrom::Start(chunk.offset))?;
            let mut previous = vec![0; chunk.data.len()];
            existing.read_exact(&mut previous)?;
            if previous != chunk.data {
                return Err(StagingError::InvalidState(
                    "retried chunk conflicts with durable staged bytes".into(),
                ));
            }
            record_partial_activity(&partial, SystemTime::now())?;
            return Ok(());
        }
        if chunk.sequence != next_sequence {
            return Err(StagingError::InvalidState("chunk is out of order".into()));
        }

        let path = part_file(&partial, chunk.file_index);
        let mut output = OpenOptions::new().append(true).open(&path)?;
        if output.metadata()?.len() != chunk.offset {
            return Err(StagingError::InvalidState(
                "staged file offset does not match the next chunk".into(),
            ));
        }
        output.write_all(&chunk.data)?;
        output.sync_all()?;
        sync_parent(&path)?;
        record_partial_activity(&partial, SystemTime::now())?;
        Ok(())
    }

    pub fn finalize(&self, transfer_id: &str, attempt_id: &str) -> Result<PathBuf, StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        validate_attempt_id(attempt_id)?;
        let partial = self.partial_path(transfer_id);
        let ready = self.ready_path(transfer_id);
        if ready.exists() {
            let descriptor = self.read_descriptor(&ready)?;
            self.verify_ready_unlocked(&descriptor)?;
            return Ok(ready);
        }
        if !partial.is_dir() {
            return Err(StagingError::InvalidState(
                "transfer is not in a writable staging state".into(),
            ));
        }
        require_attempt_owner(&partial, attempt_id)?;
        let descriptor = self.read_descriptor(&partial)?;
        self.recover_next_sequence(&descriptor, &partial)?;
        for file in &descriptor.files {
            let source = staged_file(&partial, file.index)?;
            verify_file(&source, file)?;
        }
        if descriptor.bundle_sha256
            != opencode_transfer_bundle_digest(&descriptor.manifest_json, &descriptor.files)
        {
            return Err(StagingError::InvalidState(
                "bundle metadata digest does not match".into(),
            ));
        }

        for file in &descriptor.files {
            let source = part_file(&partial, file.index);
            let target = ready_file(&partial, file.index);
            if source.exists() {
                fs::rename(&source, &target)?;
            } else {
                let metadata = fs::symlink_metadata(&target)?;
                if metadata.file_type().is_symlink()
                    || !metadata.is_file()
                    || metadata.len() != file.size_bytes
                {
                    return Err(StagingError::InvalidState(
                        "finalized transfer file is incomplete or invalid".into(),
                    ));
                }
            }
            fs::set_permissions(&target, fs::Permissions::from_mode(READY_FILE_MODE))?;
            File::open(&target)?.sync_all()?;
        }
        File::open(&partial)?.sync_all()?;
        if partial.join("READY").exists() {
            if fs::read(partial.join("READY"))? != descriptor.bundle_sha256.as_bytes() {
                return Err(StagingError::InvalidState(
                    "ready marker does not match transfer digest".into(),
                ));
            }
        } else {
            write_atomic(
                &partial.join("READY"),
                descriptor.bundle_sha256.as_bytes(),
                READY_FILE_MODE,
            )?;
        }
        match fs::remove_file(partial.join(PARTIAL_ACTIVITY_FILE)) {
            Ok(()) => File::open(&partial)?.sync_all()?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        match fs::remove_file(partial.join(PARTIAL_ATTEMPT_FILE)) {
            Ok(()) => File::open(&partial)?.sync_all()?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        File::open(&partial)?.sync_all()?;
        fs::set_permissions(&partial, fs::Permissions::from_mode(READY_DIR_MODE))?;
        File::open(&partial)?.sync_all()?;
        fs::rename(&partial, &ready)?;
        sync_parent(&ready)?;
        self.verify_ready_unlocked(&descriptor)?;
        Ok(ready)
    }

    /// Rehashes all staged files every time a runtime prepares its mount.
    pub fn verify_ready(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
    ) -> Result<PathBuf, StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        self.verify_ready_unlocked(descriptor)
    }

    pub fn abort(&self, transfer_id: &str, attempt_id: &str) -> Result<(), StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        validate_attempt_id(attempt_id)?;
        let paths = [
            self.partial_path(transfer_id),
            self.queued_path(transfer_id),
        ];
        // Preflight ownership for every directory before deleting either one.
        // A stale abort must not partially clean up a newer attempt.
        for path in &paths {
            match fs::symlink_metadata(path) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err(StagingError::InvalidState(
                            "aborted transfer is not a real directory".into(),
                        ));
                    }
                    if !attempt_owner_matches(path, attempt_id)? {
                        return Ok(());
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        for path in paths {
            if path.exists() {
                fs::set_permissions(&path, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
                fs::remove_dir_all(path)?;
            }
        }
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }

    /// Reclaim only partial transfers whose durable activity lease expired.
    /// Ready bundles are intentionally excluded: they remain governed by the
    /// receipt-bound release marker and registry reference checks below.
    pub fn reclaim_abandoned_partials(&self) -> Result<usize, StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        self.reclaim_stale_partials_unlocked(SystemTime::now())
    }

    fn reclaim_stale_partials_unlocked(&self, now: SystemTime) -> Result<usize, StagingError> {
        let mut reclaimed = 0;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let Some(transfer_id) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(".partial"))
                .map(str::to_owned)
            else {
                continue;
            };
            let partial = entry.path();
            let metadata = fs::symlink_metadata(&partial)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StagingError::InvalidState(
                    "partial transfer is not a real directory".into(),
                ));
            }
            // A receipt marker is never expected for a partial, but if the
            // finalization/release boundary is interrupted, fail closed and
            // leave that transfer to the receipt-aware cleanup path.
            match fs::symlink_metadata(self.release_marker_path(&transfer_id)) {
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let last_activity = partial_last_activity(&partial)?;
            let stale = now
                .duration_since(last_activity)
                .is_ok_and(|age| age >= ABANDONED_PARTIAL_AGE);
            if !stale {
                continue;
            }
            fs::set_permissions(&partial, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
            fs::remove_dir_all(&partial)?;
            reclaimed += 1;
        }
        if reclaimed > 0 {
            File::open(&self.root)?.sync_all()?;
        }
        Ok(reclaimed)
    }

    /// Persist a supervisor-owned release marker after the session host has
    /// returned its receipt-confirmed grant acknowledgement. The marker lives
    /// outside the mounted ready directory and contains no transcript data.
    pub fn mark_release_eligible(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
        receipt: &freshell_runtime_protocol::OpenCodeTransferReadinessReceipt,
    ) -> Result<(), StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        if !receipt.matches_descriptor(descriptor) {
            return Err(StagingError::InvalidState(
                "readiness receipt does not match the staged transfer".into(),
            ));
        }
        let ready = self.ready_path(&descriptor.transfer_id);
        let metadata = fs::symlink_metadata(&ready)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.permissions().mode() & 0o777 != READY_DIR_MODE
        {
            return Err(StagingError::InvalidState(
                "receipt-confirmed stage is not a private read-only directory".into(),
            ));
        }
        let staged_descriptor = self.read_descriptor(&ready)?;
        ensure_same_descriptor(&staged_descriptor, descriptor)?;
        let bytes = serde_json::to_vec(receipt)
            .map_err(|error| StagingError::Metadata(error.to_string()))?;
        write_atomic(
            &self.release_marker_path(&descriptor.transfer_id),
            &bytes,
            PRIVATE_FILE_MODE,
        )?;
        Ok(())
    }

    /// Delete only receipt-confirmed ready bundles that no prepared/retry
    /// launch still references. The durable marker makes startup retries
    /// idempotent across a crash between stage removal and marker removal.
    pub fn reclaim_release_eligible(
        &self,
        referenced_transfer_ids: &HashSet<String>,
    ) -> Result<usize, StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        let mut reclaimed = 0;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(transfer_id) = name
                .to_str()
                .and_then(|name| name.strip_suffix(".releasable"))
            else {
                continue;
            };
            if referenced_transfer_ids.contains(transfer_id) {
                continue;
            }
            let marker = entry.path();
            let marker_metadata = fs::symlink_metadata(&marker)?;
            if marker_metadata.file_type().is_symlink() || !marker_metadata.is_file() {
                return Err(StagingError::InvalidState(
                    "transfer release marker is not a regular file".into(),
                ));
            }
            let receipt: freshell_runtime_protocol::OpenCodeTransferReadinessReceipt =
                serde_json::from_slice(&fs::read(&marker)?)
                    .map_err(|error| StagingError::Metadata(error.to_string()))?;
            if receipt.transfer_id != transfer_id {
                return Err(StagingError::InvalidState(
                    "transfer release marker has a mismatched identity".into(),
                ));
            }
            let ready = self.ready_path(transfer_id);
            match fs::symlink_metadata(&ready) {
                Ok(metadata) => {
                    if metadata.file_type().is_symlink() || !metadata.is_dir() {
                        return Err(StagingError::InvalidState(
                            "release-eligible stage is not a real directory".into(),
                        ));
                    }
                    let descriptor = self.read_descriptor(&ready)?;
                    if !receipt.matches_descriptor(&descriptor) {
                        return Err(StagingError::InvalidState(
                            "release receipt no longer matches its staged bundle".into(),
                        ));
                    }
                    make_writable_for_owner(&ready)?;
                    fs::remove_dir_all(&ready)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            fs::remove_file(marker)?;
            reclaimed += 1;
        }
        if reclaimed > 0 {
            File::open(&self.root)?.sync_all()?;
        }
        Ok(reclaimed)
    }

    fn verify_ready_unlocked(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
    ) -> Result<PathBuf, StagingError> {
        let path = self.ready_path(&descriptor.transfer_id);
        if !path.is_dir() {
            return Err(StagingError::InvalidState(
                "transfer has not been finalized".into(),
            ));
        }
        ensure_same_descriptor(&self.read_descriptor(&path)?, descriptor)?;
        let marker = fs::read(path.join("READY"))?;
        if marker != descriptor.bundle_sha256.as_bytes() {
            return Err(StagingError::InvalidState(
                "ready marker does not match transfer digest".into(),
            ));
        }
        for file in &descriptor.files {
            verify_file(&ready_file(&path, file.index), file)?;
        }
        Ok(path)
    }

    fn resume_offsets(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
        path: &Path,
    ) -> Result<StagingStart, StagingError> {
        let next_sequence = self.recover_next_sequence(descriptor, path)?;
        let mut offsets = Vec::with_capacity(descriptor.files.len());
        for file in &descriptor.files {
            let file_path = staged_file(path, file.index)?;
            offsets.push(freshell_runtime_protocol::OpenCodeTransferFileOffset {
                file_index: file.index,
                next_offset: fs::metadata(file_path)?.len(),
            });
        }
        Ok(StagingStart::Started {
            next_sequence,
            file_offsets: offsets,
        })
    }

    fn recover_next_sequence(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
        path: &Path,
    ) -> Result<u64, StagingError> {
        let mut next = 0;
        let mut previous_incomplete = false;
        for file in &descriptor.files {
            let file_path = staged_file(path, file.index)?;
            let metadata = fs::symlink_metadata(&file_path)?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(StagingError::InvalidState(
                    "staged payload entry is not a regular file".into(),
                ));
            }
            let mut len = metadata.len();
            if previous_incomplete && len != 0 {
                return Err(StagingError::InvalidState(
                    "later bundle file contains bytes before earlier file completed".into(),
                ));
            }
            if len > file.size_bytes {
                return Err(StagingError::InvalidState(
                    "staged file exceeds declared size".into(),
                ));
            }
            if file_path
                .extension()
                .is_some_and(|extension| extension == "bin")
                && len != file.size_bytes
            {
                return Err(StagingError::InvalidState(
                    "finalized staged file is not complete".into(),
                ));
            }
            if len < file.size_bytes && len % MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64 != 0 {
                len -= len % MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64;
                OpenOptions::new()
                    .write(true)
                    .open(&file_path)?
                    .set_len(len)?;
                File::open(&file_path)?.sync_all()?;
            }
            next += chunks_for_prefix(file.size_bytes, len);
            previous_incomplete = len < file.size_bytes;
        }
        Ok(next)
    }

    fn has_capacity(&self, incoming: u64) -> Result<bool, StagingError> {
        let mut reserved = 0_u64;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !(name.ends_with(".partial") || name.ends_with(".ready")) {
                continue;
            }
            let descriptor = self.read_descriptor(&entry.path())?;
            reserved = reserved.saturating_add(descriptor.total_bytes);
        }
        Ok(reserved.saturating_add(incoming) <= self.limits.max_total_bytes)
    }

    fn read_descriptor(&self, path: &Path) -> Result<OpenCodeTransferDescriptor, StagingError> {
        let raw = fs::read(path.join("descriptor.json"))?;
        let metadata: StagingMetadata = serde_json::from_slice(&raw)
            .map_err(|error| StagingError::Metadata(error.to_string()))?;
        metadata
            .descriptor
            .validate()
            .map_err(|error| StagingError::Metadata(error.message))?;
        Ok(metadata.descriptor)
    }

    fn recover_partial_initialization(
        &self,
        path: &Path,
        requested: &OpenCodeTransferDescriptor,
    ) -> Result<OpenCodeTransferDescriptor, StagingError> {
        fs::set_permissions(path, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with(".tmp-") {
                let metadata = fs::symlink_metadata(entry.path())?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(StagingError::InvalidState(
                        "staging initialization contains an unexpected temporary entry".into(),
                    ));
                }
                fs::remove_file(entry.path())?;
            }
        }
        let descriptor_path = path.join("descriptor.json");
        let existing = if descriptor_path.exists() {
            self.read_descriptor(path)?
        } else {
            for entry in fs::read_dir(path)? {
                let entry = entry?;
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name != "descriptor.json"
                    && name != PARTIAL_ACTIVITY_FILE
                    && name != PARTIAL_ATTEMPT_FILE
                    && !name.ends_with(".part")
                    && !name.ends_with(".bin")
                {
                    return Err(StagingError::InvalidState(
                        "incomplete staging directory contains an unknown entry".into(),
                    ));
                }
                let metadata = fs::symlink_metadata(entry.path())?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(StagingError::InvalidState(
                        "descriptor-less staging directory contains payload data".into(),
                    ));
                }
                if name == PARTIAL_ATTEMPT_FILE {
                    read_attempt_owner(path)?;
                } else if metadata.len() != 0 {
                    return Err(StagingError::InvalidState(
                        "descriptor-less staging directory contains payload data".into(),
                    ));
                }
            }
            self.write_descriptor(path, requested)?;
            requested.clone()
        };
        ensure_same_descriptor(&existing, requested)?;
        Ok(existing)
    }

    fn remaining_bytes(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
        path: &Path,
    ) -> Result<u64, StagingError> {
        descriptor.files.iter().try_fold(0_u64, |remaining, file| {
            let staged = staged_file(path, file.index)?;
            let length = fs::metadata(staged)?.len();
            if length > file.size_bytes {
                return Err(StagingError::InvalidState(
                    "staged file exceeds declared size".into(),
                ));
            }
            Ok(remaining.saturating_add(file.size_bytes - length))
        })
    }

    fn write_descriptor(
        &self,
        path: &Path,
        descriptor: &OpenCodeTransferDescriptor,
    ) -> Result<(), StagingError> {
        let bytes = serde_json::to_vec(&StagingMetadata {
            descriptor: descriptor.clone(),
        })
        .map_err(|error| StagingError::Metadata(error.to_string()))?;
        write_atomic(&path.join("descriptor.json"), &bytes, PRIVATE_FILE_MODE)?;
        Ok(())
    }

    fn create_partial_files(
        &self,
        path: &Path,
        descriptor: &OpenCodeTransferDescriptor,
    ) -> Result<(), StagingError> {
        for file in &descriptor.files {
            let part = part_file(path, file.index);
            let ready = ready_file(path, file.index);
            if part.exists() && ready.exists() {
                return Err(StagingError::InvalidState(
                    "staged file has both partial and finalized entries".into(),
                ));
            }
            if part.exists() || ready.exists() {
                continue;
            }
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(PRIVATE_FILE_MODE)
                .open(part)?
                .sync_all()?;
        }
        Ok(())
    }

    fn partial_path(&self, transfer_id: &str) -> PathBuf {
        self.root.join(format!("{transfer_id}.partial"))
    }

    fn queued_path(&self, transfer_id: &str) -> PathBuf {
        self.root.join(format!("{transfer_id}.queued"))
    }

    fn ready_path(&self, transfer_id: &str) -> PathBuf {
        self.root.join(format!("{transfer_id}.ready"))
    }

    fn release_marker_path(&self, transfer_id: &str) -> PathBuf {
        self.root.join(format!("{transfer_id}.releasable"))
    }
}

fn record_partial_activity(path: &Path, at: SystemTime) -> Result<(), StagingError> {
    let activity = path.join(PARTIAL_ACTIVITY_FILE);
    let existing = match fs::symlink_metadata(&activity) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(StagingError::InvalidState(
                    "partial activity marker is not a regular file".into(),
                ));
            }
            true
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    let mut options = OpenOptions::new();
    options.write(true);
    if !existing {
        options.create_new(true).mode(PRIVATE_FILE_MODE);
    }
    let file = options.open(&activity)?;
    file.set_len(0)?;
    file.set_times(fs::FileTimes::new().set_modified(at))?;
    file.sync_all()?;
    if !existing {
        sync_parent(&activity)?;
    }
    Ok(())
}

fn validate_attempt_id(attempt_id: &str) -> Result<(), StagingError> {
    if !valid_opencode_transfer_attempt_id(attempt_id) {
        return Err(StagingError::InvalidState(
            "transfer attempt ID must be 32 lowercase hexadecimal characters".into(),
        ));
    }
    Ok(())
}

fn read_attempt_owner(path: &Path) -> Result<String, StagingError> {
    let owner_path = path.join(PARTIAL_ATTEMPT_FILE);
    let metadata = fs::symlink_metadata(&owner_path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != 32 {
        return Err(StagingError::InvalidState(
            "transfer attempt owner marker is not a regular file".into(),
        ));
    }
    let attempt_id = fs::read_to_string(owner_path)?;
    validate_attempt_id(&attempt_id)?;
    Ok(attempt_id)
}

fn write_attempt_owner(path: &Path, attempt_id: &str) -> Result<(), StagingError> {
    validate_attempt_id(attempt_id)?;
    match fs::symlink_metadata(path.join(PARTIAL_ATTEMPT_FILE)) {
        Ok(_) => {
            // Fail closed on malformed or redirected ownership metadata before
            // replacing it with a new resume attempt.
            let _ = read_attempt_owner(path)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    write_atomic(
        &path.join(PARTIAL_ATTEMPT_FILE),
        attempt_id.as_bytes(),
        PRIVATE_FILE_MODE,
    )?;
    Ok(())
}

fn require_attempt_owner(path: &Path, attempt_id: &str) -> Result<(), StagingError> {
    validate_attempt_id(attempt_id)?;
    if !attempt_owner_matches(path, attempt_id)? {
        return Err(StagingError::InvalidState(
            "transfer attempt has been superseded".into(),
        ));
    }
    Ok(())
}

fn attempt_owner_matches(path: &Path, attempt_id: &str) -> Result<bool, StagingError> {
    validate_attempt_id(attempt_id)?;
    Ok(read_attempt_owner(path)? == attempt_id)
}

fn partial_last_activity(path: &Path) -> Result<SystemTime, StagingError> {
    let activity = path.join(PARTIAL_ACTIVITY_FILE);
    match fs::symlink_metadata(&activity) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(StagingError::InvalidState(
                    "partial activity marker is not a regular file".into(),
                ));
            }
            return metadata.modified().map_err(StagingError::Io);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }

    // Older partials predate the explicit lease marker. Use their newest
    // direct child timestamp so a recently written payload remains resumable
    // across upgrade; malformed or future-dated state is never guessed stale.
    let mut newest = fs::symlink_metadata(path)?.modified()?;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let modified = fs::symlink_metadata(entry.path())?.modified()?;
        newest = newest.max(modified);
    }
    Ok(newest)
}

// libc exposes statvfs counters at the target's native unsigned-long width;
// widen both before multiplying so 32-bit Unix builds keep the same byte math.
#[allow(clippy::unnecessary_cast)]
fn statvfs_available_bytes(stats: &libc::statvfs) -> u64 {
    (stats.f_bavail as u64).saturating_mul(stats.f_frsize as u64)
}

fn ensure_same_descriptor(
    existing: &OpenCodeTransferDescriptor,
    requested: &OpenCodeTransferDescriptor,
) -> Result<(), StagingError> {
    if existing != requested {
        return Err(StagingError::InvalidState(
            "transfer id is already bound to different descriptor metadata".into(),
        ));
    }
    Ok(())
}

fn part_file(root: &Path, index: u32) -> PathBuf {
    root.join(format!("entry-{index:04}.part"))
}

fn staged_file(root: &Path, index: u32) -> Result<PathBuf, StagingError> {
    let partial = part_file(root, index);
    let finalized = ready_file(root, index);
    match (partial.exists(), finalized.exists()) {
        (true, false) => Ok(partial),
        (false, true) => Ok(finalized),
        (false, false) => Err(StagingError::InvalidState(
            "staged payload entry is missing".into(),
        )),
        (true, true) => Err(StagingError::InvalidState(
            "staged file has both partial and finalized entries".into(),
        )),
    }
}

fn ready_file(root: &Path, index: u32) -> PathBuf {
    root.join(format!("entry-{index:04}.bin"))
}

fn chunk_coordinates(files: &[OpenCodeTransferFile]) -> Vec<(u32, u64, u64)> {
    let mut coordinates = Vec::new();
    for file in files {
        let mut offset = 0_u64;
        while offset < file.size_bytes {
            let size = (file.size_bytes - offset).min(MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64);
            coordinates.push((file.index, offset, size));
            offset += size;
        }
    }
    coordinates
}

fn total_chunks(files: &[OpenCodeTransferFile]) -> u64 {
    files
        .iter()
        .map(|file| chunks_for_prefix(file.size_bytes, file.size_bytes))
        .sum()
}

fn chunks_for_prefix(file_size: u64, prefix_size: u64) -> u64 {
    if prefix_size == 0 {
        0
    } else if prefix_size >= file_size {
        file_size.div_ceil(MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64)
    } else {
        prefix_size / MAX_OPENCODE_TRANSFER_CHUNK_BYTES as u64
    }
}

fn complete_offsets(
    files: &[OpenCodeTransferFile],
) -> Vec<freshell_runtime_protocol::OpenCodeTransferFileOffset> {
    files
        .iter()
        .map(
            |file| freshell_runtime_protocol::OpenCodeTransferFileOffset {
                file_index: file.index,
                next_offset: file.size_bytes,
            },
        )
        .collect()
}

fn verify_file(path: &Path, expected: &OpenCodeTransferFile) -> Result<(), StagingError> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != expected.size_bytes
    {
        return Err(StagingError::InvalidState(format!(
            "staged file {} has the wrong type or size",
            expected.index
        )));
    }
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    if hex::encode(hasher.finalize()) != expected.sha256 {
        return Err(StagingError::InvalidState(format!(
            "staged file {} digest mismatch",
            expected.index
        )));
    }
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<(), std::io::Error> {
    let parent = path.parent().expect("staging metadata has a parent");
    let temporary = parent.join(format!(".tmp-{}", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(&temporary)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn sync_parent(path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn make_writable_for_owner(path: &Path) -> Result<(), std::io::Error> {
    if !path.is_dir() {
        return Ok(());
    }
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            make_writable_for_owner(&entry.path())?;
        } else {
            fs::set_permissions(entry.path(), fs::Permissions::from_mode(0o600))?;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "opencode_transfer_tests.rs"]
mod tests;
