//! `ProcWatch::exited` answers `Err` instead of panicking when it cannot
//! register the watch because this process has no file descriptor left
//! (a panic there would poison every waiter of a stop), and a failed
//! registration is not cached: once descriptors are available again, the
//! same watch confirms the exit.
//!
//! This is its own test binary because it lowers this process's soft
//! `RLIMIT_NOFILE`, which every thread of the process shares. Every process
//! signalled here was spawned here, and only through its own pidfd.
#![cfg(target_os = "linux")]

use std::time::Duration;

use freshell_containment::{ProcWatch, Sig};

fn own_limits() -> libc::rlimit {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid out-pointer to an rlimit.
    assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
    lim
}

fn set_own_limits(lim: &libc::rlimit) {
    // SAFETY: a valid rlimit whose soft value does not exceed its hard value.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, lim) }, 0);
}

/// The lowest file descriptor number this process could open next (a new
/// descriptor always gets the lowest free number; this one is closed again).
fn lowest_free_fd() -> libc::c_int {
    use std::os::fd::AsRawFd;
    let probe = std::fs::File::open("/dev/null").expect("open /dev/null");
    probe.as_raw_fd()
}

/// Start `sleep` as a grandchild (its `sh` parent exits at once), so the test
/// process is never its parent.
fn spawn_grandchild_sleep() -> u32 {
    let out = std::process::Command::new("sh")
        .args(["-c", "sleep 600 >/dev/null 2>&1 & echo $!"])
        .output()
        .expect("spawn sh");
    String::from_utf8(out.stdout)
        .expect("utf8 pid")
        .trim()
        .parse()
        .expect("numeric pid")
}

/// Kills the watched grandchild through its pidfd when dropped, so a failing
/// (even panicking) run leaves nothing behind.
struct KillOnDrop(ProcWatch);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.signal(Sig::Kill);
    }
}

// current_thread: no worker thread can open a descriptor while the limit is
// lowered.
#[tokio::test(flavor = "current_thread")]
async fn exited_returns_an_error_instead_of_panicking_when_no_fd_is_left() {
    let pid = spawn_grandchild_sleep();
    let guard = KillOnDrop(ProcWatch::open(pid).expect("open the watch"));
    let watch = guard.0.clone();
    assert!(!watch.has_exited());

    // Every descriptor below the soft limit is now in use: the duplicate
    // pidfd the registration needs cannot be opened.
    let original = own_limits();
    let exhausted = libc::rlimit {
        rlim_cur: lowest_free_fd() as libc::rlim_t,
        rlim_max: original.rlim_max,
    };
    set_own_limits(&exhausted);
    let starved = tokio::time::timeout(Duration::from_secs(5), watch.exited()).await;
    set_own_limits(&original);

    let err = starved
        .expect("an exhausted registration answers at once")
        .expect_err("no descriptor left: the watch cannot be registered");
    assert_eq!(err.raw_os_error(), Some(libc::EMFILE), "{err}");

    // The failure was not cached: with descriptors available again the same
    // watch registers and confirms the exit.
    watch.signal(Sig::Kill).expect("kill through the pidfd");
    tokio::time::timeout(Duration::from_secs(5), watch.exited())
        .await
        .expect("the exit is confirmed in time")
        .expect("the watch registers once descriptors are available");
    assert!(watch.has_exited());
}
