//! Who holds a lock file.
//!
//! Linux attributes holders by file descriptor. A process holds a lock file
//! when one of its descriptors refers to that file (same device and inode
//! as `stat` of the path) and the kernel lists a lock on that descriptor (a
//! `lock:` line in `/proc/<pid>/fdinfo/<fd>`). Once a process's main thread
//! has exited while others run on, its descriptor table is read through one
//! of those threads (`/proc/<pid>/task/<tid>/`).
//! The lock table's pid column (`/proc/locks`) is never used: it names the
//! process that TOOK the lock, which may have exited while a child or an
//! inheriting process keeps the descriptor (a `flock(1)` helper), it reads 0
//! across pid namespaces, and its `maj:min:ino` never matches `stat` on
//! btrfs or on overlayfs over mixed filesystems. A lock file's existence
//! proves nothing either: only current holders are reported.
//!
//! Windows asks the Restart Manager which processes have the file open:
//! Codex's `LockFileEx` lock lives on a handle that is never inherited and
//! ends only when that handle closes.
//!
//! macOS reads each candidate's descriptors through libproc: a process
//! holds a lock file when one of its vnode descriptors refers to that file
//! (same device and inode as `stat` of the path) and the open file is
//! marked `FHASLOCK` (it took a `flock` lock). A process that has begun
//! exiting no longer shows its descriptors, so an empty answer about a
//! dying process proves nothing: the unit confirms such holders through an
//! exit watch registered before their exit, or an unlock event
//! ([`UnlockEvents`]). The kernel fills each vnode descriptor's stat from
//! its filesystem, so a lookup can wait on a hung network mount; callers
//! bound it.
//!
//! One-shot reads only; nothing here waits or polls. Holders are named by
//! process name, never by command line (argv can carry secrets). On Linux,
//! file identities are read without a server round trip (except as noted on
//! `file_id`), so a lookup does not wait on a slow or unreachable network
//! mount.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LockHolder {
    pub pid: u32,
    /// The process name (Linux `comm`, Windows the image name), never its
    /// arguments.
    pub name: String,
    /// The lock file, as the caller named it.
    pub path: PathBuf,
}

/// Codex's per-thread writer lock (codex-rs rollout/src/writer_lock.rs).
///
/// `codex_home` must be the sidecar's own `codexHome`, as Codex reports it in
/// the `initialize` response (kept in the sidecar record), never the server's
/// ambient `CODEX_HOME` or `HOME`: a sidecar started with another home locks
/// its threads there.
pub fn codex_thread_lock_path(codex_home: &Path, thread_id: &str) -> PathBuf {
    codex_home
        .join("thread-writer-locks")
        .join(format!("{thread_id}.lock"))
}

/// How long the outside-holder lookup a reopen makes may take (waiting for
/// an earlier lookup included) before the reopen goes on without it.
pub const HOLDER_LOOKUP_DEADLINE: std::time::Duration = std::time::Duration::from_secs(2);

/// What a deadline-bounded holder lookup ([`lock_holders_within`]) found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HolderLookup {
    /// The lookup ran to the end: every VISIBLE holder. Empty means none is
    /// visible, which proves nothing about a holder this server cannot see
    /// (another uid, another pid namespace) or, on Windows, one a failed
    /// Restart Manager query hid; never read it as "released".
    Checked(Vec<LockHolder>),
    /// The lookup could not be made in time (`reason`): "could not check",
    /// never "held" and never "free".
    Unchecked(String),
}

/// [`lock_holders`] under a deadline, with at most one such lookup in
/// flight in the process. The lookup runs on a blocking thread because it
/// can wait on a hung network mount (macOS stats every open file through its
/// filesystem; on Linux, narrow cases noted on `file_id`). A lookup still
/// running when another is wanted is neither joined nor run beside: the new
/// one waits for it within its own deadline, so stuck lookups never pile up
/// in the blocking pool. Past the deadline the caller gets
/// [`HolderLookup::Unchecked`] and the stuck lookup is left to finish on its
/// own.
pub async fn lock_holders_within(
    paths: Vec<PathBuf>,
    deadline: std::time::Duration,
) -> HolderLookup {
    static GATE: std::sync::OnceLock<std::sync::Arc<tokio::sync::Semaphore>> =
        std::sync::OnceLock::new();
    let gate = GATE.get_or_init(|| std::sync::Arc::new(tokio::sync::Semaphore::new(1)));
    bounded_lookup(gate, deadline, move || {
        if let Some(delay) = crate::testing::holder_lookup_delay() {
            std::thread::sleep(delay);
        }
        lock_holders(&paths)
    })
    .await
}

