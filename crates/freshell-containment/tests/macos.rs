#![cfg(target_os = "macos")]
//! The macOS tag backend's facts: lock release order, exit watches on
//! processes that are not the test's children, environment reads of
//! entitled binaries, libproc lookup cost, and the kernel's responsible
//! process (which decides how detached jobs stay members).
//!
//! Every process signalled here was started by the test and is signalled
//! through a start-time-pinned `ProcWatch` or its own std `Child`. Waits for
//! readiness synchronise on lines the children print. Findings that later
//! decisions rest on are written past the test harness's output capture, so
//! every CI log carries them.
mod support;

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

use freshell_containment::process::{self, EnvRead};
use freshell_containment::*;
use support::*;

/// Repetitions of each lock-order experiment.
const REPS: usize = 200;

macro_rules! report {
    ($($arg:tt)*) => {{
        let _ = writeln!(std::io::stderr(), $($arg)*);
    }};
}

fn label() -> UnitLabel {
    UnitLabel {
        provider: "test".into(),
        ..Default::default()
    }
}

const HELPER: &str = env!("CARGO_BIN_EXE_freshell-test-helper");

/// `<sys/codesign.h>`.
const CS_OPS_STATUS: libc::c_uint = 0;
const CS_RESTRICT: u32 = 0x0000_0800;
const CS_RUNTIME: u32 = 0x0001_0000;

extern "C" {
    fn csops(
        pid: libc::pid_t,
        ops: libc::c_uint,
        useraddr: *mut libc::c_void,
        usersize: libc::size_t,
    ) -> libc::c_int;
}

/// The code-signing status flags of `pid`, read as an unprivileged caller.
fn cs_flags(pid: u32) -> Option<u32> {
    let mut flags: u32 = 0;
    // SAFETY: a valid out-pointer of the size passed.
    let rc = unsafe {
        csops(
            pid as libc::pid_t,
            CS_OPS_STATUS,
            (&mut flags as *mut u32).cast(),
            std::mem::size_of::<u32>(),
        )
    };
    (rc == 0).then_some(flags)
}

fn describe_flags(flags: Option<u32>) -> String {
    match flags {
        Some(f) => format!(
            "0x{f:08x} CS_RESTRICT={} CS_RUNTIME={}",
            f & CS_RESTRICT != 0,
            f & CS_RUNTIME != 0
        ),
        None => "unreadable".to_string(),
    }
}

/// A std child killed and reaped on drop (std never signals a reaped child).
struct Kid(Child);

impl Kid {
    fn spawn(cmd: &mut Command) -> Self {
        Self(cmd.spawn().unwrap())
    }

