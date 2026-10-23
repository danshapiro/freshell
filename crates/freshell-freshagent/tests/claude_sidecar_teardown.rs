//! How a Claude Node sidecar is stopped (`freshell_freshagent::claude_spawn`,
//! and a session's stop through `FreshClaudeState`).
//!
//! These tests drive small fake sidecars written in Node, so they run on every
//! platform the desktop app ships on: Linux in the Rust gate, and Windows and
//! macOS in the `electron-build` workflow (the crate's unit tests do not
//! compile on Windows, so the cross-platform behavior lives in this
//! integration target). They need `node` on PATH (or `FRESHELL_CLAUDE_NODE`),
//! like the crate's other sidecar tests, and on Linux `python3`. Only
//! `a_session_stop_confirms_the_whole_sidecar_tree_gone` sets process
//! environment (`FRESHELL_CLAUDE_SIDECAR`, `CLAUDE_CONFIG_DIR`), which no
//! other test here reads.
//!
//! Whether a process is still running is asked of `support/process_probe.rs`,
//! never of `kill(pid, 0)`, which also finds a killed orphan its adopter has
//! not reaped yet (see that module).

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use freshell_freshagent::claude_spawn::{
    graceful_then_kill, spawn_guarded, SidecarStop, SidecarTreeGuard, TreeConfirmation,
    SIDECAR_GRACEFUL_EXIT,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

#[path = "support/process_probe.rs"]
mod process_probe;
#[cfg(unix)]
use process_probe::ProcessGroupProbe;
use process_probe::ProcessProbe;

/// Honors the protocol like `index.mjs`: the shutdown line ends the process
/// with exit 0. Its SIGTERM handler records that a signal was needed.
const FAKE_HONORS_SHUTDOWN: &str = r#"
const fs = require('fs')
const out = process.argv[1]
process.on('SIGTERM', () => { fs.appendFileSync(out, 'sigterm\n'); process.exit(143) })
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type === 'shutdown') {
    fs.appendFileSync(out, 'shutdown-handled\n')
    // Stopping takes a moment, as the real sidecar's SDK abort does, so a
    // signal sent right behind the shutdown line reaches the trap above.
    setTimeout(() => process.exit(0), 200)
  }
})
setInterval(() => {}, 1000)
process.stdout.write('ready\n')
"#;

/// A wedged sidecar: ignores the shutdown line and stdin EOF, but still
/// exits on SIGTERM (recording it).
const FAKE_IGNORES_SHUTDOWN: &str = r#"
const fs = require('fs')
const out = process.argv[1]
process.on('SIGTERM', () => { fs.appendFileSync(out, 'sigterm\n'); process.exit(143) })
process.stdin.on('data', () => {})
process.stdin.on('end', () => {})
setInterval(() => {}, 1000)
process.stdout.write('ready\n')
"#;

/// Ignores the shutdown line, stdin EOF, and SIGTERM: only SIGKILL ends it.
#[cfg(unix)]
const FAKE_IGNORES_SIGTERM: &str = r#"
const fs = require('fs')
const out = process.argv[1]
process.on('SIGTERM', () => { fs.appendFileSync(out, 'sigterm\n') })
process.stdin.on('data', () => {})
process.stdin.on('end', () => {})
setInterval(() => {}, 1000)
process.stdout.write('ready\n')
"#;

fn node() -> String {
    std::env::var("FRESHELL_CLAUDE_NODE").unwrap_or_else(|_| "node".to_string())
}

/// A fake sidecar spawned the way production spawns the real one: inside its
/// own process-tree guard. Its first stdout line (`ready ...`) says the
/// handlers are installed.
struct Fake {
    child: Child,
    stdin: ChildStdin,
    _stdout: ChildStdout,
    guard: SidecarTreeGuard,
    ready: String,
}

async fn spawn_fake(script: &str, record: &Path) -> Fake {
    let mut command = tokio::process::Command::new(node());
    command
        .arg("-e")
        .arg(script)
        .arg(record)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let (mut child, guard) = spawn_guarded(&mut command).expect("spawn the fake sidecar with node");
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
        .await
        .expect("the fake sidecar announces readiness")
        .expect("read the fake sidecar's stdout")
        .expect("the fake sidecar wrote a readiness line");
    assert!(ready.starts_with("ready"), "{ready}");
    Fake {
        child,
        stdin,
        _stdout: lines.into_inner().into_inner(),
        guard,
        ready,
    }
}