/// The process holding the writer lock of `thread_id`, which a resume is
/// about to ask an app-server for (Task 16; Stage 2: LB-28, LB-29): one
/// bounded lookup by file descriptor ([`lock_holders_within`]) of
/// `<codex_home>/thread-writer-locks/<id>.lock` over every process of this
/// server's uid, where `codex_home` is the home that app-server reported in
/// `initialize` (never the server's ambient `CODEX_HOME`/`HOME`). A holder
/// found by descriptor is alive (a zombie has no descriptors). With no
/// (absolute) home, or a lookup that cannot finish in time, nothing is
/// known: WARN `unit.resume_preflight.skipped` and `None`, so the resume
/// proceeds and Codex's own lock decides; it is never read as "held".
pub async fn holder_before_resume(
    keys: &crate::events::UnitLogKeys,
    codex_home: Option<&Path>,
    thread_id: &str,
) -> Option<LockHolder> {
    let Some(home) = codex_home.filter(|home| home.is_absolute()) else {
        crate::events::resume_preflight_skipped(keys, thread_id, "no_codex_home", "");
        return None;
    };
    let lock = codex_thread_lock_path(home, thread_id);
    match lock_holders_within(vec![lock], HOLDER_LOOKUP_DEADLINE).await {
        HolderLookup::Checked(holders) => holders.into_iter().next(),
        HolderLookup::Unchecked(detail) => {
            crate::events::resume_preflight_skipped(keys, thread_id, "lookup_unchecked", &detail);
            None
        }
    }
}

/// Why a writer conflict names no holder (`detail` of `unit.writer_conflict`):
/// no Codex home is known for the app-server that hit it.
pub const CONFLICT_NO_KNOWN_HOME: &str = "no Codex home is known for the app-server";
/// ... the lookup ran and no process this server can see holds the lock.
pub const CONFLICT_NO_VISIBLE_HOLDER: &str = "no process this server can see holds the lock";

/// Logs, at ERROR (`unit.writer_conflict`), a writer conflict Codex
/// reported by itself for `thread_id` (`source`: who saw it), naming the
/// holder one bounded lookup ([`lock_holders_within`]) finds under
/// `codex_home`, the home the refusing app-server itself reported (never the
/// server's ambient one). With no home, no visible holder, or a lookup that
/// could not finish in time, it still logs at ERROR, `holder_visible=false`
/// with the reason "held by a process outside Freshell's view"
/// (`detail` says which); it never reports the lock as released.
/// `request_id` ties the line to the request Codex refused (empty when no
/// request is known). Returns the holder it named (`None`: none visible),
/// for a caller that tells the user.
pub async fn report_writer_conflict(
    keys: &crate::events::UnitLogKeys,
    codex_home: Option<&Path>,
    thread_id: &str,
    request_id: &str,
    source: &str,
) -> Option<LockHolder> {
    let (holder, detail) = match codex_home.filter(|home| home.is_absolute()) {
        None => (None, CONFLICT_NO_KNOWN_HOME.to_string()),
        Some(home) => {
            let lock = codex_thread_lock_path(home, thread_id);
            match lock_holders_within(vec![lock], HOLDER_LOOKUP_DEADLINE).await {
                HolderLookup::Checked(holders) => match holders.into_iter().next() {
                    Some(holder) => (Some(holder), String::new()),
                    None => (None, CONFLICT_NO_VISIBLE_HOLDER.to_string()),
                },
                HolderLookup::Unchecked(reason) => (
                    None,
                    format!("the holder lookup could not finish: {reason}"),
                ),
            }
        }
    };
    crate::events::writer_conflict(
        keys,
        thread_id,
        request_id,
        holder
            .as_ref()
            .map(|holder| (holder.pid, holder.name.as_str())),
        source,
        &detail,
    );
    holder
}

/// [`lock_holders_within`] over its own `gate` and `lookup` (testable).
async fn bounded_lookup(
    gate: &std::sync::Arc<tokio::sync::Semaphore>,
    deadline: std::time::Duration,
    lookup: impl FnOnce() -> Vec<LockHolder> + Send + 'static,
) -> HolderLookup {
    let until = tokio::time::Instant::now() + deadline;
    let permit =
        match tokio::time::timeout_at(until, std::sync::Arc::clone(gate).acquire_owned()).await {
            Ok(Ok(permit)) => permit,
            Ok(Err(closed)) => return HolderLookup::Unchecked(format!("no lookup slot: {closed}")),
            Err(_) => {
                return HolderLookup::Unchecked(format!(
                    "an earlier lookup is still running after {} ms",
                    deadline.as_millis()
                ))
            }
        };
    let task = tokio::task::spawn_blocking(move || {
        // Held until this lookup ends, however long that takes.
        let _permit = permit;
        lookup()
    });
    match tokio::time::timeout_at(until, task).await {
        Ok(Ok(holders)) => HolderLookup::Checked(holders),
        Ok(Err(failed)) => HolderLookup::Unchecked(format!("the lookup failed: {failed}")),
        Err(_) => HolderLookup::Unchecked(format!(
            "the lookup did not finish within {} ms",
            deadline.as_millis()
        )),
    }
}

/// Every process whose descriptor table this server can read (in practice
/// its own uid) that currently holds one of `paths`. A missing or unlocked
/// path yields nothing. An empty answer means no VISIBLE holder: a holder of
/// another uid or in another pid namespace cannot be seen.
#[cfg(target_os = "linux")]
pub fn lock_holders(paths: &[PathBuf]) -> Vec<LockHolder> {
    lock_holders_among(paths, &crate::process::all_pids())
}

/// [`lock_holders`] restricted to `pids` (a unit's members), one entry per
/// (pid, path).
#[cfg(target_os = "linux")]
pub fn lock_holders_among(paths: &[PathBuf], pids: &[u32]) -> Vec<LockHolder> {
    scan_among(paths, pids).holders
}