    fn id(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for Kid {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// Kills its process through the pin when dropped.
struct KillOnDrop(ProcWatch);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.signal(Sig::Kill);
    }
}

/// `freshell-test-helper hold-lock <path> --threads 16`: a real
/// `File::try_lock` (`flock(2)` here), exactly as Codex takes its
/// thread-writer lock, with extra threads that lengthen its teardown.
struct Holder {
    child: Child,
    stdin: Option<ChildStdin>,
}

impl Holder {
    fn start(path: &Path) -> Self {
        let mut child = Command::new(HELPER)
            .args(["hold-lock", path.to_str().unwrap(), "--threads", "16"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(
            line.trim(),
            format!("locked {}", child.id()),
            "the holder took the lock"
        );
        Self { child, stdin }
    }

    fn pid(&self) -> u32 {
        self.child.id()
    }

    /// The helper exits normally once its stdin reaches end of file.
    fn close_stdin(&mut self) {
        self.stdin.take();
    }

    fn reap(&mut self) {
        self.child.wait().unwrap();
    }
}

impl Drop for Holder {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Whether the test process can take `path`'s lock right now (released at
/// once when it can).
fn lock_is_free(path: &Path) -> bool {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .unwrap();
    match file.try_lock() {
        Ok(()) => {
            file.unlock().unwrap();
            true
        }
        Err(std::fs::TryLockError::WouldBlock) => false,
        Err(std::fs::TryLockError::Error(err)) => panic!("try_lock {}: {err}", path.display()),
    }
}

/// Reads lines from `child`'s stdout until one starts with `prefix`, and
/// returns the rest of it (bounded: the child prints it when ready).
fn line_after(reader: &mut impl BufRead, prefix: &str) -> String {
    let mut line = String::new();
    loop {
        line.clear();
        let n = reader.read_line(&mut line).unwrap();
        assert!(
            n > 0,
            "the child closed its output before printing {prefix:?}"
        );
        if let Some(rest) = line.trim_end().strip_prefix(prefix) {
            return rest.trim().to_string();
        }
    }
}

/// [`line_after`] for a tokio child's output.
async fn line_after_async(out: tokio::process::ChildStdout, prefix: &str) -> String {
    use tokio::io::AsyncBufReadExt;
    let mut lines = tokio::io::BufReader::new(out).lines();
    while let Some(line) = lines.next_line().await.unwrap() {
        if let Some(rest) = line.trim_end().strip_prefix(prefix) {
            return rest.trim().to_string();
        }
    }
    panic!("the child closed its output before printing {prefix:?}");
}

/// Bounded wait (test helper) until `pid` has exec'd into `name`.
async fn wait_for_name(pid: u32, name: &str) {
    eventually(
        Duration::from_secs(15),
        &format!("{pid} runs {name}"),
        || process::name(pid).is_ok_and(|n| n == name),
    )
    .await;
}

/// 95th percentile of `samples` (sorted in place).
fn p95(samples: &mut [Duration]) -> Duration {
    samples.sort_unstable();
    samples[(samples.len() * 95).div_ceil(100) - 1]
}

/// R12, as the runners are: whether the environment is withheld is decided
/// by the program's code-signing flags (`CS_RESTRICT`), which do not depend
/// on System Integrity Protection. With SIP on, the kernel trims a
/// restricted program's environment; with it off (the macOS 26 arm64 runner
/// image, run 38024127146) the kernel shows it, and `environ_read` still
/// reports it withheld. So no environment test passes falsely on a SIP-off
/// runner. Apple's own programs, `/bin/sleep` among them, are restricted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_restricted_programs_environment_is_withheld_whatever_the_sip_state() {
    let out = Command::new("csrutil").arg("status").output().unwrap();
    let sip = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let id = UnitId::mint();
    let kid = Kid::spawn(
        Command::new("/bin/sleep")
            .arg("60")
            .env(UNIT_ENV, id.as_str())
            .stdout(Stdio::null()),
    );
    wait_for_name(kid.id(), "sleep").await;
    let flags = cs_flags(kid.id());
    let ps = Command::new("ps")
        .args(["-E", "-ww", "-o", "command=", "-p", &kid.id().to_string()])
        .output()
        .unwrap();
    let kernel_shows_it = String::from_utf8_lossy(&ps.stdout).contains(id.as_str());
    report!(
        "SIP: {sip}; /bin/sleep csops {}; the kernel shows its environment: {kernel_shows_it}",
        describe_flags(flags)
    );
    let restricted = flags.is_some_and(|f| f & CS_RESTRICT != 0);
    let expected = if restricted {
        EnvRead::Withheld
    } else {
        EnvRead::Value(id.as_str().to_string())
    };
    assert_eq!(
        process::environ_read(kid.id(), UNIT_ENV),
        expected,
        "withheld exactly when the program is restricted (SIP: {sip})"
    );
}

/// V6 T1(i): macOS closes a process's descriptors (releasing its `flock`)
/// before it posts `NOTE_EXIT` to a watch registered before the exit began.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_flock_is_released_before_note_exit() {
    let dir = tempfile::tempdir().unwrap();
    for how in ["SIGKILL", "SIGTERM", "exit"] {
        let t0 = Instant::now();
        for rep in 0..REPS {
            let lock = dir.path().join(format!("{how}-{rep}.lock"));
            let mut holder = Holder::start(&lock);
            // Registered before the holder is told to go.
            let watch = ProcWatch::open(holder.pid()).unwrap();
            match how {
                "SIGKILL" => watch.signal(Sig::Kill).unwrap(),
                "SIGTERM" => watch.signal(Sig::Terminate).unwrap(),
                _ => holder.close_stdin(),
            }
            tokio::time::timeout(Duration::from_secs(10), watch.exited())
                .await
                .unwrap_or_else(|_| panic!("{how} #{rep}: no exit event"))
                .unwrap();
            assert!(
                lock_is_free(&lock),
                "{how} #{rep}: the lock was still held when the exit event arrived"
            );
            holder.reap();
        }
        report!("T1 {how}: {REPS} repetitions in {:?}", t0.elapsed());
    }
}

/// V6 T1(ii): a watch opened AFTER the kill (the process may already be
/// exiting, and then invisible to a plain lookup while its descriptors are
/// still open) never reports the exit before the lock is released.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_late_watch_never_reports_exited_while_the_lock_is_held() {
    let dir = tempfile::tempdir().unwrap();
    let (mut exited_at_open, mut exited_later) = (0usize, 0usize);
    let t0 = Instant::now();
    for rep in 0..REPS {
        let lock = dir.path().join(format!("late-{rep}.lock"));
        let mut holder = Holder::start(&lock);
        // SIGKILL through the std handle: the child is unreaped, so its pid
        // still names it below.
        holder.child.kill().unwrap();
        let watch = ProcWatch::open(holder.pid()).expect("our unreaped child can be watched");
        if watch.has_exited() {
            exited_at_open += 1;
            assert!(
                lock_is_free(&lock),
                "#{rep}: reported exited at open while the lock was held"
            );
        } else {
            exited_later += 1;
        }
        tokio::time::timeout(Duration::from_secs(10), watch.exited())
            .await
            .unwrap_or_else(|_| panic!("#{rep}: no exit"))
            .unwrap();
        assert!(
            lock_is_free(&lock),
            "#{rep}: exited() resolved while the lock was held"
        );
        holder.reap();
    }
    report!(
        "T1(ii): {REPS} late watches in {:?}: exited at open {exited_at_open}, later {exited_later}",
        t0.elapsed()
    );
}

/// V6 T2: `NOTE_EXIT` reaches a same-uid process that is not the test's
/// child (a `setsid` double fork reparented to launchd).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn note_exit_fires_for_a_reparented_non_child() {
    const DOUBLE_FORK: &str = r#"use POSIX;
my $p = fork() // die "fork: $!";
if ($p == 0) {
    POSIX::setsid() or die "setsid: $!";
    my $q = fork() // die "fork: $!";
    if ($q == 0) { $| = 1; print "pid $$\n"; close(STDOUT); sleep 600; exit 0; }
    exit 0;
}
waitpid($p, 0);"#;
    let mut top = Command::new("perl")
        .args(["-e", DOUBLE_FORK])
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let pid: u32 = line_after(&mut BufReader::new(top.stdout.take().unwrap()), "pid")
        .parse()
        .unwrap();
    top.wait().unwrap();
    let watch = ProcWatch::open(pid).unwrap();
    let _cleanup = KillOnDrop(watch.clone());
    eventually(Duration::from_secs(5), "reparented to launchd", || {
        process::parent(pid) == Some(1)
    })
    .await;
    assert!(!watch.has_exited());
    watch.signal(Sig::Kill).unwrap();
    tokio::time::timeout(Duration::from_secs(1), watch.exited())
        .await
        .expect("NOTE_EXIT within 1 s")
        .unwrap();
}