fn record_of(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

#[tokio::test]
async fn a_sidecar_that_honors_shutdown_exits_gracefully_without_a_signal() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let fake = spawn_fake(FAKE_HONORS_SHUTDOWN, &record).await;

    let exit = graceful_then_kill(fake.child, fake.stdin, fake.guard, SIDECAR_GRACEFUL_EXIT).await;

    assert!(
        exit.graceful(),
        "the shutdown line alone stopped the sidecar: {exit:?}"
    );
    assert!(
        exit.elapsed < SIDECAR_GRACEFUL_EXIT,
        "a graceful exit returns within the grace period: {exit:?}"
    );
    assert!(
        exit.status.is_some_and(|status| status.success()),
        "the sidecar exited 0 by itself: {exit:?}"
    );
    assert_eq!(
        record_of(&record),
        "shutdown-handled\n",
        "only the shutdown handler ran; no signal was sent"
    );
    assert_eq!(exit.tree, TreeConfirmation::Confirmed, "{exit:?}");
}

#[tokio::test]
async fn a_sidecar_that_ignores_shutdown_is_escalated_after_the_grace_period() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let fake = spawn_fake(FAKE_IGNORES_SHUTDOWN, &record).await;
    let grace = Duration::from_millis(400);

    let exit = graceful_then_kill(fake.child, fake.stdin, fake.guard, grace).await;

    assert_eq!(
        exit.stop,
        SidecarStop::Forced,
        "the sidecar ignored the shutdown line: {exit:?}"
    );
    assert!(
        exit.elapsed >= grace,
        "no signal is sent before the grace period ends: {exit:?}"
    );
    assert!(
        exit.elapsed < grace + Duration::from_secs(3),
        "escalation is bounded: {exit:?}"
    );
    assert!(
        exit.status.is_some(),
        "the sidecar is dead and reaped: {exit:?}"
    );
    #[cfg(unix)]
    assert_eq!(
        record_of(&record),
        "sigterm\n",
        "the escalation starts with SIGTERM (the sidecar's own graceful handler)"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_sidecar_that_ignores_sigterm_is_killed() {
    use std::os::unix::process::ExitStatusExt;

    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let fake = spawn_fake(FAKE_IGNORES_SIGTERM, &record).await;
    let grace = Duration::from_millis(300);

    let exit = graceful_then_kill(fake.child, fake.stdin, fake.guard, grace).await;

    assert_eq!(exit.stop, SidecarStop::Forced, "{exit:?}");
    assert_eq!(
        exit.status.and_then(|status| status.signal()),
        Some(libc_sigkill()),
        "SIGKILL ended the TERM-immune sidecar: {exit:?}"
    );
    assert!(
        exit.elapsed < grace + Duration::from_secs(3),
        "escalation is bounded: {exit:?}"
    );
    assert_eq!(
        record_of(&record),
        "sigterm\n",
        "SIGTERM came before SIGKILL"
    );
}

#[cfg(unix)]
fn libc_sigkill() -> i32 {
    9
}

/// Exits 0 on the shutdown line WITHOUT stopping the grandchild it started
/// (the CLI in production): the shape a hard-killed or buggy sidecar leaves
/// behind. The readiness line carries the grandchild's pid.
const FAKE_ORPHANS_GRANDCHILD: &str = r#"
const { spawn } = require('child_process')
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type === 'shutdown') process.exit(0)
})
setInterval(() => {}, 1000)
grandchild.on('spawn', () => process.stdout.write(`ready ${grandchild.pid}\n`))
"#;

fn grandchild_pid(ready: &str) -> u32 {
    ready
        .strip_prefix("ready ")
        .and_then(|pid| pid.trim().parse().ok())
        .unwrap_or_else(|| panic!("readiness line carries the grandchild pid: {ready}"))
}

