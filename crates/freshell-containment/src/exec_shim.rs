//! `unit_exec_main`: the `__unit-exec` shim a contained member is started
//! through: `[options] -- <command> [args...]`.
//!
//! Options (before `--`):
//! - `--job <name>` (Windows): first register a console control handler
//!   that keeps the shim alive through Ctrl-C and Ctrl-Break (the command
//!   still gets them), then put THIS process into the named unit job, before
//!   anything is started, so the command and everything it starts inherit
//!   the job (the Windows backend's race-free placement). Exit 3 when the
//!   job cannot be opened, 4 when the shim cannot join it, 5 when the
//!   handler cannot be registered; nothing is started then. Other OSes
//!   ignore it.
//! - `--reaper` (Linux): run the command under the child-subreaper shim
//!   (`crate::reaper`), the Linux fallback backend's member root. Other OSes
//!   ignore it (no backend there places with it).
//! - `--setsid` (macOS): make this process its own session leader (it
//!   already is one under a PTY), then exec the command in place, so the pid
//!   the spawner saw is the command's and everything it starts that never
//!   calls `setsid` stays in its session: the macOS backend's root
//!   placement, which its fork tracker follows. Exit 127 when the command
//!   cannot be started. Other OSes ignore it.
//! - `--nofile-soft=<n>` (Linux): lower this shim's own open-file soft limit
//!   to `n` (capped at the hard limit) before it starts the command, so the
//!   command starts with the server's original limit instead of the server's
//!   raised one. The server passes `child_nofile::original_soft_limit()`
//!   here; resetting the shim from outside after its spawn would come too
//!   late for the command it already started. A malformed value is ignored
//!   with a one-line note on stderr.
//!
//! Without `--reaper` it runs the command, waits for it and exits with its
//! status (128 + the signal number when a signal ended it).

use std::ffi::{OsStr, OsString};
use std::process::ExitStatus;

/// Exit status for a malformed invocation (no command after `--`).
const USAGE_EXIT: i32 = 2;
/// Exit status when the command cannot be started (the shell convention).
const START_FAILED_EXIT: i32 = 127;

#[derive(Debug, Default, PartialEq, Eq)]
struct Options {
    reaper: bool,
    setsid: bool,
    nofile_soft: Option<u64>,
    job: Option<OsString>,
}

fn parse_options(options: &[OsString]) -> Options {
    let mut parsed = Options::default();
    let mut it = options.iter();
    while let Some(raw) = it.next() {
        if raw == "--job" {
            parsed.job = it.next().cloned();
            continue;
        }
        let Some(option) = raw.to_str() else {
            continue;
        };
        if option == "--reaper" {
            parsed.reaper = true;
        } else if option == "--setsid" {
            parsed.setsid = true;
        } else if let Some(n) = option.strip_prefix("--nofile-soft=") {
            parsed.nofile_soft = n.parse().ok();
            if parsed.nofile_soft.is_none() {
                // The server builds this value, so this is a wiring mistake.
                eprintln!(
                    "freshell-unit-exec: ignoring malformed --nofile-soft value {n:?}; the open-file limit stays as inherited"
                );
            }
        }
    }
    parsed
}

