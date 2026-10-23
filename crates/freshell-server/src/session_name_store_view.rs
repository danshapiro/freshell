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
//!   replacement always has a different inode from the file it replaces.
//!   The filesystem can hand a freed inode number out again a commit or more
//!   later, so an equal stamp is still possible in rare cases (the same
//!   reused inode, the same length and the same mtime tick); the periodic
//!   full check below bounds that case.
//! * Windows: length + mtime (100 ns). The std file-index APIs are unstable
//!   and no new crate is taken for them; the periodic full check below backs
//!   the weaker stamp.
//!
//! An equal stamp is trusted for at most [`FULL_CHECK_INTERVAL`] after the
//! last full read; the next peek after that is a full read again. That
//! bounds staleness for the rare change a stamp cannot see (an in-place
//! rewrite that keeps the length within one coarse mtime tick, or a reused
//! inode as above). A changed stamp means the full read too — the same
//! strict locked adoption every transaction runs: durability
//! reconciliation, generation fencing, delta publication. The full read
//! checks the stamp again once it holds the lock, because the unlocked stat
//! can catch a commit halfway (the old view stamp, then the new file); when
//! the file then turns out to be the adopted one, nothing is parsed.
//!
//! A read never queues behind a commit: when the stamp changed it tries the
//! lock for at most [`READ_LOCK_WAIT`], and if the lock is still busy
//! (normally another participant mid-commit) it answers from the current
//! view; a later read or the 2 s tick adopts the change. The short wait is
//! there because a busy lock does not always mean a commit: a child process
//! forked anywhere in this process while a transaction held the lock keeps
//! an inherited copy of that lock's descriptor until it execs, and a single
//! attempt would mistake that brief hold for a commit and answer stale.
//! Once a read holds the lock, fences fail it exactly as before (an
//! unreconciled replacement, a vanished document, a decreasing or rewritten
//! generation); a read answered under a busy lock gets the established
//! view, never the fenced document, and a later read reports the fence.

use std::fs::TryLockError;
use std::io::Read as _;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use freshell_freshagent::naming::{NameError, NameFuture};
use freshell_protocol::session_names::{SessionNameRef, SessionNameUpdate};

use super::{
    acquire_document_lock, name_ref_key, open_lock_file, run_txn_locked, spawn_txn, update_for_key,
    Adopted, Decision, NamesCore, RedirectScope, SessionNames, StoredDocument,
};

/// How long an equal stamp is trusted before the peek re-reads the whole
/// document anyway.
const FULL_CHECK_INTERVAL: Duration = Duration::from_secs(30);

/// How long a read tries a busy document lock before answering from the
/// adopted view. It outlasts a lock descriptor inherited by a forked child
/// (measured on Linux: at most 2.4 ms with four threads spawning processes
/// nonstop) and stays far below a real commit of a live-size document, which
/// the read does not wait for.
const READ_LOCK_WAIT: Duration = Duration::from_millis(10);

/// How often a read retries a busy lock within [`READ_LOCK_WAIT`].
const READ_LOCK_POLL: Duration = Duration::from_micros(500);

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
    /// At most [`READ_LOCK_WAIT`] (reads): a lock still busy after that
    /// means another participant is mid-commit, and the read answers from
    /// the current view.
    Brief,
}

/// What a peek-and-adopt did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Adoption {
    /// The stamp matched inside the full-check window (checked again under
    /// the lock when the unlocked stat said otherwise): nothing was read.
    Current,
    /// A full read confirmed the adopted generation.
    Confirmed,
    /// A full read adopted a newer generation.
    Adopted,
    /// The stamp changed but the lock stayed busy for the read's short wait
    /// (reads only).
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

/// Try the document lock for at most `wait`: `Ok(None)` when it is still
/// held by someone else at the end.
fn try_document_lock_within(
    path: &Path,
    wait: Duration,
) -> Result<Option<std::fs::File>, NameError> {
    let file = open_lock_file(path)?;
    let deadline = Instant::now() + wait;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(Some(file)),
            Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(READ_LOCK_POLL);
            }
            Err(TryLockError::WouldBlock) => return Ok(None),
            Err(TryLockError::Error(e)) => {
                return Err(NameError::LockUnavailable(format!(
                    "session-names document lock error: {e}"
                )))
            }
        }
    }
}