/// A node that runs until it is killed, as a test's own (unreaped) child.
/// On Unix it leads its own process group.
fn spawn_idle_node() -> std::process::Child {
    let mut command = std::process::Command::new(node());
    command
        .args(["-e", "setInterval(() => {}, 1000)"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    command.spawn().expect("spawn an idle node")
}

/// How long the probe tests below watch a process that keeps running, to
/// see that it is never reported as exited.
const KEEPS_RUNNING_WATCH: Duration = Duration::from_millis(300);

/// The probe the tree assertions below rely on reports a running process
/// (and, on Unix, its group) as running, and as exited once it was killed
/// and reaped.
#[tokio::test]
async fn the_probe_sees_a_running_process_as_running_until_it_is_killed() {
    let mut child = spawn_idle_node();
    let process = ProcessProbe::open(child.id());
    #[cfg(unix)]
    let group = ProcessGroupProbe::new(child.id() as i32);

    assert!(process.running(), "the process runs");
    #[cfg(unix)]
    {
        assert!(group.running(), "its group has a running member");
        let (process_exited, group_exited) = tokio::join!(
            process.exits_within(KEEPS_RUNNING_WATCH),
            group.exits_within(KEEPS_RUNNING_WATCH)
        );
        assert!(!process_exited, "a running process does not exit");
        assert!(!group_exited, "nor does its group");
    }
    #[cfg(windows)]
    assert!(
        !process.exits_within(KEEPS_RUNNING_WATCH).await,
        "a running process does not exit"
    );

    child.kill().expect("kill the idle node");
    child.wait().expect("reap the idle node");

    assert!(process.exited(), "a killed, reaped process has exited");
    #[cfg(unix)]
    assert!(group.exited(), "its group has no member left");
}

/// Block until `pid`, a child of this process, has exited, WITHOUT reaping
/// it: it stays a zombie until the caller waits on it.
#[cfg(unix)]
fn wait_until_zombie(pid: u32) {
    loop {
        // SAFETY: `siginfo_t` is plain data that waitid fills in.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        // SAFETY: waits on this process's own child; WNOWAIT leaves it
        // unreaped.
        let result = unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOWAIT,
            )
        };
        if result == 0 {
            return;
        }
        let error = std::io::Error::last_os_error();
        assert_eq!(
            error.kind(),
            std::io::ErrorKind::Interrupted,
            "wait for the child to exit: {error}"
        );
    }
}

/// A process that was killed but not yet reaped (a zombie) has exited: it
/// runs nothing, holds no pipes and writes nothing. An orphaned grandchild
/// the guard kills is exactly that until whoever adopted it (init, or the
/// nearest subreaper such as `systemd --user`) reaps it, and on a loaded
/// machine that can come after the guard has confirmed the tree gone.
#[cfg(unix)]
#[tokio::test]
async fn the_probe_counts_a_killed_but_unreaped_process_as_exited() {
    let mut child = spawn_idle_node();
    let pid = child.id();
    let process = ProcessProbe::open(pid);
    let group = ProcessGroupProbe::new(pid as i32);
    assert!(process.running());

    child.kill().expect("kill the idle node");
    wait_until_zombie(pid);

    #[cfg(target_os = "linux")]
    {
        // SAFETY: signal 0 only probes for existence.
        assert_eq!(
            unsafe { libc::kill(pid as i32, 0) },
            0,
            "the zombie is still in the process table, where kill(pid, 0) finds it"
        );
        // SAFETY: as above.
        assert_eq!(
            unsafe { libc::kill(-(pid as i32), 0) },
            0,
            "and kill(-pgid, 0) finds the group it is still a member of"
        );
        // Linux tells the zombie apart at once: no reaper is needed.
        let process_exited = process.exited();
        let group_exited = group.exited();
        child.wait().expect("reap the zombie");
        assert!(process_exited, "an unreaped zombie has exited");
        assert!(group_exited, "so has a group holding only a zombie");
    }
    // Without /proc a zombie cannot be told from a running process, so the
    // probes see it exit once it is reaped; reap it shortly, as its adopter
    // would.
    #[cfg(not(target_os = "linux"))]
    {
        const REAPED_WITHIN: Duration = Duration::from_secs(5);
        let reaper = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            child.wait().expect("reap the zombie");
        });
        let (process_exited, group_exited) = tokio::join!(
            process.exits_within(REAPED_WITHIN),
            group.exits_within(REAPED_WITHIN)
        );
        reaper.join().expect("the reaper thread");
        assert!(process_exited, "a zombie reaped shortly after has exited");
        assert!(group_exited, "so has the group that held only it");
    }
}

/// Python code whose main thread ends alone (`pthread_exit`) while another
/// thread runs on. Linux then reports the process's state as `Z` (zombie)
/// although it still runs.
#[cfg(target_os = "linux")]
const MAIN_THREAD_ENDS_FIRST: &str = "
import ctypes, threading, time
threading.Thread(target=lambda: time.sleep(120)).start()
ctypes.CDLL(None).pthread_exit(None)
";