/// Runs `args[after "--"]` as described in the module docs and returns the
/// shim's exit code.
pub fn unit_exec_main(args: Vec<OsString>) -> i32 {
    let (options, command) = match args.iter().position(|a| a == "--") {
        Some(sep) => (parse_options(&args[..sep]), &args[sep + 1..]),
        None => (Options::default(), &args[..0]),
    };
    let Some((program, rest)) = command.split_first() else {
        eprintln!("freshell-unit-exec: usage: freshell-unit-exec [options] -- <command> [args...]");
        return USAGE_EXIT;
    };
    if let Some(soft) = options.nofile_soft {
        lower_nofile_soft_limit(soft);
    }
    #[cfg(windows)]
    if let Err(code) = windows::prepare(options.job.as_deref()) {
        return code;
    }
    #[cfg(not(windows))]
    let _ = options.job; // only the Windows backend places with a job
    #[cfg(target_os = "linux")]
    if options.reaper {
        return crate::reaper::run(program, rest);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = options.reaper; // no backend places with it off Linux
    #[cfg(target_os = "macos")]
    if options.setsid {
        macos::become_session_leader();
        return macos::exec_in_place(program, rest);
    }
    #[cfg(not(target_os = "macos"))]
    let _ = options.setsid; // a macOS option
    run_plain(program, rest)
}

/// macOS: the session leader and its in-place exec.
#[cfg(target_os = "macos")]
mod macos {
    use std::ffi::{OsStr, OsString};
    use std::os::unix::process::CommandExt;

    use super::START_FAILED_EXIT;

    /// `setsid()`; it fails (EPERM) only when this process already leads a
    /// process group, as a PTY child leads its own session: nothing to do.
    pub(super) fn become_session_leader() {
        // SAFETY: plain setsid(2) on this single-threaded process.
        unsafe { libc::setsid() };
    }

    /// Replaces this process with `program rest...` (searched on `PATH`).
    /// Returns only when that fails.
    pub(super) fn exec_in_place(program: &OsStr, rest: &[OsString]) -> i32 {
        let err = std::process::Command::new(program).args(rest).exec();
        eprintln!(
            "freshell-unit-exec: cannot start {}: {err}",
            program.to_string_lossy()
        );
        START_FAILED_EXIT
    }
}

fn run_plain(program: &OsStr, rest: &[OsString]) -> i32 {
    match std::process::Command::new(program).args(rest).status() {
        Ok(status) => exit_code(status),
        Err(err) => {
            eprintln!(
                "freshell-unit-exec: cannot start {}: {err}",
                program.to_string_lossy()
            );
            START_FAILED_EXIT
        }
    }
}

/// Lowers (never raises) this process's soft `RLIMIT_NOFILE` to `soft`.
#[cfg(target_os = "linux")]
fn lower_nofile_soft_limit(soft: u64) {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid out-pointer to an rlimit.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return;
    }
    let target = soft.min(limit.rlim_max);
    if target >= limit.rlim_cur {
        return;
    }
    limit.rlim_cur = target;
    // SAFETY: a valid rlimit whose soft value does not exceed its hard value.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
        eprintln!(
            "freshell-unit-exec: cannot lower the open-file soft limit: {}",
            std::io::Error::last_os_error()
        );
    }
}

/// Off Linux the server records no limit to restore (see
/// `freshell_platform::child_nofile`).
#[cfg(not(target_os = "linux"))]
fn lower_nofile_soft_limit(_soft: u64) {}

