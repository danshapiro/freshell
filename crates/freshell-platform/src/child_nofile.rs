//! The open-file soft limit every child of this process starts with.
//!
//! `freshell-server` raises its own soft `RLIMIT_NOFILE` to the hard limit
//! at start (`freshell_containment::startup::raise_nofile_limit`), because
//! every process watch holds a pidfd. Resource limits are inherited across
//! fork and exec, so without a reset every shell, agent and helper the server
//! starts would run with that raised limit instead of the one the server was
//! started with. Some programs misbehave with a very high soft limit
//! (`select()` past descriptor 1023, loops over every possible descriptor),
//! which is why the usual practice (systemd, Go) is to raise the limit for
//! yourself and give children the original back.
//!
//! The server records its original soft limit once
//! ([`record_original_soft_limit`]) and every spawn site gives it back:
//! - a `std` or `tokio` `Command`: [`restore_in_child`] (one `setrlimit`
//!   after fork, before exec; for tokio pass `cmd.as_std_mut()`);
//! - a PTY child, which portable-pty spawns without a pre-exec hook:
//!   [`restore_for_pid`] right after the spawn (Linux `prlimit`). The child
//!   runs with the raised limit only for the moment between its exec and that
//!   call. macOS has no way to set another process's limit, so a PTY child
//!   there keeps the raised limit.
//!
//! A process that never records a limit (the session host, tests) is left
//! exactly as before: both calls do nothing.
//!
//! This lives here rather than in `freshell-containment` because
//! `freshell-terminal`, which owns the PTY spawn, stays tokio-free and does
//! not depend on containment, and this crate is the one every child-starting
//! crate shares (like [`crate::managed_child_secrets`]).

use std::sync::OnceLock;

static ORIGINAL_SOFT: OnceLock<u64> = OnceLock::new();

/// Records the soft open-file limit this process had before it raised its
/// own. The first call wins; later calls are ignored.
pub fn record_original_soft_limit(soft: u64) {
    let _ = ORIGINAL_SOFT.set(soft);
}

/// The soft open-file limit children get back, when one was recorded.
pub fn original_soft_limit() -> Option<u64> {
    ORIGINAL_SOFT.get().copied()
}

/// The limit a child should get, when it differs from what it would inherit:
/// the recorded soft limit (never above the current hard limit) with the hard
/// limit unchanged. `None` when nothing was recorded or nothing needs lowering.
#[cfg(unix)]
fn child_limit() -> Option<libc::rlimit> {
    let original = original_soft_limit()?;
    let mut current = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid out-pointer to an rlimit.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut current) } != 0 {
        return None;
    }
    // `rlim_t` is u64 on every target Freshell ships, but not on all Unixes.
    #[allow(clippy::unnecessary_cast)]
    let soft = (original as libc::rlim_t).min(current.rlim_max);
    (soft < current.rlim_cur).then_some(libc::rlimit {
        rlim_cur: soft,
        rlim_max: current.rlim_max,
    })
}

/// Makes `cmd`'s child start with the recorded soft open-file limit. Does
/// nothing when no limit was recorded (and then `cmd` keeps its fast spawn
/// path, since no pre-exec step is added).
#[cfg(unix)]
pub fn restore_in_child(cmd: &mut std::process::Command) -> &mut std::process::Command {
    use std::os::unix::process::CommandExt;
    let Some(limit) = child_limit() else {
        return cmd;
    };
    // SAFETY: the closure runs between fork and exec, so it may only make
    // async-signal-safe calls; it makes one setrlimit system call on a value
    // computed before the fork. Lowering a soft limit to or below the hard
    // limit cannot be refused; were it refused, the child would still start,
    // with the inherited limit.
    unsafe {
        cmd.pre_exec(move || {
            libc::setrlimit(libc::RLIMIT_NOFILE, &limit);
            Ok(())
        });
    }
    cmd
}

/// Off Unix there are no resource limits to restore.
#[cfg(not(unix))]
pub fn restore_in_child(cmd: &mut std::process::Command) -> &mut std::process::Command {
    cmd
}

/// Sets the running process `pid` (a child just spawned, typically a PTY
/// child) to the recorded soft open-file limit. `Ok(())` when no limit was
/// recorded.
#[cfg(target_os = "linux")]
pub fn restore_for_pid(pid: u32) -> std::io::Result<()> {
    let Some(limit) = child_limit() else {
        return Ok(());
    };
    // SAFETY: a valid pointer to an rlimit and a null old-limit pointer.
    let rc = unsafe {
        libc::prlimit(
            pid as libc::pid_t,
            libc::RLIMIT_NOFILE,
            &limit,
            std::ptr::null_mut(),
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(())
}