/// Wait until `pid`'s main thread has ended (its state reads `Z`) and
/// return its `/proc/<pid>/stat`.
#[cfg(target_os = "linux")]
async fn wait_until_main_thread_ended(pid: u32) -> String {
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).expect("read its stat");
        // The state follows the last ')' (the command name may hold one).
        if stat
            .rsplit(')')
            .next()
            .map(str::trim_start)
            .is_some_and(|rest| rest.starts_with('Z'))
        {
            return stat;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the main thread never ended: {stat}"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// A process whose main thread ended while another thread still runs is
/// still running, although Linux then reports its state as `Z` (zombie):
/// the probe stays as strict as `kill(pid, 0)` for it.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_probe_sees_a_process_whose_main_thread_ended_as_running() {
    let mut command = std::process::Command::new("python3");
    command
        .args(["-c", MAIN_THREAD_ENDS_FIRST])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command
        .spawn()
        .expect("python3 is required by the main-thread-ended probe test");
    let pid = child.id();
    let process = ProcessProbe::open(pid);
    let group = ProcessGroupProbe::new(pid as i32);
    let stat = wait_until_main_thread_ended(pid).await;

    let running = process.running();
    let group_running = group.running();
    let (process_exited, group_exited) = tokio::join!(
        process.exits_within(KEEPS_RUNNING_WATCH),
        group.exits_within(KEEPS_RUNNING_WATCH)
    );
    child.kill().expect("kill python");
    child.wait().expect("reap python");

    assert!(running, "its other thread still runs: {stat}");
    assert!(!process_exited, "it does not exit: {stat}");
    assert!(group_running, "its group has a running member: {stat}");
    assert!(!group_exited, "its group does not exit: {stat}");
}

#[tokio::test]
async fn a_graceful_exit_does_not_leave_the_grandchild_running() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let fake = spawn_fake(FAKE_ORPHANS_GRANDCHILD, &record).await;
    let grandchild = ProcessProbe::open(grandchild_pid(&fake.ready));
    #[cfg(unix)]
    let pgid = fake.guard.process_group();
    #[cfg(windows)]
    assert!(
        fake.guard.active_processes().is_some_and(|n| n >= 2),
        "node and its grandchild both run inside the guard's job: {:?}",
        fake.guard.active_processes()
    );
    assert!(grandchild.running());
    let grace = Duration::from_millis(500);

    let exit = graceful_then_kill(fake.child, fake.stdin, fake.guard, grace).await;

    assert!(
        exit.graceful(),
        "node itself honored the shutdown line: {exit:?}"
    );
    assert!(
        grandchild.exited(),
        "the grandchild node left behind was killed: {exit:?}"
    );
    assert_eq!(
        exit.tree,
        TreeConfirmation::Confirmed,
        "the guard confirmed the whole tree gone: {exit:?}"
    );
    #[cfg(unix)]
    {
        assert!(
            exit.elapsed >= grace,
            "the grandchild got the rest of the grace period to exit by itself: {exit:?}"
        );
        let pgid = pgid.expect("the sidecar ran in its own process group");
        assert!(
            ProcessGroupProbe::new(pgid).exited(),
            "no group member survives"
        );
    }
}

/// [`FAKE_ORPHANS_GRANDCHILD`] with a grandchild whose main thread ends
/// while another of its threads runs on (`PYTHON` stands for
/// [`MAIN_THREAD_ENDS_FIRST`]): Linux reports it as a zombie although it
/// still runs.
#[cfg(target_os = "linux")]
const FAKE_ORPHANS_A_GRANDCHILD_WHOSE_MAIN_THREAD_ENDED: &str = r#"
const { spawn } = require('child_process')
const grandchild = spawn('python3', ['-c', PYTHON], { stdio: 'ignore' })
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type === 'shutdown') process.exit(0)
})
setInterval(() => {}, 1000)
grandchild.on('spawn', () => process.stdout.write(`ready ${grandchild.pid}\n`))
"#;

