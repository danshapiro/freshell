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
//! ([`record_original_soft_limit`]) and every spawn site gives it back to the
//! child right after the spawn returns, with Linux `prlimit` on the child's
//! pid: [`restore_after_spawn`], or [`restore_for_pid`] where the caller logs
//! a failure itself (the PTY spawn, which logs its terminal id).
//!
//! The reset never touches the `Command`. std starts a child with
//! `posix_spawn`, whose cost does not depend on the size of this process,
//! only when the `Command` has no pre-exec step; with one it falls back to a
//! full `fork()`, which copies the whole server's page tables while holding
//! its memory-map lock (about 120 ms per spawn at 2.5 GB resident, against
//! well under 1 ms). The price of resetting after the spawn is a short
//! window: the child runs with the raised limit from its exec until the
//! parent's `prlimit`, which follows `spawn` returning. A child that starts
//! its own child inside that window passes the raised limit on.
//!
//! The window also has a reverse side. Node (and Bun) raise their own soft
//! limit to the hard limit as they start, but only when the two differ. A
//! reset that lands after that check leaves a Node child at the original
//! limit for its whole life, although it would otherwise have raised itself
//! (measured with Node 22: a reset 5 ms after the spawn lost the raise in 2
//! of 8 runs, and one 10 ms or later in every run). So a spawn site whose
//! program is always Node skips the reset: its child starts with soft equal
//! to hard and stays there, which is where Node ends anyway. Those sites are
//! the Claude sidecar, the Claude model-catalog probe and the Claude
//! session-names helper. Sites whose program may be Node, Bun or native (the
//! Codex app-server command, `opencode`) keep the reset; there a reset that
//! is several milliseconds late, which needs the spawning thread to stall,
//! can still leave a Node or Bun child, and what it starts later, at the
//! original limit.
//!
//! Only Linux can set another process's limit. On macOS every child keeps
//! the raised limit (a pre-exec step would bring back the fork), and Windows
//! has no resource limits. A process that never records a limit (the session
//! host, tests) is left exactly as before: the reset does nothing.
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

/// The limit a child should get, when it differs from what it inherits: the
/// recorded soft limit (never above the current hard limit) with the hard
/// limit unchanged. `None` when nothing was recorded or nothing needs lowering.
#[cfg(target_os = "linux")]
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
    // `rlim_t` is u64 on every target Freshell ships, but not on all Linuxes.
    #[allow(clippy::unnecessary_cast)]
    let soft = (original as libc::rlim_t).min(current.rlim_max);
    (soft < current.rlim_cur).then_some(libc::rlimit {
        rlim_cur: soft,
        rlim_max: current.rlim_max,
    })
}

/// Sets the running process `pid` (a child just spawned) to the recorded
/// soft open-file limit. `Ok(())` when no limit was recorded. Call it before
/// the child is waited for, so `pid` still names that child.
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

/// Gives a child this process just spawned the recorded soft open-file
/// limit. Call it right after `spawn` returns and before the child is waited
/// for, with the child's id (`std` `Child::id()` or tokio's `Option`) and
/// its program for the log. A child that is already gone needs nothing; any
/// other failure (for example a setuid program) is a WARN
/// `child_nofile_restore_failed`, and that child keeps the raised limit.
/// Does nothing when no limit was recorded, and off Linux. Not for a program
/// that is always Node (see the module doc).
pub fn restore_after_spawn(pid: impl Into<Option<u32>>, program: &str) {
    #[cfg(target_os = "linux")]
    if let Some(pid) = pid.into() {
        report_restore(pid, program, restore_for_pid(pid));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (pid.into(), program);
}

/// Logs the outcome of a reset: nothing when it worked or the child is
/// already gone, otherwise a WARN `child_nofile_restore_failed` that names
/// the program by its process name (the basename of argv[0]), never by a
/// configured path.
#[cfg(target_os = "linux")]
fn report_restore(pid: u32, program: &str, result: std::io::Result<()>) {
    match result {
        Ok(()) => {}
        Err(err) if err.raw_os_error() == Some(libc::ESRCH) => {}
        Err(err) => {
            let name = std::path::Path::new(program)
                .file_name()
                .map_or(std::borrow::Cow::Borrowed(program), |n| n.to_string_lossy());
            tracing::warn!(
                component = "child_nofile",
                event = "child_nofile_restore_failed",
                pid,
                program = name.as_ref(),
                error = %err,
                "child keeps the server's raised open-file limit"
            )
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use tracing::field::{Field, Visit};
    use tracing::span::{Attributes, Id, Record};
    use tracing::{Event, Metadata, Subscriber};

    /// Every field of every event, rendered as text.
    #[derive(Clone, Default)]
    struct Capture(Arc<Mutex<Vec<BTreeMap<String, String>>>>);

    struct Fields<'a>(&'a mut BTreeMap<String, String>);

    impl Visit for Fields<'_> {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            self.0.insert(field.name().into(), format!("{value:?}"));
        }
        fn record_str(&mut self, field: &Field, value: &str) {
            self.0.insert(field.name().into(), value.into());
        }
    }

    impl Subscriber for Capture {
        fn enabled(&self, _: &Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _: &Attributes<'_>) -> Id {
            Id::from_u64(1)
        }
        fn record(&self, _: &Id, _: &Record<'_>) {}
        fn record_follows_from(&self, _: &Id, _: &Id) {}
        fn event(&self, event: &Event<'_>) {
            let mut fields = BTreeMap::new();
            event.record(&mut Fields(&mut fields));
            fields.insert("level".into(), event.metadata().level().to_string());
            self.0.lock().unwrap().push(fields);
        }
        fn enter(&self, _: &Id) {}
        fn exit(&self, _: &Id) {}
    }

    fn capture(f: impl FnOnce()) -> Vec<BTreeMap<String, String>> {
        let capture = Capture::default();
        tracing::subscriber::with_default(capture.clone(), f);
        let events = capture.0.lock().unwrap().clone();
        events
    }

    #[test]
    fn a_failed_reset_names_the_program_by_its_process_name() {
        let events = capture(|| {
            super::report_restore(
                4242,
                "/opt/tools/node-22/bin/node",
                Err(std::io::Error::from_raw_os_error(libc::EPERM)),
            )
        });

        assert_eq!(events.len(), 1, "{events:?}");
        let event = &events[0];
        assert_eq!(event["level"], "WARN");
        assert_eq!(event["event"], "child_nofile_restore_failed");
        assert_eq!(event["pid"], "4242");
        // A process name (the basename of argv[0]), never a configured path.
        assert_eq!(event["program"], "node");
        assert!(
            !format!("{events:?}").contains("/opt/tools"),
            "the log names a path: {events:?}"
        );
    }

    #[test]
    fn a_child_that_is_already_gone_is_not_logged() {
        let events = capture(|| {
            super::report_restore(
                4242,
                "node",
                Err(std::io::Error::from_raw_os_error(libc::ESRCH)),
            );
            super::report_restore(4242, "node", Ok(()));
        });

        assert!(events.is_empty(), "{events:?}");
    }
}