/// One descriptor scan of `pids` for `paths`: the visible holders, and the
/// pids whose descriptors could not be read although they may hold one of
/// `paths` ("could not check"; never "not a holder").
#[cfg(any(target_os = "linux", target_os = "macos"))]
#[derive(Debug, Default)]
pub(crate) struct LockScan {
    pub holders: Vec<LockHolder>,
    pub unreadable: Vec<u32>,
}

/// Linux: one descriptor scan. A process is `unreadable` when its
/// descriptor table cannot be read (a same-uid process that made itself
/// non-dumpable, no descriptor or memory left in this server), or one of
/// its descriptors that names a file cannot be checked for a lock or
/// identified while it is locked, for a reason other than the process or
/// the descriptor being gone. A process another uid owns is unreadable
/// too: callers that scan every process (`lock_holders`) report only the
/// visible holders.
#[cfg(target_os = "linux")]
pub(crate) fn scan_among(paths: &[PathBuf], pids: &[u32]) -> LockScan {
    let mut wanted: Vec<(&PathBuf, FileId)> = Vec::new();
    for path in paths {
        if wanted.iter().any(|(p, _)| *p == path) {
            continue;
        }
        if let Some(id) = file_id(path) {
            wanted.push((path, id));
        }
    }
    let mut scan = LockScan::default();
    if wanted.is_empty() {
        return scan;
    }
    let ids: Vec<FileId> = wanted.iter().map(|(_, id)| *id).collect();

    let mut seen = std::collections::HashSet::new();
    for &pid in pids {
        if !seen.insert(pid) {
            continue;
        }
        let table = match descriptors(pid) {
            Ok(Some(table)) => table,
            Ok(None) => continue, // gone
            Err(_) => {
                scan.unreadable.push(pid);
                continue;
            }
        };
        let mut held: Vec<FileId> = Vec::new();
        let mut unread = false;
        for fd in &table.fds {
            match fd_lock(&table, fd, &ids) {
                Ok(Some(id)) if !held.contains(&id) => held.push(id),
                Ok(_) => {}
                Err(_) => unread = true,
            }
        }
        if unread {
            scan.unreadable.push(pid);
        }
        if held.is_empty() {
            continue;
        }
        let name = crate::process::name(pid).unwrap_or_default();
        scan.holders.extend(
            wanted
                .iter()
                .filter(|(_, id)| held.contains(id))
                .map(|(path, _)| LockHolder {
                    pid,
                    name: name.clone(),
                    path: (*path).clone(),
                }),
        );
    }
    scan
}

/// A file's (device, inode), as `stat` reports them.
#[cfg(target_os = "linux")]
type FileId = (u64, u64);

/// One process's descriptor table as `/proc` shows it.
#[cfg(target_os = "linux")]
struct Table {
    /// The directory whose `fd/` and `fdinfo/` list it.
    dir: PathBuf,
    /// The descriptor numbers listed there.
    fds: Vec<String>,
}

/// `pid`'s descriptor table. Once the main thread has exited, the leader's
/// own `fd/` is root-only and its `fdinfo/` empty, although the process
/// keeps every descriptor (and every lock on them); the table is then read
/// through a running thread, which shares it
/// (`process::through_a_running_thread`). `None` when the process is gone
/// or a zombie (whose `fd/` is root-only too, with no descriptor left);
/// `Err` when the table of a running process cannot be read ("could not
/// check").
#[cfg(target_os = "linux")]
fn descriptors(pid: u32) -> std::io::Result<Option<Table>> {
    match read_table(pid) {
        Ok(table) => Ok(Some(table)),
        Err(err) if crate::process::is_gone(&err) => Ok(None),
        Err(err) => match crate::process::is_running_checked(pid) {
            Ok(false) => Ok(None),
            Ok(true) | Err(_) => Err(err),
        },
    }
}

/// One read of `pid`'s descriptor table (see [`descriptors`]).
#[cfg(target_os = "linux")]
fn read_table(pid: u32) -> std::io::Result<Table> {
    #[cfg(test)]
    crate::process::test_reads::check(pid, "fd")?;
    let (dir, fds) = crate::process::through_a_running_thread(
        pid,
        |dir| {
            let mut fds = Vec::new();
            for entry in std::fs::read_dir(dir.join("fd"))? {
                fds.extend(entry?.file_name().to_str().map(str::to_string));
            }
            Ok((dir.to_path_buf(), fds))
        },
        |(_, fds): &(PathBuf, Vec<String>)| fds.is_empty(),
    )?;
    Ok(Table { dir, fds })
}

