//! Per-process facts: identity (pid, start time, process name), the Codex
//! daemon-family exclusion, and the per-OS reads the backends build on.
//!
//! Linux reads `/proc`; Windows reads process objects and a Toolhelp32
//! snapshot; macOS reads libproc (zombie-aware, see `crate::darwin`) and
//! `KERN_PROCARGS2`.
//! A process's arguments (argv) are read only for [`is_codex_daemon_family`]
//! and are never logged or sent anywhere: argv can carry secrets.
//!
//! The plain reads answer a read that failed as if the process were gone.
//! The tag backend's member scan reads through the `_checked` and
//! `_listing` variants instead, which tell the two apart: on Linux a read
//! that failed for any reason but the process being gone (ENOENT, ESRCH) is
//! "could not check" (`Err`, or a listing's `unread`), never "not a member".

use std::io;

/// One environment variable of another process, as far as this server can
/// read it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnvRead {
    /// The variable is set to this value.
    Value(String),
    /// The environment was read and lacks the variable, or the process is
    /// gone.
    Absent,
    /// The process runs, but the kernel does not show its environment:
    /// another user's or a non-dumpable process on Linux; on macOS a
    /// restricted (entitled) program, whose environment the kernel trims
    /// silently while System Integrity Protection is on. Never "untagged".
    Withheld,
}

/// The value of `key` among `KEY=VALUE` entries.
#[cfg(any(unix, test))]
fn env_lookup<'a>(entries: impl IntoIterator<Item = &'a [u8]>, key: &str) -> EnvRead {
    let prefix = format!("{key}=");
    entries
        .into_iter()
        .find_map(|kv| kv.strip_prefix(prefix.as_bytes()))
        .map_or(EnvRead::Absent, |v| {
            EnvRead::Value(String::from_utf8_lossy(v).into_owned())
        })
}

/// Linux: `/proc/<pid>/environ` (through a running thread once the main
/// thread has exited, see [`read_memory_file`]); a permission error (another
/// uid, a non-dumpable process) is `Withheld`, any other error (gone, or a
/// read that could not be made) `Absent`.
#[cfg(target_os = "linux")]
pub fn environ_read(pid: u32, key: &str) -> EnvRead {
    environ_read_checked(pid, key).unwrap_or(EnvRead::Absent)
}

/// Linux: [`environ_read`], except that a read that failed for a reason
/// other than permission or the process being gone is `Err` ("could not
/// check"), never `Absent`.
#[cfg(target_os = "linux")]
pub(crate) fn environ_read_checked(pid: u32, key: &str) -> io::Result<EnvRead> {
    match read_memory_file(pid, "environ") {
        Ok(raw) => Ok(env_lookup(raw.split(|b| *b == 0), key)),
        Err(err) if err.kind() == io::ErrorKind::PermissionDenied => Ok(EnvRead::Withheld),
        Err(err) if is_gone(&err) => Ok(EnvRead::Absent),
        Err(err) => Err(err),
    }
}

/// macOS: [`environ_read`] (a failed lookup is not told from a gone
/// process there).
#[cfg(target_os = "macos")]
pub(crate) fn environ_read_checked(pid: u32, key: &str) -> io::Result<EnvRead> {
    Ok(environ_read(pid, key))
}

/// macOS: `Withheld` when the program is restricted (`CS_RESTRICT`) or the
/// environment section of `KERN_PROCARGS2` is empty (the kernel trims it
/// silently; an `env -i` process looks the same), `Absent` when a readable
/// section lacks `key` or the process is gone (or exiting: the kernel
/// answers EINVAL).
#[cfg(target_os = "macos")]
pub fn environ_read(pid: u32, key: &str) -> EnvRead {
    if crate::darwin::cs_flags(pid).is_some_and(|f| f & crate::darwin::CS_RESTRICT != 0) {
        return EnvRead::Withheld;
    }
    let Some(args) = crate::darwin::procargs(pid)
        .ok()
        .and_then(|raw| parse_procargs(&raw))
    else {
        return EnvRead::Absent;
    };
    if args.env.is_empty() {
        return EnvRead::Withheld;
    }
    env_lookup(args.env.iter().map(Vec::as_slice), key)
}