/// V6 T3, as the runners are: a process's unit tag reads back unless the
/// program is restricted (`CS_RESTRICT`: Apple's own programs and entitled
/// ones), whose environment is reported withheld, never absent; argv is
/// exactly the arguments, never the environment that follows them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_unit_tag_is_read_or_reported_withheld() {
    let codex = std::env::var("FRESHELL_TEST_CODEX_NATIVE").expect(
        "FRESHELL_TEST_CODEX_NATIVE must name the native Codex binary (CI installs @openai/codex@0.162.0)",
    );
    let id = UnitId::mint();
    let codex_home = tempfile::tempdir().unwrap();
    let node = |args: &[&str]| -> Vec<String> {
        std::iter::once("node")
            .chain(args.iter().copied())
            .map(str::to_string)
            .collect()
    };
    let sleep: Vec<String> = vec!["/bin/sleep".into(), "60".into()];
    // (what, command, process name after exec, argv after exec)
    type Case = (&'static str, Vec<String>, &'static str, Vec<String>);
    let cases: Vec<Case> = vec![
        ("sleep", sleep.clone(), "sleep", sleep.clone()),
        (
            "sandbox-exec",
            [
                "/usr/bin/sandbox-exec",
                "-p",
                "(version 1)(allow default)",
                "/bin/sleep",
                "60",
            ]
            .map(str::to_string)
            .to_vec(),
            "sleep",
            sleep.clone(),
        ),
        (
            "node",
            node(&["-e", "setTimeout(()=>{},60000)"]),
            "node",
            node(&["-e", "setTimeout(()=>{},60000)"]),
        ),
        (
            "codex",
            vec![codex.clone(), "app-server".into()],
            "codex",
            vec![codex.clone(), "app-server".into()],
        ),
    ];
    for (what, command, name, argv) in cases {
        // stdin is held open (Codex's app-server serves stdio until EOF).
        let kid = Kid::spawn(
            Command::new(&command[0])
                .args(&command[1..])
                .env(UNIT_ENV, id.as_str())
                .env("CODEX_HOME", codex_home.path())
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null()),
        );
        wait_for_name(kid.id(), name).await;
        let flags = cs_flags(kid.id());
        let read = process::environ_read(kid.id(), UNIT_ENV);
        let seen_argv = process::argv(kid.id()).unwrap();
        report!(
            "T3 {what}: pid {} csops {} environ_read {read:?}",
            kid.id(),
            describe_flags(flags)
        );
        let restricted = flags.is_some_and(|f| f & CS_RESTRICT != 0);
        match &read {
            EnvRead::Value(v) => {
                assert_eq!(v, id.as_str(), "{what}");
                assert!(!restricted, "{what}: a restricted program read back");
            }
            EnvRead::Withheld => assert!(restricted, "{what}: its environment must be readable"),
            EnvRead::Absent => panic!("{what}: a withheld environment was reported as untagged"),
        }
        assert_eq!(seen_argv, argv, "{what}: argv is exactly the arguments");
    }
}

/// V6 T4: the member-scoped lock-holder and listener lookups and the
/// same-uid outside-holder scan each fit twice inside the 5 s Gone window.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn libproc_lookups_fit_the_gone_window() {
    let dir = tempfile::tempdir().unwrap();
    let lock = dir.path().join("t.lock");
    let holder = Holder::start(&lock);
    let mut node = Kid::spawn(
        Command::new("node")
            .args([
                "-e",
                "const s = require('net').createServer().listen(0, '127.0.0.1', () => console.log('port ' + s.address().port))",
            ])
            .stdout(Stdio::piped()),
    );
    let port: u16 = line_after(&mut BufReader::new(node.0.stdout.take().unwrap()), "port")
        .parse()
        .unwrap();
    report!(
        "T4: proc_listallpids lists {} processes",
        process::all_pids().len()
    );
    let paths = [lock.clone()];
    let timed = |what: &str, f: &mut dyn FnMut() -> bool| {
        let mut samples = Vec::new();
        for _ in 0..20 {
            let t0 = Instant::now();
            assert!(f(), "{what}: wrong answer");
            samples.push(t0.elapsed());
        }
        let p = p95(&mut samples);
        report!("T4 {what}: p95 {p:?} (max {:?})", samples.last().unwrap());
        assert!(p < Duration::from_secs(1), "{what}: p95 {p:?}");
    };
    timed("member lock holders", &mut || {
        lock_holders_among(&paths, &[holder.pid()])
            .iter()
            .any(|h| h.pid == holder.pid())
    });
    timed("member listener", &mut || {
        listening_socket_owner(port, &[node.id()]) == Some(node.id())
    });
    timed("same-uid outside holders", &mut || {
        lock_holders(&paths).iter().any(|h| h.pid == holder.pid())
    });
}

