//! Name-reliability Task 11 (D9, RC9): lock-free name reads and a cheap
//! cross-process peek.
//!
//! The adopted view (`NamesCore::view`) already holds the whole document
//! this store last committed or adopted, so a name read never needs the
//! document lock or a re-parse. The one question a read must answer is "did
//! another participant replace the document since?", and a stat answers it:
//! the view remembers the [`DocumentStamp`] of the exact file it was adopted
//! from, and the peek compares the document's current stamp with it.
//!
//! * Unix: device + inode + length + nanosecond mtime. Every cooperating
//!   writer replaces the document atomically (sibling temp + rename), and a
//!   replacement is always a new inode, so every commit changes the stamp.
//! * Windows: length + mtime (100 ns). The std file-index APIs are unstable
//!   and no new crate is taken for them; the periodic full check below backs
//!   the weaker stamp.
//!
//! An equal stamp is trusted for at most [`FULL_CHECK_INTERVAL`] after the
//! last full read; the next peek after that is a full read again. That
//! bounds staleness for the rare change a stamp cannot see (an in-place
//! rewrite that keeps the length within one coarse mtime tick). A changed
//! stamp means the full read too — the same strict locked adoption every
//! transaction runs: durability reconciliation, generation fencing, delta
//! publication.
//!
//! A read never waits for the lock: when the stamp changed and another
//! participant holds the lock (it is mid-commit), the read answers from the
//! current view and a later read or the 2 s tick adopts the commit. Fences
//! still fail a read exactly as before (an unreconciled replacement, a
//! vanished document, a decreasing or rewritten generation).

use std::fs::TryLockError;
use std::io::Read as _;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use freshell_freshagent::naming::{NameError, NameFuture};
use freshell_protocol::session_names::{SessionNameRef, SessionNameUpdate};

use super::{
    acquire_document_lock, name_ref_key, open_lock_file, run_txn_locked, spawn_txn, update_for_key,
    Decision, NamesCore, RedirectScope, SessionNames, StoredDocument,
};

/// How long an equal stamp is trusted before the peek re-reads the whole
/// document anyway.
const FULL_CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// What a stat of the name document says about the file: its length, its
/// modification time and (Unix) its device and inode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DocumentStamp {
    pub(crate) len: u64,
    pub(crate) mtime_ns: i128,
    pub(crate) file_id: Option<(u64, u64)>,
}

impl DocumentStamp {
    fn of(metadata: &std::fs::Metadata) -> Self {
        let mtime_ns = metadata
            .modified()
            .ok()
            .map(
                |modified| match modified.duration_since(std::time::UNIX_EPOCH) {
                    Ok(after) => after.as_nanos() as i128,
                    Err(before) => -(before.duration().as_nanos() as i128),
                },
            )
            .unwrap_or(0);
        #[cfg(unix)]
        let file_id = {
            use std::os::unix::fs::MetadataExt;
            Some((metadata.dev(), metadata.ino()))
        };
        #[cfg(not(unix))]
        let file_id = None;
        Self {
            len: metadata.len(),
            mtime_ns,
            file_id,
        }
    }
}

/// Stat the document at `path`.
pub(crate) fn stat_stamp(path: &Path) -> std::io::Result<DocumentStamp> {
    std::fs::metadata(path).map(|metadata| DocumentStamp::of(&metadata))
}

/// Read the whole document together with the stamp of the exact file the
/// bytes came from (taken from the open handle BEFORE reading, so a stamp
/// can only be older than its bytes — a later peek then re-reads, it never
/// misses a change).
pub(super) fn read_with_stamp(path: &Path) -> std::io::Result<(Vec<u8>, DocumentStamp)> {
    let mut file = std::fs::File::open(path)?;
    let stamp = DocumentStamp::of(&file.metadata()?);
    let mut bytes = Vec::with_capacity(usize::try_from(stamp.len).unwrap_or(0));
    file.read_to_end(&mut bytes)?;
    Ok((bytes, stamp))
}