/// The (device, inode) of the file `path` names (following symlinks, so a
/// `/proc/<pid>/fd/<n>` link gives its open file), read with
/// `statx(AT_STATX_DONT_SYNC, STATX_INO)`. A plain `stat` asks an NFS, CIFS
/// or FUSE server for fresh attributes once its cache expires, and waits
/// for that server's timeout when the mount is unreachable (minutes on a
/// soft mount, forever on a hard one). With `AT_STATX_DONT_SYNC` those
/// filesystems answer from the attributes the kernel already has; the
/// device comes from the mount and the inode never changes, so nothing is
/// lost. (CIFS still asks its server once its cached attributes have been
/// invalidated, for example after a truncate; 9p ignores the flag.)
///
/// Where `statx` is missing or refused (on a kernel without it, glibc's
/// emulation rejects `AT_STATX_DONT_SYNC` with EINVAL; a seccomp filter may
/// answer ENOSYS or EPERM), the identity is read with a plain `stat`
/// instead, which may ask a network server: a holder must never be missed.
/// `None` when the file is missing or unreadable: no file to match.
#[cfg(target_os = "linux")]
fn file_id(path: &Path) -> Option<FileId> {
    file_id_checked(path).ok().flatten()
}

/// [`file_id`], telling a missing file (`Ok(None)`, as for a path no file
/// can have or a file with no inode number) from one whose identity could
/// not be read (`Err`, "could not check").
#[cfg(target_os = "linux")]
fn file_id_checked(path: &Path) -> std::io::Result<Option<FileId>> {
    use crate::process::is_gone;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
        return Ok(None);
    };
    let mut buf = std::mem::MaybeUninit::<libc::statx>::zeroed();
    // SAFETY: a NUL-terminated path and a writable, correctly sized buffer.
    let rc = unsafe {
        libc::statx(
            libc::AT_FDCWD,
            c_path.as_ptr(),
            libc::AT_STATX_DONT_SYNC,
            libc::STATX_INO,
            buf.as_mut_ptr(),
        )
    };
    if rc != 0 {
        let err = std::io::Error::last_os_error();
        return match err.raw_os_error() {
            Some(libc::ENOSYS | libc::EPERM | libc::EINVAL) => match std::fs::metadata(path) {
                Ok(meta) => Ok(Some((meta.dev(), meta.ino()))),
                Err(err) if is_gone(&err) => Ok(None),
                Err(err) => Err(err),
            },
            _ if is_gone(&err) => Ok(None),
            _ => Err(err),
        };
    }
    // SAFETY: statx succeeded, so it filled the (already zeroed) buffer.
    let stx = unsafe { buf.assume_init() };
    if stx.stx_mask & libc::STATX_INO == 0 {
        return Ok(None); // no inode number: the file cannot be matched
    }
    Ok(Some((
        libc::makedev(stx.stx_dev_major, stx.stx_dev_minor),
        stx.stx_ino,
    )))
}

/// The wanted file that descriptor `fd` of `table` ([`descriptors`]) refers
/// to, when the kernel lists a lock on that descriptor. The checks run
/// cheapest first: the link target (sockets, pipes and anonymous inodes are
/// never lock files), then the fdinfo `lock:` line (both are kernel
/// bookkeeping and never reach the file's filesystem), and only then the
/// identity of the open file, read without a server round trip (except as
/// noted on [`file_id`]). A full scan passes thousands of other processes'
/// open files, so it reads the identity of locked ones only. `Ok(None)`
/// also when the descriptor (or the process) is gone; `Err` when one of
/// those reads failed for another reason ("could not check").
#[cfg(target_os = "linux")]
fn fd_lock(table: &Table, fd: &str, wanted: &[FileId]) -> std::io::Result<Option<FileId>> {
    use crate::process::is_gone;
    let link = table.dir.join("fd").join(fd);
    match std::fs::read_link(&link) {
        Ok(target) if target.is_absolute() => {}
        Ok(_) => return Ok(None),
        Err(err) if is_gone(&err) => return Ok(None),
        Err(err) => return Err(err),
    }
    let fdinfo = match read_fdinfo(table, fd) {
        Ok(fdinfo) => fdinfo,
        Err(err) if is_gone(&err) => return Ok(None),
        Err(err) => return Err(err),
    };
    if !fdinfo_has_lock(&fdinfo) {
        return Ok(None);
    }
    // Follows the link to the open file.
    Ok(file_id_checked(&link)?.filter(|id| wanted.contains(id)))
}

/// One read of descriptor `fd`'s `fdinfo` in `table`.
#[cfg(target_os = "linux")]
fn read_fdinfo(table: &Table, fd: &str) -> std::io::Result<String> {
    #[cfg(test)]
    crate::process::test_reads::check_under(&table.dir, "fdinfo")?;
    std::fs::read_to_string(table.dir.join("fdinfo").join(fd))
}

/// True when an fdinfo text has a `lock:` line. In `/proc/<pid>/fdinfo/<fd>`
/// the kernel lists a lock (or lease, which prints a `lock:` line too) only
/// when it was taken through that descriptor's open file description and is
/// owned either by that description (flock and OFD locks, leases) or by the
/// process's descriptor table (POSIX locks). So a flock or OFD lock shows on
/// every descriptor sharing the description, in any process (dup'ed or
/// inherited across fork), and a POSIX lock shows only in the process that
/// took it, on the descriptors sharing the description it was taken
/// through. Either way the line means this descriptor holds a lock on its
/// file; another descriptor of the same file shows none.
#[cfg(target_os = "linux")]
fn fdinfo_has_lock(fdinfo: &str) -> bool {
    fdinfo.lines().any(|line| line.starts_with("lock:"))
}

