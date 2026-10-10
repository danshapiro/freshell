//! Per-process facts: identity (pid, start time, process name), the Codex
//! daemon-family exclusion, and the per-OS reads the backends build on.
//!
//! Linux reads `/proc`; Windows reads process objects and a Toolhelp32
//! snapshot; the macOS bodies land in a later task behind the same names
//! (until then they answer `ErrorKind::Unsupported`).
//! A process's arguments (argv) are read only for [`is_codex_daemon_family`]
//! and are never logged or sent anywhere: argv can carry secrets.

use std::io;

/// One process incarnation. `name` is the process name (Linux
/// `/proc/<pid>/comm`, Windows the image file name), never its arguments: argv can carry tokens
/// (`--token=…`, `https://user:pass@…`, `-c …bearer_token="…"`) and the log
/// scrubber cannot redact every shape, so logs and the wire carry only `name`
/// plus `pid` (plus `start` for survivors).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcIdentity {
    pub pid: u32,
    /// OS start time of this incarnation (Linux: clock ticks since boot;
    /// Windows: the creation time in 100 ns intervals since 1601).
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

#[cfg(all(unix, not(target_os = "linux")))]
pub fn start_time(_pid: u32) -> io::Result<u64> {
    Err(unsupported())
}

/// The process name. Linux: `/proc/<pid>/comm` without its trailing newline.
#[cfg(target_os = "linux")]
pub fn name(pid: u32) -> io::Result<String> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/comm"))?;
    Ok(raw.trim_end_matches('\n').to_string())
}

#[cfg(all(unix, not(target_os = "linux")))]
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

/// Splits a Windows command line into its arguments by the C runtime's
/// rules (what `CommandLineToArgvW` and the MSVC runtime produce, so the
/// arguments match the process's own `argv`): the program name ends at the
/// first whitespace, or at its closing quote when it starts with one (no
/// backslash rules there); later arguments are separated by whitespace
/// outside quotes, where `2n` backslashes before a quote are `n`
/// backslashes and the quote delimits, `2n+1` are `n` backslashes and a
/// literal quote, other backslashes are literal, and a doubled quote inside
/// quotes is a literal quote.
#[cfg(any(windows, test))]
fn split_command_line(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut out = Vec::new();
    while i < chars.len() && chars[i].is_whitespace() {
        i += 1;
    }
    if i == chars.len() {
        return out;
    }
    let mut program = String::new();
    if chars[i] == '"' {
        i += 1;
        while i < chars.len() && chars[i] != '"' {
            program.push(chars[i]);
            i += 1;
        }
        i += 1; // the closing quote
    } else {
        while i < chars.len() && !chars[i].is_whitespace() {
            program.push(chars[i]);
            i += 1;
        }
    }
    out.push(program);
    loop {
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            return out;
        }
        let mut arg = String::new();
        let mut quoted = false;
        while i < chars.len() && (quoted || !chars[i].is_whitespace()) {
            match chars[i] {
                '\\' => {
                    let run = chars[i..].iter().take_while(|c| **c == '\\').count();
                    i += run;
                    if chars.get(i) == Some(&'"') {
                        arg.extend(std::iter::repeat_n('\\', run / 2));
                        if run % 2 == 1 {
                            arg.push('"');
                            i += 1;
                        }
                    } else {
                        arg.extend(std::iter::repeat_n('\\', run));
                    }
                }
                '"' if quoted && chars.get(i + 1) == Some(&'"') => {
                    arg.push('"');
                    i += 2;
                }
                '"' => {
                    quoted = !quoted;
                    i += 1;
                }
                c => {
                    arg.push(c);
                    i += 1;
                }
            }
        }
        out.push(arg);
    }
}

// Windows: process facts from the kernel's process objects (start time,
// command line, exit state) and from one Toolhelp32 snapshot (parents and
// image names). A process handle pins its process, and Windows never reuses
// a pid while any handle to that process is open.

/// The processes reachable from `roots` (each a live `(pid, start)`)
/// through `links` (`(pid, parent pid)` pairs), roots first. A link is
/// followed only to a child that started no earlier than its parent:
/// Windows never re-parents, so a process whose parent exited still names
/// that parent's pid, which a later process may reuse, and such a process
/// started before the pid's new owner. `start_of` reads a process's start
/// time (`None` when it is gone).
#[cfg(any(windows, test))]
pub(crate) fn tree_by_start(
    roots: &[(u32, u64)],
    links: &[(u32, u32)],
    start_of: impl Fn(u32) -> Option<u64>,
) -> Vec<(u32, u64)> {
    let mut out: Vec<(u32, u64)> = Vec::new();
    for root in roots {
        if !out.iter().any(|(pid, _)| *pid == root.0) {
            out.push(*root);
        }
    }
    let mut next = 0;
    while next < out.len() {
        let (parent, parent_start) = out[next];
        next += 1;
        for (pid, _) in links
            .iter()
            .filter(|(pid, pp)| *pp == parent && *pid != parent)
        {
            if out.iter().any(|(p, _)| p == pid) {
                continue;
            }
            if let Some(start) = start_of(*pid).filter(|start| *start >= parent_start) {
                out.push((*pid, start));
            }
        }
    }
    out
}

