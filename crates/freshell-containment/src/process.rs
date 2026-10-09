//! Per-process facts: identity (pid, start time, process name), the Codex
//! daemon-family exclusion, and the per-OS reads the backends build on.
//!
//! Linux reads `/proc`; the Windows and macOS bodies land in later tasks
//! behind the same names (until then they answer `ErrorKind::Unsupported`).
//! A process's arguments (argv) are read only for [`is_codex_daemon_family`]
//! and are never logged or sent anywhere: argv can carry secrets.

use std::io;

/// One process incarnation. `name` is the process name (Linux
/// `/proc/<pid>/comm`), never its arguments: argv can carry tokens
/// (`--token=…`, `https://user:pass@…`, `-c …bearer_token="…"`) and the log
/// scrubber cannot redact every shape, so logs and the wire carry only `name`
/// plus `pid` (plus `start` for survivors).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcIdentity {
    pub pid: u32,
    /// OS start time of this incarnation (Linux: clock ticks since boot).
    /// `(pid, start)` names one process forever; a recycled pid differs.
    pub start: u64,
    pub name: String,
}

/// The identity of the live process `pid`. `name` is empty when unreadable;
/// an unreadable start time is an error (the incarnation cannot be pinned).
pub fn identity(pid: u32) -> io::Result<ProcIdentity> {
    Ok(ProcIdentity {
        pid,
        start: start_time(pid)?,
        name: name(pid).unwrap_or_default(),
    })
}

/// True when `argv` (ONE process's own arguments) belongs to Codex's own
/// managed app-server daemon family, which Freshell must never signal.
///
/// It finds the first `app-server` element (none: false) and inspects only
/// what follows it. True when that includes `--managed-daemon` (the daemon
/// and its capability probe), when it starts with `daemon pid-update-loop`
/// (the updater, with or without `--restore-release` or `--help`), or when it
/// holds `--listen` immediately followed by `unix://` (the legacy managed
/// launch without the optional flag, including the `--remote-control`
/// variant).
///
/// Rules every caller follows:
/// - this is the only argv inspection in the kill path;
/// - it is evaluated per process, on that process's own argv (the daemon and
///   the updater are siblings, and a pane can start a lone updater);
/// - it can only spare a process, never select one for a signal;
/// - callers also spare every descendant of a spared process.
pub fn is_codex_daemon_family(argv: &[String]) -> bool {
    let Some(at) = argv.iter().position(|a| a == "app-server") else {
        return false;
    };
    let rest = &argv[at + 1..];
    rest.iter().any(|a| a == "--managed-daemon")
        || (rest.len() >= 2 && rest[0] == "daemon" && rest[1] == "pid-update-loop")
        || rest
            .windows(2)
            .any(|w| w[0] == "--listen" && w[1] == "unix://")
}

/// Linux: the fields of `/proc/<pid>/stat` after `pid (comm) `, so a process
/// name holding spaces or parentheses cannot shift them.
#[cfg(target_os = "linux")]
pub(crate) fn stat_fields(pid: u32) -> io::Result<Vec<String>> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/stat"))?;
    let close = raw
        .rfind(')')
        .ok_or_else(|| io::Error::other("malformed stat"))?;
    Ok(raw
        .get(close + 2..)
        .unwrap_or_default()
        .split_whitespace()
        .map(str::to_string)
        .collect())
}

/// Linux: `/proc/<pid>/stat` field 22 (clock ticks since boot).
#[cfg(target_os = "linux")]
pub fn start_time(pid: u32) -> io::Result<u64> {
    stat_fields(pid)?
        .get(19) // field 22 overall; index 19 after "pid (comm) "
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| io::Error::other("no starttime"))
}

#[cfg(not(target_os = "linux"))]
pub fn start_time(_pid: u32) -> io::Result<u64> {
    Err(unsupported())
}

/// The process name. Linux: `/proc/<pid>/comm` without its trailing newline.
#[cfg(target_os = "linux")]
pub fn name(pid: u32) -> io::Result<String> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/comm"))?;
    Ok(raw.trim_end_matches('\n').to_string())
}

#[cfg(not(target_os = "linux"))]
pub fn name(_pid: u32) -> io::Result<String> {
    Err(unsupported())
}

