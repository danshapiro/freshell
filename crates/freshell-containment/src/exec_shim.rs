//! `unit_exec_main`: the `__unit-exec` shim a contained member can be started
//! through. Today it runs the command after `--`, waits for it and exits with
//! its status on every OS; later tasks put per-OS placement in front of that
//! (Windows job self-placement, the Linux `--reaper` child subreaper).

use std::ffi::OsString;
use std::process::ExitStatus;

/// Exit status for a malformed invocation (no command after `--`).
const USAGE_EXIT: i32 = 2;
/// Exit status when the command cannot be started (the shell convention).
const START_FAILED_EXIT: i32 = 127;

/// Runs `args[after "--"]`, waits, and returns its exit code (128 + the
/// signal number when a signal ended it, as a shell reports it).
pub fn unit_exec_main(args: Vec<OsString>) -> i32 {
    let command = args
        .iter()
        .position(|a| a == "--")
        .map(|sep| &args[sep + 1..])
        .unwrap_or_default();
    let Some((program, rest)) = command.split_first() else {
        eprintln!("freshell-unit-exec: usage: freshell-unit-exec [options] -- <command> [args...]");
        return USAGE_EXIT;
    };
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn it_runs_the_command_after_the_separator_and_returns_its_exit_code() {
        assert_eq!(unit_exec_main(args(&["--", "sh", "-c", "exit 7"])), 7);
        assert_eq!(unit_exec_main(args(&["--opt", "--", "true"])), 0);
    }

    #[test]
    fn a_signal_exit_is_reported_as_the_shell_does() {
        assert_eq!(
            unit_exec_main(args(&["--", "sh", "-c", "kill -TERM $$"])),
            128 + libc::SIGTERM
        );
    }

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