/// Windows: the creation time of the process `handle` names (100 ns
/// intervals since 1601, `GetProcessTimes`). `(pid, start)` names one
/// process forever, as on Linux.
#[cfg(windows)]
pub(crate) fn start_time_of(handle: windows_sys::Win32::Foundation::HANDLE) -> io::Result<u64> {
    use windows_sys::Win32::Foundation::FILETIME;
    use windows_sys::Win32::System::Threading::GetProcessTimes;
    let zero = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
    // SAFETY: a live process handle and four valid out-pointers.
    let ok = unsafe { GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user) };
    if ok == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((u64::from(created.dwHighDateTime) << 32) | u64::from(created.dwLowDateTime))
}

/// Windows: a handle to `pid` with `access`, closed on drop.
/// `ErrorKind::NotFound` when no such process exists.
#[cfg(windows)]
pub(crate) fn open_process(
    pid: u32,
    access: windows_sys::Win32::System::Threading::PROCESS_ACCESS_RIGHTS,
) -> io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::io::FromRawHandle;
    use windows_sys::Win32::Foundation::ERROR_INVALID_PARAMETER;
    use windows_sys::Win32::System::Threading::OpenProcess;
    // SAFETY: plain OpenProcess; the result is checked before use.
    let handle = unsafe { OpenProcess(access, 0, pid) };
    if handle.is_null() {
        let err = io::Error::last_os_error();
        return Err(
            if err.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                io::Error::new(io::ErrorKind::NotFound, "process gone")
            } else {
                err
            },
        );
    }
    // SAFETY: a fresh handle this call owns exclusively.
    Ok(unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) })
}

/// Windows: `(pid, parent pid, image name)` of every process, from one
/// Toolhelp32 snapshot (empty when the snapshot cannot be taken).
#[cfg(windows)]
fn snapshot() -> Vec<(u32, u32, String)> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    // SAFETY: a process snapshot; the handle is checked and closed below.
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return out;
    }
    // SAFETY: an all-zero PROCESSENTRY32W is valid; dwSize is set before use.
    let mut entry: PROCESSENTRY32W = unsafe { std::mem::zeroed() };
    entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
    // SAFETY: a live snapshot handle and a correctly sized entry.
    let mut more = unsafe { Process32FirstW(snap, &mut entry) } != 0;
    while more {
        let len = entry
            .szExeFile
            .iter()
            .position(|c| *c == 0)
            .unwrap_or(entry.szExeFile.len());
        out.push((
            entry.th32ProcessID,
            entry.th32ParentProcessID,
            String::from_utf16_lossy(&entry.szExeFile[..len]),
        ));
        // SAFETY: as above.
        more = unsafe { Process32NextW(snap, &mut entry) } != 0;
    }
    // SAFETY: the snapshot handle is ours and closed once.
    unsafe { CloseHandle(snap) };
    out
}

/// Windows: `(pid, parent pid)` of every process, from one snapshot.
#[cfg(windows)]
pub(crate) fn parent_links() -> Vec<(u32, u32)> {
    snapshot()
        .into_iter()
        .map(|(pid, parent, _)| (pid, parent))
        .collect()
}

/// Windows: the creation time of `pid` (see [`start_time_of`]).
#[cfg(windows)]
pub fn start_time(pid: u32) -> io::Result<u64> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    let handle = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    start_time_of(handle.as_raw_handle())
}

/// Windows: the image file name (for example `codex.exe`) from the
/// Toolhelp32 entry, never the command line.
#[cfg(windows)]
pub fn name(pid: u32) -> io::Result<String> {
    snapshot()
        .into_iter()
        .find(|(p, _, _)| *p == pid)
        .map(|(_, _, name)| name)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "process gone"))
}

/// Windows: the process's arguments, from its command line
/// (`NtQueryInformationProcess(ProcessCommandLineInformation)`) split by the
/// C runtime's rules. Only [`is_codex_daemon_family`] callers read this, and
/// never log it.
#[cfg(windows)]
pub fn argv(pid: u32) -> io::Result<Vec<String>> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Wdk::System::Threading::{
        NtQueryInformationProcess, ProcessCommandLineInformation,
    };
    use windows_sys::Win32::Foundation::{STATUS_INFO_LENGTH_MISMATCH, UNICODE_STRING};
    use windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION;
    let handle = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION)?;
    // u64 elements keep the buffer aligned for the UNICODE_STRING header.
    let mut buf = vec![0u64; 4096];
    loop {
        let size = (buf.len() * std::mem::size_of::<u64>()) as u32;
        let mut needed = 0u32;
        // SAFETY: a live handle and a writable buffer of `size` bytes.
        let status = unsafe {
            NtQueryInformationProcess(
                handle.as_raw_handle(),
                ProcessCommandLineInformation,
                buf.as_mut_ptr().cast(),
                size,
                &mut needed,
            )
        };
        if status == STATUS_INFO_LENGTH_MISMATCH && needed > size {
            buf = vec![0u64; (needed as usize).div_ceil(std::mem::size_of::<u64>())];
            continue;
        }
        if status != 0 {
            return Err(io::Error::other(format!(
                "NtQueryInformationProcess: status {status:#x}"
            )));
        }
        // SAFETY: on success the buffer starts with a UNICODE_STRING whose
        // Buffer points at `Length` bytes inside this same buffer.
        let line = unsafe {
            let us = &*buf.as_ptr().cast::<UNICODE_STRING>();
            if us.Buffer.is_null() || us.Length == 0 {
                String::new()
            } else {
                String::from_utf16_lossy(std::slice::from_raw_parts(
                    us.Buffer,
                    usize::from(us.Length) / 2,
                ))
            }
        };
        return Ok(split_command_line(&line));
    }
}

