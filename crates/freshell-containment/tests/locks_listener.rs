#![cfg(target_os = "linux")]
//! Lock holders are the processes whose file descriptors carry the lock
//! (fdinfo `lock:` lines), never the lock table's pid column and never the
//! lock file's existence; the app-server main process is whoever owns the
//! listening socket. Every process here is spawned and killed by the test.
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use freshell_containment::{
    codex_thread_lock_path, listening_socket_owner, lock_holders, lock_holders_among, process,
    LockHolder, ProcWatch, Sig,
};

/// Test-only bounded wait (product code never polls).
async fn eventually(what: &str, mut f: impl FnMut() -> bool) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while !f() {
        assert!(tokio::time::Instant::now() < deadline, "timed out: {what}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// The test's own child, killed and reaped when dropped, so a failed
/// assertion leaves nothing running.
struct OwnChild(Child);

impl OwnChild {
    fn spawn(cmd: &mut Command) -> Self {
        Self(cmd.spawn().expect("spawn test child"))
    }

    fn pid(&self) -> u32 {
        self.0.id()
    }

    /// The first line the child prints (empty at end of output).
    fn read_line(&mut self) -> String {
        let out = self.0.stdout.as_mut().expect("stdout is piped");
        let mut line = String::new();
        BufReader::new(out)
            .read_line(&mut line)
            .expect("read child stdout");
        line.trim_end().to_string()
    }

    fn kill(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

impl Drop for OwnChild {
    fn drop(&mut self) {
        self.kill();
    }
}

/// `(parent pid, start time)` from ONE read of `/proc/<pid>/stat`.
fn parent_and_start(pid: u32) -> Option<(u32, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let fields: Vec<&str> = stat
        .get(stat.rfind(')')? + 2..)?
        .split_whitespace()
        .collect();
    Some((fields.get(1)?.parse().ok()?, fields.get(19)?.parse().ok()?))
}

/// The test's grandchild: the child of one of its own children, identified
/// by its parent, not by timing. Its pid and start time come from one stat
/// read that names that child as parent while the child is unreaped (so
/// its pid names no one else), and the guard exists before anything else
/// is read, asserted or pinned. SIGKILLed when dropped: through its pidfd,
/// or, if pinning failed, by pid only while the pid has that start time.
struct Grandchild {
    pid: u32,
    start: u64,
    watch: Option<ProcWatch>,
}

impl Grandchild {
    /// The first child of `parent` (bounded test-only wait), pinned.
    async fn of(parent: &OwnChild) -> Self {
        let parent_pid = parent.pid();
        let mut found = None;
        eventually("the test's child starts its own child", || {
            found =
                process::children(parent_pid).into_iter().find_map(|pid| {
                    match parent_and_start(pid) {
                        Some((ppid, start)) if ppid == parent_pid => Some((pid, start)),
                        _ => None,
                    }
                });
            found.is_some()
        })
        .await;
        let (pid, start) = found.expect("found above");
        let mut grandchild = Self {
            pid,
            start,
            watch: None,
        };
        grandchild.watch = Some(ProcWatch::open_expecting(pid, start).expect("pin the grandchild"));
        grandchild
    }

    fn watch(&self) -> &ProcWatch {
        self.watch.as_ref().expect("pinned in `of`")
    }

    fn kill(&self) {
        match &self.watch {
            Some(watch) => {
                let _ = watch.signal(Sig::Kill);
            }
            None => {
                if process::start_time(self.pid).is_ok_and(|s| s == self.start) {
                    // SAFETY: plain kill(2) of a pid whose start time was
                    // just checked (it is still this test's grandchild).
                    unsafe { libc::kill(self.pid as libc::pid_t, libc::SIGKILL) };
                }
            }
        }
    }
}

impl Drop for Grandchild {
    fn drop(&mut self) {
        self.kill();
    }
}

/// True when one of `pid`'s descriptors is open on `path`.
fn has_open(pid: u32, path: &Path) -> bool {
    let target = std::fs::canonicalize(path).expect("canonical path");
    std::fs::read_dir(format!("/proc/{pid}/fd")).is_ok_and(|fds| {
        fds.flatten()
            .any(|fd| std::fs::read_link(fd.path()).is_ok_and(|t| t == target))
    })
}

/// `sh` that opens `$0` as fd 3, takes an exclusive flock through it, says
/// `locked`, and execs `sleep 600` holding it: one long-lived pid owns the
/// only descriptor, while the lock table names the exited `flock(1)` helper
/// (the realistic fake's shape).
const HOLD: &str = r#"exec 3>>"$0"; flock -x -n 3 || exit 1; echo locked; exec sleep 600"#;

/// Starts a [`HOLD`] holder of `lock` and waits until it is `sleep`.
async fn spawn_holder(lock: &Path) -> OwnChild {
    let mut child = OwnChild::spawn(
        Command::new("sh")
            .args(["-c", HOLD])
            .arg(lock)
            .stdout(Stdio::piped()),
    );
    assert_eq!(child.read_line(), "locked", "the holder took the lock");
    let pid = child.pid();
    eventually("the holder execs sleep", || {
        process::name(pid).is_ok_and(|n| n == "sleep")
    })
    .await;
    child
}

fn holder(pid: u32, name: &str, path: &Path) -> LockHolder {
    LockHolder {
        pid,
        name: name.to_string(),
        path: path.to_path_buf(),
    }
}

fn sorted(mut holders: Vec<LockHolder>) -> Vec<LockHolder> {
    holders.sort_by_key(|h| h.pid);
    holders
}

#[test]
fn codex_lock_path_layout() {
    let p = codex_thread_lock_path(std::path::Path::new("/h/.codex"), "01a1");
    assert_eq!(
        p,
        std::path::PathBuf::from("/h/.codex/thread-writer-locks/01a1.lock")
    );
}

#[test]
fn lock_holders_ignores_missing_paths() {
    assert!(lock_holders(&[std::path::PathBuf::from("/nonexistent/x.lock")]).is_empty());
}

#[tokio::test]
async fn lock_holders_attributes_a_lock_to_the_process_holding_its_descriptor() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("t.lock");
    std::fs::write(&lock, b"").unwrap();
    assert!(
        lock_holders(std::slice::from_ref(&lock)).is_empty(),
        "an existing, unlocked file has no holders"
    );

    // The lock table's pid column names the exited `flock(1)` helper.
    let mut child = spawn_holder(&lock).await;
    let pid = child.pid();

    let expected = vec![holder(pid, "sleep", &lock)];
    assert_eq!(lock_holders(std::slice::from_ref(&lock)), expected);
    assert_eq!(
        lock_holders_among(std::slice::from_ref(&lock), &[pid]),
        expected
    );
    assert!(
        lock_holders_among(std::slice::from_ref(&lock), &[std::process::id()]).is_empty(),
        "a process without the descriptor is not a holder"
    );

    child.kill();
    eventually("the lock is released with its holder", || {
        lock_holders(std::slice::from_ref(&lock)).is_empty()
    })
    .await;
}

#[tokio::test]
async fn a_process_with_the_lock_file_open_but_unlocked_is_not_a_holder() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("t.lock");
    std::fs::write(&lock, b"").unwrap();

    // Keeps the lock file open without locking it (the shape of Codex's own
    // refused second writer).
    let mut opener = OwnChild::spawn(
        Command::new("sh")
            .args(["-c", r#"exec 3>>"$0"; echo open; exec sleep 600"#])
            .arg(&lock)
            .stdout(Stdio::piped()),
    );
    assert_eq!(opener.read_line(), "open");
    let opener_pid = opener.pid();
    assert!(has_open(opener_pid, &lock), "the opener has the file open");

    assert_eq!(
        lock_holders_among(std::slice::from_ref(&lock), &[opener_pid]),
        vec![],
        "an open descriptor without a lock is not a holder"
    );
    assert_eq!(lock_holders(std::slice::from_ref(&lock)), vec![]);

    // The real holder, alongside the opener: only it is listed.
    let holder_child = spawn_holder(&lock).await;
    let expected = vec![holder(holder_child.pid(), "sleep", &lock)];
    assert_eq!(lock_holders(std::slice::from_ref(&lock)), expected);
    assert_eq!(
        lock_holders_among(
            std::slice::from_ref(&lock),
            &[opener_pid, holder_child.pid()]
        ),
        expected
    );
    assert!(has_open(opener_pid, &lock), "the opener still has it open");
}

#[tokio::test]
async fn a_lock_on_one_file_is_not_reported_for_another() {
    let dir = tempfile::tempdir().unwrap();
    let a = dir.path().join("a.lock");
    let b = dir.path().join("b.lock");
    std::fs::write(&a, b"").unwrap();
    std::fs::write(&b, b"").unwrap();

    let holder_child = spawn_holder(&a).await;
    let pid = holder_child.pid();

    assert_eq!(
        lock_holders_among(std::slice::from_ref(&b), &[pid]),
        vec![],
        "a lock on a.lock is not a lock on b.lock"
    );
    assert_eq!(lock_holders(std::slice::from_ref(&b)), vec![]);
    let on_a = vec![holder(pid, "sleep", &a)];
    assert_eq!(lock_holders(&[a.clone(), b.clone()]), on_a);
    assert_eq!(lock_holders_among(&[b.clone(), a.clone()], &[pid]), on_a);
    // Repeated paths and pids give one entry per (pid, path).
    assert_eq!(
        lock_holders_among(&[a.clone(), a.clone()], &[pid, pid]),
        on_a
    );
}

/// The exact name of [`lock_holders_fall_back_to_stat_where_statx_is_refused`].
const STATX_REFUSED_TEST: &str = "lock_holders_fall_back_to_stat_where_statx_is_refused";
/// Set (to the errno the filter answers) in a re-run of this test binary
/// whose `statx` is refused.
const STATX_REFUSED_ENV: &str = "FRESHELL_TEST_STATX_REFUSED_WITH";
/// Printed by that re-run once every check passed (so a re-run that ran no
/// test cannot pass).
const STATX_REFUSED_DONE: &str = "statx-refused lookups: all checks passed";

/// Where `statx` is missing or refused, the lookups still find the holder.
/// The identity read then fails with EINVAL (on a kernel without `statx`,
/// glibc's emulation rejects `AT_STATX_DONT_SYNC`) or EPERM (a seccomp
/// filter). The test re-runs itself as a child process whose `statx` is
/// refused from its first instruction, as in such an environment; the filter
/// never applies to this process.
#[tokio::test]
async fn lock_holders_fall_back_to_stat_where_statx_is_refused() {
    if let Ok(errno) = std::env::var(STATX_REFUSED_ENV) {
        return check_lookups_with_statx_refused(errno.parse().expect("an errno")).await;
    }
    let failures: Vec<String> = [libc::ENOSYS, libc::EPERM]
        .into_iter()
        .filter_map(|errno| {
            let out = run_with_statx_refused(errno);
            let stdout = String::from_utf8_lossy(&out.stdout);
            let passed = out.status.success() && stdout.contains(STATX_REFUSED_DONE);
            (!passed).then(|| {
                format!(
                    "with statx answering errno {errno}: {}\nstdout:\n{stdout}\nstderr:\n{}",
                    out.status,
                    String::from_utf8_lossy(&out.stderr)
                )
            })
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The checks, run inside the re-run whose `statx` answers `errno`.
async fn check_lookups_with_statx_refused(errno: i32) {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("t.lock");
    let other = dir.path().join("other.lock");
    std::fs::write(&lock, b"").unwrap();
    std::fs::write(&other, b"").unwrap();

    // The filter is in place: the identity read's own call fails.
    let refused_with = statx_dont_sync_errno(&lock);
    let expected_errnos: &[i32] = if errno == libc::ENOSYS {
        &[libc::EINVAL, libc::ENOSYS] // glibc emulates, or passes ENOSYS on
    } else {
        &[errno]
    };
    assert!(
        refused_with.is_some_and(|e| expected_errnos.contains(&e)),
        "statx(AT_STATX_DONT_SYNC) is refused here: {refused_with:?}"
    );

    let holder_child = spawn_holder(&lock).await;
    let pid = holder_child.pid();
    let expected = vec![holder(pid, "sleep", &lock)];
    assert_eq!(lock_holders(std::slice::from_ref(&lock)), expected);
    assert_eq!(
        lock_holders_among(&[other.clone(), lock.clone()], &[pid]),
        expected
    );
    assert_eq!(lock_holders(std::slice::from_ref(&other)), vec![]);
    println!("{STATX_REFUSED_DONE}");
}

/// The errno of `statx(AT_STATX_DONT_SYNC, STATX_INO)` on `path`, `None`
/// when it succeeds.
fn statx_dont_sync_errno(path: &Path) -> Option<i32> {
    use std::os::unix::ffi::OsStrExt;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
    let mut buf = std::mem::MaybeUninit::<libc::statx>::zeroed();
    // SAFETY: a NUL-terminated path and a writable, correctly sized buffer.
    let rc = unsafe {
        libc::statx(
            libc::AT_FDCWD,
            path.as_ptr(),
            libc::AT_STATX_DONT_SYNC,
            libc::STATX_INO,
            buf.as_mut_ptr(),
        )
    };
    (rc != 0).then(|| std::io::Error::last_os_error().raw_os_error().unwrap_or(0))
}

/// Re-runs [`STATX_REFUSED_TEST`] alone, in a child process whose `statx`
/// answers `errno`.
fn run_with_statx_refused(errno: i32) -> std::process::Output {
    use std::os::unix::process::CommandExt;

    let mut cmd = Command::new(std::env::current_exe().expect("this test binary"));
    cmd.args([STATX_REFUSED_TEST, "--exact", "--nocapture"])
        .env(STATX_REFUSED_ENV, errno.to_string())
        .stdin(Stdio::null());
    // SAFETY: the hook only builds a filter on its own stack and makes two
    // prctl calls, which is safe between fork and exec.
    unsafe {
        cmd.pre_exec(move || refuse_statx(errno));
    }
    cmd.output()
        .expect("re-run this test binary with statx refused")
}

/// Installs a seccomp filter on the calling thread that answers `statx` with
/// `errno` and allows every other system call. It is kept across exec and
/// inherited by children. The process uses only its native system-call
/// table, so the filter needs no architecture check.
fn refuse_statx(errno: i32) -> std::io::Result<()> {
    let insn = |code: u32, jt: u8, jf: u8, k: u32| libc::sock_filter {
        code: code as u16,
        jt,
        jf,
        k,
    };
    let filter = [
        insn(
            libc::BPF_LD | libc::BPF_W | libc::BPF_ABS,
            0,
            0,
            std::mem::offset_of!(libc::seccomp_data, nr) as u32,
        ),
        insn(
            libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K,
            0,
            1,
            libc::SYS_statx as u32,
        ),
        insn(
            libc::BPF_RET | libc::BPF_K,
            0,
            0,
            libc::SECCOMP_RET_ERRNO | (errno as u32 & libc::SECCOMP_RET_DATA),
        ),
        insn(libc::BPF_RET | libc::BPF_K, 0, 0, libc::SECCOMP_RET_ALLOW),
    ];
    let prog = libc::sock_fprog {
        len: filter.len() as u16,
        filter: filter.as_ptr().cast_mut(),
    };
    // SAFETY: plain prctl calls; `prog` points at `filter`, both alive here.
    unsafe {
        if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1 as libc::c_ulong, 0, 0, 0) != 0 {
            return Err(std::io::Error::last_os_error());
        }
        if libc::prctl(
            libc::PR_SET_SECCOMP,
            libc::SECCOMP_MODE_FILTER as libc::c_ulong,
            &prog as *const libc::sock_fprog,
        ) != 0
        {
            return Err(std::io::Error::last_os_error());
        }
    }
    Ok(())
}

#[tokio::test]
async fn a_lock_shared_by_two_processes_stays_held_until_both_are_gone() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("t.lock");
    std::fs::write(&lock, b"").unwrap();

    // `flock FILE cmd` keeps its descriptor and its `cmd` child inherits it:
    // both hold the same lock.
    let mut flock = OwnChild::spawn(
        Command::new("flock")
            .arg("-x")
            .arg(&lock)
            .args(["sleep", "600"]),
    );
    let flock_pid = flock.pid();
    // Pinned before anything is read from it or asserted.
    let sleep = Grandchild::of(&flock).await;
    let sleep_pid = sleep.pid;
    eventually("the child execs sleep", || {
        process::name(sleep_pid).is_ok_and(|n| n == "sleep")
    })
    .await;

    eventually("the lock is taken", || {
        !lock_holders(std::slice::from_ref(&lock)).is_empty()
    })
    .await;
    assert_eq!(
        sorted(lock_holders(std::slice::from_ref(&lock))),
        sorted(vec![
            holder(flock_pid, "flock", &lock),
            holder(sleep_pid, "sleep", &lock),
        ])
    );

    flock.kill();
    assert_eq!(
        lock_holders(std::slice::from_ref(&lock)),
        vec![holder(sleep_pid, "sleep", &lock)],
        "the lock stays held while the child keeps the descriptor"
    );

    sleep.kill();
    tokio::time::timeout(Duration::from_secs(10), sleep.watch().exited())
        .await
        .expect("the sleep child exits")
        .expect("exit watch");
    eventually("the lock is released when its last holder is gone", || {
        lock_holders(std::slice::from_ref(&lock)).is_empty()
    })
    .await;
}

#[tokio::test]
async fn listening_socket_owner_finds_only_a_listener_inside_the_candidates_trees() {
    // A wrapper whose `node` child owns the listener (the launcher -> native
    // shape). Node picks a free port and prints it, so no port is guessed,
    // and exits by itself after ten minutes like the tests' `sleep 600`s.
    let mut wrapper = OwnChild::spawn(
        Command::new("sh")
            .args([
                "-c",
                r#"node -e "setTimeout(() => process.exit(0), 600000); const s = require('net').createServer().listen(0, '127.0.0.1', () => console.log(s.address().port))" & wait"#,
            ])
            .stdout(Stdio::piped()),
    );
    let wrapper_pid = wrapper.pid();
    // Pinned before anything is read from it or asserted.
    let node = Grandchild::of(&wrapper).await;
    let node_pid = node.pid;
    let port: u16 = wrapper
        .read_line()
        .parse()
        .expect("node prints its listening port");
    assert_eq!(process::name(node_pid).unwrap(), "node");

    assert_eq!(
        listening_socket_owner(port, &[wrapper_pid]),
        Some(node_pid),
        "the listener's owner is the wrapper's node child, not the wrapper"
    );

    // Another pane's unit: the listener answers, but not from its tree.
    let other = OwnChild::spawn(Command::new("sleep").arg("600"));
    std::net::TcpStream::connect(("127.0.0.1", port)).expect("the listener answers connections");
    assert_eq!(listening_socket_owner(port, &[other.pid()]), None);

    node.kill();
    wrapper.kill();
    drop(other);
}
