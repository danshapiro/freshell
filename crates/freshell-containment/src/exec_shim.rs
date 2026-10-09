//! `unit_exec_main`: the `__unit-exec` shim a contained member is started
//! through: `[options] -- <command> [args...]`.
//!
//! Options (before `--`):
//! - `--reaper` (Linux): run the command under the child-subreaper shim
//!   (`crate::reaper`), the Linux fallback backend's member root. Other OSes
//!   ignore it (no backend there places with it).
//! - `--nofile-soft=<n>` (Linux): lower this shim's own open-file soft limit
//!   to `n` (capped at the hard limit) before it starts the command, so the
//!   command starts with the server's original limit instead of the server's
//!   raised one. The server passes `child_nofile::original_soft_limit()`
//!   here; resetting the shim from outside after its spawn would come too
//!   late for the command it already started.
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
    nofile_soft: Option<u64>,
}

fn parse_options(options: &[OsString]) -> Options {
    let mut parsed = Options::default();
    for option in options.iter().filter_map(|o| o.to_str()) {
        if option == "--reaper" {
            parsed.reaper = true;
        } else if let Some(n) = option.strip_prefix("--nofile-soft=") {
            parsed.nofile_soft = n.parse().ok();
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
    #[cfg(target_os = "linux")]
    if options.reaper {
        return crate::reaper::run(program, rest);
    }
    #[cfg(not(target_os = "linux"))]
    let _ = options.reaper; // no backend places with it off Linux
    run_plain(program, rest)
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
                nofile_soft: Some(1024)
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