/// Windows: another process's environment is not read; the unit's job is
/// the membership authority there.
#[cfg(windows)]
pub fn environ_read(_pid: u32, _key: &str) -> EnvRead {
    EnvRead::Absent
}

/// One environment value, when it can be read and is set (see
/// [`environ_read`] for the cases that tell absent from withheld).
pub fn environ_value(pid: u32, key: &str) -> Option<String> {
    match environ_read(pid, key) {
        EnvRead::Value(value) => Some(value),
        EnvRead::Absent | EnvRead::Withheld => None,
    }
}

/// The parts of a macOS `KERN_PROCARGS2` area.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, PartialEq, Eq)]
struct ProcArgs {
    argv: Vec<String>,
    /// `KEY=VALUE` entries, raw.
    env: Vec<Vec<u8>>,
}

/// Parses a `KERN_PROCARGS2` area: `argc` (a native-endian `i32`), the
/// exec path NUL-terminated, NUL padding, exactly `argc` NUL-terminated
/// argv strings, then NUL-terminated `KEY=VALUE` strings until an empty
/// string (or the end, when the kernel trimmed the environment). `argv`
/// never reads past its `argc` strings, so no environment entry can be
/// taken for an argument. `None` when the area is too short for `argc`.
#[cfg(any(target_os = "macos", test))]
fn parse_procargs(raw: &[u8]) -> Option<ProcArgs> {
    let argc = i32::from_ne_bytes(raw.get(..4)?.try_into().ok()?);
    let argc = usize::try_from(argc).ok()?;
    let mut at = 4;
    // One NUL-terminated string from `at` (the rest of the area when it has
    // no NUL), and the position after its terminator.
    let next = |at: usize| -> (&[u8], usize) {
        let rest = &raw[at.min(raw.len())..];
        let len = rest.iter().position(|b| *b == 0).unwrap_or(rest.len());
        (&rest[..len], at + len + 1)
    };
    let (_exec_path, after) = next(at);
    at = after;
    while raw.get(at) == Some(&0) {
        at += 1;
    }
    let mut argv = Vec::with_capacity(argc);
    for _ in 0..argc {
        if at >= raw.len() {
            break;
        }
        let (arg, after) = next(at);
        argv.push(String::from_utf8_lossy(arg).into_owned());
        at = after;
    }
    let mut env = Vec::new();
    while at < raw.len() {
        let (entry, after) = next(at);
        if entry.is_empty() {
            break;
        }
        env.push(entry.to_vec());
        at = after;
    }
    Some(ProcArgs { argv, env })
}

/// One process incarnation. `name` is the process name (Linux
/// `/proc/<pid>/comm`, Windows the image file name, macOS `pbi_name` or
/// `pbi_comm`), never its arguments: argv can carry tokens
/// (`--token=…`, `https://user:pass@…`, `-c …bearer_token="…"`) and the log
/// scrubber cannot redact every shape, so logs and the wire carry only `name`
/// plus `pid` (plus `start` for survivors).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ProcIdentity {
    pub pid: u32,
    /// OS start time of this incarnation (Linux: clock ticks since boot;
    /// Windows: the creation time in 100 ns intervals since 1601; macOS:
    /// microseconds since the epoch).
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

