//! Event-driven waits on cgroup v2 `cgroup.events` (populated / frozen).
//! The kernel raises a file-modified event when either value changes.
//!
//! Every caller bounds a wait with a deadline: a waiter armed on a cgroup
//! that is removed gets no event at all, and the kernel can delay an event
//! by about 10 ms and coalesce back-to-back changes (Stage 2: LB-05), so a
//! transient value can be missed and only the latest one is ever seen.
//!
//! A wait that cannot watch or read the file is an error, never the value:
//! callers decide to stop a slice (and everything in it) or to kill on the
//! strength of it.
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};

/// Whether `events` shows `key value`. A file that no longer exists (the
/// cgroup was removed) holds every value; any other failure to read it, or
/// a file without `key`, is an error.
fn holds(events: &Path, key: &str, value: u8) -> io::Result<bool> {
    let raw = match std::fs::read_to_string(events) {
        Ok(raw) => raw,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(true),
        Err(err) => return Err(err),
    };
    raw.lines()
        .find_map(|l| l.strip_prefix(key)?.trim().parse::<u8>().ok())
        .map(|v| v == value)
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                format!("{} has no {key:?} line", events.display()),
            )
        })
}

/// Resolves `Ok` when `<dir>/cgroup.events` shows `key value` or the cgroup
/// is gone; `Err` when the wait cannot watch or read the file (no inotify
/// instance or watch, or a failed read).
pub(crate) async fn wait_flag(dir: PathBuf, key: &'static str, value: u8) -> io::Result<()> {
    let events = dir.join("cgroup.events");
    // SAFETY: inotify_init1 takes flags and returns a new fd or -1.
    let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `fd` is a fresh inotify fd this call owns exclusively.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let c = std::ffi::CString::new(events.as_os_str().as_encoded_bytes())
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
    // SAFETY: a valid inotify fd and a NUL-terminated path.
    let wd = unsafe {
        libc::inotify_add_watch(
            fd.as_raw_fd(),
            c.as_ptr(),
            libc::IN_MODIFY | libc::IN_DELETE_SELF,
        )
    };
    if wd < 0 {
        let err = io::Error::last_os_error();
        // Removed before the watch: nothing is left to wait for.
        return match err.kind() {
            io::ErrorKind::NotFound => Ok(()),
            _ => Err(err),
        };
    }
    // Watch first, then check: no lost wake-up.
    if holds(&events, key, value)? {
        return Ok(());
    }
    let afd = tokio::io::unix::AsyncFd::with_interest(fd, tokio::io::Interest::READABLE)?;
    loop {
        let mut guard = afd.readable().await?;
        let mut buf = [0u8; 4096];
        loop {
            // SAFETY: reading into a local buffer of the given length.
            let n = unsafe {
                libc::read(
                    afd.get_ref().as_raw_fd(),
                    buf.as_mut_ptr().cast(),
                    buf.len(),
                )
            };
            if n <= 0 {
                break;
            }
        }
        guard.clear_ready();
        if holds(&events, key, value)? {
            return Ok(());
        }
    }
}
