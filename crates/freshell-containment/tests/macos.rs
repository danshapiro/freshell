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

#[test]
fn system_integrity_protection_is_enabled() {
    let out = Command::new("csrutil").arg("status").output().unwrap();
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    report!("csrutil status: {}", text.trim());
    assert!(
        text.contains("status: enabled"),
        "System Integrity Protection is off here: the kernel then returns every \
         process's environment, so the withheld-environment tests would pass falsely: {text}"
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

/// V6 T3: the unit tag of an ordinary process reads back; an entitled
/// binary's environment reads back or is reported withheld, never absent;
/// argv is exactly the arguments, never the environment that follows them.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_unit_tag_is_read_or_reported_withheld() {
    let codex = std::env::var("FRESHELL_TEST_CODEX_NATIVE").expect(
        "FRESHELL_TEST_CODEX_NATIVE must name the native Codex binary (CI installs @openai/codex@0.162.0)",
    );
    let id = UnitId::mint();
    let codex_home = tempfile::tempdir().unwrap();
    // (what, command, process name after exec, argv after exec, may be withheld)
    let cases: Vec<(&str, Vec<String>, &str, Vec<String>, bool)> = vec![
        (
            "sleep",
            vec!["/bin/sleep".into(), "60".into()],
            "sleep",
            vec!["/bin/sleep".into(), "60".into()],
            false,
        ),
        (
            "sandbox-exec",
            vec![
                "/usr/bin/sandbox-exec".into(),
                "-p".into(),
                "(version 1)(allow default)".into(),
                "/bin/sleep".into(),
                "60".into(),
            ],
            "sleep",
            vec!["/bin/sleep".into(), "60".into()],
            false,
        ),
        (
            "node",
            vec![
                "node".into(),
                "-e".into(),
                "setTimeout(()=>{},60000)".into(),
            ],
            "node",
            vec![
                "node".into(),
                "-e".into(),
                "setTimeout(()=>{},60000)".into(),
            ],
            true,
        ),
        (
            "codex",
            vec![codex.clone(), "app-server".into()],
            "codex",
            vec![codex.clone(), "app-server".into()],
            true,
        ),
    ];
    for (what, command, name, argv, may_withhold) in cases {
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
        match &read {
            EnvRead::Value(v) => assert_eq!(v, id.as_str(), "{what}"),
            EnvRead::Withheld => assert!(may_withhold, "{what}: its environment must be readable"),
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

/// Plan review R1-F2: decides how detached jobs stay members. A root started
/// through the shim's `--disclaim` is its own responsible process, and the
/// kernel keeps that responsible pid on every descendant through `nohup`,
/// `setsid` and reparenting to launchd.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn responsibility_follows_detached_descendants() {
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
N2=$(perl -e 'use POSIX; my $p = fork() // die; if ($p == 0) { POSIX::setsid() or die; my $q = fork() // die; if ($q == 0) { open(STDOUT, ">", "/dev/null"); exec "node", "-e", "setInterval(()=>{},1000)"; } print "$q\n"; exit 0; } waitpid($p, 0);')
echo "nodes $N1 $N2"
exec sleep 600"#;
    let mut root = Kid::spawn(
        Command::new(test_shim().exe)
            .args(["--disclaim", "--", "/bin/sh", "-c", SCRIPT])
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
        process::responsible_pid(root.id()),
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
            process::responsible_pid(*pid),
            root.id(),
            describe_flags(cs_flags(*pid))
        );
    }
    let stranger = OwnChild::sleep();
    let stranger_responsible = process::responsible_pid(stranger.id());
    report!(
        "T5: an unwrapped sleep's responsible pid {stranger_responsible:?} (the test runs as pid {})",
        std::process::id()
    );
    assert_ne!(stranger_responsible, Some(root.id()));
    for pid in &nodes {
        assert_eq!(
            process::responsible_pid(*pid),
            Some(root.id()),
            "detached node {pid} keeps the root as its responsible process"
        );
    }
    drop(pins);
}

/// The planned selection test: the tag backend is selected and a member's
/// unit tag reads back; a Force stop reaches Gone.
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
        .tokio_command("sleep", &["600".to_string()], MemberRole::Agent)
        .unwrap();
    cmd.kill_on_drop(true).stdin(Stdio::null());
    let mut child = cmd.spawn().unwrap();
    let pid = child.id().unwrap();
    let watch = ProcWatch::open(pid).unwrap();
    unit.set_main(watch.clone());
    wait_for_name(pid, "sleep").await;
    assert_eq!(
        process::environ_read(pid, UNIT_ENV),
        EnvRead::Value(unit.id().as_str().to_string())
    );
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

/// R12: an entitled main whose environment may be withheld is still a
/// member (the pinned root), and so is its child (a descendant); the stop
/// logs that it met withheld environments, and ends both.
#[tokio::test(flavor = "current_thread")]
async fn a_withheld_environment_falls_back_to_roots_and_descendants() {
    let (cap, _guard) = capture::install();
    let state = tempfile::tempdir().unwrap();
    let c = Containment::select(SelectOptions {
        shim: Some(test_shim()),
        state_root: state.path().to_path_buf(),
    });
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let script = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); console.log('ready ' + c.pid); setInterval(()=>{}, 1000);";
    let mut cmd = unit
        .tokio_command(
            "node",
            &["-e".to_string(), script.to_string()],
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
    let child_pid: u32 = line_after_async(main.stdout.take().unwrap(), "ready")
        .await
        .parse()
        .unwrap();
    let child_watch = ProcWatch::open(child_pid).unwrap();
    let _child_cleanup = KillOnDrop(child_watch.clone());
    let reads = [
        process::environ_read(main_watch.pid(), UNIT_ENV),
        process::environ_read(child_pid, UNIT_ENV),
    ];
    report!(
        "R12: main node environ {:?} csops {}, child node environ {:?} csops {}",
        reads[0],
        describe_flags(cs_flags(main_watch.pid())),
        reads[1],
        describe_flags(cs_flags(child_pid))
    );
    let members: Vec<u32> = {
        let unit = unit.clone();
        tokio::task::spawn_blocking(move || unit.members().unwrap())
            .await
            .unwrap()
            .iter()
            .map(|m| m.pid)
            .collect()
    };
    assert!(members.contains(&main_watch.pid()), "{members:?}");
    assert!(members.contains(&child_pid), "{members:?}");
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
            .unwrap_or_else(|_| panic!("the {what} node survived the stop"))
            .unwrap();
    }
    if reads.iter().any(|r| *r == EnvRead::Withheld) {
        assert!(
            cap.has(tracing::Level::INFO, "unit.members.environ_withheld"),
            "a stop that met withheld environments logs it"
        );
    }
    let _ = main.wait().await;
}

/// Plan review R1-F2: jobs the agent detached (`nohup`, `setsid`) running
/// the official, entitled `node` are reparented to launchd and still killed
/// by a stop.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_detached_entitled_job_is_killed_by_a_stop() {
    let state = tempfile::tempdir().unwrap();
    let c = Containment::select(SelectOptions {
        shim: Some(test_shim()),
        state_root: state.path().to_path_buf(),
    });
    let unit = c.create_unit(UnitId::mint(), label()).unwrap();
    let script = r#"const { execFileSync } = require('child_process');
const a = execFileSync('/bin/sh', ['-c', 'nohup node -e "setInterval(()=>{},1000)" >/dev/null 2>&1 & echo $!']).toString().trim();
const b = execFileSync('perl', ['-e', 'use POSIX; my $p = fork() // die; if ($p == 0) { POSIX::setsid() or die; my $q = fork() // die; if ($q == 0) { open(STDOUT, ">", "/dev/null"); exec "node", "-e", "setInterval(()=>{},1000)"; } print "$q\n"; exit 0; } waitpid($p, 0);']).toString().trim();
console.log('jobs ' + a + ' ' + b);
setInterval(() => {}, 1000);"#;
    let mut cmd = unit
        .tokio_command(
            "node",
            &["-e".to_string(), script.to_string()],
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
    let jobs: Vec<u32> = line_after_async(main.stdout.take().unwrap(), "jobs")
        .await
        .split_whitespace()
        .map(|p| p.parse().unwrap())
        .collect();
    let watches: Vec<ProcWatch> = jobs
        .iter()
        .map(|pid| ProcWatch::open(*pid).unwrap())
        .collect();
    let _cleanup: Vec<KillOnDrop> = watches.iter().cloned().map(KillOnDrop).collect();
    eventually(Duration::from_secs(10), "both jobs reparented", || {
        jobs.iter().all(|pid| process::parent(*pid) == Some(1))
    })
    .await;
    for pid in &jobs {
        report!(
            "R1-F2: detached node {pid} environ {:?} csops {}",
            process::environ_read(*pid, UNIT_ENV),
            describe_flags(cs_flags(*pid))
        );
    }
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
