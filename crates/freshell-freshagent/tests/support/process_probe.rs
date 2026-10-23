//! Whether a process a test started, or its whole process group, is still
//! running. A zombie (a process that was killed but not yet reaped) is not:
//! it runs nothing, holds no pipes and writes nothing.
//!
//! Tests must not ask `kill(pid, 0)` instead, because it still finds a
//! zombie. When the sidecar's tree guard kills a grandchild whose parent has
//! already exited, the grandchild is adopted by init or the nearest
//! subreaper (`systemd --user` on a desktop, a container's init) and stays a
//! zombie until that process gets round to reaping it. On a loaded machine
//! that can be well after the guard rightly confirmed the tree gone, which
//! is how `kill(pid, 0)` made `claude_sidecar_teardown` flaky in CI.
//!
//! - **Linux**: [`ProcessProbe::running`] is exact, from `/proc/<pid>/stat`.
//!   A process runs until it is gone, dead (`X`), or a zombie (`Z`) with no
//!   other thread left. A `Z` process that still has threads is either one
//!   whose main thread ended while another thread runs on (it is running),
//!   or one a signal killed whose other threads are still finishing their
//!   exit, which takes a moment on a loaded machine.
//! - **Other Unix** (macOS): without `/proc` a zombie cannot be told from a
//!   running process, so a zombie counts as running until it is reaped.
//! - **Windows**: exact, from a process handle opened while the process ran.
//!   Windows has no zombies.
//!
//! So on Unix, [`ProcessProbe::exited`] gives a killed process up to
//! [`EXIT_ALLOWANCE`] to finish exiting and, where that is the only way to
//! tell, to be reaped. That never hides a process left running: nothing ends
//! one in the meantime, so it is still running when the allowance ends.
//!
//! On Windows it answers at once. The tree guard confirms a tree only once
//! every member's process handle is signaled, so a member must have exited
//! by then. A wait would also be unsound there: dropping the guard closes
//! its kill-on-close job, which would end a process the guard had wrongly
//! reported gone while the probe was still waiting.
//!
//! Shared by the `claude_sidecar_teardown` integration test and the crate's
//! unit tests (`lib.rs` includes this file under `cfg(all(test, unix))`).
#![allow(dead_code)] // each including test crate uses a different subset

use std::time::{Duration, Instant};

/// How long a killed process gets to finish exiting (and, off Linux, to be
/// reaped by whoever adopted it) before it counts as still running.
#[cfg(unix)]
pub const EXIT_ALLOWANCE: Duration = Duration::from_secs(5);

const POLL: Duration = Duration::from_millis(20);

/// Observes one process. Open it while the process is known to run: on
/// Linux and Windows a process that later reuses its id is then never
/// mistaken for it.
pub struct ProcessProbe {
    #[cfg(unix)]
    pid: u32,
    /// The kernel's start time for `pid` when the probe was opened.
    #[cfg(target_os = "linux")]
    start_time: Option<u64>,
    #[cfg(windows)]
    watch: freshell_platform::process_job::ProcessExitWatch,
}

impl ProcessProbe {
    pub fn open(pid: u32) -> Self {
        Self {
            #[cfg(unix)]
            pid,
            #[cfg(target_os = "linux")]
            start_time: linux::stat(pid).map(|stat| stat.start_time),
            #[cfg(windows)]
            watch: freshell_platform::process_job::ProcessExitWatch::open(pid)
                .expect("open the process while it runs"),
        }
    }

    /// Whether the process is running now (see the module docs for what
    /// that means on each platform).
    pub fn running(&self) -> bool {
        #[cfg(target_os = "linux")]
        {
            match linux::stat(self.pid) {
                None => false,
                Some(stat)
                    if self
                        .start_time
                        .is_some_and(|start| start != stat.start_time) =>
                {
                    // The id now names a newer process: ours has exited.
                    false
                }
                Some(stat) => stat.running,
            }
        }
        #[cfg(all(unix, not(target_os = "linux")))]
        {
            signal_zero_finds(self.pid as i32)
        }
        #[cfg(windows)]
        {
            !self
                .watch
                .wait(Duration::ZERO)
                .expect("wait on the process")
        }
    }