/// Windows: the console control handler and the job self-assignment.
#[cfg(windows)]
mod windows {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    use windows_sys::Win32::Foundation::{CloseHandle, BOOL, FALSE, TRUE};
    use windows_sys::Win32::System::Console::{
        SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_C_EVENT,
    };
    use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, OpenJobObjectW};
    use windows_sys::Win32::System::SystemServices::JOB_OBJECT_ASSIGN_PROCESS;
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    /// The job named by `--job` cannot be opened.
    const JOB_OPEN_FAILED_EXIT: i32 = 3;
    /// The shim cannot join the job.
    const JOB_ASSIGN_FAILED_EXIT: i32 = 4;
    /// The console control handler cannot be registered.
    const HANDLER_FAILED_EXIT: i32 = 5;

    /// Ctrl-C and Ctrl-Break reach every process attached to the console;
    /// the default handler would end the shim (`ExitProcess`) while the
    /// command runs on, so the shim handles both and stays. Other events
    /// (console close, logoff, shutdown) go to the default handler.
    unsafe extern "system" fn keep_running(ctrl_type: u32) -> BOOL {
        if ctrl_type == CTRL_C_EVENT || ctrl_type == CTRL_BREAK_EVENT {
            TRUE
        } else {
            FALSE
        }
    }

    /// Registers the handler (never `SetConsoleCtrlHandler(NULL, TRUE)`:
    /// that "ignore Ctrl-C" attribute is inherited and would disable Ctrl-C
    /// in the command), then joins `job` when one is named.
    pub(super) fn prepare(job: Option<&OsStr>) -> Result<(), i32> {
        // SAFETY: registers a handler routine that lives for the process.
        if unsafe { SetConsoleCtrlHandler(Some(keep_running), TRUE) } == 0 {
            eprintln!(
                "freshell-unit-exec: cannot register the console control handler: {}",
                std::io::Error::last_os_error()
            );
            return Err(HANDLER_FAILED_EXIT);
        }
        let Some(name) = job else {
            return Ok(());
        };
        let wide: Vec<u16> = name.encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: a NUL-terminated name; the handle is checked and closed.
        let handle = unsafe { OpenJobObjectW(JOB_OBJECT_ASSIGN_PROCESS, FALSE, wide.as_ptr()) };
        if handle.is_null() {
            eprintln!(
                "freshell-unit-exec: cannot open job {}: {}",
                name.to_string_lossy(),
                std::io::Error::last_os_error()
            );
            return Err(JOB_OPEN_FAILED_EXIT);
        }
        // SAFETY: a live job handle and this process's pseudo-handle.
        let joined = unsafe { AssignProcessToJobObject(handle, GetCurrentProcess()) } != 0;
        let err = std::io::Error::last_os_error();
        // SAFETY: the handle is ours and closed once.
        unsafe { CloseHandle(handle) };
        if !joined {
            eprintln!(
                "freshell-unit-exec: cannot join job {}: {err}",
                name.to_string_lossy()
            );
            return Err(JOB_ASSIGN_FAILED_EXIT);
        }
        Ok(())
    }
}

fn exit_code(status: ExitStatus) -> i32 {
    if let Some(code) = status.code() {
        return code;
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        if let Some(signal) = status.signal() {
            return 128 + signal;
        }
    }
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn options_before_the_separator_are_parsed_and_unknown_ones_ignored() {
        assert_eq!(
            parse_options(&args(&["--reaper", "--nofile-soft=1024", "--other"])),
            Options {
                reaper: true,
                nofile_soft: Some(1024),
                ..Options::default()
            }
        );
        assert_eq!(
            parse_options(&args(&["--job", "Local\\freshell-unit-u1", "--reaper"])),
            Options {
                reaper: true,
                job: Some("Local\\freshell-unit-u1".into()),
                ..Options::default()
            }
        );
        assert_eq!(
            parse_options(&args(&["--setsid"])),
            Options {
                setsid: true,
                ..Options::default()
            }
        );
        assert_eq!(
            parse_options(&args(&["--nofile-soft=lots"])),
            Options::default()
        );
    }

    #[cfg(unix)]
    #[test]
    fn it_runs_the_command_after_the_separator_and_returns_its_exit_code() {
        assert_eq!(unit_exec_main(args(&["--", "sh", "-c", "exit 7"])), 7);
        assert_eq!(unit_exec_main(args(&["--opt", "--", "true"])), 0);
    }

    #[cfg(unix)]
    #[test]
    fn a_signal_exit_is_reported_as_the_shell_does() {
        assert_eq!(
            unit_exec_main(args(&["--", "sh", "-c", "kill -TERM $$"])),
            128 + libc::SIGTERM
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_missing_command_or_program_fails_without_running_anything() {
        assert_eq!(unit_exec_main(args(&["sh", "-c", "exit 0"])), USAGE_EXIT);
        assert_eq!(unit_exec_main(args(&["--"])), USAGE_EXIT);
        assert_eq!(
            unit_exec_main(args(&["--", "/nonexistent/freshell-unit-exec-test"])),
            START_FAILED_EXIT
        );
    }
}