/// A tree member whose main thread has ended while another of its threads
/// still runs is not gone, although Linux reports its state as `Z`: the
/// guard waits for it and kills it like any other member left behind.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_graceful_exit_does_not_leave_a_member_whose_main_thread_ended_running() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let script = FAKE_ORPHANS_A_GRANDCHILD_WHOSE_MAIN_THREAD_ENDED.replace(
        "PYTHON",
        &serde_json::to_string(MAIN_THREAD_ENDS_FIRST).expect("encode the Python code"),
    );
    let fake = spawn_fake(&script, &record).await;
    let pid = grandchild_pid(&fake.ready);
    let grandchild = ProcessProbe::open(pid);
    let stat = wait_until_main_thread_ended(pid).await;
    assert!(grandchild.running(), "its other thread runs: {stat}");
    let grace = Duration::from_millis(500);

    let exit = graceful_then_kill(fake.child, fake.stdin, fake.guard, grace).await;

    assert!(
        exit.graceful(),
        "node itself honored the shutdown line: {exit:?}"
    );
    assert_eq!(exit.tree, TreeConfirmation::Confirmed, "{exit:?}");
    assert!(
        exit.elapsed >= grace,
        "the member counted as running, so it got the rest of the grace period: {exit:?}"
    );
    assert!(
        grandchild.exited(),
        "the member whose main thread ended was killed: {exit:?}"
    );
}

/// Exits 1 on the shutdown line WITHOUT stopping its grandchild: a sidecar
/// that crashed on its way down (for example on a write to a stdout nobody
/// reads any more) before its shutdown handler could abort the SDK query,
/// so the CLI it started keeps running the turn. The readiness line carries
/// the grandchild's pid.
const FAKE_CRASHES_LEAVING_GRANDCHILD: &str = r#"
const { spawn } = require('child_process')
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type === 'shutdown') process.exit(1)
})
setInterval(() => {}, 1000)
grandchild.on('spawn', () => process.stdout.write(`ready ${grandchild.pid}\n`))
"#;

/// Node exiting inside the grace period is graceful only when it exited 0
/// (its shutdown handler ran). Any other exit means nothing stopped the
/// rest of the tree, so the guard kills it at once instead of granting it
/// the rest of the grace period.
#[tokio::test]
async fn an_abnormal_exit_is_not_graceful_and_the_tree_is_killed_at_once() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let fake = spawn_fake(FAKE_CRASHES_LEAVING_GRANDCHILD, &record).await;
    let grandchild = ProcessProbe::open(grandchild_pid(&fake.ready));
    assert!(grandchild.running());
    // Far longer than node needs to crash even on a loaded machine (it can
    // take over a second there), so granting the tree the rest of it is
    // never mistaken for a slow crash.
    let grace = Duration::from_secs(20);

    let exit = graceful_then_kill(fake.child, fake.stdin, fake.guard, grace).await;

    assert_eq!(
        exit.stop,
        SidecarStop::AbnormalExit,
        "a crash is not a graceful stop: {exit:?}"
    );
    assert_eq!(
        exit.status.and_then(|status| status.code()),
        Some(1),
        "node's own exit status is reported: {exit:?}"
    );
    assert!(
        exit.elapsed < grace / 2,
        "the orphaned tree did not get the rest of the grace period: {exit:?}"
    );
    assert!(grandchild.exited(), "the grandchild was killed: {exit:?}");
    assert_eq!(exit.tree, TreeConfirmation::Confirmed, "{exit:?}");
}

/// [`FAKE_CRASHES_LEAVING_GRANDCHILD`] with a grandchild that holds 512 MB it
/// has written to, so once it is killed, finishing its exit (releasing that
/// memory) takes tens of milliseconds. The readiness line comes once the
/// grandchild holds the memory.
///
/// That gap is what these tests are about on Windows: a job stops counting a
/// process as active the moment it starts to exit, but Windows signals the
/// process (it has exited) only once the exit is done. On windows-2022 that
/// came about 4 ms after the count for an idle node and 25-30 ms after it
/// for one holding 768 MB, every time.
const FAKE_CRASHES_LEAVING_A_SLOW_EXITING_GRANDCHILD: &str = r#"
const { spawn } = require('child_process')
const grandchild = spawn(process.execPath, ['-e', "const held = Buffer.alloc(512 * 1024 * 1024, 1); setInterval(() => held[0]++, 1000); console.log('holding')"], { stdio: ['ignore', 'pipe', 'ignore'] })
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type === 'shutdown') process.exit(1)
})
setInterval(() => {}, 1000)
grandchild.stdout.once('data', () => process.stdout.write(`ready ${grandchild.pid}\n`))
"#;

