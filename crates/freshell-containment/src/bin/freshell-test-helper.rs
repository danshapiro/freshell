//! Test-only helper for the containment suites (never shipped). Modes:
//!
//! - `hold-lock <path> [--threads N] [--child]`: opens `<path>` with std
//!   `OpenOptions` (read, write, create) and takes `File::try_lock()`, exactly
//!   as Codex takes its thread-writer lock (`rollout/src/writer_lock.rs`;
//!   `LockFileEx` on Windows, `flock(2)` on Unix). Exits 3 when the lock is
//!   held elsewhere. Then starts `N` idle threads (they lengthen process
//!   teardown) and, with `--child`, a long-lived `idle` copy of itself (the
//!   lock's handle is not inheritable, so the child never holds it). Prints
//!   one line `locked <pid>` and exits normally when its stdin reaches end of
//!   file.
//! - `idle [args...]`: prints `idle <pid>` and sleeps until killed; it
//!   ignores its arguments, so
//!   `freshell-test-helper idle app-server --managed-daemon` is shaped like a
//!   Codex daemon-family process (`is_codex_daemon_family` judges argv).
//! - `until-eof`: prints `until-eof <pid>` and exits normally when its stdin
//!   reaches end of file.
//! - `job-child` (Windows only): runs an `until-eof` copy of itself in a
//!   nested kill-on-close job of its own, as Codex runs each shell command
//!   (prints `job-child <child pid>`); when its own stdin reaches end of
//!   file it ends the child's stdin, waits for the child, prints
//!   `child-exited` (the nested job is now empty) and sleeps until killed.
//! - `breakaway-daemon` (Windows only): starts a copy of itself as
//!   `idle app-server --managed-daemon` with
//!   `DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB` (Codex 0.162's exact
//!   managed-daemon flags), prints `daemon <pid>` or
//!   `spawn-error <win32 error code>`, then sleeps until killed.

use std::io::Write;
use std::process::{Command, Stdio};

/// Usage error.
const USAGE_EXIT: i32 = 2;
/// The lock is held elsewhere (Codex's "already has an active writer").
const WOULD_BLOCK_EXIT: i32 = 3;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("hold-lock") => hold_lock(&args[1..]),
        Some("idle") => idle(),
        Some("until-eof") => until_eof(),
        Some("job-child") => job_child(),
        Some("breakaway-daemon") => breakaway_daemon(),
        _ => {
            eprintln!(
                "usage: freshell-test-helper hold-lock <path> [--threads N] [--child] | idle [args...] | until-eof | job-child | breakaway-daemon"
            );
            USAGE_EXIT
        }
    };
    std::process::exit(code);
}

fn hold_lock(args: &[String]) -> i32 {
    let Some((path, options)) = args.split_first() else {
        eprintln!("freshell-test-helper hold-lock: missing <path>");
        return USAGE_EXIT;
    };
    let mut threads = 0usize;
    let mut child = false;
    let mut it = options.iter();
    while let Some(option) = it.next() {
        match option.as_str() {
            "--threads" => match it.next().and_then(|n| n.parse().ok()) {
                Some(n) => threads = n,
                None => {
                    eprintln!("freshell-test-helper hold-lock: --threads needs a number");
                    return USAGE_EXIT;
                }
            },
            "--child" => child = true,
            other => {
                eprintln!("freshell-test-helper hold-lock: unknown option {other}");
                return USAGE_EXIT;
            }
        }
    }
    // Exactly Codex's open: read + write + create, std's default sharing and
    // a non-inheritable handle.
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
    {
        Ok(file) => file,
        Err(err) => {
            eprintln!("freshell-test-helper hold-lock: cannot open {path}: {err}");
            return 1;
        }
    };
    match file.try_lock() {
        Ok(()) => {}
        Err(std::fs::TryLockError::WouldBlock) => return WOULD_BLOCK_EXIT,
        Err(std::fs::TryLockError::Error(err)) => {
            eprintln!("freshell-test-helper hold-lock: cannot lock {path}: {err}");
            return 1;
        }
    }
    for _ in 0..threads {
        std::thread::spawn(|| loop {
            std::thread::park();
        });
    }
    if child {
        let spawned = std::env::current_exe().and_then(|exe| {
            Command::new(exe)
                .arg("idle")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .spawn()
        });
        if let Err(err) = spawned {
            eprintln!("freshell-test-helper hold-lock: cannot start the child: {err}");
            return 1;
        }
    }
    println!("locked {}", std::process::id());
    let _ = std::io::stdout().flush();
    // Runs until stdin reaches end of file, then exits normally; the lock is
    // released by the OS when the file's handle closes, as Codex's is.
    let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
    drop(file);
    0
}

fn idle() -> i32 {
    println!("idle {}", std::process::id());
    let _ = std::io::stdout().flush();
    park_forever()
}

fn until_eof() -> i32 {
    println!("until-eof {}", std::process::id());
    let _ = std::io::stdout().flush();
    let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
    0
}

#[cfg(windows)]
fn job_child() -> i32 {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    // SAFETY: an unnamed job with default security; checked below.
    let raw = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if raw.is_null() {
        eprintln!(
            "freshell-test-helper job-child: CreateJobObjectW: {}",
            std::io::Error::last_os_error()
        );
        return 1;
    }
    // SAFETY: a fresh handle this process owns.
    let job = unsafe { OwnedHandle::from_raw_handle(raw) };
    // SAFETY: an all-zero limit block is valid; only the flags are set.
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: a live job and a correctly sized information block.
    let limited = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
    };
    if limited == 0 {
        eprintln!(
            "freshell-test-helper job-child: SetInformationJobObject: {}",
            std::io::Error::last_os_error()
        );
        return 1;
    }
    let spawned = std::env::current_exe().and_then(|exe| {
        Command::new(exe)
            .arg("until-eof")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
    });
    let mut child = match spawned {
        Ok(child) => child,
        Err(err) => {
            eprintln!("freshell-test-helper job-child: cannot start the child: {err}");
            return 1;
        }
    };
    // SAFETY: two live handles.
    if unsafe { AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle()) } == 0 {
        eprintln!(
            "freshell-test-helper job-child: AssignProcessToJobObject: {}",
            std::io::Error::last_os_error()
        );
        let _ = child.kill();
        return 1;
    }
    println!("job-child {}", child.id());
    let _ = std::io::stdout().flush();
    let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
    drop(child.stdin.take());
    let _ = child.wait();
    println!("child-exited");
    let _ = std::io::stdout().flush();
    park_forever()
}

#[cfg(not(windows))]
fn job_child() -> i32 {
    eprintln!("freshell-test-helper job-child: Windows only");
    USAGE_EXIT
}

fn park_forever() -> i32 {
    loop {
        std::thread::park();
    }
}

#[cfg(windows)]
fn breakaway_daemon() -> i32 {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_BREAKAWAY_FROM_JOB, DETACHED_PROCESS};

    let spawned = std::env::current_exe().and_then(|exe| {
        Command::new(exe)
            .args(["idle", "app-server", "--managed-daemon"])
            .creation_flags(DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    });
    match spawned {
        Ok(daemon) => println!("daemon {}", daemon.id()),
        Err(err) => println!("spawn-error {}", err.raw_os_error().unwrap_or(-1)),
    }
    let _ = std::io::stdout().flush();
    park_forever()
}

#[cfg(not(windows))]
fn breakaway_daemon() -> i32 {
    eprintln!("freshell-test-helper breakaway-daemon: Windows only");
    USAGE_EXIT
}
