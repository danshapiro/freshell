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
//! - `idle [args...]`: sleeps until killed and ignores its arguments, so
//!   `freshell-test-helper idle app-server --managed-daemon` is shaped like a
//!   Codex daemon-family process (`is_codex_daemon_family` judges argv).
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
        Some("breakaway-daemon") => breakaway_daemon(),
        _ => {
            eprintln!(
                "usage: freshell-test-helper hold-lock <path> [--threads N] [--child] | idle [args...] | breakaway-daemon"
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
    idle()
}

#[cfg(not(windows))]
fn breakaway_daemon() -> i32 {
    eprintln!("freshell-test-helper breakaway-daemon: Windows only");
    USAGE_EXIT
}
