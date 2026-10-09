//! A process that raised its own open-file soft limit (as `freshell-server`
//! does at start) gives every child it starts the soft limit it recorded
//! before the raise (`freshell_platform::child_nofile`).
//!
//! This is its own test binary because it changes this process's soft
//! `RLIMIT_NOFILE` and records the process-wide original, which is set once.
//! Every process signalled here was spawned here.
#![cfg(target_os = "linux")]

use std::process::{Child, Command, Stdio};
use std::sync::Once;

use freshell_platform::child_nofile;

/// The soft limit this process "started with". Set explicitly, because the
/// test runner may already run with soft == hard.
const ORIGINAL_SOFT: u64 = 512;

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

/// Start at `ORIGINAL_SOFT`, record it, then raise the soft limit to the
/// hard limit: the server's start-up sequence. Returns the hard limit.
fn raised_like_the_server() -> u64 {
    static SETUP: Once = Once::new();
    SETUP.call_once(|| {
        let hard = own_limits().1;
        assert!(
            hard > ORIGINAL_SOFT,
            "the test needs a hard limit above {ORIGINAL_SOFT} (got {hard})"
        );
        set_own_soft(ORIGINAL_SOFT);
        child_nofile::record_original_soft_limit(ORIGINAL_SOFT);
        set_own_soft(hard);
    });
    let (soft, hard) = own_limits();
    assert_eq!(soft, hard, "this process must run with its raised limit");
    hard
}

/// `(soft, hard)` from the `Max open files` row of `/proc/<pid>/limits`.
fn nofile_limits(pid: u32) -> (u64, u64) {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/limits")).expect("read limits");
    let row = raw
        .lines()
        .find(|l| l.starts_with("Max open files"))
        .expect("Max open files row");
    let cols: Vec<&str> = row.split_whitespace().collect();
    (
        cols[3].parse().expect("numeric soft limit"),
        cols[4].parse().expect("numeric hard limit"),
    )
}

fn sleeper() -> Command {
    let mut cmd = Command::new("sleep");
    cmd.arg("30")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd
}

fn stop(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn a_child_command_starts_with_the_recorded_soft_limit() {
    let hard = raised_like_the_server();

    let mut restored = sleeper();
    child_nofile::restore_in_child(&mut restored);
    let restored = restored.spawn().expect("spawn the restored child");
    // Control: without the reset a child inherits the raised limit, so the
    // assertion below is about the reset, not about the test runner.
    let inherited = sleeper().spawn().expect("spawn the control child");

    let restored_limits = nofile_limits(restored.id());
    let inherited_limits = nofile_limits(inherited.id());
    stop(restored);
    stop(inherited);

    assert_eq!(restored_limits, (ORIGINAL_SOFT, hard));
    assert_eq!(inherited_limits, (hard, hard));
}

#[test]
fn a_running_child_gets_the_recorded_soft_limit_through_its_pid() {
    let hard = raised_like_the_server();

    let child = sleeper().spawn().expect("spawn the child");
    let before = nofile_limits(child.id());
    let result = child_nofile::restore_for_pid(child.id());
    let after = nofile_limits(child.id());
    stop(child);

    result.expect("prlimit on our own child");
    assert_eq!(before, (hard, hard));
    assert_eq!(after, (ORIGINAL_SOFT, hard));
}
