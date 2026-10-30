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
    collections::{HashMap, HashSet},
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
const QUEUE_ORDER_FILE: &str = ".queue-order";
const QUEUE_SEQUENCE_FILE: &str = ".queue-sequence";
const MAX_QUEUED_TRANSFERS: usize = 128;
const QUEUE_INITIALIZATION_PREFIX: &str = ".queue-init-";
/// A partial transfer with no durable progress for an hour is abandoned.
/// Normal retries resume it before this lease expires; failed live requests
/// also send Abort, leaving this as the process-crash fallback.
const ABANDONED_PARTIAL_AGE: Duration = Duration::from_secs(60 * 60);
/// A finalized stage is kept while its attempt prepares and registers a
/// launch. After a supervisor crash, cleanup checks the registry and reclaims
/// only after this durable lease has expired.
pub(super) const ABANDONED_READY_AGE: Duration = Duration::from_secs(60 * 60);

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueMetadata {
    order: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueueSequence {
    next_order: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ReadyOwnershipState {
    Pending,
    Registering,
    Claimed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadyOwnership {
    attempt_id: String,
    state: ReadyOwnershipState,
    updated_at_unix_ms: u64,
}

/// Owns a persistent private spool rooted beneath the supervisor runtime root.
pub struct OpenCodeTransferStaging {
    root: PathBuf,
    limits: StagingLimits,
    lock: Mutex<()>,
    capacity_changed: tokio::sync::watch::Sender<u64>,
    #[cfg(test)]
    queue_initialization_failpoint: Mutex<Option<QueueInitializationPhase>>,
    #[cfg(test)]
    queue_promotion_crash_after_order_removal: Mutex<bool>,
    #[cfg(test)]
    begin_lock_contention_observer: Mutex<Option<std::sync::mpsc::Sender<BeginLockTestEvent>>>,
}

#[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(super) enum BeginLockTestEvent {
    Contended,
    Probe(u8),
}

pub type OpenCodeTransferStageReferences = HashMap<String, Vec<OpenCodeTransferDescriptor>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum QueueInitializationPhase {
    DirectoryCreated,
    DescriptorDurable,
    AttemptDurable,
    OrderDurable,
}

impl OpenCodeTransferStaging {
    #[cfg(test)]
    fn crash_checkpoint(&self, point: &str) {
        if std::env::var("FRESHELL_OPENCODE_STAGE_CRASH_POINT")
            .ok()
            .as_deref()
            == Some(point)
        {
            // The isolated parent verifies this signal and runs only inside
            // scripts/sandbox-test.sh's disposable Docker container.
            unsafe {
                libc::kill(libc::getpid(), libc::SIGKILL);
            }
            unreachable!("SIGKILL should terminate the staging crash fixture");
        }
    }

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
        let (capacity_changed, _) = tokio::sync::watch::channel(0);
        let staging = Self {
            root,
            limits,
            lock: Mutex::new(()),
            capacity_changed,
            #[cfg(test)]
            queue_initialization_failpoint: Mutex::new(None),
            #[cfg(test)]
            queue_promotion_crash_after_order_removal: Mutex::new(false),
            #[cfg(test)]
            begin_lock_contention_observer: Mutex::new(None),
        };
        {
            let _guard = staging.lock.lock().expect("transfer staging lock poisoned");
            staging.recover_interrupted_queue_initializations_unlocked()?;
            staging.recover_incomplete_partial_payloads_unlocked()?;
        }
        Ok(staging)
    }

    /// Enumerate retained recovery artifacts without opening payload bodies.
    /// Partial and queued transfers also block a complete-absence verdict.
    pub(crate) fn has_origin_artifact(
        &self,
        source_store_id: &str,
        root_session_id: &str,
    ) -> Result<bool, StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        let mut found = false;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if ![".ready", ".partial", ".queued"]
                .iter()
                .any(|suffix| name.ends_with(suffix))
            {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(StagingError::InvalidState(
                    "source artifact is not a real directory".into(),
                ));
            }
            let descriptor = self.read_descriptor(&entry.path())?;
            found |= descriptor.source_store_id == source_store_id
                && descriptor.root_session_id == root_session_id;
        }
        Ok(found)
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

    /// Begin or resume staging. Tests inject the physical free-space snapshot;
    /// production uses `begin_from_filesystem` so the snapshot is taken while
    /// the staging lock serializes admission with writes and other begins.
    pub fn begin(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
        attempt_id: &str,
        available_bytes: u64,
    ) -> Result<StagingStart, StagingError> {
        self.begin_with_space_probe(descriptor, attempt_id, || Ok(available_bytes))
    }

    pub fn begin_from_filesystem(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
        attempt_id: &str,
    ) -> Result<StagingStart, StagingError> {
        self.begin_with_space_probe(descriptor, attempt_id, || self.available_space_bytes())
    }

    fn begin_with_space_probe<F>(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
        attempt_id: &str,
        mut space_probe: F,
    ) -> Result<StagingStart, StagingError>
    where
        F: FnMut() -> Result<u64, StagingError>,
    {
        let _guard = self.lock_for_begin();
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
        // Keep capacity observation inside the same lock as the reservation
        // scan and state transition. This prevents parallel Begins from using
        // the same unreserved free-space snapshot. Measure after stale stages
        // are reclaimed so the snapshot includes the space they release.
        let available_bytes = space_probe()?;
        if self.advance_queue_unlocked(available_bytes)? > 0 {
            self.notify_capacity_change();
        }
        let partial = self.partial_path(&descriptor.transfer_id);
        let queued = self.queued_path(&descriptor.transfer_id);
        let ready = self.ready_path(&descriptor.transfer_id);
        if partial.exists() && queued.exists() {
            return Err(StagingError::InvalidState(
                "transfer has both queued and partial staging entries".into(),
            ));
        }
        if ready.exists() {
            let existing = self.read_descriptor(&ready)?;
            ensure_same_descriptor(&existing, descriptor)?;
            self.verify_ready_unlocked(descriptor)?;
            self.adopt_unclaimed_ready_unlocked(&descriptor.transfer_id, attempt_id)?;
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
            self.notify_capacity_change();
            if queued.exists() {
                self.ensure_queue_order_unlocked(&queued)?;
                if self.advance_queue_unlocked(available_bytes)? > 0 {
                    self.notify_capacity_change();
                }
                if !partial.exists() {
                    return Ok(StagingStart::Queued);
                }
                let resumed = self.resume_offsets(descriptor, &partial)?;
                record_partial_activity(&partial, SystemTime::now())?;
                return Ok(resumed);
            } else {
                self.create_partial_files(&partial, descriptor)?;
                if !self.has_physical_capacity(0, available_bytes)? {
                    return Err(StagingError::Capacity(
                        "filesystem free space is below outstanding staging reservations".into(),
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

        if self.queued_count_unlocked()? >= MAX_QUEUED_TRANSFERS {
            return Err(StagingError::Capacity(
                "transfer staging queue is full".into(),
            ));
        }
        if self.has_queued_transfers_unlocked()?
            || !self.has_capacity(descriptor.total_bytes)?
            || !self.has_physical_capacity(descriptor.total_bytes, available_bytes)?
        {
            self.publish_queue_entry_unlocked(&queued, descriptor, attempt_id)?;
            self.advance_queue_unlocked(available_bytes)?;
            if partial.exists() {
                self.notify_capacity_change();
                return self.resume_offsets(descriptor, &partial);
            }
            self.notify_capacity_change();
            return Ok(StagingStart::Queued);
        }

        fs::create_dir(&partial)?;
        fs::set_permissions(&partial, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
        sync_parent(&partial)?;
        self.write_descriptor(&partial, descriptor)?;
        #[cfg(test)]
        self.crash_checkpoint("begin.after_descriptor");
        for file in &descriptor.files {
            let path = part_file(&partial, file.index);
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(PRIVATE_FILE_MODE)
                .open(path)?
                .sync_all()?;
            #[cfg(test)]
            self.crash_checkpoint(&format!("begin.after_placeholder.{}", file.index));
        }
        File::open(&partial)?.sync_all()?;
        sync_parent(&partial)?;
        write_attempt_owner(&partial, attempt_id)?;
        record_partial_activity(&partial, SystemTime::now())?;
        self.notify_capacity_change();
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

    fn lock_for_begin(&self) -> std::sync::MutexGuard<'_, ()> {
        #[cfg(test)]
        {
            match self.lock.try_lock() {
                Ok(guard) => guard,
                Err(std::sync::TryLockError::WouldBlock) => {
                    let observer = self
                        .begin_lock_contention_observer
                        .lock()
                        .expect("begin lock observer mutex poisoned")
                        .take();
                    if let Some(observer) = observer {
                        let _ = observer.send(BeginLockTestEvent::Contended);
                    }
                    self.lock.lock().expect("transfer staging lock poisoned")
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    panic!("transfer staging lock poisoned")
                }
            }
        }
        #[cfg(not(test))]
        {
            self.lock.lock().expect("transfer staging lock poisoned")
        }
    }

    #[cfg(test)]
    fn observe_next_begin_lock_contention_for_test(
        &self,
        observer: std::sync::mpsc::Sender<BeginLockTestEvent>,
    ) {
        *self
            .begin_lock_contention_observer
            .lock()
            .expect("begin lock observer mutex poisoned") = Some(observer);
    }

    #[cfg(test)]
    fn crash_after_queue_promotion_order_removal_for_test(&self) {
        *self
            .queue_promotion_crash_after_order_removal
            .lock()
            .expect("queue promotion crash failpoint mutex poisoned") = true;
    }

    #[cfg(test)]
    fn queue_promotion_checkpoint_after_order_removal(&self) {
        let should_crash = std::mem::take(
            &mut *self
                .queue_promotion_crash_after_order_removal
                .lock()
                .expect("queue promotion crash failpoint mutex poisoned"),
        );
        if should_crash {
            // This is called only in the isolated crash-fixture child. The
            // sandboxed parent verifies the exact signal before restart.
            unsafe {
                libc::kill(libc::getpid(), libc::SIGKILL);
            }
            unreachable!("SIGKILL should terminate the crash fixture child");
        }
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
        #[cfg(test)]
        self.crash_checkpoint(&format!("chunk.after_write.{}", chunk.sequence));
        output.sync_all()?;
        #[cfg(test)]
        self.crash_checkpoint(&format!("chunk.after_file_sync.{}", chunk.sequence));
        sync_parent(&path)?;
        #[cfg(test)]
        self.crash_checkpoint(&format!("chunk.after_parent_sync.{}", chunk.sequence));
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
                #[cfg(test)]
                self.crash_checkpoint(&format!("finalize.after_file_rename.{}", file.index));
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
            #[cfg(test)]
            self.crash_checkpoint(&format!("finalize.after_file_sync.{}", file.index));
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
            #[cfg(test)]
            self.crash_checkpoint("finalize.after_ready_marker");
        }
        self.write_ready_ownership_unlocked(
            transfer_id,
            attempt_id,
            ReadyOwnershipState::Pending,
            SystemTime::now(),
        )?;
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
        #[cfg(test)]
        self.crash_checkpoint("finalize.after_ready_rename");
        sync_parent(&ready)?;
        #[cfg(test)]
        self.crash_checkpoint("finalize.after_ready_parent_sync");
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
        self.abort_with_references(transfer_id, attempt_id, &HashSet::new())
    }

    pub fn abort_with_references(
        &self,
        transfer_id: &str,
        attempt_id: &str,
        referenced_transfer_ids: &HashSet<String>,
    ) -> Result<(), StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        validate_attempt_id(attempt_id)?;
        let ready = self.ready_path(transfer_id);
        if ready.exists() {
            // A finalized stage remains attempt-owned until the supervisor
            // claims it together with registry preparation. Once claimed, or
            // once a receipt marker exists, cancellation cannot remove it.
            if self.release_marker_exists(transfer_id)?
                || referenced_transfer_ids.contains(transfer_id)
            {
                return Ok(());
            }
            let Some(owner) = self.read_ready_ownership(transfer_id)? else {
                return Ok(());
            };
            if owner.state == ReadyOwnershipState::Claimed || owner.attempt_id != attempt_id {
                return Ok(());
            }
            let metadata = fs::symlink_metadata(&ready)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StagingError::InvalidState(
                    "aborted ready transfer is not a real directory".into(),
                ));
            }
            make_writable_for_owner(&ready)?;
            fs::remove_dir_all(&ready)?;
            self.remove_ready_ownership(transfer_id)?;
            File::open(&self.root)?.sync_all()?;
            self.advance_queue_unlocked(self.available_space_bytes()?)?;
            self.notify_capacity_change();
            return Ok(());
        }
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
        self.advance_queue_unlocked(self.available_space_bytes()?)?;
        self.notify_capacity_change();
        Ok(())
    }

    /// Reclaim only partial transfers whose durable activity lease expired.
    /// Ready bundles are intentionally excluded: they remain governed by the
    /// receipt-bound release marker and registry reference checks below.
    pub fn reclaim_abandoned_partials(&self) -> Result<usize, StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        let reclaimed = self.reclaim_stale_partials_unlocked(SystemTime::now())?;
        if reclaimed > 0 {
            self.advance_queue_unlocked(self.available_space_bytes()?)?;
            self.notify_capacity_change();
        }
        Ok(reclaimed)
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
            self.remove_orphan_ready_ownership_unlocked(&transfer_id)?;
            reclaimed += 1;
        }
        if reclaimed > 0 {
            File::open(&self.root)?.sync_all()?;
        }
        Ok(reclaimed)
    }

    /// Claim a finalized stage in the same supervisor critical section as
    /// durable registry preparation. Matching pre-registration aborts and
    /// expiry cleanup use this same staging lock.
    pub fn mark_launch_registering(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
        attempt_id: &str,
        already_referenced: bool,
    ) -> Result<(), StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        validate_attempt_id(attempt_id)?;
        self.verify_ready_metadata_unlocked(descriptor)?;
        match self.read_ready_ownership(&descriptor.transfer_id)? {
            Some(mut owner)
                if owner.state == ReadyOwnershipState::Pending
                    || owner.state == ReadyOwnershipState::Registering =>
            {
                if !already_referenced && owner.attempt_id != attempt_id {
                    return Err(StagingError::InvalidState(
                        "ready stage is owned by a superseded transfer attempt".into(),
                    ));
                }
                owner.state = if already_referenced {
                    ReadyOwnershipState::Claimed
                } else {
                    ReadyOwnershipState::Registering
                };
                if already_referenced {
                    owner.attempt_id = attempt_id.to_owned();
                }
                owner.updated_at_unix_ms = unix_millis(SystemTime::now());
                self.write_ready_ownership(&descriptor.transfer_id, &owner)?;
            }
            Some(owner) if owner.state == ReadyOwnershipState::Claimed => {}
            Some(_) => unreachable!("ready owner state is exhaustive"),
            None => {
                // A ready stage from an older supervisor build has no pending
                // owner. Preserve it as claimed; only receipt cleanup may
                // release it after this compatibility adoption.
                self.write_ready_ownership(
                    &descriptor.transfer_id,
                    &ReadyOwnership {
                        attempt_id: attempt_id.to_owned(),
                        state: if already_referenced {
                            ReadyOwnershipState::Claimed
                        } else {
                            ReadyOwnershipState::Registering
                        },
                        updated_at_unix_ms: unix_millis(SystemTime::now()),
                    },
                )?;
            }
        }
        Ok(())
    }

    /// Reconcile durable registration owners after the supervisor has
    /// restarted and loaded a complete registry reference snapshot. A
    /// matching reference makes the stage claimed; no reference releases
    /// only the stale registering fence back to pending. Any same-ID
    /// descriptor mismatch is treated as corruption and left fenced.
    pub fn reconcile_registering_ready(
        &self,
        references: &OpenCodeTransferStageReferences,
    ) -> Result<usize, StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        let mut reconciliations = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let Some(transfer_id) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(".ready"))
                .map(str::to_owned)
            else {
                continue;
            };
            let ready = entry.path();
            let metadata = fs::symlink_metadata(&ready)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StagingError::InvalidState(
                    "ready transfer is not a real directory".into(),
                ));
            }
            let descriptor = self.read_descriptor(&ready)?;
            if descriptor.transfer_id != transfer_id {
                return Err(StagingError::InvalidState(
                    "ready transfer directory does not match its descriptor".into(),
                ));
            }
            let Some(mut owner) = self.read_ready_ownership(&transfer_id)? else {
                continue;
            };
            if owner.state != ReadyOwnershipState::Registering {
                continue;
            }

            owner.state = if registry_reference_matches(references, &descriptor)? {
                ReadyOwnershipState::Claimed
            } else {
                ReadyOwnershipState::Pending
            };
            owner.updated_at_unix_ms = unix_millis(SystemTime::now());
            reconciliations.push((transfer_id, owner));
        }
        // Validate the complete snapshot and every affected stage before
        // writing any ownership transition. A mismatch later in the scan
        // must not release an earlier stage to a fresh attempt.
        for (transfer_id, owner) in &reconciliations {
            self.write_ready_ownership(transfer_id, owner)?;
        }
        Ok(reconciliations.len())
    }

    pub fn has_exact_registry_reference(
        &self,
        references: &OpenCodeTransferStageReferences,
        descriptor: &OpenCodeTransferDescriptor,
    ) -> Result<bool, StagingError> {
        registry_reference_matches(references, descriptor)
    }

    pub fn ready_registration_needs_reconciliation(
        &self,
        transfer_id: &str,
    ) -> Result<bool, StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        let ready = self.ready_path(transfer_id);
        match fs::symlink_metadata(&ready) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(StagingError::InvalidState(
                        "ready transfer is not a real directory".into(),
                    ));
                }
                Ok(self
                    .read_ready_ownership(transfer_id)?
                    .is_some_and(|owner| owner.state == ReadyOwnershipState::Registering))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    pub fn mark_launch_claimed(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
        attempt_id: &str,
    ) -> Result<(), StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        validate_attempt_id(attempt_id)?;
        self.verify_ready_metadata_unlocked(descriptor)?;
        match self.read_ready_ownership(&descriptor.transfer_id)? {
            Some(owner) if owner.state == ReadyOwnershipState::Claimed => Ok(()),
            Some(mut owner) => {
                if owner.attempt_id != attempt_id {
                    return Err(StagingError::InvalidState(
                        "ready stage is owned by a superseded transfer attempt".into(),
                    ));
                }
                owner.state = ReadyOwnershipState::Claimed;
                owner.updated_at_unix_ms = unix_millis(SystemTime::now());
                self.write_ready_ownership(&descriptor.transfer_id, &owner)
            }
            None => self.write_ready_ownership_unlocked(
                &descriptor.transfer_id,
                attempt_id,
                ReadyOwnershipState::Claimed,
                SystemTime::now(),
            ),
        }
    }

    /// Restore a failed registry preparation to its attempt-owned pending
    /// state. The server holds the lifecycle lock and has confirmed no
    /// registry reference exists before calling this method.
    pub fn restore_unregistered_pending(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
        attempt_id: &str,
    ) -> Result<(), StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        validate_attempt_id(attempt_id)?;
        let Some(mut owner) = self.read_ready_ownership(&descriptor.transfer_id)? else {
            return Err(StagingError::InvalidState(
                "ready stage lost its ownership marker during registry preparation".into(),
            ));
        };
        if owner.state != ReadyOwnershipState::Registering || owner.attempt_id != attempt_id {
            return Err(StagingError::InvalidState(
                "ready stage registration claim was superseded".into(),
            ));
        }
        owner.state = ReadyOwnershipState::Pending;
        owner.updated_at_unix_ms = unix_millis(SystemTime::now());
        self.write_ready_ownership(&descriptor.transfer_id, &owner)
    }

    /// Reclaim only stale pending ready bundles that are absent from the
    /// synchronized registry snapshot and have no receipt-backed consumer.
    /// Claimed/retryable bundles remain under the existing receipt/refcount
    /// release protocol.
    pub fn reclaim_abandoned_ready(
        &self,
        referenced_transfer_ids: &HashSet<String>,
    ) -> Result<usize, StagingError> {
        self.reclaim_abandoned_ready_at(referenced_transfer_ids, SystemTime::now())
    }

    fn reclaim_abandoned_ready_at(
        &self,
        referenced_transfer_ids: &HashSet<String>,
        now: SystemTime,
    ) -> Result<usize, StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        let reclaimed = self.reclaim_abandoned_ready_unlocked(referenced_transfer_ids, now)?;
        if reclaimed > 0 {
            self.advance_queue_unlocked(self.available_space_bytes()?)?;
            self.notify_capacity_change();
        }
        Ok(reclaimed)
    }

    fn reclaim_abandoned_ready_unlocked(
        &self,
        referenced_transfer_ids: &HashSet<String>,
        now: SystemTime,
    ) -> Result<usize, StagingError> {
        let mut reclaimed = 0;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let Some(transfer_id) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(".ready"))
                .map(str::to_owned)
            else {
                continue;
            };
            let ready = entry.path();
            let metadata = fs::symlink_metadata(&ready)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StagingError::InvalidState(
                    "ready transfer is not a real directory".into(),
                ));
            }
            if self.release_marker_exists(&transfer_id)?
                || referenced_transfer_ids.contains(&transfer_id)
            {
                continue;
            }
            let Some(owner) = self.read_ready_ownership(&transfer_id)? else {
                // Legacy ready stages without typed ownership fail closed.
                continue;
            };
            if owner.state == ReadyOwnershipState::Claimed {
                continue;
            }
            let Some(updated_at) =
                SystemTime::UNIX_EPOCH.checked_add(Duration::from_millis(owner.updated_at_unix_ms))
            else {
                return Err(StagingError::Metadata(
                    "ready ownership timestamp is outside the supported range".into(),
                ));
            };
            if !now
                .duration_since(updated_at)
                .is_ok_and(|age| age >= ABANDONED_READY_AGE)
            {
                continue;
            }

            let descriptor = self.read_descriptor(&ready)?;
            self.verify_ready_unlocked(&descriptor)?;
            make_writable_for_owner(&ready)?;
            fs::remove_dir_all(&ready)?;
            self.remove_ready_ownership(&transfer_id)?;
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
            self.remove_ready_ownership(transfer_id)?;
            fs::remove_file(marker)?;
            reclaimed += 1;
        }
        if reclaimed > 0 {
            File::open(&self.root)?.sync_all()?;
            self.advance_queue_unlocked(self.available_space_bytes()?)?;
            self.notify_capacity_change();
        }
        Ok(reclaimed)
    }

    pub(crate) async fn wait_for_capacity(
        &self,
        transfer_id: &str,
        attempt_id: &str,
    ) -> Result<StagingStart, StagingError> {
        validate_attempt_id(attempt_id)?;
        let mut changes = self.capacity_changed.subscribe();
        loop {
            let observed_generation = *changes.borrow();
            if let Some(start) = self.poll_queued_transfer(transfer_id, attempt_id)? {
                return Ok(start);
            }
            if *changes.borrow() == observed_generation {
                changes.changed().await.map_err(|_| {
                    StagingError::InvalidState(
                        "staging capacity notifications are unavailable".into(),
                    )
                })?;
            }
        }
    }

    fn poll_queued_transfer(
        &self,
        transfer_id: &str,
        attempt_id: &str,
    ) -> Result<Option<StagingStart>, StagingError> {
        let _guard = self.lock.lock().expect("transfer staging lock poisoned");
        let available = self.available_space_bytes()?;
        if self.advance_queue_unlocked(available)? > 0 {
            self.notify_capacity_change();
        }
        let partial = self.partial_path(transfer_id);
        if partial.is_dir() {
            require_attempt_owner(&partial, attempt_id)?;
            let descriptor = self.read_descriptor(&partial)?;
            return self.resume_offsets(&descriptor, &partial).map(Some);
        }
        let queued = self.queued_path(transfer_id);
        if queued.is_dir() {
            require_attempt_owner(&queued, attempt_id)?;
            return Ok(None);
        }
        let ready = self.ready_path(transfer_id);
        if ready.is_dir() {
            let Some(owner) = self.read_ready_ownership(transfer_id)? else {
                return Err(StagingError::InvalidState(
                    "queued transfer became ready without attempt ownership".into(),
                ));
            };
            if owner.state == ReadyOwnershipState::Pending && owner.attempt_id != attempt_id {
                return Err(StagingError::InvalidState(
                    "queued transfer was superseded by another attempt".into(),
                ));
            }
            let descriptor = self.read_descriptor(&ready)?;
            return Ok(Some(StagingStart::Started {
                next_sequence: total_chunks(&descriptor.files),
                file_offsets: complete_offsets(&descriptor.files),
            }));
        }
        Err(StagingError::InvalidState(
            "queued transfer was cancelled or superseded".into(),
        ))
    }

    fn verify_ready_unlocked(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
    ) -> Result<PathBuf, StagingError> {
        let path = self.verify_ready_metadata_unlocked(descriptor)?;
        for file in &descriptor.files {
            verify_file(&ready_file(&path, file.index), file)?;
        }
        Ok(path)
    }

    fn verify_ready_metadata_unlocked(
        &self,
        descriptor: &OpenCodeTransferDescriptor,
    ) -> Result<PathBuf, StagingError> {
        let path = self.ready_path(&descriptor.transfer_id);
        let metadata = fs::symlink_metadata(&path)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(StagingError::InvalidState(
                "transfer has not been finalized into a real directory".into(),
            ));
        }
        ensure_same_descriptor(&self.read_descriptor(&path)?, descriptor)?;
        let marker = fs::read(path.join("READY"))?;
        if marker != descriptor.bundle_sha256.as_bytes() {
            return Err(StagingError::InvalidState(
                "ready marker does not match transfer digest".into(),
            ));
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

    fn has_queued_transfers_unlocked(&self) -> Result<bool, StagingError> {
        Ok(self.queued_count_unlocked()? > 0)
    }

    fn publish_queue_entry_unlocked(
        &self,
        queued: &Path,
        descriptor: &OpenCodeTransferDescriptor,
        attempt_id: &str,
    ) -> Result<(), StagingError> {
        let temporary = self.root.join(format!(
            "{QUEUE_INITIALIZATION_PREFIX}{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&temporary)?;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
        self.queue_initialization_checkpoint(QueueInitializationPhase::DirectoryCreated)?;

        self.write_descriptor(&temporary, descriptor)?;
        self.queue_initialization_checkpoint(QueueInitializationPhase::DescriptorDurable)?;

        write_attempt_owner(&temporary, attempt_id)?;
        self.queue_initialization_checkpoint(QueueInitializationPhase::AttemptDurable)?;

        let order = self.allocate_queue_order_unlocked()?;
        self.write_queue_order(&temporary, order)?;
        File::open(&temporary)?.sync_all()?;
        self.queue_initialization_checkpoint(QueueInitializationPhase::OrderDurable)?;

        // All entry metadata is durable before the atomic rename makes the
        // FIFO position visible to queue enumeration.
        fs::rename(&temporary, queued)?;
        File::open(&self.root)?.sync_all()?;
        Ok(())
    }

    fn recover_interrupted_queue_initializations_unlocked(&self) -> Result<usize, StagingError> {
        let mut removed = 0;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            let Some(id) = name.strip_prefix(QUEUE_INITIALIZATION_PREFIX) else {
                continue;
            };
            if uuid::Uuid::parse_str(id).is_err() {
                continue;
            }

            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StagingError::InvalidState(
                    "queue initialization entry is not a real directory".into(),
                ));
            }
            if !is_exact_interrupted_queue_initialization(&path)? {
                // It is not one of our exact temporary shapes. Leave it
                // untouched; importantly, its name cannot enter the .queued
                // FIFO or count against queue capacity.
                continue;
            }
            fs::set_permissions(&path, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
            fs::remove_dir_all(path)?;
            removed += 1;
        }
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let Some(transfer_id) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(".queued"))
                .map(str::to_owned)
            else {
                continue;
            };
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StagingError::InvalidState(
                    "queued transfer is not a real directory".into(),
                ));
            }
            if !self.is_incomplete_legacy_queue_entry_unlocked(&path, &transfer_id)? {
                continue;
            }
            fs::set_permissions(&path, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
            fs::remove_dir_all(path)?;
            removed += 1;
        }
        if removed > 0 {
            File::open(&self.root)?.sync_all()?;
        }
        Ok(removed)
    }

    fn is_incomplete_legacy_queue_entry_unlocked(
        &self,
        path: &Path,
        transfer_id: &str,
    ) -> Result<bool, StagingError> {
        let mut has_descriptor = false;
        let mut has_attempt = false;
        for entry in fs::read_dir(path)? {
            let entry = entry?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                return Ok(false);
            };
            let metadata = fs::symlink_metadata(entry.path())?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Ok(false);
            }
            match name.as_str() {
                "descriptor.json" => {
                    if self.read_descriptor(path)?.transfer_id != transfer_id {
                        return Err(StagingError::InvalidState(
                            "queued directory does not match its descriptor".into(),
                        ));
                    }
                    has_descriptor = true;
                }
                PARTIAL_ATTEMPT_FILE => {
                    read_attempt_owner(path)?;
                    has_attempt = true;
                }
                QUEUE_ORDER_FILE => {
                    read_queue_order_marker(path)?;
                }
                _ if name
                    .strip_prefix(".tmp-")
                    .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok()) => {}
                _ => return Ok(false),
            }
        }
        // Previous builds published the final directory before these files
        // existed. Such an entry has no accepted queue position or payload;
        // a producer retry can safely create it again. Fully owned entries,
        // including the recoverable missing-order case, remain untouched.
        Ok(!has_descriptor || !has_attempt)
    }

    #[cfg(test)]
    fn queue_initialization_checkpoint(
        &self,
        phase: QueueInitializationPhase,
    ) -> Result<(), StagingError> {
        let mut failpoint = self
            .queue_initialization_failpoint
            .lock()
            .expect("queue initialization failpoint lock poisoned");
        if *failpoint == Some(phase) {
            *failpoint = None;
            return Err(StagingError::Io(std::io::Error::other(
                "injected queue initialization filesystem failure",
            )));
        }
        Ok(())
    }

    #[cfg(not(test))]
    fn queue_initialization_checkpoint(
        &self,
        _phase: QueueInitializationPhase,
    ) -> Result<(), StagingError> {
        Ok(())
    }

    #[cfg(test)]
    fn fail_next_queue_initialization_after_order_for_test(&self) {
        *self
            .queue_initialization_failpoint
            .lock()
            .expect("queue initialization failpoint lock poisoned") =
            Some(QueueInitializationPhase::OrderDurable);
    }

    fn queued_count_unlocked(&self) -> Result<usize, StagingError> {
        let mut count = 0;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".queued"))
            {
                let metadata = fs::symlink_metadata(entry.path())?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err(StagingError::InvalidState(
                        "queued transfer is not a real directory".into(),
                    ));
                }
                count += 1;
            }
        }
        if count > MAX_QUEUED_TRANSFERS {
            return Err(StagingError::InvalidState(
                "transfer staging queue exceeds its configured bound".into(),
            ));
        }
        Ok(count)
    }

    fn advance_queue_unlocked(&self, available_bytes: u64) -> Result<usize, StagingError> {
        // A prior promotion or partial initialization may have been
        // interrupted after its directory became visible. Repair those
        // payload placeholders before physical reservation accounting reads
        // the partial stages.
        self.recover_incomplete_partial_payloads_unlocked()?;

        let mut queued = Vec::new();
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            let Some(transfer_id) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.strip_suffix(".queued"))
                .map(str::to_owned)
            else {
                continue;
            };
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StagingError::InvalidState(
                    "queued transfer is not a real directory".into(),
                ));
            }
            queued.push((self.read_queue_order_unlocked(&path)?, transfer_id, path));
        }
        queued.sort_by(|(left_order, left_id, _), (right_order, right_id, _)| {
            left_order
                .cmp(right_order)
                .then_with(|| left_id.cmp(right_id))
        });

        let mut promoted = 0;
        for (_, transfer_id, queued_path) in queued {
            let descriptor = self.read_descriptor(&queued_path)?;
            let _attempt_id = read_attempt_owner(&queued_path)?;
            if descriptor.total_bytes > self.limits.max_bundle_bytes {
                return Err(StagingError::Capacity(
                    "queued bundle exceeds the configured per-bundle limit".into(),
                ));
            }
            if available_bytes < descriptor.total_bytes
                || !self.has_capacity(descriptor.total_bytes)?
                || !self.has_physical_capacity(descriptor.total_bytes, available_bytes)?
            {
                // Strict FIFO avoids starvation: a smaller new transfer may
                // not repeatedly jump ahead of this queued descriptor.
                break;
            }

            let partial = self.partial_path(&transfer_id);
            if partial.exists() {
                return Err(StagingError::InvalidState(
                    "queued transfer already has a partial stage".into(),
                ));
            }
            // Prepare all required (still-empty) payload files while the FIFO
            // entry is still queued. The directory rename must never publish
            // a partial stage whose required payload paths do not exist.
            self.create_partial_files(&queued_path, &descriptor)?;
            record_partial_activity(&queued_path, SystemTime::now())?;
            File::open(&queued_path)?.sync_all()?;
            fs::rename(&queued_path, &partial)?;
            File::open(&self.root)?.sync_all()?;
            fs::set_permissions(&partial, fs::Permissions::from_mode(TRANSFER_ROOT_MODE))?;
            let queue_order = partial.join(QUEUE_ORDER_FILE);
            if queue_order.exists() {
                let _ = self.read_queue_order_unlocked(&partial)?;
                fs::remove_file(&queue_order)?;
            }
            File::open(&partial)?.sync_all()?;
            #[cfg(test)]
            self.queue_promotion_checkpoint_after_order_removal();
            self.create_partial_files(&partial, &descriptor)?;
            record_partial_activity(&partial, SystemTime::now())?;
            File::open(&partial)?.sync_all()?;
            sync_parent(&partial)?;
            promoted += 1;
        }
        Ok(promoted)
    }

    fn recover_incomplete_partial_payloads_unlocked(&self) -> Result<usize, StagingError> {
        let mut recovered = 0;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".partial"))
            {
                continue;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StagingError::InvalidState(
                    "partial transfer is not a real directory".into(),
                ));
            }
            let descriptor_path = path.join("descriptor.json");
            match fs::symlink_metadata(&descriptor_path) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    return Err(StagingError::InvalidState(
                        "partial transfer descriptor is not a regular file".into(),
                    ));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    // Direct Begin publishes the descriptor before ownership
                    // or payloads. An empty directory (or only its interrupted
                    // atomic metadata write) therefore holds no reservation
                    // to preserve. Reclaim it before any quota scan so other
                    // transfers can proceed without waiting for its retry.
                    if is_exact_interrupted_metadata_initialization(&path, &[])? {
                        fs::remove_dir_all(&path)?;
                        sync_parent(&path)?;
                        tracing::info!(
                            event = "opencode_transfer.partial_initialization_recovered",
                            path = %path.display(),
                            "reclaimed unpublished transfer initialization"
                        );
                        recovered += 1;
                    }
                    continue;
                }
                Err(error) => return Err(error.into()),
            }
            let descriptor = self.read_descriptor(&path)?;
            let attempt_path = path.join(PARTIAL_ATTEMPT_FILE);
            match fs::symlink_metadata(&attempt_path) {
                Ok(_) => {
                    read_attempt_owner(&path)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }

            let queue_order_path = path.join(QUEUE_ORDER_FILE);
            let had_queue_order = match fs::symlink_metadata(&queue_order_path) {
                Ok(_) => {
                    read_queue_order_marker(&path)?;
                    true
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => return Err(error.into()),
            };

            let created = self.create_partial_files(&path, &descriptor)?;
            if had_queue_order {
                // The marker is retained across the directory rename. Its
                // removal is the durable end of the promotion transition.
                fs::remove_file(queue_order_path)?;
            }
            if created > 0 || had_queue_order {
                record_partial_activity(&path, SystemTime::now())?;
                File::open(&path)?.sync_all()?;
                sync_parent(&path)?;
                recovered += 1;
            }
        }
        Ok(recovered)
    }

    fn read_queue_order_unlocked(&self, path: &Path) -> Result<u64, StagingError> {
        let order_path = path.join(QUEUE_ORDER_FILE);
        match fs::symlink_metadata(&order_path) {
            Ok(_) => read_queue_order_marker(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                // A crash during queue creation can leave the fully validated
                // descriptor and owner without an order marker. Assign a
                // durable tail position before the supervisor acknowledges or
                // promotes that entry.
                let order = self.allocate_queue_order_unlocked()?;
                self.write_queue_order(path, order)?;
                Ok(order)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn ensure_queue_order_unlocked(&self, path: &Path) -> Result<(), StagingError> {
        self.read_queue_order_unlocked(path).map(|_| ())
    }

    fn write_queue_order(&self, path: &Path, order: u64) -> Result<(), StagingError> {
        let bytes = serde_json::to_vec(&QueueMetadata { order })
            .map_err(|error| StagingError::Metadata(error.to_string()))?;
        write_atomic(&path.join(QUEUE_ORDER_FILE), &bytes, PRIVATE_FILE_MODE)?;
        Ok(())
    }

    fn allocate_queue_order_unlocked(&self) -> Result<u64, StagingError> {
        let path = self.root.join(QUEUE_SEQUENCE_FILE);
        let next_order = match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 64 {
                    return Err(StagingError::InvalidState(
                        "queue sequence is not a bounded regular file".into(),
                    ));
                }
                let sequence: QueueSequence = serde_json::from_slice(&fs::read(&path)?)
                    .map_err(|error| StagingError::Metadata(error.to_string()))?;
                sequence.next_order
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let mut highest = 0_u64;
                for entry in fs::read_dir(&self.root)? {
                    let entry = entry?;
                    let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                        continue;
                    };
                    if !name.ends_with(".queued") {
                        continue;
                    }
                    let queued = entry.path();
                    let order_path = queued.join(QUEUE_ORDER_FILE);
                    match fs::symlink_metadata(&order_path) {
                        Ok(metadata)
                            if !metadata.file_type().is_symlink()
                                && metadata.is_file()
                                && metadata.len() <= 64 =>
                        {
                            let metadata: QueueMetadata =
                                serde_json::from_slice(&fs::read(order_path)?)
                                    .map_err(|error| StagingError::Metadata(error.to_string()))?;
                            highest = highest.max(metadata.order.saturating_add(1));
                        }
                        Ok(_) => {
                            return Err(StagingError::InvalidState(
                                "queue order marker is not a bounded regular file".into(),
                            ));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => return Err(error.into()),
                    }
                }
                highest.max(1)
            }
            Err(error) => return Err(error.into()),
        };
        let next = next_order.checked_add(1).ok_or_else(|| {
            StagingError::Capacity("transfer queue order space is exhausted".into())
        })?;
        let bytes = serde_json::to_vec(&QueueSequence { next_order: next })
            .map_err(|error| StagingError::Metadata(error.to_string()))?;
        write_atomic(&path, &bytes, PRIVATE_FILE_MODE)?;
        Ok(next_order)
    }

    fn write_ready_ownership_unlocked(
        &self,
        transfer_id: &str,
        attempt_id: &str,
        state: ReadyOwnershipState,
        updated_at: SystemTime,
    ) -> Result<(), StagingError> {
        validate_attempt_id(attempt_id)?;
        self.write_ready_ownership(
            transfer_id,
            &ReadyOwnership {
                attempt_id: attempt_id.to_owned(),
                state,
                updated_at_unix_ms: unix_millis(updated_at),
            },
        )
    }

    fn write_ready_ownership(
        &self,
        transfer_id: &str,
        owner: &ReadyOwnership,
    ) -> Result<(), StagingError> {
        let bytes =
            serde_json::to_vec(owner).map_err(|error| StagingError::Metadata(error.to_string()))?;
        write_atomic(
            &self.ready_ownership_path(transfer_id),
            &bytes,
            PRIVATE_FILE_MODE,
        )?;
        Ok(())
    }

    fn read_ready_ownership(
        &self,
        transfer_id: &str,
    ) -> Result<Option<ReadyOwnership>, StagingError> {
        let path = self.ready_ownership_path(transfer_id);
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 256
                {
                    return Err(StagingError::InvalidState(
                        "ready ownership marker is not a bounded regular file".into(),
                    ));
                }
                let owner: ReadyOwnership = serde_json::from_slice(&fs::read(path)?)
                    .map_err(|error| StagingError::Metadata(error.to_string()))?;
                validate_attempt_id(&owner.attempt_id)?;
                Ok(Some(owner))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn adopt_unclaimed_ready_unlocked(
        &self,
        transfer_id: &str,
        attempt_id: &str,
    ) -> Result<(), StagingError> {
        match self.read_ready_ownership(transfer_id)? {
            Some(mut owner) if owner.state == ReadyOwnershipState::Pending => {
                owner.attempt_id = attempt_id.to_owned();
                owner.updated_at_unix_ms = unix_millis(SystemTime::now());
                self.write_ready_ownership(transfer_id, &owner)
            }
            Some(owner)
                if owner.state == ReadyOwnershipState::Registering
                    && owner.attempt_id != attempt_id =>
            {
                Err(StagingError::InvalidState(
                    "ready stage registration is owned by another transfer attempt".into(),
                ))
            }
            Some(mut owner) if owner.state == ReadyOwnershipState::Registering => {
                owner.updated_at_unix_ms = unix_millis(SystemTime::now());
                self.write_ready_ownership(transfer_id, &owner)
            }
            Some(_) => Ok(()),
            None => self.write_ready_ownership_unlocked(
                transfer_id,
                attempt_id,
                ReadyOwnershipState::Pending,
                SystemTime::now(),
            ),
        }
    }

    fn remove_ready_ownership(&self, transfer_id: &str) -> Result<(), StagingError> {
        let path = self.ready_ownership_path(transfer_id);
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    return Err(StagingError::InvalidState(
                        "ready ownership marker is not a regular file".into(),
                    ));
                }
                fs::remove_file(path)?;
                Ok(())
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.into()),
        }
    }

    fn remove_orphan_ready_ownership_unlocked(
        &self,
        transfer_id: &str,
    ) -> Result<(), StagingError> {
        if self.ready_path(transfer_id).exists() || self.partial_path(transfer_id).exists() {
            return Ok(());
        }
        self.remove_ready_ownership(transfer_id)
    }

    fn release_marker_exists(&self, transfer_id: &str) -> Result<bool, StagingError> {
        match fs::symlink_metadata(self.release_marker_path(transfer_id)) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(
                StagingError::InvalidState("transfer release marker is not a regular file".into()),
            ),
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    fn notify_capacity_change(&self) {
        self.capacity_changed
            .send_modify(|generation| *generation = generation.saturating_add(1));
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

    fn has_physical_capacity(
        &self,
        incoming: u64,
        available_bytes: u64,
    ) -> Result<bool, StagingError> {
        let mut outstanding = 0_u64;
        for entry in fs::read_dir(&self.root)? {
            let entry = entry?;
            if !entry
                .file_name()
                .to_str()
                .is_some_and(|name| name.ends_with(".partial"))
            {
                continue;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(StagingError::InvalidState(
                    "partial transfer is not a real directory".into(),
                ));
            }
            let descriptor = self.read_descriptor(&path)?;
            let remaining = self.remaining_bytes(&descriptor, &path)?;
            let Some(next_outstanding) = outstanding.checked_add(remaining) else {
                return Ok(false);
            };
            outstanding = next_outstanding;
        }
        let Some(required) = outstanding.checked_add(incoming) else {
            return Ok(false);
        };
        Ok(required <= available_bytes)
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
        let queue_order_path = path.join(QUEUE_ORDER_FILE);
        if queue_order_path.exists() {
            let _ = self.read_queue_order_unlocked(path)?;
            fs::remove_file(queue_order_path)?;
        }
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
    ) -> Result<usize, StagingError> {
        let mut created = 0;
        for file in &descriptor.files {
            let part = part_file(path, file.index);
            let ready = ready_file(path, file.index);
            let part_exists = regular_staged_file_exists(&part)?;
            let ready_exists = regular_staged_file_exists(&ready)?;
            if part_exists && ready_exists {
                return Err(StagingError::InvalidState(
                    "staged file has both partial and finalized entries".into(),
                ));
            }
            if part_exists || ready_exists {
                continue;
            }
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(PRIVATE_FILE_MODE)
                .open(part)?
                .sync_all()?;
            created += 1;
        }
        Ok(created)
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

    fn ready_ownership_path(&self, transfer_id: &str) -> PathBuf {
        self.root.join(format!("{transfer_id}.owner"))
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

fn registry_reference_matches(
    references: &OpenCodeTransferStageReferences,
    descriptor: &OpenCodeTransferDescriptor,
) -> Result<bool, StagingError> {
    let Some(candidates) = references.get(&descriptor.transfer_id) else {
        return Ok(false);
    };
    if candidates.is_empty()
        || candidates.iter().any(|candidate| {
            candidate.transfer_id != descriptor.transfer_id || candidate != descriptor
        })
    {
        return Err(StagingError::InvalidState(
            "registry transfer reference does not match the ready-stage descriptor".into(),
        ));
    }
    Ok(true)
}

fn is_exact_interrupted_queue_initialization(path: &Path) -> Result<bool, StagingError> {
    is_exact_interrupted_metadata_initialization(
        path,
        &["descriptor.json", PARTIAL_ATTEMPT_FILE, QUEUE_ORDER_FILE],
    )
}

fn is_exact_interrupted_metadata_initialization(
    path: &Path,
    allowed_metadata: &[&str],
) -> Result<bool, StagingError> {
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            return Ok(false);
        };
        let known_metadata = allowed_metadata.contains(&name.as_str());
        let atomic_temporary = name
            .strip_prefix(".tmp-")
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok());
        if !known_metadata && !atomic_temporary {
            return Ok(false);
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Ok(false);
        }
    }
    Ok(true)
}

fn unix_millis(time: SystemTime) -> u64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
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

fn read_queue_order_marker(path: &Path) -> Result<u64, StagingError> {
    let order_path = path.join(QUEUE_ORDER_FILE);
    let metadata = fs::symlink_metadata(&order_path)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 64 {
        return Err(StagingError::InvalidState(
            "queue order marker is not a bounded regular file".into(),
        ));
    }
    let metadata: QueueMetadata = serde_json::from_slice(&fs::read(order_path)?)
        .map_err(|error| StagingError::Metadata(error.to_string()))?;
    Ok(metadata.order)
}

fn regular_staged_file_exists(path: &Path) -> Result<bool, StagingError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(StagingError::InvalidState(
                    "staged payload entry is not a regular file".into(),
                ));
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.into()),
    }
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