/// [`identity`], `None` when the process is gone; a start time that could
/// not be read for another reason is `Err` ("could not check", see
/// [`start_time_checked`]).
#[cfg(unix)]
pub(crate) fn identity_checked(pid: u32) -> io::Result<Option<ProcIdentity>> {
    Ok(start_time_checked(pid)?.map(|start| ProcIdentity {
        pid,
        start,
        name: name(pid).unwrap_or_default(),
    }))
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

/// Whether `pid`'s OWN argv is Codex's daemon family
/// ([`is_codex_daemon_family`]), as far as it can be read: `Ok(false)` also
/// when the process is gone (there is nothing to spare); `Err` when its
/// argv could not be read for another reason ("could not check"). Every
/// caller spares a process it gets `Err` for, as it spares the family: a
/// process is never signalled while Freshell cannot tell whether it is
/// Codex's daemon (Stage 2: LB-06).
#[cfg(target_os = "linux")]
pub(crate) fn daemon_family_checked(pid: u32) -> io::Result<bool> {
    match argv(pid) {
        Ok(argv) => Ok(is_codex_daemon_family(&argv)),
        Err(err) if is_gone(&err) => Ok(false),
        Err(err) => Err(err),
    }
}

/// macOS: [`daemon_family_checked`]; the zombie-aware lookup tells a
/// process that was reaped, or is a zombie (it never runs again), from one
/// whose arguments could not be read.
#[cfg(target_os = "macos")]
pub(crate) fn daemon_family_checked(pid: u32) -> io::Result<bool> {
    match argv(pid) {
        Ok(argv) => Ok(is_codex_daemon_family(&argv)),
        Err(err) => match crate::darwin::bsdinfo(pid) {
            Err(gone) if gone.kind() == io::ErrorKind::NotFound => Ok(false),
            Ok(info) if crate::darwin::is_zombie(&info) => Ok(false),
            _ => Err(err),
        },
    }
}

/// Windows: [`daemon_family_checked`]; a process that has exited (its
/// command line is no longer readable) is gone.
#[cfg(windows)]
pub(crate) fn daemon_family_checked(pid: u32) -> io::Result<bool> {
    match argv(pid) {
        Ok(argv) => Ok(is_codex_daemon_family(&argv)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(err) => match has_exited(pid) {
            Ok(true) => Ok(false),
            _ => Err(err),
        },
    }
}

/// Whether `pid` is in Codex's daemon family: its own argv is
/// ([`is_codex_daemon_family`]), or an ancestor's is, since the family
/// includes every descendant. The parent chain is read up to this server
/// at most (whatever started the server is never judged), and only through
/// parents that started no later than their child (on Windows a dead
/// parent's pid can name a later process). `Err` when an argv, start time
/// or parent link on the way could not be read for a reason other than
/// the process being gone ("could not check"): callers spare it as they
/// spare the family. One-shot reads, used only to spare a process: a unit
/// never records it as a root nor pins it from a record.
pub(crate) fn in_codex_daemon_family(pid: u32) -> io::Result<bool> {
    in_codex_daemon_family_unless(pid, |_, _| false)
}

/// [`in_codex_daemon_family`], ending the walk (false) at an ancestor
/// `(pid, start time)` that `cleared` already knows to be outside the
/// family (the macOS fork tracker's tracked processes, each judged when it
/// was tracked and dropped if it execs into the family).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn in_codex_daemon_family_unless(
    pid: u32,
    cleared: impl Fn(u32, u64) -> bool,
) -> io::Result<bool> {
    let me = std::process::id();
    let mut at = pid;
    for _ in 0..4096 {
        if daemon_family_checked(at)? {
            return Ok(true);
        }
        let (Some(started), Some(up)) = (start_time_checked(at)?, parent_checked(at)?) else {
            return Ok(false);
        };
        if up <= 1 || up == me || up == at {
            return Ok(false);
        }
        match start_time_checked(up)? {
            Some(parent_started) if parent_started <= started => {
                if cleared(up, parent_started) {
                    return Ok(false);
                }
                at = up;
            }
            _ => return Ok(false),
        }
    }
    Ok(false)
}

/// Linux: the fields of `/proc/<pid>/stat` after `pid (comm) `, so a process
/// name holding spaces or parentheses cannot shift them.
#[cfg(target_os = "linux")]
pub(crate) fn stat_fields(pid: u32) -> io::Result<Vec<String>> {
    #[cfg(test)]
    test_reads::check(pid, "stat")?;
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

/// macOS: `pbi_start_tvsec * 1_000_000 + pbi_start_tvusec` (zombies too).
#[cfg(target_os = "macos")]
pub fn start_time(pid: u32) -> io::Result<u64> {
    crate::darwin::bsdinfo(pid).map(|info| crate::darwin::start_of(&info))
}

/// Linux: [`start_time`], `None` when the process is gone; a read that
/// failed for another reason is `Err` ("could not check").
#[cfg(target_os = "linux")]
pub(crate) fn start_time_checked(pid: u32) -> io::Result<Option<u64>> {
    match start_time(pid) {
        Ok(start) => Ok(Some(start)),
        Err(err) if is_gone(&err) => Ok(None),
        Err(err) => Err(err),
    }
}

/// macOS: [`start_time`], `None` when it cannot be read (a failed lookup is
/// not told from a gone process there).
#[cfg(target_os = "macos")]
pub(crate) fn start_time_checked(pid: u32) -> io::Result<Option<u64>> {
    Ok(start_time(pid).ok())
}

/// Linux: whether a failed read of a `/proc/<pid>/` file means that the
/// process (or the thread read) is gone: no such entry (ENOENT), or its
/// task went away during the read (ESRCH).
#[cfg(target_os = "linux")]
pub(crate) fn is_gone(err: &io::Error) -> bool {
    matches!(err.raw_os_error(), Some(libc::ENOENT | libc::ESRCH))
}

/// The process name. Linux: `/proc/<pid>/comm` without its trailing newline.
#[cfg(target_os = "linux")]
pub fn name(pid: u32) -> io::Result<String> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/comm"))?;
    Ok(raw.trim_end_matches('\n').to_string())
}

/// macOS: `pbi_name`, or `pbi_comm` when that is empty.
#[cfg(target_os = "macos")]
pub fn name(pid: u32) -> io::Result<String> {
    crate::darwin::bsdinfo(pid).map(|info| crate::darwin::name_of(&info))
}

/// Linux: the process's arguments (through a running thread once the main
/// thread has exited, see [`read_memory_file`]). Only
/// [`is_codex_daemon_family`] callers read this, and never log it.
#[cfg(target_os = "linux")]
pub fn argv(pid: u32) -> io::Result<Vec<String>> {
    let raw = read_memory_file(pid, "cmdline")?;
    Ok(raw
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect())
}

/// Linux: true while the process runs, that is while any thread of it runs:
/// also while its main thread has exited and other threads run on (a main
/// thread that called `pthread_exit`; [`main_thread_exited`]), never for a
/// zombie. False also when its state cannot be read
/// ([`is_running_checked`] tells that apart).
#[cfg(target_os = "linux")]
pub fn is_running(pid: u32) -> bool {
    is_running_checked(pid).unwrap_or(false)
}

/// Linux: [`is_running`], except that a read that failed for a reason
/// other than the process being gone is `Err` ("could not check").
#[cfg(target_os = "linux")]
pub(crate) fn is_running_checked(pid: u32) -> io::Result<bool> {
    liveness(pid).map(|now| matches!(now, Liveness::Running | Liveness::MainThreadExited))
}

/// Linux: whether `pid` runs on although its main thread has exited (its
/// thread-group leader is Z while other threads remain).
#[cfg(target_os = "linux")]
pub(crate) fn main_thread_exited(pid: u32) -> bool {
    liveness(pid).is_ok_and(|now| now == Liveness::MainThreadExited)
}

/// Linux: where a process is between running and gone, as `/proc` shows it.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Liveness {
    /// It runs, its main thread included.
    Running,
    /// Its main thread has exited while other threads run on: it runs.
    MainThreadExited,
    /// A zombie: only its unreaped leader is left.
    Zombie,
    /// No such process.
    Gone,
}

