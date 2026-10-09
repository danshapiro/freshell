//! Linux `__unit-exec --reaper`: the child-subreaper shim every member of a
//! Linux fallback (tag backend) unit starts under.
//!
//! The kernel reparents every orphaned descendant (a `setsid` or
//! double-forked job, whatever it does to its environment) to its nearest
//! living subreaper ancestor, so while the shim lives everything the pane
//! started stays in the shim's tree, and that tree is the unit's membership.
//! The shim:
//!
//! 1. marks itself a child subreaper (exit 126 before starting anything when
//!    refused, so the member fails before its placement is confirmed);
//! 2. starts the command as its child in the command's own process group,
//!    made the terminal's foreground group when the shim owns one, so a
//!    Ctrl+C or a resize the user makes reaches the agent, never the shim;
//! 3. forwards SIGINT, SIGTERM, SIGHUP and SIGQUIT to the command;
//! 4. reaps every child (adopted orphans included) until the command exits;
//! 5. kills what is left of its own tree with the stop-the-world sweep,
//!    sparing the Codex daemon family, without waiting for the killed
//!    processes (whoever adopts them reaps them);
//! 6. exits with the command's status: its exit code, or the same signal
//!    raised on itself.
//!
//! It never reads or writes the terminal and holds no state beyond the
//! child's pid.

use std::collections::BTreeSet;
use std::ffi::{OsStr, OsString};
use std::io;
use std::os::unix::process::CommandExt;
use std::sync::atomic::{AtomicI32, Ordering};

use crate::backend::tag::{daemon_family_within, stop_the_world, with_descendants};
use crate::process;

/// The member could not be contained (no subreaper): exit before starting.
const NOT_CONTAINED_EXIT: i32 = 126;
/// The command could not be started (the shell convention).
const START_FAILED_EXIT: i32 = 127;

const FORWARDED: [libc::c_int; 4] = [libc::SIGINT, libc::SIGTERM, libc::SIGHUP, libc::SIGQUIT];

/// The command's pid while it runs (0 once it is reaped): the only state the
/// signal handler reads.
static CHILD: AtomicI32 = AtomicI32::new(0);

extern "C" fn forward(sig: libc::c_int) {
    // Async-signal-safe only: an atomic load and kill(2), errno preserved.
    // SAFETY: __errno_location returns this thread's errno slot.
    let errno = unsafe { *libc::__errno_location() };
    let pid = CHILD.load(Ordering::SeqCst);
    if pid > 0 {
        // SAFETY: kill is async-signal-safe; `pid` is our unreaped child.
        unsafe { libc::kill(pid, sig) };
    }
    // SAFETY: as above.
    unsafe { *libc::__errno_location() = errno };
}

/// Runs `program args` under the shim and returns the exit code for the
/// shim's own exit (it does not return when the command died by a signal:
/// the shim raises that signal on itself).
pub(crate) fn run(program: &OsStr, args: &[OsString]) -> i32 {
    // 1. Become a child subreaper.
    // SAFETY: prctl with integer arguments.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        eprintln!(
            "freshell-unit-exec: cannot become a child subreaper: {}",
            io::Error::last_os_error()
        );
        return NOT_CONTAINED_EXIT;
    }

    // 2. Block the forwarded signals until the handlers know the child.
    let mut blocked = empty_sigset();
    for sig in FORWARDED {
        // SAFETY: a valid, initialized sigset.
        unsafe { libc::sigaddset(&mut blocked, sig) };
    }
    let mut previous = empty_sigset();
    // SAFETY: valid sigsets.
    unsafe { libc::pthread_sigmask(libc::SIG_BLOCK, &blocked, &mut previous) };

    let foreground = owns_terminal_foreground();
    let mut command = std::process::Command::new(program);
    command.args(args);
    // SAFETY: the closure makes only async-signal-safe calls.
    unsafe {
        command.pre_exec(move || {
            // The command starts with nothing blocked.
            let none = empty_sigset();
            libc::pthread_sigmask(libc::SIG_SETMASK, &none, std::ptr::null_mut());
            if libc::setpgid(0, 0) != 0 {
                return Err(io::Error::last_os_error());
            }
            if foreground {
                take_terminal_foreground(libc::getpid());
            }
            Ok(())
        });
    }
    let child = match command.spawn() {
        Ok(child) => child,
        Err(err) => {
            eprintln!(
                "freshell-unit-exec: cannot start {}: {err}",
                program.to_string_lossy()
            );
            return START_FAILED_EXIT;
        }
    };
    let pid = child.id() as libc::pid_t;
    // The same calls on the shim's side (the usual shell order), so neither
    // side races; EACCES once the child exec'd is expected.
    // SAFETY: plain syscalls on our own child.
    unsafe { libc::setpgid(pid, pid) };
    if foreground {
        take_terminal_foreground(pid);
    }

    // 3. Forward, then unblock (a signal that arrived meanwhile is forwarded).
    CHILD.store(pid, Ordering::SeqCst);
    for sig in FORWARDED {
        install_forwarder(sig);
    }
    // SAFETY: a valid sigset.
    unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &previous, std::ptr::null_mut()) };

    // 4. Reap until the command itself exits.
    let status = reap_until(pid);
    drop(child); // already reaped above; dropping a std Child never waits

    // 5. Kill what is left of the tree, sparing the Codex daemon family.
    sweep_own_tree();

    // 6. Exit as the command did.
    match status {
        Some(status) if libc::WIFSIGNALED(status) => {
            let sig = libc::WTERMSIG(status);
            reraise(sig);
            128 + sig
        }
        Some(status) if libc::WIFEXITED(status) => libc::WEXITSTATUS(status),
        _ => 1,
    }
}

