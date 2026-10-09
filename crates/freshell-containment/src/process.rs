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
    let raw = std::fs::read(format!("/proc/{pid}/environ")).ok()?;
    let prefix = format!("{key}=");
    raw.split(|b| *b == 0).find_map(|kv| {
        let s = String::from_utf8_lossy(kv);
        s.strip_prefix(&prefix).map(str::to_string)
    })
}

#[cfg(not(target_os = "linux"))]
fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "process facts are not implemented on this OS yet",
    )
}