/// Linux: `pid`'s [`Liveness`], from the state letter of `/proc/<pid>/stat`
/// (the thread-group leader's own state: Z once the main thread has exited,
/// also while other threads run on) and, for a Z leader, the `Threads:`
/// count of `/proc/<pid>/status` (the threads not yet released: a zombie
/// counts 1, its leader). A read that failed for a reason other than the
/// process being gone is `Err` ("could not check").
#[cfg(target_os = "linux")]
fn liveness(pid: u32) -> io::Result<Liveness> {
    let state = match stat_fields(pid) {
        Ok(fields) => fields
            .into_iter()
            .next()
            .ok_or_else(|| io::Error::other("malformed stat"))?,
        Err(err) if is_gone(&err) => return Ok(Liveness::Gone),
        Err(err) => return Err(err),
    };
    Ok(match state.as_str() {
        "X" => Liveness::Gone,
        "Z" => match thread_count(pid) {
            Ok(threads) if threads > 1 => Liveness::MainThreadExited,
            Ok(_) => Liveness::Zombie,
            Err(err) if is_gone(&err) => Liveness::Gone,
            Err(err) => return Err(err),
        },
        _ => Liveness::Running,
    })
}

/// Linux: the `Threads:` count of `/proc/<pid>/status`.
#[cfg(target_os = "linux")]
fn thread_count(pid: u32) -> io::Result<u32> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status"))?;
    status
        .lines()
        .find_map(|line| line.strip_prefix("Threads:"))
        .and_then(|threads| threads.trim().parse().ok())
        .ok_or_else(|| io::Error::other("no thread count"))
}