/// When the adopted view was last confirmed against the whole document (a
/// commit, an adoption or an unchanged full read).
#[derive(Debug, Default)]
pub(super) struct FullCheck(Mutex<Option<Instant>>);

impl FullCheck {
    pub(super) fn mark(&self) {
        *self.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(Instant::now());
    }

    fn within(&self, interval: Duration) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .is_some_and(|checked| checked.elapsed() < interval)
    }
}

/// A full read confirmed the file still holds the adopted generation (the
/// equal-generation, equal-digest outcome): keep the view, record the
/// file's current stamp, and restart the full-check window.
pub(super) fn confirm_view(core: &NamesCore, stamp: Option<DocumentStamp>) {
    let view = core.current_view();
    if view.stamp == stamp {
        core.full_check.mark();
    } else {
        core.set_view(view.document.clone(), view.digest, stamp);
    }
}

/// Why a peek has to read the whole document.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FullReadReason {
    /// The view was never stamped (a failed stat after a commit).
    NoStamp,
    /// The document's stamp differs from the adopted one.
    StampChanged,
    /// The document cannot be stat'ed (vanished, permissions); the full
    /// read reports the fence.
    StatFailed,
    /// The stamp is equal but the full-check window elapsed.
    PeriodicCheck,
}

impl FullReadReason {
    fn as_str(self) -> &'static str {
        match self {
            Self::NoStamp => "no_stamp",
            Self::StampChanged => "stamp_changed",
            Self::StatFailed => "stat_failed",
            Self::PeriodicCheck => "periodic_full_check",
        }
    }
}

/// How long a full read may wait for the document lock.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LockWait {
    /// The strict transaction budget (the 2 s tick).
    Bounded,
    /// One attempt (reads): a busy lock means another participant is
    /// mid-commit, and the read answers from the current view.
    NoWait,
}

/// What a peek-and-adopt did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Adoption {
    /// The stamp matched inside the full-check window: nothing was read.
    Current,
    /// A full read confirmed the adopted generation.
    Confirmed,
    /// A full read adopted a newer generation.
    Adopted,
    /// The stamp changed but the lock was busy (reads only).
    Busy,
}

/// The stat-only decision: `None` when the view may be served as is.
fn peek(core: &NamesCore) -> Option<FullReadReason> {
    let Some(adopted) = core.current_view().stamp else {
        return Some(FullReadReason::NoStamp);
    };
    match stat_stamp(&core.doc_path) {
        Err(_) => Some(FullReadReason::StatFailed),
        Ok(current) if current != adopted => Some(FullReadReason::StampChanged),
        Ok(_) if !core.full_check.within(full_check_interval(&core.data_dir)) => {
            Some(FullReadReason::PeriodicCheck)
        }
        Ok(_) => None,
    }
}

/// One attempt at the document lock: `Ok(None)` when another participant
/// holds it.
fn try_document_lock(path: &Path) -> Result<Option<std::fs::File>, NameError> {
    let file = open_lock_file(path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some(file)),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(e)) => Err(NameError::LockUnavailable(format!(
            "session-names document lock error: {e}"
        ))),
    }
}

/// The full read: the strict locked adoption (a pure-read transaction).
fn full_read(
    core: &NamesCore,
    wait: LockWait,
    reason: FullReadReason,
) -> Result<Adoption, NameError> {
    let guard = match wait {
        LockWait::Bounded => acquire_document_lock(&core.lock_path)?,
        LockWait::NoWait => match try_document_lock(&core.lock_path)? {
            Some(guard) => guard,
            None => {
                tracing::debug!(
                    target: "freshell_server::session_names",
                    op = "get",
                    reason = reason.as_str(),
                    class = "lock_busy",
                    "session_names.read_served_from_view: another participant holds the \
                     document lock; answering from the adopted view"
                );
                return Ok(Adoption::Busy);
            }
        },
    };
    let before = core.current_view().document.document_generation;
    run_txn_locked(core, guard, |_doc, _meta| Ok(Decision::Read(())))?;
    let after = core.current_view().document.document_generation;
    if after <= before {
        return Ok(Adoption::Confirmed);
    }
    if reason == FullReadReason::PeriodicCheck {
        // The stamp was equal yet the document had moved on: the change a
        // stamp cannot see, caught by the window it is backed by.
        tracing::info!(
            target: "freshell_server::session_names",
            op = "adopt_external",
            reason = reason.as_str(),
            from_generation = before,
            to_generation = after,
            "session_names.stamp_missed_change: the periodic full check adopted a newer \
             document whose stamp was unchanged"
        );
    } else {
        tracing::debug!(
            target: "freshell_server::session_names",
            op = "adopt_external",
            reason = reason.as_str(),
            from_generation = before,
            to_generation = after,
            "session_names.adopted_external: adopted a newer document generation"
        );
    }
    Ok(Adoption::Adopted)
}