/// Windows: every process that has one of `paths` open, as the Restart
/// Manager reports it. Codex holds its thread-writer lock with `LockFileEx`
/// on a handle that is never inherited and releases it only by closing that
/// handle, so the processes with the file open are its holders. Each holder
/// is named by its image name (falling back to the Restart Manager's
/// application name), never by its command line. An entry whose pid now
/// names a different process (started at another time) is dropped. A path
/// that does not exist yields nothing. So does one the Restart Manager
/// cannot be asked about, which is logged as a warning
/// (`containment.lock_lookup_failed`): that empty answer is not proof that
/// nobody holds the file.
#[cfg(windows)]
pub fn lock_holders(paths: &[PathBuf]) -> Vec<LockHolder> {
    let mut out: Vec<LockHolder> = Vec::new();
    let mut seen: Vec<&PathBuf> = Vec::new();
    for path in paths {
        if seen.contains(&path) || !path.exists() {
            continue;
        }
        seen.push(path);
        for (pid, start, app_name) in restart_manager::processes_using(path) {
            if crate::process::start_time(pid).ok() != Some(start) {
                continue; // exited since; the pid may name another process
            }
            let name = crate::process::name(pid)
                .ok()
                .filter(|n| !n.is_empty())
                .unwrap_or(app_name);
            out.push(LockHolder {
                pid,
                name,
                path: path.clone(),
            });
        }
    }
    out
}

/// Windows: [`lock_holders`] restricted to `pids` (a unit's members), one
/// entry per (pid, path).
#[cfg(windows)]
pub fn lock_holders_among(paths: &[PathBuf], pids: &[u32]) -> Vec<LockHolder> {
    let mut out: Vec<LockHolder> = Vec::new();
    for holder in lock_holders(paths) {
        if pids.contains(&holder.pid)
            && !out
                .iter()
                .any(|h| h.pid == holder.pid && h.path == holder.path)
        {
            out.push(holder);
        }
    }
    out
}

/// Windows: one Restart Manager session per path (one session cannot tell
/// which of its registered files a process has open).
#[cfg(windows)]
mod restart_manager {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS};
    use windows_sys::Win32::System::RestartManager::{
        RmEndSession, RmGetList, RmRegisterResources, RmStartSession, CCH_RM_SESSION_KEY,
        RM_PROCESS_INFO,
    };

    /// How many times a list that grew between the size query and the read
    /// is asked for again.
    const LIST_ATTEMPTS: usize = 4;

    /// An open Restart Manager session, always ended.
    struct Session(u32);

    impl Drop for Session {
        fn drop(&mut self) {
            // SAFETY: a session this process started, ended once.
            unsafe { RmEndSession(self.0) };
        }
    }

    /// A Restart Manager call that failed: logged, and the lookup answers
    /// nothing (it could not check).
    fn failed(call: &'static str, code: u32, path: &Path) -> Vec<(u32, u64, String)> {
        tracing::warn!(target: "freshell_unit",
            event = "containment.lock_lookup_failed",
            call,
            code,
            error = %std::io::Error::from_raw_os_error(code as i32),
            path = %path.display(),
            "the Restart Manager could not say who has a lock file open; it is reported as having no holder");
        Vec::new()
    }

    /// `(pid, start time, application name)` of every process that has
    /// `path` open (empty, after a warning, when the Restart Manager cannot
    /// be asked).
    pub(super) fn processes_using(path: &Path) -> Vec<(u32, u64, String)> {
        let mut handle = 0u32;
        let mut key = [0u16; CCH_RM_SESSION_KEY as usize + 1];
        // SAFETY: valid out-pointers; the key buffer has room for the key.
        let started = unsafe { RmStartSession(&mut handle, 0, key.as_mut_ptr()) };
        if started != ERROR_SUCCESS {
            return failed("RmStartSession", started, path);
        }
        let session = Session(handle);
        let wide: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let files = [wide.as_ptr()];
        // SAFETY: one NUL-terminated path; no applications or services.
        let registered = unsafe {
            RmRegisterResources(
                session.0,
                1,
                files.as_ptr(),
                0,
                std::ptr::null(),
                0,
                std::ptr::null(),
            )
        };
        if registered != ERROR_SUCCESS {
            return failed("RmRegisterResources", registered, path);
        }
        let mut capacity = 16usize;
        for _ in 0..LIST_ATTEMPTS {
            // SAFETY: an all-zero RM_PROCESS_INFO is valid.
            let mut list: Vec<RM_PROCESS_INFO> = vec![unsafe { std::mem::zeroed() }; capacity];
            let mut needed = 0u32;
            let mut count = capacity as u32;
            let mut reasons = 0u32;
            // SAFETY: `list` has room for `count` entries.
            let rc = unsafe {
                RmGetList(
                    session.0,
                    &mut needed,
                    &mut count,
                    list.as_mut_ptr(),
                    &mut reasons,
                )
            };
            if rc == ERROR_MORE_DATA {
                capacity = (needed as usize).max(capacity * 2);
                continue;
            }
            if rc != ERROR_SUCCESS {
                return failed("RmGetList", rc, path);
            }
            list.truncate(count as usize);
            return list
                .iter()
                .map(|info| {
                    let start = (u64::from(info.Process.ProcessStartTime.dwHighDateTime) << 32)
                        | u64::from(info.Process.ProcessStartTime.dwLowDateTime);
                    let len = info
                        .strAppName
                        .iter()
                        .position(|c| *c == 0)
                        .unwrap_or(info.strAppName.len());
                    (
                        info.Process.dwProcessId,
                        start,
                        String::from_utf16_lossy(&info.strAppName[..len]),
                    )
                })
                .collect();
        }
        // The list kept growing between the size query and the read.
        failed("RmGetList", ERROR_MORE_DATA, path)
    }
}