/// Windows: true while the process has not exited.
#[cfg(windows)]
pub fn is_running(pid: u32) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
    use windows_sys::Win32::System::Threading::{
        WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    let Ok(handle) = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE)
    else {
        return false;
    };
    // SAFETY: a live handle with SYNCHRONIZE; zero timeout.
    unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) == WAIT_TIMEOUT }
}

/// Windows: the parent pid the process was created by. Windows never
/// re-parents, so the parent may have exited and its pid been reused:
/// compare start times (a child never starts before its parent) before
/// relying on the link.
#[cfg(windows)]
pub fn parent(pid: u32) -> Option<u32> {
    snapshot()
        .into_iter()
        .find(|(p, _, _)| *p == pid)
        .map(|(_, parent, _)| parent)
}

/// Windows: the processes whose recorded parent pid is `pid` (see
/// [`parent`] on reused parent pids).
#[cfg(windows)]
pub fn children(pid: u32) -> Vec<u32> {
    snapshot()
        .into_iter()
        .filter(|(p, parent, _)| *parent == pid && *p != pid)
        .map(|(p, _, _)| p)
        .collect()
}

#[cfg(windows)]
pub fn all_pids() -> Vec<u32> {
    snapshot().into_iter().map(|(p, _, _)| p).collect()
}

/// Windows: another process's environment is not readable through a
/// supported API; the unit's job is the membership authority there.
#[cfg(windows)]
pub fn environ_value(_pid: u32, _key: &str) -> Option<String> {
    None
}

// macOS: the process facts below answer "nothing" until its bodies land
// (Task 7). No backend there finds members through them yet.

#[cfg(all(unix, not(target_os = "linux")))]
pub fn argv(_pid: u32) -> io::Result<Vec<String>> {
    Err(unsupported())
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn is_running(_pid: u32) -> bool {
    false
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn parent(_pid: u32) -> Option<u32> {
    None
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn children(_pid: u32) -> Vec<u32> {
    Vec::new()
}

#[cfg(all(unix, not(target_os = "linux")))]
pub fn all_pids() -> Vec<u32> {
    Vec::new()
}

#[cfg(all(unix, not(target_os = "linux")))]
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

#[cfg(all(unix, not(target_os = "linux")))]
fn unsupported() -> io::Error {
    io::Error::new(
        io::ErrorKind::Unsupported,
        "process facts are not implemented on this OS yet",
    )
}

#[cfg(test)]
mod command_line_tests {
    use super::split_command_line;

    fn split(line: &str) -> Vec<String> {
        split_command_line(line)
    }

    #[test]
    fn plain_arguments_split_on_whitespace() {
        assert_eq!(
            split("C:\\codex\\codex.exe app-server  --managed-daemon\t--x"),
            [
                "C:\\codex\\codex.exe",
                "app-server",
                "--managed-daemon",
                "--x"
            ]
        );
    }

    #[test]
    fn quoted_arguments_keep_their_spaces_and_lose_their_quotes() {
        assert_eq!(
            split("\"C:\\Program Files\\codex.exe\" app-server --listen \"unix://\""),
            [
                "C:\\Program Files\\codex.exe",
                "app-server",
                "--listen",
                "unix://"
            ]
        );
        assert_eq!(split("a b\"c d\"e"), ["a", "bc de"]);
    }

    #[test]
    fn backslashes_follow_the_c_runtime_rules() {
        // Not before a quote: literal.
        assert_eq!(split("p a\\\\b"), ["p", "a\\\\b"]);
        // 2n before a quote: n backslashes, the quote delimits.
        assert_eq!(split("p \"a\\\\\" b"), ["p", "a\\", "b"]);
        // 2n+1 before a quote: n backslashes and a literal quote.
        assert_eq!(split("p a\\\"b"), ["p", "a\"b"]);
        // A doubled quote inside quotes is a literal quote.
        assert_eq!(split("p \"a\"\"b\""), ["p", "a\"b"]);
    }

    #[test]
    fn the_program_name_ends_at_its_closing_quote_without_backslash_rules() {
        assert_eq!(split("\"C:\\dir\\\" x"), ["C:\\dir\\", "x"]);
        assert_eq!(split(""), Vec::<String>::new());
        assert_eq!(split("   "), Vec::<String>::new());
    }
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