    /// Whether the process has exited (a zombie has). Returns as soon as it
    /// has; on Unix a process still exiting gets [`EXIT_ALLOWANCE`].
    pub async fn exited(&self) -> bool {
        #[cfg(unix)]
        {
            self.exits_within(EXIT_ALLOWANCE).await
        }
        #[cfg(windows)]
        {
            !self.running()
        }
    }

    /// Whether the process exits within `budget`.
    pub async fn exits_within(&self, budget: Duration) -> bool {
        poll_until_stopped(budget, || self.running()).await
    }
}

/// Observes a process group: it has exited once none of its members runs.
#[cfg(unix)]
pub struct ProcessGroupProbe {
    pgid: i32,
}

#[cfg(unix)]
impl ProcessGroupProbe {
    pub fn new(pgid: i32) -> Self {
        Self { pgid }
    }

    /// Whether any member of the group is running now, in the sense of
    /// [`ProcessProbe::running`].
    pub fn running(&self) -> bool {
        // ESRCH: nothing at all, not even a zombie, is left in the group.
        if !signal_zero_finds(-self.pgid) {
            return false;
        }
        #[cfg(target_os = "linux")]
        {
            linux::group_has_running_member(self.pgid)
        }
        #[cfg(not(target_os = "linux"))]
        {
            true
        }
    }

    /// Whether every member of the group has exited (zombies have). Returns
    /// as soon as they have; members still exiting get [`EXIT_ALLOWANCE`].
    pub async fn exited(&self) -> bool {
        self.exits_within(EXIT_ALLOWANCE).await
    }

    /// Whether every member of the group exits within `budget`.
    pub async fn exits_within(&self, budget: Duration) -> bool {
        poll_until_stopped(budget, || self.running()).await
    }
}

/// `kill(target, 0)` finds a process (or, for a negative target, a group
/// member), zombies included.
#[cfg(unix)]
fn signal_zero_finds(target: i32) -> bool {
    // SAFETY: signal 0 only probes for existence.
    let result = unsafe { libc::kill(target, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Poll `running` until it answers `false` (`true`) or `budget` ends (`false`).
async fn poll_until_stopped(budget: Duration, running: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + budget;
    while running() {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(POLL).await;
    }
    true
}

#[cfg(target_os = "linux")]
mod linux {
    /// What `/proc/<pid>/stat` says about a process.
    pub struct Stat {
        pub process_group: i32,
        pub start_time: u64,
        pub running: bool,
    }

    /// The process's stat, or `None` once there is no such process (or, for
    /// another user's process, when `/proc` hides it).
    pub fn stat(pid: u32) -> Option<Stat> {
        let text = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // The command name (field 2) may hold spaces and parentheses, so the
        // fields resume after the last ')', at field 3 (state).
        let (_, rest) = text
            .rsplit_once(')')
            .unwrap_or_else(|| panic!("malformed /proc/{pid}/stat: {text}"));
        let fields: Vec<&str> = rest.split_whitespace().collect();
        // `proc(5)` numbers the fields from 1.
        let field = |index: usize| {
            *fields
                .get(index - 3)
                .unwrap_or_else(|| panic!("/proc/{pid}/stat has no field {index}: {text}"))
        };
        let number = |index: usize| -> i64 {
            field(index)
                .parse()
                .unwrap_or_else(|_| panic!("/proc/{pid}/stat field {index} is no number: {text}"))
        };
        let threads = number(20);
        Some(Stat {
            process_group: number(5) as i32,
            start_time: number(22) as u64,
            running: match field(3) {
                // Threads other than the ended main thread are left.
                "Z" => threads > 1,
                "X" | "x" => false,
                _ => true,
            },
        })
    }

    /// Whether a running process is in group `pgid`.
    pub fn group_has_running_member(pgid: i32) -> bool {
        std::fs::read_dir("/proc")
            .expect("list /proc")
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter_map(stat)
            .any(|stat| stat.process_group == pgid && stat.running)
    }
}