/// macOS: every process of this server's (effective) uid that currently
/// holds one of `paths` (other users' descriptor tables cannot be read).
#[cfg(target_os = "macos")]
pub fn lock_holders(paths: &[PathBuf]) -> Vec<LockHolder> {
    // SAFETY: geteuid has no preconditions and cannot fail.
    let me = unsafe { libc::geteuid() };
    let pids: Vec<u32> = crate::process::all_pids()
        .into_iter()
        .filter(|pid| crate::darwin::bsdinfo(*pid).is_ok_and(|info| info.pbi_uid == me))
        .collect();
    lock_holders_among(paths, &pids)
}

/// macOS: [`lock_holders`] restricted to `pids` (a unit's members), one
/// entry per (pid, path).
#[cfg(target_os = "macos")]
pub fn lock_holders_among(paths: &[PathBuf], pids: &[u32]) -> Vec<LockHolder> {
    scan_among(paths, pids).holders
}

/// One macOS descriptor scan ([`LockScan`]): the pids whose descriptors
/// could not be read although the process still runs have begun exiting,
/// so they may still hold a lock they no longer show.
#[cfg(target_os = "macos")]
pub(crate) fn scan_among(paths: &[PathBuf], pids: &[u32]) -> LockScan {
    use crate::darwin;
    use std::os::unix::fs::MetadataExt;

    let mut wanted: Vec<(&PathBuf, (u32, u64))> = Vec::new();
    for path in paths {
        if wanted.iter().any(|(p, _)| *p == path) {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(path) {
            // `st_dev` is a signed 32-bit value here; its bits are the
            // `vst_dev` libproc reports.
            wanted.push((path, (meta.dev() as u32, meta.ino())));
        }
    }
    let mut scan = LockScan::default();
    if wanted.is_empty() {
        return scan;
    }
    let mut seen = std::collections::HashSet::new();
    for &pid in pids {
        if !seen.insert(pid) {
            continue;
        }
        #[cfg(test)]
        if test_unreadable::reports(pid) {
            scan.unreadable.push(pid);
            continue;
        }
        let fds = match darwin::fds(pid) {
            Ok(fds) => fds,
            Err(_) => {
                if crate::process::is_running(pid) {
                    scan.unreadable.push(pid);
                }
                continue;
            }
        };
        let mut held: Vec<(u32, u64)> = Vec::new();
        for fd in fds
            .iter()
            .filter(|fd| fd.proc_fdtype == libc::PROX_FDTYPE_VNODE as u32)
        {
            let Some(info) = darwin::vnode_fd_info(pid, fd.proc_fd) else {
                continue;
            };
            if info.pfi.fi_openflags & darwin::FHASLOCK == 0 {
                continue;
            }
            let id = (info.pvi.vi_stat.vst_dev, info.pvi.vi_stat.vst_ino);
            if wanted.iter().any(|(_, w)| *w == id) && !held.contains(&id) {
                held.push(id);
            }
        }
        if held.is_empty() {
            continue;
        }
        let name = crate::process::name(pid).unwrap_or_default();
        scan.holders.extend(
            wanted
                .iter()
                .filter(|(_, id)| held.contains(id))
                .map(|(path, _)| LockHolder {
                    pid,
                    name: name.clone(),
                    path: (*path).clone(),
                }),
        );
    }
    scan
}

/// Test support: pids the descriptor scan reports unreadable although they
/// run, as it does for a process that has begun exiting, so a test can
/// give the Gone lock check that answer for a live process of its own.
#[cfg(all(test, target_os = "macos"))]
pub(crate) mod test_unreadable {
    use std::sync::Mutex;

    static PIDS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

    /// Reports `pid` unreadable until the returned guard is dropped.
    pub(crate) fn report(pid: u32) -> Reported {
        PIDS.lock().unwrap().push(pid);
        Reported(pid)
    }

    pub(crate) struct Reported(u32);

    impl Drop for Reported {
        fn drop(&mut self) {
            PIDS.lock().unwrap().retain(|pid| *pid != self.0);
        }
    }

    pub(super) fn reports(pid: u32) -> bool {
        PIDS.lock().unwrap().contains(&pid)
    }
}

/// macOS: unlock events on a set of lock files (`EVFILT_VNODE` /
/// `NOTE_FUNLOCK`, posted when a `flock` lock on the file is released by
/// `flock(2)` or by the last close of its open file). Registered when made,
/// so an unlock that happens after that is never missed.
#[cfg(target_os = "macos")]
pub(crate) struct UnlockEvents {
    kq: std::sync::Arc<crate::darwin::Kqueue>,
    /// The watched files (kept open while registered), by descriptor.
    files: Vec<(std::fs::File, PathBuf)>,
}

#[cfg(target_os = "macos")]
impl UnlockEvents {
    /// Watches every one of `paths` that exists.
    pub(crate) fn watch(paths: &[PathBuf]) -> std::io::Result<Self> {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        let kq = crate::darwin::Kqueue::new()?;
        let mut files = Vec::new();
        for path in paths {
            let Ok(file) = std::fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_EVTONLY)
                .open(path)
            else {
                continue; // no file, no holder
            };
            kq.change(
                file.as_raw_fd() as usize,
                libc::EVFILT_VNODE,
                libc::EV_ADD | libc::EV_CLEAR,
                crate::darwin::NOTE_FUNLOCK,
            )?;
            files.push((file, path.clone()));
        }
        Ok(Self {
            kq: std::sync::Arc::new(kq),
            files,
        })
    }

    /// Whether `path` is watched (it existed when this was made).
    pub(crate) fn watches(&self, path: &std::path::Path) -> bool {
        self.files.iter().any(|(_, watched)| watched == path)
    }

    /// Waits (on a blocking thread, woken when this is dropped) for unlock
    /// events, and returns the paths that were unlocked.
    pub(crate) async fn next(&self) -> std::io::Result<Vec<PathBuf>> {
        use std::os::fd::AsRawFd;
        let kq = self.kq.clone();
        let unlocked: Vec<usize> = tokio::task::spawn_blocking(move || {
            kq.wait(None).map(|events| {
                events
                    .iter()
                    .filter(|e| e.filter == libc::EVFILT_VNODE)
                    .map(|e| e.ident)
                    .collect()
            })
        })
        .await
        .map_err(std::io::Error::other)??;
        Ok(self
            .files
            .iter()
            .filter(|(file, _)| unlocked.contains(&(file.as_raw_fd() as usize)))
            .map(|(_, path)| path.clone())
            .collect())
    }
}