/// The process the system holds responsible for `pid` (itself after a
/// disclaimed spawn, else copied from its parent at fork), read through the
/// private libSystem function `responsibility_get_pid_responsible_for_pid`;
/// `None` when it cannot be read.
fn responsible_pid(pid: u32) -> Option<u32> {
    type GetResponsible = unsafe extern "C" fn(libc::pid_t) -> libc::pid_t;
    // SAFETY: a NUL-terminated name looked up in every loaded image.
    let symbol = unsafe {
        libc::dlsym(
            libc::RTLD_DEFAULT,
            c"responsibility_get_pid_responsible_for_pid".as_ptr(),
        )
    };
    if symbol.is_null() {
        return None;
    }
    // SAFETY: the libSystem function of this exact signature.
    let get = unsafe { std::mem::transmute::<usize, GetResponsible>(symbol as usize) };
    // SAFETY: a plain pid argument.
    let responsible = unsafe { get(pid as libc::pid_t) };
    u32::try_from(responsible).ok().filter(|r| *r > 0)
}

/// Plan review R1-F2, Branch B's record of why fork tracking is used: a
/// root started through the test helper's `disclaim-exec` is its own
/// responsible process, but a detached official `node` (via `nohup`, or a
/// `setsid` double fork) is its own responsible process too, so
/// responsibility cannot carry membership to detached jobs (decision run
/// 38024127146). Fails if macOS ever carries it through, when the
/// responsible process could replace the fork tracker. The disclaimed
/// spawn and the responsible-process query are test-only code (the helper
/// and this file); the server never uses them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn responsibility_does_not_follow_detached_descendants() {
    for symbol in [
        c"responsibility_spawnattrs_setdisclaim",
        c"responsibility_get_pid_responsible_for_pid",
    ] {
        // SAFETY: a NUL-terminated symbol name looked up in every loaded image.
        let found = unsafe { libc::dlsym(libc::RTLD_DEFAULT, symbol.as_ptr()) };
        assert!(!found.is_null(), "{symbol:?} is not exported here");
    }
    const SCRIPT: &str = r#"echo "root $$"
N1=$(sh -c 'nohup node -e "setInterval(()=>{},1000)" >/dev/null 2>&1 & echo $!')
N2=$(perl -e 'use POSIX; my $p = fork() // die; if ($p == 0) { POSIX::setsid() or die; my $q = fork() // die; if ($q == 0) { open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null"); exec "node", "-e", "setInterval(()=>{},1000)"; } print "$q\n"; exit 0; } waitpid($p, 0);')
echo "nodes $N1 $N2"
exec sleep 600"#;
    let mut root = Kid::spawn(
        Command::new(HELPER)
            .args(["disclaim-exec", "--", "/bin/sh", "-c", SCRIPT])
            .stdout(Stdio::piped()),
    );
    let mut out = BufReader::new(root.0.stdout.take().unwrap());
    let shell: u32 = line_after(&mut out, "root").parse().unwrap();
    let nodes: Vec<u32> = line_after(&mut out, "nodes")
        .split_whitespace()
        .map(|p| p.parse().unwrap())
        .collect();
    let pins: Vec<KillOnDrop> = nodes
        .iter()
        .map(|pid| KillOnDrop(ProcWatch::open(*pid).unwrap()))
        .collect();
    assert_eq!(shell, root.id(), "the shim execs its command in place");
    assert_eq!(
        responsible_pid(root.id()),
        Some(root.id()),
        "a disclaimed root is its own responsible process"
    );
    eventually(Duration::from_secs(10), "both nodes reparented", || {
        nodes.iter().all(|pid| process::parent(*pid) == Some(1))
    })
    .await;
    for pid in &nodes {
        report!(
            "T5: node {pid} responsible pid {:?} (root {}) csops {}",
            responsible_pid(*pid),
            root.id(),
            describe_flags(cs_flags(*pid))
        );
    }
    let stranger = OwnChild::sleep();
    assert_ne!(responsible_pid(stranger.id()), Some(root.id()));
    for pid in &nodes {
        assert_ne!(
            responsible_pid(*pid),
            Some(root.id()),
            "detached node {pid} now keeps the root as its responsible process: \
             the responsible process could carry membership"
        );
    }
    drop(pins);
}

/// The planned selection test: the tag backend is selected, a member's unit
/// tag reads back (the official `node`, an unrestricted program; Apple's
/// own `sleep` is restricted), and a Force stop reaches Gone.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn macos_selects_the_tag_backend_and_reads_the_unit_tag() {
    let state = tempfile::tempdir().unwrap();
    let c = Containment::select(SelectOptions {
        state_root: state.path().to_path_buf(),
        ..Default::default()
    });
    assert_eq!(c.capability().kind, BackendKind::MacosTag);
    assert!(!c.capability().full);
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let mut cmd = unit
        .tokio_command(
            "node",
            &["-e".to_string(), "setInterval(()=>{},1000)".to_string()],
            MemberRole::Agent,
        )
        .unwrap();
    cmd.kill_on_drop(true).stdin(Stdio::null());
    let mut child = cmd.spawn().unwrap();
    let pid = child.id().unwrap();
    let watch = ProcWatch::open(pid).unwrap();
    unit.set_main(watch.clone());
    wait_for_name(pid, "node").await;
    let flags = cs_flags(pid);
    report!("selection: node csops {}", describe_flags(flags));
    let expected = if flags.is_some_and(|f| f & CS_RESTRICT != 0) {
        EnvRead::Withheld
    } else {
        EnvRead::Value(unit.id().as_str().to_string())
    };
    assert_eq!(process::environ_read(pid, UNIT_ENV), expected);
    let report = tokio::time::timeout(
        Duration::from_secs(10),
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "test",
        ))
        .wait(),
    )
    .await
    .expect("Gone");
    assert_eq!(report.reason, "shift-x");
    tokio::time::timeout(Duration::from_secs(5), watch.exited())
        .await
        .expect("the member exited")
        .unwrap();
    child.wait().await.unwrap();
}