/// The guard confirms the tree gone only once every process in it has
/// exited, not as soon as the last one has started to: a grandchild still
/// finishing its exit at that moment is not gone yet. On Windows a crashed
/// node's own exit is what kills this grandchild (node keeps the children it
/// spawns in a kill-on-close job of its own), so the guard must already be
/// watching it when node goes.
#[tokio::test]
async fn an_abnormal_exit_is_confirmed_only_once_a_slow_exiting_grandchild_has_exited() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let fake = spawn_fake(FAKE_CRASHES_LEAVING_A_SLOW_EXITING_GRANDCHILD, &record).await;
    let grandchild = ProcessProbe::open(grandchild_pid(&fake.ready));
    assert!(grandchild.running());

    let exit = graceful_then_kill(fake.child, fake.stdin, fake.guard, SIDECAR_GRACEFUL_EXIT).await;

    assert_eq!(exit.stop, SidecarStop::AbnormalExit, "{exit:?}");
    assert_eq!(exit.tree, TreeConfirmation::Confirmed, "{exit:?}");
    assert!(
        grandchild.exited(),
        "the grandchild had exited when the tree was confirmed gone: {exit:?}"
    );
}

/// Starts nothing until the shutdown line. Then it starts a grandchild like
/// [`FAKE_CRASHES_LEAVING_A_SLOW_EXITING_GRANDCHILD`]'s, writes its pid to
/// the record file once it holds its memory, and exits 1 as soon as the
/// test creates `<record>.go`.
const FAKE_STARTS_A_SLOW_EXITING_GRANDCHILD_ON_SHUTDOWN_THEN_CRASHES: &str = r#"
const fs = require('fs')
const { spawn } = require('child_process')
const out = process.argv[1]
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type !== 'shutdown') return
  const grandchild = spawn(process.execPath, ['-e', "const held = Buffer.alloc(512 * 1024 * 1024, 1); setInterval(() => held[0]++, 1000); console.log('holding')"], { stdio: ['ignore', 'pipe', 'ignore'] })
  grandchild.stdout.once('data', () => {
    fs.writeFileSync(`${out}.tmp`, String(grandchild.pid))
    fs.renameSync(`${out}.tmp`, out)
    setInterval(() => { if (fs.existsSync(`${out}.go`)) process.exit(1) }, 5)
  })
})
setInterval(() => {}, 1000)
process.stdout.write('ready\n')
"#;

/// The guard also watches a process that joins the tree after the stop has
/// begun, not only those running when it began: here node starts the
/// slow-exiting grandchild after the shutdown line and then crashes. On
/// Windows that crash is what kills the grandchild (node's own kill-on-close
/// job), so it may already be exiting when the guard first looks.
#[tokio::test]
async fn an_abnormal_exit_is_confirmed_only_once_a_grandchild_started_during_the_stop_has_exited() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let fake = spawn_fake(
        FAKE_STARTS_A_SLOW_EXITING_GRANDCHILD_ON_SHUTDOWN_THEN_CRASHES,
        &record,
    )
    .await;
    // Ample, so a slow machine's grandchild holds its memory well inside it;
    // the crash ends the wait as soon as the test lets it.
    let grace = Duration::from_secs(20);
    let stop = tokio::spawn(graceful_then_kill(
        fake.child, fake.stdin, fake.guard, grace,
    ));
    let deadline = std::time::Instant::now() + grace;
    let pid: u32 = loop {
        if let Some(pid) = std::fs::read_to_string(&record)
            .ok()
            .and_then(|pid| pid.trim().parse().ok())
        {
            break pid;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the fake started its grandchild"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    let grandchild = ProcessProbe::open(pid);
    assert!(grandchild.running());

    let mut go = record.into_os_string();
    go.push(".go");
    std::fs::write(go, "").expect("let the fake crash");
    let exit = stop.await.expect("the stop task");

    assert_eq!(exit.stop, SidecarStop::AbnormalExit, "{exit:?}");
    assert_eq!(exit.tree, TreeConfirmation::Confirmed, "{exit:?}");
    assert!(
        grandchild.exited(),
        "the grandchild had exited when the tree was confirmed gone: {exit:?}"
    );
}

/// As above, for a tree the guard itself kills while all of it runs.
#[tokio::test]
async fn terminating_the_guard_is_confirmed_only_once_a_slow_exiting_grandchild_has_exited() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let mut fake = spawn_fake(FAKE_CRASHES_LEAVING_A_SLOW_EXITING_GRANDCHILD, &record).await;
    let grandchild = ProcessProbe::open(grandchild_pid(&fake.ready));
    assert!(grandchild.running());

    let confirmation = fake.guard.terminate(&mut fake.child).await;

    assert_eq!(confirmation, TreeConfirmation::Confirmed);
    assert!(
        grandchild.exited(),
        "the grandchild had exited when the tree was confirmed gone"
    );
}

