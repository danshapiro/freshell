//! Event-driven waits on cgroup v2 `cgroup.events` (populated / frozen).
//! The kernel raises a file-modified event when either value changes.
//!
//! Every caller bounds a wait with a deadline: a waiter armed on a cgroup
//! that is removed gets no event at all, and the kernel can delay an event
//! by about 10 ms and coalesce back-to-back changes (Stage 2: LB-05), so a
//! transient value can be missed and only the latest one is ever seen.
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::path::{Path, PathBuf};

fn read_flag(events: &Path, key: &str) -> Option<u8> {
    let raw = std::fs::read_to_string(events).ok()?;
    raw.lines()
        .find_map(|l| l.strip_prefix(key)?.trim().parse().ok())
}

/// Resolve when `<dir>/cgroup.events` shows `key value` (or the cgroup is gone).
pub(crate) async fn wait_flag(dir: PathBuf, key: &'static str, value: u8) {
    let events = dir.join("cgroup.events");
    // SAFETY: inotify_init1 takes flags and returns a new fd or -1.
    let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
    if fd < 0 {
        return;
    }
    // SAFETY: `fd` is a fresh inotify fd this call owns exclusively.
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let Ok(c) = std::ffi::CString::new(events.as_os_str().as_encoded_bytes()) else {
        return;
    };
    // SAFETY: a valid inotify fd and a NUL-terminated path.
    let wd = unsafe {
        libc::inotify_add_watch(
            fd.as_raw_fd(),
            c.as_ptr(),
            libc::IN_MODIFY | libc::IN_DELETE_SELF,
        )
    };
    // Watch first, then check: no lost wake-up.
    if wd < 0 || read_flag(&events, key).is_none_or(|v| v == value) {
        return;
    }
    let Ok(afd) = tokio::io::unix::AsyncFd::with_interest(fd, tokio::io::Interest::READABLE) else {
        return;
    };
    loop {
        let Ok(mut guard) = afd.readable().await else {
            return;
        };
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
        if read_flag(&events, key).is_none_or(|v| v == value) {
            return;
        }
    }
}
