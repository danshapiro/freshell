//! Who holds a lock file, attributed by file descriptor.
//!
//! A process holds a lock file when one of its descriptors refers to that
//! file (same device and inode as `stat` of the path) and the kernel lists a
//! lock on that descriptor (a `lock:` line in `/proc/<pid>/fdinfo/<fd>`).
//! The lock table's pid column (`/proc/locks`) is never used: it names the
//! process that TOOK the lock, which may have exited while a child or an
//! inheriting process keeps the descriptor (a `flock(1)` helper), it reads 0
//! across pid namespaces, and its `maj:min:ino` never matches `stat` on
//! btrfs or on overlayfs over mixed filesystems. A lock file's existence
//! proves nothing either: only current holders are reported.
//!
//! One-shot reads only; nothing here waits or polls. Holders are named by
//! process name, never by command line (argv can carry secrets). File
//! identities are read without a server round trip (except as noted on
//! [`file_id`]), so a lookup does not wait on a slow or unreachable network
//! mount.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct LockHolder {
    pub pid: u32,
    /// The process name (Linux `comm`), never its arguments.
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

/// Not implemented on this OS yet: no visible holder (Windows: Task 6,
/// Restart Manager; macOS: Task 7, libproc `FHASLOCK`).
#[cfg(not(target_os = "linux"))]
pub fn lock_holders(_paths: &[PathBuf]) -> Vec<LockHolder> {
    Vec::new()
}

/// Not implemented on this OS yet: no visible holder (Windows: Task 6;
/// macOS: Task 7).
#[cfg(not(target_os = "linux"))]
pub fn lock_holders_among(_paths: &[PathBuf], _pids: &[u32]) -> Vec<LockHolder> {
    Vec::new()
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