#[cfg(target_os = "macos")]
impl Drop for UnlockEvents {
    fn drop(&mut self) {
        // A wait still blocked in `next` returns.
        let _ = self.kq.wake();
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::fdinfo_has_lock;

    #[test]
    fn an_fdinfo_lock_line_means_the_descriptor_holds_a_lock() {
        let held = "pos:\t0\nflags:\t02102001\nmnt_id:\t31\nino:\t117340213\n\
                    lock:\t1: FLOCK  ADVISORY  WRITE 1006575 08:11:117340213 0 EOF\n";
        assert!(fdinfo_has_lock(held));
    }

    #[test]
    fn an_fdinfo_without_a_lock_line_holds_nothing() {
        let unlocked = "pos:\t0\nflags:\t02102001\nmnt_id:\t31\n";
        assert!(!fdinfo_has_lock(unlocked));
    }

    /// A zombie (killed, not yet reaped) has closed every descriptor. Its
    /// `fd/` is root's once its memory is gone, so the read is refused like
    /// a non-dumpable process's, but that refusal is no "could not check":
    /// it is neither a holder nor unreadable.
    #[test]
    fn a_zombie_is_neither_a_holder_nor_unreadable() {
        use crate::proc_watch::{ProcWatch, Sig};
        use std::process::Stdio;
        use std::time::Duration;
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("thread.lock");
        std::fs::write(&lock, "").unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("600")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        // The test's own unreaped child: its pid names it until the wait
        // below, so the scan reads it as a zombie.
        let killed = ProcWatch::open(child.id()).and_then(|pin| {
            pin.signal(Sig::Kill)?;
            pin.wait_exited_blocking(Duration::from_secs(5))
        });
        let scan = super::scan_among(std::slice::from_ref(&lock), &[child.id()]);
        let _ = child.kill();
        child.wait().unwrap();
        assert!(
            matches!(killed, Ok(true)),
            "the child became a zombie: {killed:?}"
        );
        assert!(
            scan.holders.is_empty() && scan.unreadable.is_empty(),
            "{scan:?}"
        );
    }
}

/// macOS: the unlock events the Gone lock check waits on when it found a
/// holder with no exit watch registered before its exit.
#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    use super::UnlockEvents;
    use crate::proc_watch::{ProcWatch, Sig};

