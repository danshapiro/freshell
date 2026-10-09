//! A PTY child starts with the open-file soft limit its server recorded
//! before raising its own (`freshell_platform::child_nofile`), even though
//! portable-pty has no pre-exec hook: the spawn sets the child's limit right
//! after it starts.
//!
//! This is its own test binary because it changes this process's soft
//! `RLIMIT_NOFILE` and records the process-wide original, which is set once.
//! The only process stopped here is the PTY child this test spawned.
#![cfg(target_os = "linux")]

use std::collections::BTreeMap;

use freshell_platform::{child_nofile, SpawnSpec};
use freshell_terminal::pty::PtyTerminal;

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

#[test]
fn a_pty_child_starts_with_the_recorded_soft_limit() {
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
    assert_eq!(own_limits(), (hard, hard));

    let spec = SpawnSpec {
        program: "sleep".into(),
        args: vec!["30".into()],
        env_overrides: BTreeMap::new(),
        cwd: None,
        cols: 80,
        rows: 24,
    };
    let env: BTreeMap<String, String> = std::env::vars().filter(|(k, _)| k == "PATH").collect();
    let mut pty =
        PtyTerminal::spawn(&spec, &env, "t-nofile", "s-nofile", None).expect("spawn the PTY");
    let pid = pty.pid().expect("the PTY child's pid");
    let child_limits = nofile_limits(pid);
    pty.kill();

    assert_eq!(child_limits, (ORIGINAL_SOFT, hard));
}