/// Linux: one of the `/proc/<pid>/` files read from the process's memory
/// (`cmdline`, `environ`), through a running thread once the main thread
/// has exited (see [`through_a_running_thread`]): the leader's own
/// `cmdline` then reads empty and its `environ` is owned by root.
#[cfg(target_os = "linux")]
fn read_memory_file(pid: u32, file: &str) -> io::Result<Vec<u8>> {
    #[cfg(test)]
    test_reads::check(pid, file)?;
    through_a_running_thread(pid, |dir| std::fs::read(dir.join(file)), Vec::is_empty)
}

/// Linux: `read` of `pid`'s own `/proc/<pid>` directory, which the kernel
/// answers for the thread-group leader's own task. Once the main thread has
/// exited, that task has no memory and no descriptor table, so what it
/// shows of them reads empty or is refused, although the process runs on
/// in its other threads. Then `read` is made of those threads' directories
/// (`/proc/<pid>/task/<tid>`), which show the process's own: the first
/// answer that is not `empty`; else, when a thread's read failed for a
/// reason other than the thread being gone, that error (the running
/// thread's answer is unknown); else an empty answer; else the leader's.
/// When whether the main thread has exited cannot be read, after an empty
/// or refused answer, that error is the answer ("could not check").
#[cfg(target_os = "linux")]
pub(crate) fn through_a_running_thread<T>(
    pid: u32,
    read: impl Fn(&std::path::Path) -> io::Result<T>,
    empty: impl Fn(&T) -> bool,
) -> io::Result<T> {
    let own = std::path::PathBuf::from(format!("/proc/{pid}"));
    let leader = read(&own);
    if matches!(&leader, Ok(found) if !empty(found)) {
        return leader;
    }
    match liveness(pid)? {
        Liveness::MainThreadExited => {}
        Liveness::Running | Liveness::Zombie | Liveness::Gone => return leader,
    }
    let tasks = match std::fs::read_dir(own.join("task")) {
        Ok(tasks) => tasks,
        Err(err) if is_gone(&err) => return leader,
        Err(err) => return Err(err),
    };
    let leader_tid = pid.to_string();
    let mut empty_read = None;
    let mut unread = None;
    for task in tasks {
        let task = match task {
            Ok(task) => task,
            Err(err) => {
                unread.get_or_insert(err);
                continue;
            }
        };
        if task.file_name().to_str() == Some(leader_tid.as_str()) {
            continue;
        }
        match read(&task.path()) {
            Ok(found) if !empty(&found) => return Ok(found),
            Ok(found) => {
                empty_read.get_or_insert(found);
            }
            Err(err) if is_gone(&err) => {}
            Err(err) => {
                unread.get_or_insert(err);
            }
        }
    }
    match (unread, empty_read) {
        (Some(err), _) => Err(err),
        (None, Some(found)) => Ok(found),
        (None, None) => leader,
    }
}

#[cfg(target_os = "linux")]
pub fn parent(pid: u32) -> Option<u32> {
    parent_checked(pid).ok().flatten()
}