    /// A perl `flock` holder of `path`, pinned once it holds the lock.
    fn holder(path: &std::path::Path) -> (std::process::Child, ProcWatch) {
        let mut child = Command::new("perl")
            .args([
                "-e",
                "use Fcntl qw(:flock); open(my $f, '>>', $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print \"locked\\n\"; sleep 600",
                path.to_str().unwrap(),
            ])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "locked");
        // Unreaped, so its pid names it.
        let watch = ProcWatch::open(child.id()).unwrap();
        (child, watch)
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_killed_holders_release_is_an_unlock_event_on_its_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("t.lock");
        let other = dir.path().join("other.lock");
        std::fs::write(&other, b"").unwrap();
        let (mut child, watch) = holder(&lock);
        // Registered while the lock is held; a missing file is not watched.
        let events =
            UnlockEvents::watch(&[lock.clone(), other.clone(), dir.path().join("none")]).unwrap();
        assert!(events.watches(&lock) && events.watches(&other));
        assert!(!events.watches(&dir.path().join("none")));
        watch.signal(Sig::Kill).unwrap();
        let unlocked = tokio::time::timeout(Duration::from_secs(5), events.next())
            .await
            .expect("an unlock event when the holder dies")
            .unwrap();
        assert_eq!(unlocked, [lock]);
        child.wait().unwrap();
    }

    /// A perl holder, killed (through its pin) and reaped on drop.
    struct Held(std::process::Child, ProcWatch);

    impl Drop for Held {
        fn drop(&mut self) {
            let _ = self.1.signal(Sig::Kill);
            let _ = self.0.wait();
        }
    }

    /// A wait with no unlock stays pending, and dropping the events ends a
    /// wait still blocked on its thread: the runtime that ran it finishes
    /// its shutdown (which waits for every blocking task) within a bound.
    #[test]
    fn a_wait_with_no_unlock_stays_pending_and_dropping_it_ends_the_wait() {
        let dir = tempfile::tempdir().unwrap();
        let lock = dir.path().join("t.lock");
        let (child, watch) = holder(&lock);
        let _held = Held(child, watch);
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .unwrap();
            let pending = runtime.block_on(async {
                let events = UnlockEvents::watch(std::slice::from_ref(&lock)).unwrap();
                let pending = tokio::time::timeout(Duration::from_millis(300), events.next())
                    .await
                    .is_err();
                // The wait started above is still blocked on its thread.
                drop(events);
                pending
            });
            drop(runtime);
            let _ = done_tx.send(pending);
        });
        let pending = done_rx
            .recv_timeout(Duration::from_secs(5))
            .expect("dropping the events did not end the blocked wait");
        assert!(pending, "no unlock while the holder runs");
    }
}

/// The bounded lookup behind [`lock_holders_within`]: a deadline, and one
/// lookup in flight at a time (Task 16).
#[cfg(test)]
mod bounded_tests {
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{mpsc, Arc};
    use std::time::Duration;

    use tokio::sync::Semaphore;

    use super::{bounded_lookup, HolderLookup, LockHolder};

    fn holder() -> LockHolder {
        LockHolder {
            pid: 4242,
            name: "codex".into(),
            path: PathBuf::from("/h/thread-writer-locks/t.lock"),
        }
    }

    #[tokio::test]
    async fn a_lookup_that_finishes_in_time_reports_what_it_found() {
        let gate = Arc::new(Semaphore::new(1));
        assert_eq!(
            bounded_lookup(&gate, Duration::from_secs(2), || vec![holder()]).await,
            HolderLookup::Checked(vec![holder()])
        );
        assert_eq!(
            bounded_lookup(&gate, Duration::from_secs(2), Vec::new).await,
            HolderLookup::Checked(Vec::new()),
            "nothing visible is a finished lookup too"
        );
    }

    /// A lookup that outlives its deadline (a hung network mount) answers
    /// "could not check" at the deadline, never "held" and never "free".
    #[tokio::test]
    async fn a_lookup_past_its_deadline_could_not_check() {
        let gate = Arc::new(Semaphore::new(1));
        let started = tokio::time::Instant::now();
        let answer = bounded_lookup(&gate, Duration::from_millis(100), || {
            std::thread::sleep(Duration::from_millis(600));
            vec![holder()]
        })
        .await;
        assert!(
            matches!(&answer, HolderLookup::Unchecked(reason) if reason.contains("did not finish")),
            "{answer:?}"
        );
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "answered at the deadline, not when the lookup ended"
        );
    }

    /// While one lookup is stuck, a lookup wanted meanwhile neither joins it
    /// nor runs beside it (stuck threads never pile up): it could not check.
    /// Once the stuck one ends, lookups run again.
    #[tokio::test]
    async fn a_lookup_wanted_while_one_is_stuck_neither_joins_nor_runs_beside_it() {
        let gate = Arc::new(Semaphore::new(1));
        let (release, stuck) = mpsc::channel::<()>();
        let runs = Arc::new(AtomicUsize::new(0));

        let first = bounded_lookup(&gate, Duration::from_millis(100), {
            let runs = runs.clone();
            move || {
                runs.fetch_add(1, Ordering::SeqCst);
                let _ = stuck.recv();
                vec![holder()]
            }
        })
        .await;
        assert!(matches!(first, HolderLookup::Unchecked(_)), "{first:?}");

        let second = bounded_lookup(&gate, Duration::from_millis(100), {
            let runs = runs.clone();
            move || {
                runs.fetch_add(1, Ordering::SeqCst);
                vec![holder()]
            }
        })
        .await;
        assert!(
            matches!(&second, HolderLookup::Unchecked(reason) if reason.contains("still running")),
            "{second:?}"
        );
        assert_eq!(runs.load(Ordering::SeqCst), 1, "the second never ran");

        release.send(()).expect("the stuck lookup is still waiting");
        let third = bounded_lookup(&gate, Duration::from_secs(5), {
            let runs = runs.clone();
            move || {
                runs.fetch_add(1, Ordering::SeqCst);
                Vec::new()
            }
        })
        .await;
        assert_eq!(third, HolderLookup::Checked(Vec::new()));
        assert_eq!(runs.load(Ordering::SeqCst), 2);
    }
}