/// Peek, and run the full read only when the peek says so. The stat runs
/// inline (one metadata call, the settings store's freshness-check
/// precedent); the full read runs on a detached blocking task like every
/// transaction, so its lock guard lives until it completes.
async fn adopt_if_changed(core: Arc<NamesCore>, wait: LockWait) -> Result<Adoption, NameError> {
    let Some(reason) = peek(&core) else {
        return Ok(Adoption::Current);
    };
    tokio::task::spawn_blocking(move || full_read(&core, wait, reason))
        .await
        .map_err(|join_err| {
            NameError::Persistence(format!("naming adoption task failed: {join_err}"))
        })?
}

/// Resolve `refs` against `document` — the read model's answer shape:
/// each ref through its pending→durable redirect, unknown refs omitted.
fn get_from_view(document: &StoredDocument, refs: &[SessionNameRef]) -> Vec<SessionNameUpdate> {
    let mut updates = Vec::new();
    for target in refs {
        let (resolved, traversed) = document.resolve_ref(target);
        let key = name_ref_key(&resolved);
        if let Some(mut update) = update_for_key(document, &key, false, RedirectScope::None) {
            if let Some(redirect) = traversed {
                update.redirects.push(redirect);
            }
            updates.push(update);
        }
    }
    updates
}

/// The name read: adopt a changed document if the lock is free, then answer
/// from the adopted view. Only an unestablished store (generation 0, never
/// the case after `open`) takes the strict locked path.
pub(super) async fn read_names(
    core: Arc<NamesCore>,
    refs: Vec<SessionNameRef>,
) -> Result<Vec<SessionNameUpdate>, NameError> {
    adopt_if_changed(Arc::clone(&core), LockWait::NoWait).await?;
    let view = core.current_view();
    if view.document.document_generation == 0 {
        return spawn_txn(core, move |doc, _meta| {
            Ok(Decision::Read(get_from_view(doc, &refs)))
        })
        .await;
    }
    Ok(get_from_view(&view.document, &refs))
}

impl SessionNames {
    /// The 2 s tick's cross-process check: stat the document and, only when
    /// its stamp differs from the adopted one or the full-check window
    /// elapsed, run the strict locked full-read adoption (which publishes
    /// the delta to subscribers). `true` when a newer generation was
    /// adopted.
    pub(crate) fn adopt_external_if_changed(&self) -> NameFuture<bool> {
        let core = Arc::clone(&self.core);
        Box::pin(async move {
            let adoption = adopt_if_changed(core, LockWait::Bounded).await?;
            Ok(adoption == Adoption::Adopted)
        })
    }
}

/// The full-check interval for `data_dir` (a test seam shortens it).
fn full_check_interval(data_dir: &Path) -> Duration {
    #[cfg(test)]
    {
        if let Some(super::TestHook::FullCheckIntervalMs(ms)) =
            super::take_matching_hook(data_dir, |h| {
                matches!(h, super::TestHook::FullCheckIntervalMs(_))
            })
        {
            return Duration::from_millis(ms);
        }
    }
    let _ = data_dir;
    FULL_CHECK_INTERVAL
}

#[cfg(test)]
#[path = "session_name_store_view_tests.rs"]
mod tests;