/// Linux: [`parent`], `None` when the process is gone; a read that failed
/// for another reason is `Err` ("could not check").
#[cfg(target_os = "linux")]
pub(crate) fn parent_checked(pid: u32) -> io::Result<Option<u32>> {
    match stat_fields(pid) {
        Ok(fields) => fields
            .get(1)
            .and_then(|parent| parent.parse().ok())
            .map(Some)
            .ok_or_else(|| io::Error::other("malformed stat")),
        Err(err) if is_gone(&err) => Ok(None),
        Err(err) => Err(err),
    }
}

/// Linux: the direct children of every thread of `pid`
/// (`/proc/<pid>/task/*/children`), as far as they can be read.
#[cfg(target_os = "linux")]
pub fn children(pid: u32) -> Vec<u32> {
    child_listing(pid).found
}

/// Linux: every process `/proc` lists, as far as it can be read.
#[cfg(target_os = "linux")]
pub fn all_pids() -> Vec<u32> {
    pid_listing().found
}

/// One one-shot listing of processes, and the first read it could not make
/// ("could not check"; a process found gone is no failure): `found` is
/// complete only when `unread` is `None`.
#[cfg(unix)]
#[derive(Debug, Default)]
pub(crate) struct Listing {
    pub(crate) found: Vec<u32>,
    pub(crate) unread: Option<io::Error>,
}

/// Linux: [`all_pids`], with what could not be read.
#[cfg(target_os = "linux")]
pub(crate) fn pid_listing() -> Listing {
    let mut listing = Listing::default();
    match std::fs::read_dir("/proc") {
        Ok(entries) => {
            for entry in entries {
                match entry {
                    Ok(entry) => listing.found.extend(
                        entry
                            .file_name()
                            .to_str()
                            .and_then(|n| n.parse::<u32>().ok()),
                    ),
                    Err(err) => {
                        listing.unread.get_or_insert(err);
                    }
                }
            }
        }
        Err(err) => listing.unread = Some(err),
    }
    listing
}

/// Linux: [`children`], with what could not be read (a thread, or `pid`
/// itself, found gone has no children to list).
#[cfg(target_os = "linux")]
pub(crate) fn child_listing(pid: u32) -> Listing {
    let mut listing = Listing::default();
    #[cfg(test)]
    if let Err(err) = test_reads::check(pid, "children") {
        listing.unread = Some(err);
        return listing;
    }
    let tasks = match std::fs::read_dir(format!("/proc/{pid}/task")) {
        Ok(tasks) => tasks,
        Err(err) => {
            if !is_gone(&err) {
                listing.unread = Some(err);
            }
            return listing;
        }
    };
    for task in tasks {
        match task.and_then(|task| std::fs::read_to_string(task.path().join("children"))) {
            Ok(raw) => listing
                .found
                .extend(raw.split_whitespace().filter_map(|p| p.parse::<u32>().ok())),
            Err(err) if is_gone(&err) => {}
            Err(err) => {
                listing.unread.get_or_insert(err);
            }
        }
    }
    listing
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
    snapshot_checked().unwrap_or_default()
}

/// Windows: [`snapshot`], `Err` when the snapshot cannot be taken.
#[cfg(windows)]
fn snapshot_checked() -> io::Result<Vec<(u32, u32, String)>> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    // SAFETY: a process snapshot; the handle is checked and closed below.
    let snap = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snap == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
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
    Ok(out)
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
    parent_checked(pid).ok().flatten()
}

/// Windows: [`parent`], `None` when the process is gone; `Err` when the
/// snapshot cannot be taken ("could not check").
#[cfg(windows)]
pub(crate) fn parent_checked(pid: u32) -> io::Result<Option<u32>> {
    Ok(snapshot_checked()?
        .into_iter()
        .find(|(p, _, _)| *p == pid)
        .map(|(_, parent, _)| parent))
}