/// R12: a main whose environment may be withheld is still a member (the
/// pinned root), and so is its child (a descendant); a stop that met
/// withheld environments logs it, and ends both. Run with the official
/// `node` (the plan's program, readable on the runners) and with Apple's
/// `/bin/sh` and `sleep` (restricted, so the fallback is always exercised).
#[tokio::test(flavor = "current_thread")]
async fn a_withheld_environment_falls_back_to_roots_and_descendants() {
    let node_main = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); console.log('ready ' + c.pid); setInterval(()=>{}, 1000);";
    let cases = [
        ("node", ["-e", node_main]),
        ("/bin/sh", ["-c", "sleep 600 & echo \"ready $!\"; wait"]),
    ];
    for (program, args) in cases {
        let (cap, guard) = capture::install();
        let state = tempfile::tempdir().unwrap();
        let c = Containment::select(SelectOptions {
            shim: Some(test_shim()),
            state_root: state.path().to_path_buf(),
        });
        let unit = c.create_unit(UnitId::mint(), label()).unwrap();
        let args: Vec<String> = args.iter().map(|a| a.to_string()).collect();
        let mut cmd = unit
            .tokio_command(program, &args, MemberRole::Agent)
            .unwrap();
        cmd.kill_on_drop(false)
            .stdin(Stdio::null())
            .stdout(Stdio::piped());
        let mut main = cmd.spawn().unwrap();
        let main_watch = ProcWatch::open(main.id().unwrap()).unwrap();
        let _main_cleanup = KillOnDrop(main_watch.clone());
        unit.set_main(main_watch.clone());
        let child_pid: u32 = line_after_async(main.stdout.take().unwrap(), "ready")
            .await
            .parse()
            .unwrap();
        let child_watch = ProcWatch::open(child_pid).unwrap();
        let _child_cleanup = KillOnDrop(child_watch.clone());
        let mut reads = Vec::new();
        for pid in [main_watch.pid(), child_pid] {
            let flags = cs_flags(pid);
            let read = process::environ_read(pid, UNIT_ENV);
            report!(
                "R12 {program}: pid {pid} environ {read:?} csops {}",
                describe_flags(flags)
            );
            if flags.is_some_and(|f| f & CS_RESTRICT != 0) {
                assert_eq!(read, EnvRead::Withheld, "{program}: pid {pid}");
            }
            reads.push(read);
        }
        let members: Vec<u32> = {
            let unit = unit.clone();
            tokio::task::spawn_blocking(move || unit.members().unwrap())
                .await
                .unwrap()
                .iter()
                .map(|m| m.pid)
                .collect()
        };
        assert!(
            members.contains(&main_watch.pid()),
            "{program}: {members:?}"
        );
        assert!(members.contains(&child_pid), "{program}: {members:?}");
        unit.stop(StopRequest::new(
            StopMode::Force,
            StopReason::ShiftX,
            "test",
        ))
        .wait_swept()
        .await;
        for (what, watch) in [("main", &main_watch), ("child", &child_watch)] {
            tokio::time::timeout(Duration::from_secs(5), watch.exited())
                .await
                .unwrap_or_else(|_| panic!("{program}: the {what} survived the stop"))
                .unwrap();
        }
        if reads.contains(&EnvRead::Withheld) {
            assert!(
                cap.has(tracing::Level::INFO, "unit.members.environ_withheld"),
                "{program}: a stop that met withheld environments logs it"
            );
        }
        let _ = main.wait().await;
        drop(guard);
    }
}

/// The detached-job test's main (the official `node`): a `nohup` job whose
/// intermediate shell exits at once, and a job in a `setsid` session (the
/// perl script below); then it prints `jobs <nohup job> <session leader>
/// <session job>`.
const DETACHING_MAIN: &str = r#"const { execFileSync, spawn } = require('child_process');
const nohup = execFileSync('/bin/sh', ['-c', 'nohup /bin/sleep 600 >/dev/null 2>&1 & echo $!']).toString().trim();
const session = spawn('perl', [process.argv[2]], { stdio: ['ignore', 'pipe', 'ignore'] });
let out = '';
let told = false;
session.stdout.on('data', (d) => {
  out += d;
  if (!told && out.includes('\n')) {
    told = true;
    console.log('jobs ' + nohup + ' ' + out.trim());
  }
});
setInterval(() => {}, 1000);
"#;

/// A session leader (it stays, as `/bin/sleep`, the child of this script,
/// which waits for it) whose intermediate child starts the job and exits at
/// once, so the job's parent link ends with it. Prints `<leader> <job>`.
const DETACHING_SESSION: &str = r#"use POSIX;
pipe(my $r, my $w) or die "pipe: $!";
my $leader = fork() // die "fork: $!";
if ($leader == 0) {
    close $r;
    POSIX::setsid() or die "setsid: $!";
    my $mid = fork() // die "fork: $!";
    if ($mid == 0) {
        my $job = fork() // die "fork: $!";
        if ($job == 0) {
            close $w;
            open(STDIN, "<", "/dev/null"); open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null");
            exec "/bin/sleep", "600" or exit 127;
        }
        print $w "$job\n";
        close $w;
        exit 0;
    }
    close $w;
    waitpid($mid, 0);
    open(STDIN, "<", "/dev/null"); open(STDOUT, ">", "/dev/null"); open(STDERR, ">", "/dev/null");
    exec "/bin/sleep", "600" or exit 127;
}
close $w;
my $job = <$r>;
chomp $job;
$| = 1;
print "$leader $job\n";
close STDOUT;
waitpid($leader, 0);
"#;

