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
//!   nested kill-on-close job of its own that has its own completion port,
//!   as a program that watches the jobs it runs commands in does (prints
//!   `job-child <child pid>`); when its own stdin reaches end of file it ends
//!   the child's stdin, waits for the child, prints `child-exited` (the
//!   nested job is now empty) and sleeps until killed. (On the runner a
//!   nested job WITHOUT a port of its own posted no zero message to its
//!   parent job's port.)
//! - `disclaim-exec -- <command> [args...]` (macOS only): replaces itself
//!   with the command (`posix_spawn` with `POSIX_SPAWN_SETEXEC`, so the pid
//!   is unchanged) after the private libSystem function
//!   `responsibility_spawnattrs_setdisclaim`, so the command is its own
//!   responsible process. Exits 127 when the command cannot be started,
//!   the function included. The macOS suite uses it to record that a
//!   detached official `node` resets its responsible process, so
//!   responsibility cannot carry unit membership (the reason the macOS
//!   backend tracks forks).
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
/// The command cannot be started (the shell convention).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const START_FAILED_EXIT: i32 = 127;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("hold-lock") => hold_lock(&args[1..]),
        Some("idle") => idle(),
        Some("until-eof") => until_eof(),
        Some("job-child") => job_child(),
        Some("breakaway-daemon") => breakaway_daemon(),
        Some("disclaim-exec") => disclaim_exec(&args[1..]),
        _ => {
            eprintln!(
                "usage: freshell-test-helper hold-lock <path> [--threads N] [--child] | idle [args...] | until-eof | job-child | breakaway-daemon | disclaim-exec -- <command> [args...]"
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
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectAssociateCompletionPortInformation,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::IO::CreateIoCompletionPort;

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
    // SAFETY: a new completion port not tied to any file; checked below.
    let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1) };
    if port.is_null() {
        eprintln!(
            "freshell-test-helper job-child: CreateIoCompletionPort: {}",
            std::io::Error::last_os_error()
        );
        return 1;
    }
    // SAFETY: a fresh handle this process owns; it lives as long as the job.
    let port = unsafe { OwnedHandle::from_raw_handle(port) };
    let association = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
        CompletionKey: std::ptr::null_mut(),
        CompletionPort: port.as_raw_handle(),
    };
    // SAFETY: a live job and a correctly sized information block.
    let associated = unsafe {
        SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectAssociateCompletionPortInformation,
            std::ptr::from_ref(&association).cast(),
            std::mem::size_of_val(&association) as u32,
        )
    };
    if associated == 0 {
        eprintln!(
            "freshell-test-helper job-child: associating the port: {}",
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

#[cfg(target_os = "macos")]
fn disclaim_exec(args: &[String]) -> i32 {
    use std::ffi::CString;

    type SetDisclaim =
        unsafe extern "C" fn(*mut libc::posix_spawnattr_t, libc::c_int) -> libc::c_int;

    let command = match args.split_first() {
        Some((separator, command)) if separator == "--" && !command.is_empty() => command,
        _ => {
            eprintln!("usage: freshell-test-helper disclaim-exec -- <command> [args...]");
            return USAGE_EXIT;
        }
    };
    let fail = |why: String| {
        eprintln!(
            "freshell-test-helper disclaim-exec: cannot start {}: {why}",
            command[0]
        );
        START_FAILED_EXIT
    };
    let Ok(args) = command
        .iter()
        .map(|arg| CString::new(arg.as_str()))
        .collect::<Result<Vec<CString>, _>>()
    else {
        return fail("an argument holds a NUL byte".into());
    };
    let mut argv: Vec<*mut libc::c_char> = args
        .iter()
        .map(|arg| arg.as_ptr().cast_mut())
        .chain(std::iter::once(std::ptr::null_mut()))
        .collect();
    // A private libSystem function, resolved at run time (as LLDB and
    // Chromium resolve it).
    // SAFETY: a NUL-terminated name looked up in every loaded image.
    let symbol = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"responsibility_spawnattrs_setdisclaim".as_ptr(),
        )
    };
    if symbol.is_null() {
        return fail("this macOS has no responsibility_spawnattrs_setdisclaim".into());
    }
    // SAFETY: the libSystem function of this exact signature.
    let set_disclaim = unsafe { std::mem::transmute::<usize, SetDisclaim>(symbol as usize) };
    let mut attr: libc::posix_spawnattr_t = std::ptr::null_mut();
    // SAFETY: initialises the attribute object this function owns.
    let rc = unsafe { libc::posix_spawnattr_init(&mut attr) };
    if rc != 0 {
        return fail(std::io::Error::from_raw_os_error(rc).to_string());
    }
    // SAFETY: a live attribute object, SETEXEC (which fits the flags' type)
    // and the documented disclaim value.
    let rc = unsafe {
        match libc::posix_spawnattr_setflags(&mut attr, libc::POSIX_SPAWN_SETEXEC as libc::c_short)
        {
            0 => set_disclaim(&mut attr, 1),
            rc => rc,
        }
    };
    if rc != 0 {
        // SAFETY: the attribute object initialised above.
        unsafe { libc::posix_spawnattr_destroy(&mut attr) };
        return fail(std::io::Error::from_raw_os_error(rc).to_string());
    }
    let mut pid: libc::pid_t = 0;
    // SAFETY: a NUL-terminated program, a null-terminated argv of live
    // CStrings, the live attribute object and this process's own
    // environment. With SETEXEC a success never returns.
    let rc = unsafe {
        libc::posix_spawnp(
            &mut pid,
            args[0].as_ptr(),
            std::ptr::null(),
            &attr,
            argv.as_mut_ptr().cast_const(),
            (*libc::_NSGetEnviron()).cast_const(),
        )
    };
    // SAFETY: the attribute object initialised above.
    unsafe { libc::posix_spawnattr_destroy(&mut attr) };
    fail(std::io::Error::from_raw_os_error(rc).to_string())
}

#[cfg(not(target_os = "macos"))]
fn disclaim_exec(_args: &[String]) -> i32 {
    eprintln!("freshell-test-helper disclaim-exec: macOS only");
    USAGE_EXIT
}