/// Linux: the process's arguments. Only [`is_codex_daemon_family`] callers
/// read this, and never log it.
#[cfg(target_os = "linux")]
pub fn argv(pid: u32) -> io::Result<Vec<String>> {
    let raw = std::fs::read(format!("/proc/{pid}/cmdline"))?;
    Ok(raw
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect())
}

/// Linux: true for a live (non-zombie) process.
#[cfg(target_os = "linux")]
pub fn is_running(pid: u32) -> bool {
    stat_fields(pid).is_ok_and(|f| f.first().is_some_and(|s| s != "Z" && s != "X"))
}

#[cfg(target_os = "linux")]
pub fn parent(pid: u32) -> Option<u32> {
    stat_fields(pid).ok()?.get(1)?.parse().ok()
}

/// Linux: the direct children of every thread of `pid`
/// (`/proc/<pid>/task/*/children`).
#[cfg(target_os = "linux")]
pub fn children(pid: u32) -> Vec<u32> {
    let mut out = Vec::new();
    if let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) {
        for task in tasks.flatten() {
            if let Ok(raw) = std::fs::read_to_string(task.path().join("children")) {
                out.extend(raw.split_whitespace().filter_map(|p| p.parse::<u32>().ok()));
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
pub fn all_pids() -> Vec<u32> {
    std::fs::read_dir("/proc")
        .map(|it| {
            it.flatten()
                .filter_map(|e| e.file_name().to_str()?.parse().ok())
                .collect()
        })
        .unwrap_or_default()
}

/// Linux: one environment value, or None when unreadable (other uid,
/// non-dumpable) — callers log unreadable candidates, never guess.
#[cfg(target_os = "linux")]
pub fn environ_value(pid: u32, key: &str) -> Option<String> {
    environ_entry(pid, key).ok().flatten()
}

/// Linux: one environment value of `pid`: `Ok(Some)` when set, `Ok(None)`
/// when absent, `Err` when the environment cannot be read (another uid, a
/// non-dumpable process). The tag backend counts unreadable same-uid
/// processes instead of silently treating them as untagged.
#[cfg(target_os = "linux")]
pub(crate) fn environ_entry(pid: u32, key: &str) -> io::Result<Option<String>> {
    let raw = std::fs::read(format!("/proc/{pid}/environ"))?;
    let prefix = format!("{key}=");
    Ok(raw.split(|b| *b == 0).find_map(|kv| {
        let s = String::from_utf8_lossy(kv);
        s.strip_prefix(&prefix).map(str::to_string)
    }))
}

/// Linux: the real uid of `pid` (`/proc/<pid>/status`), readable even for
/// processes whose environment is withheld.
#[cfg(target_os = "linux")]
pub(crate) fn real_uid(pid: u32) -> Option<u32> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("Uid:"))?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

/// Linux: the first `name` found in a `PATH` directory (one-shot helper
/// commands are run by this absolute path).
#[cfg(target_os = "linux")]
pub(crate) fn find_on_path(name: &str) -> Option<std::path::PathBuf> {
    std::env::var_os("PATH")?
        .to_str()?
        .split(':')
        .map(|d| std::path::Path::new(d).join(name))
        .find(|p| p.is_file())
}

/// What a one-shot helper command printed, and how it ended.
#[cfg(target_os = "linux")]
pub(crate) struct CommandOutput {
    pub status: std::process::ExitStatus,
    pub stdout: String,
    pub stderr: String,
}

/// Linux: runs one helper command (stdin null, stdout and stderr captured)
/// under ONE deadline rule shared by every one-shot command the crate runs:
/// it waits at most `deadline` for the command to exit (a pidfd wait armed
/// with the deadline, no polling) and then for its output to close. On
/// timeout the command is killed through its pin and reaped, and the error
/// is `ErrorKind::TimedOut` ("timed out"). Blocks the calling thread: async
/// callers run it on a blocking task.
#[cfg(target_os = "linux")]
pub(crate) fn run_capture_with_deadline(
    cmd: &mut std::process::Command,
    deadline: std::time::Duration,
) -> io::Result<CommandOutput> {
    use std::io::Read;
    use std::process::Stdio;
    use std::sync::mpsc;

    use crate::proc_watch::{ProcWatch, Sig};

    let until = std::time::Instant::now() + deadline;
    let timed_out = || io::Error::new(io::ErrorKind::TimedOut, "timed out");
    let mut child = cmd
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    // The child is unreaped until `wait` below, so its pid names it.
    let watch = match ProcWatch::open(child.id()) {
        Ok(watch) => watch,
        Err(err) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
    };
    // Each pipe is drained on its own thread (a full pipe must never stall
    // the command); its text arrives once the pipe closes.
    fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<String> {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let mut text = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_end(&mut text);
            }
            let _ = tx.send(String::from_utf8_lossy(&text).into_owned());
        });
        rx
    }
    let stdout = drain(child.stdout.take());
    let stderr = drain(child.stderr.take());
    let exited = watch.wait_exited_blocking(deadline);
    if !matches!(exited, Ok(true)) {
        let _ = watch.signal(Sig::Kill);
        let _ = child.wait();
        exited?;
        return Err(timed_out());
    }
    let status = child.wait()?;
    let left = || until.saturating_duration_since(std::time::Instant::now());
    let stdout = stdout.recv_timeout(left()).map_err(|_| timed_out())?;
    let stderr = stderr.recv_timeout(left()).map_err(|_| timed_out())?;
    Ok(CommandOutput {
        status,
        stdout,
        stderr,
    })
}

