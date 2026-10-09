//! Giving a child the server's original open-file soft limit keeps the spawn
//! on std's `posix_spawn` path (`freshell_platform::child_nofile`).
//!
//! std uses `posix_spawn`, whose cost does not depend on this process's size,
//! only when a `Command` has no pre-exec step. With one it falls back to a
//! full `fork()`, which copies the whole server's page tables (about 116 ms
//! per spawn at 2.5 GB resident). glibc's `fork()` runs `pthread_atfork`
//! handlers and its `posix_spawn` does not, so a counting handler shows which
//! path a spawn took.
//!
//! This is its own test binary because it changes this process's soft
//! `RLIMIT_NOFILE`, records the process-wide original (set once) and counts
//! every fork of this process. It has one test, so nothing else forks while
//! it counts. Every process here is a child of this test and exits by itself.
#![cfg(all(target_os = "linux", target_env = "gnu"))]

use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use freshell_platform::{child_nofile, CommandRunner, StdCommandRunner};

/// The soft limit this process "started with". Set explicitly, because the
/// test runner may already run with soft == hard.
const ORIGINAL_SOFT: u64 = 512;

static FORKS: AtomicUsize = AtomicUsize::new(0);

extern "C" fn count_fork() {
    FORKS.fetch_add(1, Ordering::SeqCst);
}

fn own_limits() -> (u64, u64) {
    let mut lim = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid out-pointer to an rlimit.
    assert_eq!(unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut lim) }, 0);
    (lim.rlim_cur, lim.rlim_max)
}

fn set_own_soft(soft: u64) {
    let lim = libc::rlimit {
        rlim_cur: soft,
        rlim_max: own_limits().1,
    };
    // SAFETY: a valid rlimit whose soft value does not exceed its hard value.
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &lim) }, 0);
}

#[test]
fn the_shared_runner_restores_the_limit_without_forking_the_server() {
    // SAFETY: registers a handler that only increments an atomic.
    assert_eq!(
        unsafe { libc::pthread_atfork(Some(count_fork), None, None) },
        0
    );

    // Control: a spawn with a pre-exec step is a fork, and the handler sees
    // it. Without this, a handler that never ran would pass the check below.
    let mut forked = Command::new("true");
    // SAFETY: an empty pre-exec step.
    unsafe {
        forked.pre_exec(|| Ok(()));
    }
    let status = forked
        .stdin(Stdio::null())
        .status()
        .expect("run the control child");
    assert!(status.success());
    assert_eq!(FORKS.load(Ordering::SeqCst), 1, "the control spawn forks");

    // The server's start-up sequence: started at ORIGINAL_SOFT, recorded it,
    // raised its own soft limit to the hard limit.
    let hard = own_limits().1;
    assert!(
        hard > ORIGINAL_SOFT,
        "the test needs a hard limit above {ORIGINAL_SOFT} (got {hard})"
    );
    set_own_soft(ORIGINAL_SOFT);
    child_nofile::record_original_soft_limit(ORIGINAL_SOFT);
    set_own_soft(hard);

    // The child gets the original limit right after its spawn returns, so it
    // waits (up to 2 s) for its soft limit to drop before printing its row;
    // a child that is never reset prints the raised limit.
    let script = format!(
        "i=0; while [ \"$(ulimit -Sn)\" != {ORIGINAL_SOFT} ] && [ $i -lt 40 ]; do \
         sleep 0.05; i=$((i+1)); done; grep 'Max open files' /proc/$$/limits"
    );
    let out = StdCommandRunner::default().run("sh", &["-c", &script]);
    let forks = FORKS.load(Ordering::SeqCst) - 1;

    assert_eq!(out.exit_code, Some(0), "the child ran: {out:?}");
    let cols: Vec<&str> = out.stdout.split_whitespace().collect();
    let child_limits: (u64, u64) = (
        cols[3].parse().expect("numeric soft limit"),
        cols[4].parse().expect("numeric hard limit"),
    );
    assert_eq!(
        (forks, child_limits),
        (0, (ORIGINAL_SOFT, hard)),
        "(forks of this process, the child's (soft, hard) open-file limits)"
    );
}
