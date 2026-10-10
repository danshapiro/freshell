//! Who holds a lock file.
//!
//! Linux attributes holders by file descriptor. A process holds a lock file
//! when one of its descriptors refers to that file (same device and inode
//! as `stat` of the path) and the kernel lists a lock on that descriptor (a
//! `lock:` line in `/proc/<pid>/fdinfo/<fd>`).
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
    let mut wanted: Vec<(&PathBuf, FileId)> = Vec::new();
    for path in paths {
        if wanted.iter().any(|(p, _)| *p == path) {
            continue;
        }
        if let Some(id) = file_id(path) {
            wanted.push((path, id));
        }
    }
    if wanted.is_empty() {
        return Vec::new();
    }
    let ids: Vec<FileId> = wanted.iter().map(|(_, id)| *id).collect();

    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for &pid in pids {
        if !seen.insert(pid) {
            continue;
        }
        let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
            continue; // gone, or another uid's descriptor table
        };
        let mut held: Vec<FileId> = Vec::new();
        for entry in fds.flatten() {
            let Some(fd) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            if let Some(id) = fd_holds_lock(pid, &fd, &ids) {
                if !held.contains(&id) {
                    held.push(id);
                }
            }
        }
        if held.is_empty() {
            continue;
        }
        let name = crate::process::name(pid).unwrap_or_default();
        out.extend(
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
    out
}

/// A file's (device, inode), as `stat` reports them.
#[cfg(target_os = "linux")]
type FileId = (u64, u64);

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
#[cfg(target_os = "linux")]
fn file_id(path: &Path) -> Option<FileId> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::fs::MetadataExt;

    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
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
        return match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ENOSYS | libc::EPERM | libc::EINVAL) => std::fs::metadata(path)
                .ok()
                .map(|meta| (meta.dev(), meta.ino())),
            _ => None, // missing or unreadable: no file to match
        };
    }
    // SAFETY: statx succeeded, so it filled the (already zeroed) buffer.
    let stx = unsafe { buf.assume_init() };
    if stx.stx_mask & libc::STATX_INO == 0 {
        return None; // no inode number: the file cannot be matched
    }
    Some((
        libc::makedev(stx.stx_dev_major, stx.stx_dev_minor),
        stx.stx_ino,
    ))
}

/// The wanted file that descriptor `fd` of `pid` refers to, when the kernel
/// lists a lock on that descriptor. The checks run cheapest first: the link
/// target (sockets, pipes and anonymous inodes are never lock files), then
/// the fdinfo `lock:` line (both are kernel bookkeeping and never reach the
/// file's filesystem), and only then the identity of the open file, read
/// without a server round trip (except as noted on [`file_id`]). A full scan
/// passes thousands of other processes' open files, so it reads the identity
/// of locked ones only.
#[cfg(target_os = "linux")]
fn fd_holds_lock(pid: u32, fd: &str, wanted: &[FileId]) -> Option<FileId> {
    let link = format!("/proc/{pid}/fd/{fd}");
    if !std::fs::read_link(&link).ok()?.is_absolute() {
        return None;
    }
    let fdinfo = std::fs::read_to_string(format!("/proc/{pid}/fdinfo/{fd}")).ok()?;
    if !fdinfo_has_lock(&fdinfo) {
        return None;
    }
    let id = file_id(Path::new(&link))?; // follows to the open file
    wanted.contains(&id).then_some(id)
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

/// One macOS descriptor scan: the visible holders, and the pids whose
/// descriptors could not be read although the process still runs (it has
/// begun exiting, so it may still hold a lock it no longer shows).
#[cfg(target_os = "macos")]
#[derive(Debug, Default)]
pub(crate) struct LockScan {
    pub holders: Vec<LockHolder>,
    pub unreadable: Vec<u32>,
}

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
}