/// Plan review R1-F2, R2-F2: jobs the agent detached, a `nohup` job and a
/// job in a `setsid` session, are still killed by a stop when they run a
/// restricted program (`/bin/sleep`: its environment, and so its unit tag,
/// is withheld) and were reparented to launchd. Neither a tag nor a parent
/// link reaches them, only the fork tracker's session and process-group
/// links. Both jobs detach before the unit tracks its root (as after a
/// server restart, when tracking resumes from the recorded roots), so their
/// parents are gone when the tracker first scans: the `nohup` job is linked
/// through the root's session and process group, the `setsid` job through
/// its session leader, which stays a member as the root's descendant. The
/// test waits for the unit record to list both jobs (only the tracker
/// writes that), then stops the unit. A session leader that exits before
/// the tracker scans is the tracker's stated residual, which no test
/// claims.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_detached_restricted_job_is_killed_by_a_stop() {
    let dir = tempfile::tempdir().unwrap();
    let main_js = dir.path().join("main.js");
    std::fs::write(&main_js, DETACHING_MAIN).unwrap();
    let session_pl = dir.path().join("session.pl");
    std::fs::write(&session_pl, DETACHING_SESSION).unwrap();
    let state = tempfile::tempdir().unwrap();
    let c = Containment::select(SelectOptions {
        shim: Some(test_shim()),
        state_root: state.path().to_path_buf(),
    });
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let mut cmd = unit
        .tokio_command(
            "node",
            &[
                main_js.display().to_string(),
                session_pl.display().to_string(),
            ],
            MemberRole::Agent,
        )
        .unwrap();
    cmd.kill_on_drop(false)
        .stdin(Stdio::null())
        .stdout(Stdio::piped());
    let mut main = cmd.spawn().unwrap();
    let main_watch = ProcWatch::open(main.id().unwrap()).unwrap();
    let _main_cleanup = KillOnDrop(main_watch.clone());
    let pids: Vec<u32> = line_after_async(main.stdout.take().unwrap(), "jobs")
        .await
        .split_whitespace()
        .map(|p| p.parse().unwrap())
        .collect();
    let (nohup_job, leader, session_job) = (pids[0], pids[1], pids[2]);
    let jobs = [nohup_job, session_job];
    let watches: Vec<ProcWatch> = jobs
        .iter()
        .map(|pid| ProcWatch::open(*pid).unwrap())
        .collect();
    let _cleanup: Vec<KillOnDrop> = watches.iter().cloned().map(KillOnDrop).collect();
    let _leader_cleanup = KillOnDrop(ProcWatch::open(leader).unwrap());
    eventually(Duration::from_secs(10), "both jobs reparented", || {
        jobs.iter().all(|pid| process::parent(*pid) == Some(1))
    })
    .await;
    for pid in jobs {
        wait_for_name(pid, "sleep").await;
        // SAFETY: plain reads of a pid's process group and session.
        let (pgid, sid) = unsafe {
            (
                libc::getpgid(pid as libc::pid_t),
                libc::getsid(pid as libc::pid_t),
            )
        };
        report!(
            "R1-F2: detached job {pid} (root {}, session leader {leader}): pgid {pgid} sid {sid} csops {}",
            main_watch.pid(),
            describe_flags(cs_flags(pid))
        );
        assert_eq!(
            process::environ_read(pid, UNIT_ENV),
            EnvRead::Withheld,
            "a restricted program's tag is withheld"
        );
    }
    // Tracking starts now, with both jobs' parents gone.
    unit.set_main(main_watch.clone());
    let record = state
        .path()
        .join("units")
        .join(format!("{}.json", unit.id().as_str()));
    let job_roots: Vec<(u32, u64)> = watches
        .iter()
        .map(|w| (w.pid(), w.identity().start))
        .collect();
    eventually(
        Duration::from_secs(10),
        "the fork tracker records both detached jobs as roots",
        || {
            recorded_roots(&record)
                .is_some_and(|roots| job_roots.iter().all(|job| roots.contains(job)))
        },
    )
    .await;
    unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test",
    ))
    .wait_swept()
    .await;
    for (pid, watch) in jobs.iter().zip(&watches) {
        tokio::time::timeout(Duration::from_secs(5), watch.exited())
            .await
            .unwrap_or_else(|_| panic!("detached job {pid} survived the stop"))
            .unwrap();
    }
    let _ = main.wait().await;
}

/// The roots of the unit record at `path`, when it can be read.
fn recorded_roots(path: &Path) -> Option<Vec<(u32, u64)>> {
    let raw = std::fs::read(path).ok()?;
    serde_json::from_slice::<UnitRecord>(&raw)
        .ok()
        .map(|record| record.roots)
}

