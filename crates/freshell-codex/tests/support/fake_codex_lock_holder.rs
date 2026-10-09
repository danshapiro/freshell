//! `fake-codex-lock-holder <lock path>`: the realistic Codex fake's writer lock off
//! Linux (Stage 2: LB-11), a test fixture only.
//!
//! Takes the lock exactly as Codex's `rollout/src/writer_lock.rs` does — open the
//! file read/write/create and `File::try_lock()` (an exclusive `flock` on Unix,
//! `LockFileEx` on a non-inheritable handle on Windows) — then:
//! - prints `locked` and holds the lock until its stdin reaches end of file, then
//!   exits 0 (the fake native keeps that pipe open for the thread's lifetime);
//! - prints `conflict` and exits 1 when another process holds the lock;
//! - prints `error: <error>` on stderr and exits 2 on any other failure.

use std::fs::{OpenOptions, TryLockError};
use std::io::Write;
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(path) = std::env::args_os().nth(1).map(PathBuf::from) else {
        eprintln!("error: usage: fake-codex-lock-holder <lock path>");
        return ExitCode::from(2);
    };
    match hold(&path) {
        Ok(code) => code,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::from(2)
        }
    }
}

fn hold(path: &std::path::Path) -> std::io::Result<ExitCode> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)?;
    match file.try_lock() {
        Ok(()) => {
            let mut out = std::io::stdout().lock();
            writeln!(out, "locked")?;
            out.flush()?;
            drop(out);
            std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink())?;
            drop(file);
            Ok(ExitCode::SUCCESS)
        }
        Err(TryLockError::WouldBlock) => {
            let mut out = std::io::stdout().lock();
            writeln!(out, "conflict")?;
            out.flush()?;
            Ok(ExitCode::from(1))
        }
        Err(TryLockError::Error(error)) => Err(error),
    }
}