/// The full read: the strict locked adoption (a pure-read transaction).
///
/// `peeked` is what the unlocked peek decided. That stat ran without the
/// lock, so it can have caught a commit halfway (the old view stamp, then
/// the new file): once the lock is held no cooperating writer is mid-replace,
/// so the peek runs again and its answer is final. When it now finds the file
/// is the adopted one, nothing is read.
fn full_read(
    core: &NamesCore,
    wait: LockWait,
    peeked: FullReadReason,
) -> Result<Adoption, NameError> {
    let guard = match wait {
        LockWait::Bounded => acquire_document_lock(&core.lock_path)?,
        LockWait::Brief => {
            match try_document_lock_within(&core.lock_path, read_lock_wait(&core.data_dir))? {
                Some(guard) => guard,
                None => {
                    count_busy_read_for_test(&core.data_dir);
                    tracing::debug!(
                        target: "freshell_server::session_names",
                        op = "get",
                        reason = peeked.as_str(),
                        class = "lock_busy",
                        "session_names.read_served_from_view: the document lock stayed busy \
                         for the read's short wait; answering from the adopted view"
                    );
                    return Ok(Adoption::Busy);
                }
            }
        }
    };
    let Some(reason) = peek(core) else {
        tracing::debug!(
            target: "freshell_server::session_names",
            op = "adopt_external",
            reason = peeked.as_str(),
            "session_names.peek_settled_under_lock: the document is the adopted one; \
             skipped the full read"
        );
        return Ok(Adoption::Current);
    };
    let before = core.current_view();
    run_txn_locked(core, guard, |_doc, _meta| Ok(Decision::Read(())))?;
    let after = core.current_view();
    if after.document.document_generation <= before.document.document_generation {
        return Ok(Adoption::Confirmed);
    }
    report_adoption(reason, &before, &after);
    Ok(Adoption::Adopted)
}

/// Log an adoption of a newer generation. The adopted view carries the
/// stamp of the exact file just read: when it equals the stamp adopted
/// before, the stamp missed this change (the case the periodic full check
/// exists for), which is worth an INFO line; otherwise the stamp did its job.
fn report_adoption(reason: FullReadReason, before: &Adopted, after: &Adopted) {
    let from_generation = before.document.document_generation;
    let to_generation = after.document.document_generation;
    if before.stamp.is_some() && after.stamp == before.stamp {
        tracing::info!(
            target: "freshell_server::session_names",
            op = "adopt_external",
            reason = reason.as_str(),
            from_generation,
            to_generation,
            "session_names.stamp_missed_change: adopted a newer document whose stamp was \
             unchanged"
        );
    } else {
        tracing::debug!(
            target: "freshell_server::session_names",
            op = "adopt_external",
            reason = reason.as_str(),
            from_generation,
            to_generation,
            "session_names.adopted_external: adopted a newer document generation"
        );
    }
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
    adopt_if_changed(Arc::clone(&core), LockWait::Brief).await?;
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

/// Test tally of reads that answered from the view because the lock stayed
/// busy past the read's short wait (data-dir keyed like the other test
/// seams, so parallel tests never see each other's counts). A no-op in
/// non-test builds.
fn count_busy_read_for_test(data_dir: &Path) {
    #[cfg(test)]
    {
        *busy_read_tallies()
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .entry(data_dir.to_path_buf())
            .or_default() += 1;
    }
    #[cfg(not(test))]
    {
        let _ = data_dir;
    }
}

#[cfg(test)]
fn busy_read_tallies() -> &'static Mutex<std::collections::BTreeMap<std::path::PathBuf, u64>> {
    static TALLIES: std::sync::OnceLock<
        Mutex<std::collections::BTreeMap<std::path::PathBuf, u64>>,
    > = std::sync::OnceLock::new();
    TALLIES.get_or_init(Default::default)
}

/// The current test tally of busy reads against `data_dir`.
#[cfg(test)]
pub(super) fn test_busy_read_count(data_dir: &Path) -> u64 {
    busy_read_tallies()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(data_dir)
        .copied()
        .unwrap_or(0)
}

/// Test helper: `get`, repeated only while the read answered from the view
/// because the lock stayed busy past its short wait (the busy tally proves
/// it). Under a heavily loaded test run, a child process forked while a
/// transaction held the lock can keep its inherited copy of the lock's
/// descriptor longer than [`READ_LOCK_WAIT`]; the read then answers from the
/// adopted view (safe, but not yet the new document) and a later read
/// settles. Every other outcome (an adoption, a fence error, an answer from
/// an unchanged document) is returned as is.
#[cfg(test)]
pub(super) async fn get_settled_for_test(
    names: &SessionNames,
    refs: Vec<SessionNameRef>,
) -> Result<Vec<SessionNameUpdate>, NameError> {
    use freshell_freshagent::naming::SessionNaming as _;

    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let busy_before = test_busy_read_count(&names.core.data_dir);
        let result = names.get(refs.clone()).await;
        let was_busy = test_busy_read_count(&names.core.data_dir) != busy_before;
        if !was_busy || Instant::now() >= deadline {
            return result;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// The read's lock wait for `data_dir` (a test seam lengthens it).
fn read_lock_wait(data_dir: &Path) -> Duration {
    #[cfg(test)]
    {
        if let Some(super::TestHook::ReadLockWaitMs(ms)) =
            super::take_matching_hook(data_dir, |h| {
                matches!(h, super::TestHook::ReadLockWaitMs(_))
            })
        {
            return Duration::from_millis(ms);
        }
    }
    let _ = data_dir;
    READ_LOCK_WAIT
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