/// The user's rule: Codex's managed daemon is never signalled, and its
/// family is never a unit root. A member that starts a daemon-family
/// process (the test helper shaped as `app-server --managed-daemon`,
/// through a shell's fork and exec, so the tracker can see it before the
/// exec) does not leave it in the unit record, while a plain job started
/// after it is recorded; and the stop spares it.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_daemon_family_process_is_never_left_in_the_unit_record() {
    let state = tempfile::tempdir().unwrap();
    let c = Containment::select(SelectOptions {
        shim: Some(test_shim()),
        state_root: state.path().to_path_buf(),
    });
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let script = format!(
        "'{HELPER}' idle app-server --managed-daemon >/dev/null 2>&1 & echo \"daemon $!\"; /bin/sleep 600 & echo \"job $!\"; exec /bin/sleep 600"
    );
    let mut cmd = unit
        .tokio_command("/bin/sh", &["-c".to_string(), script], MemberRole::Agent)
        .unwrap();
    cmd.kill_on_drop(false)
        .stdin(Stdio::null())
        .stdout(Stdio::piped());
    let mut main = cmd.spawn().unwrap();
    let main_watch = ProcWatch::open(main.id().unwrap()).unwrap();
    let _main_cleanup = KillOnDrop(main_watch.clone());
    unit.set_main(main_watch.clone());
    let (daemon, job) = {
        use tokio::io::AsyncBufReadExt;
        let mut lines = tokio::io::BufReader::new(main.stdout.take().unwrap()).lines();
        let mut pids = Vec::new();
        for prefix in ["daemon", "job"] {
            let line = lines
                .next_line()
                .await
                .unwrap()
                .expect("the main printed its children");
            let pid: u32 = line
                .strip_prefix(prefix)
                .unwrap_or_else(|| panic!("expected {prefix:?}: {line:?}"))
                .trim()
                .parse()
                .unwrap();
            pids.push(pid);
        }
        (pids[0], pids[1])
    };
    // Both are children of the main, which runs on: their pids name them.
    let daemon_watch = ProcWatch::open(daemon).unwrap();
    let _daemon_cleanup = KillOnDrop(daemon_watch.clone());
    let job_watch = ProcWatch::open(job).unwrap();
    let _job_cleanup = KillOnDrop(job_watch.clone());
    eventually(
        Duration::from_secs(10),
        "the daemon-family process exec'd",
        || process::argv(daemon).is_ok_and(|argv| is_codex_daemon_family(&argv)),
    )
    .await;
    let record = state
        .path()
        .join("units")
        .join(format!("{}.json", unit.id().as_str()));
    let job_root = (job, job_watch.identity().start);
    eventually(
        Duration::from_secs(10),
        "the job is a recorded root and the daemon-family process is not",
        || {
            recorded_roots(&record).is_some_and(|roots| {
                roots.contains(&job_root) && !roots.iter().any(|(pid, _)| *pid == daemon)
            })
        },
    )
    .await;
    unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test",
    ))
    .wait_swept()
    .await;
    tokio::time::timeout(Duration::from_secs(5), job_watch.exited())
        .await
        .expect("the job was stopped")
        .unwrap();
    assert!(
        !daemon_watch.has_exited(),
        "the daemon-family process was signalled"
    );
    let _ = main.wait().await;
}

/// The `--setsid` shim makes its command lead its own session (so what the
/// command starts stays linked to it by session after its parent exits),
/// also when the spawner made it a process-group leader
/// (`process_group(0)`), where `setsid()` alone is refused; the command
/// still leads its own process group.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_setsid_shim_leads_a_session_even_when_spawned_as_a_group_leader() {
    use std::os::unix::process::CommandExt;
    for group_leader in [false, true] {
        let mut cmd = Command::new(test_shim().exe);
        cmd.args(["--setsid", "--", "/bin/sleep", "600"]);
        if group_leader {
            cmd.process_group(0);
        }
        let child = Kid::spawn(&mut cmd);
        let pid = child.id();
        wait_for_name(pid, "sleep").await;
        // SAFETY: plain reads of a pid's session and process group.
        let (sid, pgid) = unsafe {
            (
                libc::getsid(pid as libc::pid_t),
                libc::getpgid(pid as libc::pid_t),
            )
        };
        assert_eq!(
            sid, pid as libc::pid_t,
            "spawned as a group leader: {group_leader}: the command leads its own session"
        );
        assert_eq!(
            pgid, pid as libc::pid_t,
            "spawned as a group leader: {group_leader}: the command leads its own process group"
        );
    }
}

