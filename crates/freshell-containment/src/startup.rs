//! Server-start prelude, run at the top of `freshell-server`'s `main`:
//!
//! - remove an inherited unit tag from the server's own environment, so a
//!   server started from inside an agent pane never hands that pane's tag to
//!   every terminal and sidecar it starts;
//! - raise the open-file soft limit to the hard limit, so fd exhaustion under
//!   the common 1024 default cannot surface as stop errors (every `ProcWatch`
//!   holds a pidfd);
//! - one self-check of the facilities every confirmed stop rests on (pidfd
//!   and `/proc/<pid>/task/<tid>/children` on Linux), logged once.

use crate::unit_id::{LEGACY_CODEX_TAG_ENV, UNIT_ENV};

/// Removes `UNIT_ENV` and `LEGACY_CODEX_TAG_ENV` from this process's
/// environment and returns the names it removed. Call it before anything
/// else reads the environment from another thread (the top of `main`).
pub fn strip_inherited_unit_tags() -> Vec<&'static str> {
    let mut removed = Vec::new();
    for key in [UNIT_ENV, LEGACY_CODEX_TAG_ENV] {
        if std::env::var_os(key).is_some() {
            std::env::remove_var(key);
            removed.push(key);
        }
    }
    removed
}

/// Raises the soft `RLIMIT_NOFILE` to the hard limit (macOS: capped at
/// `kern.maxfilesperproc`, since an unlimited soft value is refused) and
/// returns (soft before, soft after). Errors are returned, never panicked.
#[cfg(unix)]
pub fn raise_nofile_limit() -> std::io::Result<(u64, u64)> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid out-pointer to an rlimit.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    // `rlim_t` is u64 on every target Freshell ships, but not on all Unixes.
    #[allow(clippy::unnecessary_cast)]
    let before = limit.rlim_cur as u64;
    let target = nofile_soft_target(limit.rlim_max)?;
    if limit.rlim_cur >= target {
        return Ok((before, before));
    }
    limit.rlim_cur = target;
    // SAFETY: a valid rlimit whose soft value does not exceed its hard value.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((before, target as u64))
}

