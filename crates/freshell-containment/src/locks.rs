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
//! process name, never by command line (argv can carry secrets).

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
    use std::os::unix::fs::MetadataExt;

    let mut wanted: Vec<(&PathBuf, FileId)> = Vec::new();
    for path in paths {
        if wanted.iter().any(|(p, _)| *p == path) {
            continue;
        }
        if let Ok(meta) = std::fs::metadata(path) {
            wanted.push((path, (meta.dev(), meta.ino())));
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

/// The wanted file that descriptor `fd` of `pid` refers to, when the kernel
/// lists a lock on that descriptor. The checks run cheapest first: the link
/// target (sockets, pipes and anonymous inodes are never lock files), then
/// the fdinfo `lock:` line, and only then a `stat` through the descriptor.
/// So a scan never reaches into the filesystem of an unlocked file: a `stat`
/// on a slow or hung network mount can block for seconds, and a full scan
/// passes thousands of other processes' open files.
#[cfg(target_os = "linux")]
fn fd_holds_lock(pid: u32, fd: &str, wanted: &[FileId]) -> Option<FileId> {
    use std::os::unix::fs::MetadataExt;

    let link = format!("/proc/{pid}/fd/{fd}");
    if !std::fs::read_link(&link).ok()?.is_absolute() {
        return None;
    }
    let fdinfo = std::fs::read_to_string(format!("/proc/{pid}/fdinfo/{fd}")).ok()?;
    if !fdinfo_has_lock(&fdinfo) {
        return None;
    }
    let meta = std::fs::metadata(&link).ok()?; // follows to the open file
    let id = (meta.dev(), meta.ino());
    wanted.contains(&id).then_some(id)
}

/// True when an fdinfo text lists a lock. The kernel lists only the locks
/// held through that descriptor's open file description (flock) or by its
/// process on that file (POSIX), so the line means "this descriptor holds".
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