/// Windows: the guard's job holds node and every descendant; terminating it
/// empties the job.
#[cfg(windows)]
#[tokio::test]
async fn terminating_the_guard_empties_the_job() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let mut fake = spawn_fake(FAKE_ORPHANS_GRANDCHILD, &record).await;
    let grandchild = ProcessProbe::open(grandchild_pid(&fake.ready));
    assert!(fake.guard.active_processes().is_some_and(|n| n >= 2));

    let confirmation = fake.guard.terminate(&mut fake.child).await;

    assert_eq!(confirmation, TreeConfirmation::Confirmed);
    assert_eq!(fake.guard.active_processes(), Some(0), "the job is empty");
    assert!(
        grandchild.exited(),
        "the grandchild was in the job and died"
    );
}

/// Windows: dropping the guard (kill-on-close) ends node and its grandchild
/// within five seconds, with nothing else signaling them.
#[cfg(windows)]
#[tokio::test]
async fn dropping_the_guard_kills_the_job_tree() {
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let fake = spawn_fake(FAKE_ORPHANS_GRANDCHILD, &record).await;
    let grandchild = ProcessProbe::open(grandchild_pid(&fake.ready));
    let node = ProcessProbe::open(fake.child.id().expect("node is running"));
    let Fake { child, guard, .. } = fake;

    drop(guard);

    assert!(node.exits_within(Duration::from_secs(5)).await, "node died");
    assert!(
        grandchild.exits_within(Duration::from_secs(5)).await,
        "the grandchild died with the job"
    );
    drop(child);
}

/// The process group the kernel has `pid` in (not the guard's own record).
#[cfg(unix)]
fn kernel_process_group(pid: u32) -> i32 {
    // SAFETY: getpgid only reads the process table.
    unsafe { libc::getpgid(pid as i32) }
}

#[cfg(unix)]
#[tokio::test]
async fn terminating_the_guard_kills_every_member_of_the_process_group() {
    let mut command = tokio::process::Command::new("sh");
    command
        .args(["-c", "sleep 300 & echo $!; wait"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .kill_on_drop(true);
    let (mut child, mut guard) = spawn_guarded(&mut command).expect("spawn sh");
    let stdout = child.stdout.take().expect("piped stdout");
    let member: u32 = tokio::time::timeout(
        Duration::from_secs(10),
        BufReader::new(stdout).lines().next_line(),
    )
    .await
    .expect("sh reports its background member")
    .expect("read sh's stdout")
    .and_then(|line| line.trim().parse().ok())
    .expect("the background member's pid");
    let leader = child.id().expect("sh is running");
    assert_eq!(
        kernel_process_group(leader),
        leader as i32,
        "the kernel has the child leading its own process group"
    );
    assert_eq!(
        kernel_process_group(member),
        leader as i32,
        "the background member is in the child's group"
    );
    assert_eq!(guard.process_group(), Some(leader as i32));
    let member = ProcessProbe::open(member);
    assert!(member.running());

    let confirmation = guard.terminate(&mut child).await;

    assert_eq!(confirmation, TreeConfirmation::Confirmed);
    assert!(
        member.exited(),
        "the background member of the group was killed"
    );
    assert!(
        ProcessGroupProbe::new(leader as i32).exited(),
        "no group member survives"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn dropping_the_guard_kills_the_process_group() {
    use std::os::unix::process::ExitStatusExt;

    let mut command = tokio::process::Command::new("sh");
    command
        .args(["-c", "sleep 300 & sleep 300"])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let (mut child, guard) = spawn_guarded(&mut command).expect("spawn sh");
    let pgid = guard
        .process_group()
        .expect("the child runs in its own process group");
    tokio::time::sleep(Duration::from_millis(100)).await;

    drop(guard);

    let status = tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .expect("the guard's drop ended the child")
        .expect("reap the child");
    assert_eq!(
        status.signal(),
        Some(9),
        "the drop sent SIGKILL: {status:?}"
    );
    // Nothing confirms a drop's kill, so the member gets time to finish
    // exiting.
    assert!(
        ProcessGroupProbe::new(pgid)
            .exits_within(Duration::from_secs(5))
            .await,
        "the background member of the group survived the drop"
    );
}

/// The session sidecar for the `FreshClaudeState` stop test: it answers
/// `create`, starts a grandchild (the CLI's stand-in) whose pid it writes to
/// `PID_FILE`, and exits 0 on the shutdown line WITHOUT stopping that
/// grandchild, so the session stop must find and kill it. CommonJS (`.cjs`):
/// `FreshClaudeState` runs the entry as `node <entry>`.
const SESSION_SIDECAR: &str = r#"
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
grandchild.on('spawn', () => fs.writeFileSync(PID_FILE, String(grandchild.pid)))
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type === 'create') {
    process.stdout.write(JSON.stringify({ type: 'created', requestId: msg.requestId, sessionId: 'teardownConfirmSession01', protocol: 2 }) + '\n')
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
setInterval(() => {}, 1000)
"#;

/// `freshagent.claude.teardown` events, captured on this test's thread.
mod teardown_log {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex};

    use tracing::field::{Field, Visit};
    use tracing::{Event, Subscriber};
    use tracing_subscriber::layer::{Context, SubscriberExt};
    use tracing_subscriber::Layer;

    pub type Fields = BTreeMap<String, String>;

    #[derive(Default)]
    struct Visitor(Fields);
    impl Visit for Visitor {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            self.0.insert(
                field.name().to_string(),
                format!("{value:?}").replace('"', ""),
            );
        }
    }

    struct Capture(Arc<Mutex<Vec<Fields>>>);
    impl<S: Subscriber> Layer<S> for Capture {
        fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
            let mut visitor = Visitor::default();
            event.record(&mut visitor);
            if visitor.0.get("event").map(String::as_str) == Some("freshagent.claude.teardown") {
                self.0.lock().expect("capture lock").push(visitor.0);
            }
        }
    }

    pub fn install() -> (Arc<Mutex<Vec<Fields>>>, tracing::subscriber::DefaultGuard) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry().with(Capture(Arc::clone(&events)));
        (events, tracing::subscriber::set_default(subscriber))
    }
}