/// Off Unix there is no soft open-file limit to raise.
#[cfg(not(unix))]
pub fn raise_nofile_limit() -> std::io::Result<(u64, u64)> {
    Ok((0, 0))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn nofile_soft_target(hard: libc::rlim_t) -> std::io::Result<libc::rlim_t> {
    Ok(hard)
}

#[cfg(target_os = "macos")]
fn nofile_soft_target(hard: libc::rlim_t) -> std::io::Result<libc::rlim_t> {
    let mut per_process: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    // SAFETY: a NUL-terminated name and an out-buffer of the size passed.
    let rc = unsafe {
        libc::sysctlbyname(
            c"kern.maxfilesperproc".as_ptr(),
            (&mut per_process as *mut libc::c_int).cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(hard.min(per_process.max(0) as libc::rlim_t))
}

/// The one-shot confirmation that the facilities Gone rests on exist here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfCheck {
    /// False off Linux until those platforms add their own facility checks.
    pub applicable: bool,
    /// A pidfd on the server itself opens and does not report it exited.
    pub pidfd: bool,
    /// `/proc/self/task/<pid>/children` can be read.
    pub task_children: bool,
    /// Each failure with its OS error; empty when both pass.
    pub detail: String,
}

impl SelfCheck {
    fn failed(&self) -> bool {
        self.applicable && !(self.pidfd && self.task_children)
    }
}

#[cfg(target_os = "linux")]
pub fn self_check() -> SelfCheck {
    let pid = std::process::id();
    let mut failures = Vec::new();
    let pidfd = match crate::ProcWatch::open(pid) {
        Ok(watch) if !watch.has_exited() => true,
        Ok(_) => {
            failures.push("pidfd: the server's own pidfd reports it exited".to_string());
            false
        }
        Err(err) => {
            failures.push(format!("pidfd: {err}"));
            false
        }
    };
    let task_children = match std::fs::read_to_string(format!("/proc/self/task/{pid}/children")) {
        Ok(_) => true,
        Err(err) => {
            failures.push(format!("task_children: {err}"));
            false
        }
    };
    SelfCheck {
        applicable: true,
        pidfd,
        task_children,
        detail: failures.join("; "),
    }
}

#[cfg(not(target_os = "linux"))]
pub fn self_check() -> SelfCheck {
    SelfCheck {
        applicable: false,
        pidfd: false,
        task_children: false,
        detail: "not applicable".to_string(),
    }
}

/// Logs one `event=containment.self_check` (target `freshell_unit`; ERROR
/// when the check applies and failed, INFO otherwise) and prints one stderr
/// summary line, which cloud e2e logs carry. Tag names only, never values.
pub fn log_startup(removed_tags: &[&str], nofile: &std::io::Result<(u64, u64)>, check: &SelfCheck) {
    let removed_tags = removed_tags.join(",");
    let (nofile_soft_before, nofile_soft_after, nofile_error) = match nofile {
        Ok((before, after)) => (*before, *after, String::new()),
        Err(err) => (0, 0, err.to_string()),
    };
    macro_rules! self_check_event {
        ($lvl:ident, $msg:literal) => {
            tracing::$lvl!(target: "freshell_unit",
                event = "containment.self_check",
                applicable = check.applicable,
                pidfd = check.pidfd,
                task_children = check.task_children,
                detail = %check.detail,
                removed_tags = %removed_tags,
                nofile_soft_before,
                nofile_soft_after,
                nofile_error = %nofile_error,
                $msg)
        };
    }
    if check.failed() {
        self_check_event!(
            error,
            "containment self-check failed: stops cannot confirm that agent processes exited"
        );
    } else {
        self_check_event!(info, "containment self-check");
    }
    eprintln!("{}", stderr_summary(check));
}

fn stderr_summary(check: &SelfCheck) -> String {
    let word = |ok: bool| match (check.applicable, ok) {
        (false, _) => "n/a",
        (true, true) => "ok",
        (true, false) => "failed",
    };
    format!(
        "freshell-server: containment self-check pidfd={} task_children={}",
        word(check.pidfd),
        word(check.task_children)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::log_capture::capture;

    fn check(applicable: bool, pidfd: bool, task_children: bool) -> SelfCheck {
        SelfCheck {
            applicable,
            pidfd,
            task_children,
            detail: String::new(),
        }
    }

    #[test]
    fn a_failed_check_logs_an_error_and_says_failed_on_stderr() {
        let failed = SelfCheck {
            detail: "task_children: No such file or directory (os error 2)".into(),
            ..check(true, true, false)
        };
        let events = capture(|| log_startup(&[], &Ok((1024, 1024)), &failed));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].level, tracing::Level::ERROR);
        assert_eq!(events[0].str("event"), "containment.self_check");
        assert_eq!(events[0].str("detail"), failed.detail);
        assert_eq!(
            stderr_summary(&failed),
            "freshell-server: containment self-check pidfd=ok task_children=failed"
        );
    }

    #[test]
    fn a_check_that_does_not_apply_is_info_and_not_applicable() {
        let na = check(false, false, false);
        let err = std::io::Error::other("getrlimit refused");
        let events = capture(|| log_startup(&[UNIT_ENV, LEGACY_CODEX_TAG_ENV], &Err(err), &na));
        assert_eq!(events[0].level, tracing::Level::INFO);
        assert_eq!(
            events[0].str("removed_tags"),
            "FRESHELL_UNIT_ID,FRESHELL_CODEX_SIDECAR_ID"
        );
        // An unreadable limit is reported as an error text, with numbers kept numeric.
        assert_eq!(events[0].u64("nofile_soft_before"), 0);
        assert_eq!(events[0].str("nofile_error"), "getrlimit refused");
        assert_eq!(
            stderr_summary(&na),
            "freshell-server: containment self-check pidfd=n/a task_children=n/a"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_linux_facilities_are_present_on_this_host() {
        let found = self_check();
        assert_eq!(found, check(true, true, true));
        assert_eq!(
            stderr_summary(&found),
            "freshell-server: containment self-check pidfd=ok task_children=ok"
        );
    }
}