/// Windows: [`start_time`], `None` when no process has the pid.
#[cfg(windows)]
pub(crate) fn start_time_checked(pid: u32) -> io::Result<Option<u64>> {
    match start_time(pid) {
        Ok(start) => Ok(Some(start)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// Windows: whether `pid` has exited (no process has it, or its handle is
/// signalled); `Err` when that cannot be read.
#[cfg(windows)]
fn has_exited(pid: u32) -> io::Result<bool> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
    use windows_sys::Win32::System::Threading::{
        WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    match open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE) {
        // SAFETY: a live handle with SYNCHRONIZE; zero timeout.
        Ok(handle) => {
            Ok(unsafe { WaitForSingleObject(handle.as_raw_handle(), 0) } == WAIT_OBJECT_0)
        }
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(true),
        Err(err) => Err(err),
    }
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

// macOS: libproc facts, every lookup zombie-aware (`crate::darwin`).

/// macOS: the process's arguments: exactly the `argc` strings of
/// `KERN_PROCARGS2`, never the environment that follows them. Only
/// [`is_codex_daemon_family`] callers read this, and never log it.
#[cfg(target_os = "macos")]
pub fn argv(pid: u32) -> io::Result<Vec<String>> {
    let raw = crate::darwin::procargs(pid)?;
    parse_procargs(&raw)
        .map(|args| args.argv)
        .ok_or_else(|| io::Error::other("malformed KERN_PROCARGS2 area"))
}

/// macOS: true while the process exists and is not a zombie (a process
/// that has begun exiting still runs until it becomes one).
#[cfg(target_os = "macos")]
pub fn is_running(pid: u32) -> bool {
    crate::darwin::bsdinfo(pid).is_ok_and(|info| !crate::darwin::is_zombie(&info))
}

/// macOS: [`is_running`] (a failed lookup is not told from a gone process
/// there).
#[cfg(target_os = "macos")]
pub(crate) fn is_running_checked(pid: u32) -> io::Result<bool> {
    Ok(is_running(pid))
}

#[cfg(target_os = "macos")]
pub fn parent(pid: u32) -> Option<u32> {
    crate::darwin::bsdinfo(pid).ok().map(|info| info.pbi_ppid)
}

/// macOS: [`parent`], `None` when the process was reaped; another failed
/// lookup is `Err` ("could not check").
#[cfg(target_os = "macos")]
pub(crate) fn parent_checked(pid: u32) -> io::Result<Option<u32>> {
    match crate::darwin::bsdinfo(pid) {
        Ok(info) => Ok(Some(info.pbi_ppid)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err),
    }
}

/// macOS: the processes whose parent is `pid` (the kernel's own filter of
/// its process list, zombies included).
#[cfg(target_os = "macos")]
pub fn children(pid: u32) -> Vec<u32> {
    crate::darwin::child_pids(pid)
        .into_iter()
        .filter(|child| *child != pid)
        .collect()
}

#[cfg(target_os = "macos")]
pub fn all_pids() -> Vec<u32> {
    crate::darwin::all_pids()
}

/// macOS: [`all_pids`] as a listing (libproc's list; a failed lookup is not
/// told from a gone process there).
#[cfg(target_os = "macos")]
pub(crate) fn pid_listing() -> Listing {
    Listing {
        found: all_pids(),
        unread: None,
    }
}

/// macOS: [`children`] as a listing (see [`pid_listing`]).
#[cfg(target_os = "macos")]
pub(crate) fn child_listing(pid: u32) -> Listing {
    Listing {
        found: children(pid),
        unread: None,
    }
}

/// Test support (Linux): makes this process's reads of one `/proc/<pid>/`
/// file of a chosen process fail with a chosen errno, as a `/proc` mounted
/// `hidepid=invisible` (ENOENT), descriptor exhaustion (EMFILE) or a
/// non-dumpable process (EACCES) answers them, so a unit test can give a
/// reader that answer about a live process of its own. Files: `stat`,
/// `cmdline`, `environ`, `children` (the listing of its threads' children),
/// and `fd` and `fdinfo` (the descriptor table and a descriptor's lock
/// information the lock lookup reads).
#[cfg(all(test, target_os = "linux"))]
pub(crate) mod test_reads {
    use std::sync::{Mutex, PoisonError};

    static FAILING: Mutex<Vec<(u32, &'static str, i32)>> = Mutex::new(Vec::new());

    /// Reads of `/proc/<pid>/<file>` fail with `errno` until the returned
    /// guard is dropped.
    #[must_use]
    pub(crate) fn fail(pid: u32, file: &'static str, errno: i32) -> Failing {
        FAILING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push((pid, file, errno));
        Failing { pid, file }
    }

    pub(crate) struct Failing {
        pid: u32,
        file: &'static str,
    }

    impl Drop for Failing {
        fn drop(&mut self) {
            FAILING
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .retain(|(pid, file, _)| (*pid, *file) != (self.pid, self.file));
        }
    }

    /// The failure a test gave reads of `/proc/<pid>/<file>`, if any.
    pub(crate) fn check(pid: u32, file: &str) -> std::io::Result<()> {
        let failing = FAILING.lock().unwrap_or_else(PoisonError::into_inner);
        match failing.iter().find(|(p, f, _)| *p == pid && *f == file) {
            Some((_, _, errno)) => Err(std::io::Error::from_raw_os_error(*errno)),
            None => Ok(()),
        }
    }

    /// [`check`] for a read of `file` under `dir`: a process's
    /// `/proc/<pid>` directory, or one of its `task/<tid>` ones.
    pub(crate) fn check_under(dir: &std::path::Path, file: &str) -> std::io::Result<()> {
        let pid = dir
            .strip_prefix("/proc")
            .ok()
            .and_then(|rest| rest.components().next())
            .and_then(|pid| pid.as_os_str().to_str()?.parse().ok());
        pid.map_or(Ok(()), |pid| check(pid, file))
    }
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

#[cfg(test)]
mod procargs_tests {
    use super::{env_lookup, parse_procargs, EnvRead, ProcArgs};

    /// A `KERN_PROCARGS2` area: argc, the exec path, NUL padding, then the
    /// given NUL-separated strings.
    fn area(argc: i32, strings: &[&str], tail: &[u8]) -> Vec<u8> {
        let mut raw = argc.to_ne_bytes().to_vec();
        raw.extend_from_slice(b"/usr/local/bin/node\0\0\0\0");
        for s in strings {
            raw.extend_from_slice(s.as_bytes());
            raw.push(0);
        }
        raw.extend_from_slice(tail);
        raw
    }

    #[test]
    fn argv_is_exactly_argc_strings_and_the_environment_follows_them() {
        let raw = area(
            3,
            &["node", "-e", "", "FRESHELL_UNIT_ID=u1", "PATH=/bin", ""],
            b"executable_path=/x\0",
        );
        assert_eq!(
            parse_procargs(&raw).unwrap(),
            ProcArgs {
                argv: vec!["node".into(), "-e".into(), "".into()],
                env: vec![b"FRESHELL_UNIT_ID=u1".to_vec(), b"PATH=/bin".to_vec()],
            }
        );
    }

    #[test]
    fn a_trimmed_environment_is_an_empty_section() {
        // The kernel trims a restricted program's area right after argv.
        let raw = area(2, &["/bin/sleep", "60"], &[0, 0, 0]);
        let parsed = parse_procargs(&raw).unwrap();
        assert_eq!(parsed.argv, ["/bin/sleep", "60"]);
        assert!(parsed.env.is_empty());
        let cut = area(2, &["/bin/sleep", "60"], b"");
        assert!(parse_procargs(&cut).unwrap().env.is_empty());
    }

    #[test]
    fn a_short_or_truncated_area_never_reads_past_its_end() {
        assert_eq!(parse_procargs(&[1, 0]), None);
        assert_eq!(parse_procargs(&(-1i32).to_ne_bytes()), None);
        // argc promises more strings than the area holds.
        let raw = area(5, &["a", "b"], b"");
        assert_eq!(parse_procargs(&raw).unwrap().argv, ["a", "b"]);
    }

    #[test]
    fn an_environment_lookup_tells_a_value_from_an_absent_key() {
        let entries: [&[u8]; 2] = [b"FRESHELL_UNIT_IDX=no", b"FRESHELL_UNIT_ID=u1"];
        assert_eq!(
            env_lookup(entries, "FRESHELL_UNIT_ID"),
            EnvRead::Value("u1".into())
        );
        assert_eq!(env_lookup(entries, "OTHER"), EnvRead::Absent);
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