/// A session's stop through the public `FreshClaudeState` API answers
/// `confirmed` only when the sidecar's whole tree is gone. The session
/// handoff turns that answer into `StopResult::Reaped` (a new writer may
/// start). On Linux it comes from the `/proc` ownership confirmation; on
/// Windows and macOS, where the crate's unit tests cannot run, from the
/// process-tree guard, and this is the test that pins that mapping there.
#[tokio::test]
async fn a_session_stop_confirms_the_whole_sidecar_tree_gone() {
    let (events, _capture) = teardown_log::install();
    let dir = tempfile::tempdir().unwrap();
    let pid_file = dir.path().join("grandchild.pid");
    let entry = dir.path().join("session-sidecar.cjs");
    std::fs::write(
        &entry,
        format!(
            "const PID_FILE = {}\n{SESSION_SIDECAR}",
            serde_json::to_string(&pid_file).expect("encode the pid file path")
        ),
    )
    .unwrap();
    std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &entry);
    std::env::set_var("CLAUDE_CONFIG_DIR", dir.path().join("claude"));
    let (tx, mut frames) = tokio::sync::broadcast::channel::<String>(64);
    let state = freshell_freshagent::claude::FreshClaudeState::new(std::sync::Arc::new(tx));

    state
        .handle_create(
            serde_json::from_value(serde_json::json!({
                "requestId": "teardown-confirm",
                "sessionType": "freshclaude",
                "provider": "claude",
            }))
            .expect("a freshclaude create"),
            None,
        )
        .await;
    std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
    let created = loop {
        let frame = tokio::time::timeout(Duration::from_secs(20), frames.recv())
            .await
            .expect("the create answers")
            .expect("read a broadcast frame");
        let frame: serde_json::Value = serde_json::from_str(&frame).expect("a JSON frame");
        if frame["requestId"] == "teardown-confirm" {
            break frame;
        }
    };
    assert_eq!(created["type"], "freshAgent.created", "{created}");
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    let grandchild_pid: u32 = loop {
        if let Some(pid) = std::fs::read_to_string(&pid_file)
            .ok()
            .and_then(|pid| pid.trim().parse().ok())
        {
            break pid;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "the sidecar started its grandchild"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    };
    let grandchild = ProcessProbe::open(grandchild_pid);
    assert!(grandchild.running());

    state.shutdown().await;
    std::env::remove_var("CLAUDE_CONFIG_DIR");

    let logged = events.lock().expect("capture lock").clone();
    assert_eq!(logged.len(), 1, "one logged stop: {logged:?}");
    assert_eq!(
        logged[0].get("confirmation").map(String::as_str),
        Some("confirmed"),
        "{logged:?}"
    );
    assert!(
        grandchild.exited(),
        "the grandchild the sidecar left behind was killed"
    );
}