// Off Linux the process facts below answer "nothing" until the per-OS
// bodies land (Windows: Task 6, macOS: Task 7). No backend there finds
// members through them yet.

#[cfg(not(target_os = "linux"))]
pub fn argv(_pid: u32) -> io::Result<Vec<String>> {
    Err(unsupported())
}

#[cfg(not(target_os = "linux"))]
pub fn is_running(_pid: u32) -> bool {
    false
}

#[cfg(not(target_os = "linux"))]
pub fn parent(_pid: u32) -> Option<u32> {
    None
}

#[cfg(not(target_os = "linux"))]
pub fn children(_pid: u32) -> Vec<u32> {
    Vec::new()
}

#[cfg(not(target_os = "linux"))]
pub fn all_pids() -> Vec<u32> {
    Vec::new()
}

#[cfg(not(target_os = "linux"))]
pub fn environ_value(_pid: u32, _key: &str) -> Option<String> {
    None
}

#[cfg(all(unix, not(target_os = "linux")))]
pub(crate) fn environ_entry(_pid: u32, _key: &str) -> io::Result<Option<String>> {
    Err(unsupported())
}

#[cfg(all(unix, not(target_os = "linux")))]
pub(crate) fn real_uid(_pid: u32) -> Option<u32> {
    None
}

#[cfg(not(target_os = "linux"))]
fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "process facts are not implemented on this OS yet",
    )
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn a_helper_command_reports_its_status_and_both_outputs() {
        let out = run_capture_with_deadline(
            Command::new("sh").args(["-c", "echo out; echo err >&2; exit 3"]),
            Duration::from_secs(10),
        )
        .unwrap();
        assert_eq!(out.status.code(), Some(3));
        assert_eq!(out.stdout, "out\n");
        assert_eq!(out.stderr, "err\n");
    }

    #[test]
    fn a_helper_command_past_its_deadline_is_killed_reaped_and_timed_out() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("pid");
        let t0 = Instant::now();
        let err = run_capture_with_deadline(
            Command::new("sh").args([
                "-c",
                &format!("echo $$ > '{}'; exec sleep 600", pid_file.display()),
            ]),
            Duration::from_millis(300),
        )
        .err()
        .expect("the command outlived its deadline");
        let took = t0.elapsed();
        assert_eq!(err.kind(), io::ErrorKind::TimedOut, "{err}");
        assert!(
            took >= Duration::from_millis(300) && took < Duration::from_secs(5),
            "{took:?}"
        );
        let pid: u32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        // Reaped, not a zombie: the pid names no process of ours any more.
        assert!(
            std::fs::read_to_string(format!("/proc/{pid}/stat")).is_err()
                || parent(pid) != Some(std::process::id()),
            "the timed-out command {pid} is still our child"
        );
    }

    #[test]
    fn find_on_path_returns_an_absolute_program_path() {
        let sh = find_on_path("sh").expect("sh is on PATH");
        assert!(sh.is_absolute() && sh.is_file(), "{}", sh.display());
        assert!(find_on_path("freshell-no-such-program-x").is_none());
    }
}