/// Why Branch B records every followed process as a root: after a server
/// crash, the restarted server finishes the unit from its record and
/// reaches a followed job by identity, though nothing else leads to it any
/// more (a restricted program, so no readable tag; reparented to launchd;
/// its session leader, the main, gone).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_followed_job_is_stopped_from_the_unit_record_after_a_crash() {
    let state = tempfile::tempdir().unwrap();
    let c = rebuild("selected", state.path());
    assert_eq!(c.capability().kind, BackendKind::MacosTag);
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let mut cmd = unit
        .tokio_command(
            "/bin/sh",
            &[
                "-c".to_string(),
                "nohup /bin/sleep 600 >/dev/null 2>&1 & echo \"job $!\"; exec /bin/sleep 600"
                    .to_string(),
            ],
            MemberRole::Agent,
        )
        .unwrap();
    cmd.kill_on_drop(false)
        .stdin(Stdio::null())
        .stdout(Stdio::piped());
    let mut main = cmd.spawn().unwrap();
    let main_watch = ProcWatch::open(main.id().unwrap()).unwrap();
    let _main_cleanup = KillOnDrop(main_watch.clone());
    unit.set_main(main_watch.clone());
    let job: u32 = line_after_async(main.stdout.take().unwrap(), "job")
        .await
        .parse()
        .unwrap();
    // A child of the main, which runs on: its pid names it.
    let job_watch = ProcWatch::open(job).unwrap();
    let _job_cleanup = KillOnDrop(job_watch.clone());
    let job_root = (job, job_watch.identity().start);
    wait_for_name(job, "sleep").await;
    assert_eq!(
        process::environ_read(job, UNIT_ENV),
        EnvRead::Withheld,
        "a restricted program's tag is withheld"
    );
    let record = record_path(state.path(), "selected", &unit);
    eventually(
        Duration::from_secs(10),
        "the job is a recorded root",
        || recorded_roots(&record).is_some_and(|roots| roots.contains(&job_root)),
    )
    .await;
    // The main (the job's parent and session leader) ends; the record
    // keeps the job.
    main_watch.signal(Sig::Kill).unwrap();
    let _ = main.wait().await;
    eventually(Duration::from_secs(10), "the job is reparented", || {
        process::parent(job) == Some(1)
    })
    .await;
    let main_pid = main_watch.pid();
    eventually(
        Duration::from_secs(10),
        "the record keeps the job and drops the main",
        || {
            recorded_roots(&record).is_some_and(|roots| {
                roots.contains(&job_root) && !roots.iter().any(|(pid, _)| *pid == main_pid)
            })
        },
    )
    .await;
    // The server crashes: its unit and containment go away without a stop.
    let unit_id = unit.id().clone();
    drop(unit);
    drop(c);
    assert!(!job_watch.has_exited(), "the crash stopped nothing");
    let c = rebuild("selected", state.path());
    let records = c.recorded_units().unwrap();
    let record = records
        .iter()
        .find(|r| r.unit_id == unit_id)
        .expect("the restarted server finds the unit's record");
    let unit = c.reopen_unit(record, label()).unwrap();
    unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::BootFinish,
        "boot",
    ))
    .wait_swept()
    .await;
    tokio::time::timeout(Duration::from_secs(5), job_watch.exited())
        .await
        .expect("the followed job was stopped from the record")
        .unwrap();
    assert!(
        c.recorded_units().unwrap().is_empty(),
        "Gone deletes the record"
    );
}

/// Branch B: every process the fork tracker follows is recorded as a root
/// in the unit record while it runs, so a restarted server reaches it by
/// identity even if the server crashed mid-stop.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_followed_process_is_recorded_as_a_root() {
    let state = tempfile::tempdir().unwrap();
    let c = Containment::select(SelectOptions {
        shim: Some(test_shim()),
        state_root: state.path().to_path_buf(),
    });
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let mut cmd = unit
        .tokio_command(
            "/bin/sh",
            &[
                "-c".to_string(),
                "nohup sleep 600 >/dev/null 2>&1 & echo \"job $!\"; exec sleep 600".to_string(),
            ],
            MemberRole::Agent,
        )
        .unwrap();
    cmd.kill_on_drop(false)
        .stdin(Stdio::null())
        .stdout(Stdio::piped());
    let mut main = cmd.spawn().unwrap();
    let main_watch = ProcWatch::open(main.id().unwrap()).unwrap();
    let _main_cleanup = KillOnDrop(main_watch.clone());
    unit.set_main(main_watch.clone());
    let job: u32 = line_after_async(main.stdout.take().unwrap(), "job")
        .await
        .parse()
        .unwrap();
    let job_watch = ProcWatch::open(job).unwrap();
    let _job_cleanup = KillOnDrop(job_watch.clone());
    let identity = (job, job_watch.identity().start);
    let record = state
        .path()
        .join("units")
        .join(format!("{}.json", unit.id().as_str()));
    eventually(
        Duration::from_secs(10),
        "the job is a recorded root",
        || {
            std::fs::read(&record)
                .ok()
                .and_then(|raw| serde_json::from_slice::<UnitRecord>(&raw).ok())
                .is_some_and(|r| r.roots.contains(&identity))
        },
    )
    .await;
    unit.stop(StopRequest::new(
        StopMode::Force,
        StopReason::ShiftX,
        "test",
    ))
    .wait_swept()
    .await;
    tokio::time::timeout(Duration::from_secs(5), job_watch.exited())
        .await
        .expect("the followed job was stopped")
        .unwrap();
    let _ = main.wait().await;
}

/// The planned lookup test (it was `lsof_lookups_find_lock_file_holders_and_listeners`):
/// libproc finds a `flock` holder and a listening socket's owner.
#[tokio::test(flavor = "multi_thread")]
async fn libproc_lookups_find_lock_file_holders_and_listeners() {
    let dir = tempfile::tempdir().unwrap();
    let lock: PathBuf = dir.path().join("t.lock");
    std::fs::write(&lock, b"").unwrap();
    let mut holder = Kid::spawn(
        Command::new("perl")
            .args([
                "-e",
                "use Fcntl qw(:flock); open(my $f, '>>', $ARGV[0]) or die; flock($f, LOCK_EX) or die; $| = 1; print \"locked\\n\"; sleep 600",
                lock.to_str().unwrap(),
            ])
            .stdout(Stdio::piped()),
    );
    line_after(
        &mut BufReader::new(holder.0.stdout.take().unwrap()),
        "locked",
    );
    assert!(lock_holders(std::slice::from_ref(&lock))
        .iter()
        .any(|h| h.pid == holder.id()));
    let mut listener = Kid::spawn(
        Command::new("node")
            .args([
                "-e",
                "const s = require('net').createServer().listen(0, '127.0.0.1', () => console.log('port ' + s.address().port))",
            ])
            .stdout(Stdio::piped()),
    );
    let port: u16 = line_after(
        &mut BufReader::new(listener.0.stdout.take().unwrap()),
        "port",
    )
    .parse()
    .unwrap();
    assert_eq!(
        listening_socket_owner(port, &[listener.id()]),
        Some(listener.id())
    );
}