fn empty_sigset() -> libc::sigset_t {
    // SAFETY: sigemptyset initializes the set it is given.
    unsafe {
        let mut set = std::mem::zeroed::<libc::sigset_t>();
        libc::sigemptyset(&mut set);
        set
    }
}

/// True when fd 0 is our controlling terminal and our process group is its
/// foreground group (a screen: the PTY session leader portable-pty made us).
fn owns_terminal_foreground() -> bool {
    // SAFETY: plain queries on fd 0 and ourselves.
    unsafe { libc::isatty(0) == 1 && libc::tcgetpgrp(0) == libc::getpgrp() }
}

/// Makes `pgid` the terminal's foreground group. SIGTTOU stays ignored
/// around the call (a background group's `tcsetpgrp` would stop it).
/// Async-signal-safe: also called in the child before exec.
fn take_terminal_foreground(pgid: libc::pid_t) {
    // SAFETY: signal and tcsetpgrp are async-signal-safe.
    unsafe {
        let old = libc::signal(libc::SIGTTOU, libc::SIG_IGN);
        libc::tcsetpgrp(0, pgid);
        libc::signal(libc::SIGTTOU, old);
    }
}

fn install_forwarder(sig: libc::c_int) {
    // SAFETY: a zeroed sigaction with a valid handler, mask and flags.
    unsafe {
        let mut action = std::mem::zeroed::<libc::sigaction>();
        action.sa_sigaction = forward as extern "C" fn(libc::c_int) as libc::sighandler_t;
        action.sa_flags = libc::SA_RESTART;
        libc::sigemptyset(&mut action.sa_mask);
        for other in FORWARDED {
            libc::sigaddset(&mut action.sa_mask, other);
        }
        libc::sigaction(sig, &action, std::ptr::null_mut());
    }
}

/// Reaps every child until `pid` exits and returns its wait status. The
/// command is seen exited without being reaped first (`WNOWAIT`), so the
/// handler stops forwarding before its pid can be reused.
fn reap_until(pid: libc::pid_t) -> Option<libc::c_int> {
    loop {
        // SAFETY: a zeroed siginfo out-buffer.
        let mut info = unsafe { std::mem::zeroed::<libc::siginfo_t>() };
        // SAFETY: P_ALL with a valid out-pointer.
        let rc = unsafe { libc::waitid(libc::P_ALL, 0, &mut info, libc::WEXITED | libc::WNOWAIT) };
        if rc != 0 {
            match io::Error::last_os_error().raw_os_error() {
                Some(libc::EINTR) => continue,
                _ => return None, // ECHILD: nothing left to wait for
            }
        }
        // SAFETY: waitid filled a child-state siginfo.
        let exited = unsafe { info.si_pid() };
        if exited == pid {
            CHILD.store(0, Ordering::SeqCst);
        }
        let mut status = 0;
        loop {
            // SAFETY: reaping a child waitid just reported.
            let rc = unsafe { libc::waitpid(exited, &mut status, 0) };
            if rc == -1 && io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            break;
        }
        if exited == pid {
            return Some(status);
        }
    }
}

/// Kills every remaining descendant of the shim, sparing the Codex daemon
/// family (each judged by its own argv, plus its descendants). Descendants
/// come from one-shot `/proc` child reads; nothing is awaited.
fn sweep_own_tree() {
    let me = std::process::id();
    let _ = stop_the_world(
        || {
            let mut candidates = with_descendants(BTreeSet::from([me]), me);
            candidates.remove(&me);
            // Zombies (killed, not yet reaped) are done.
            candidates.retain(|pid| process::is_running(*pid));
            let spared = daemon_family_within(&candidates);
            (candidates, spared)
        },
        |pid, candidates| {
            process::parent(pid).is_some_and(|parent| parent == me || candidates.contains(&parent))
        },
    );
}

/// Dies by `sig` like the command did, so the PTY reader and the stop
/// sequence see the status it produced.
fn reraise(sig: libc::c_int) {
    // SAFETY: restoring the default action, unblocking and raising on self.
    unsafe {
        libc::signal(sig, libc::SIG_DFL);
        let mut set = empty_sigset();
        libc::sigaddset(&mut set, sig);
        libc::pthread_sigmask(libc::SIG_UNBLOCK, &set, std::ptr::null_mut());
        libc::raise(sig);
    }
}
