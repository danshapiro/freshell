//! How a Claude Node sidecar is stopped (`freshell_freshagent::claude_spawn`,
//! and a session's stop through `FreshClaudeState`).
//!
//! These tests drive small fake sidecars written in Node, so they run on every
//! platform the desktop app ships on: Linux in the Rust gate, and Windows and
//! macOS in the `electron-build` workflow (the crate's unit tests do not
//! compile on Windows, so the cross-platform behavior lives in this
//! integration target). They need `node` on PATH (or `FRESHELL_CLAUDE_NODE`),
//! like the crate's other sidecar tests. Only
//! `a_session_stop_confirms_the_whole_sidecar_tree_gone` sets process
//! environment (`FRESHELL_CLAUDE_SIDECAR`, `CLAUDE_CONFIG_DIR`), which no
//! other test here reads.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use freshell_freshagent::claude_spawn::{
    graceful_then_kill, spawn_guarded, SidecarStop, SidecarTreeGuard, TreeConfirmation,
    SIDECAR_GRACEFUL_EXIT,
};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};

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

#[cfg(unix)]
fn process_group_exists(pgid: i32) -> bool {
    // SAFETY: signal 0 only probes for existence.
    let result = unsafe { libc::kill(-pgid, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Observes one process's exit. On Windows the handle is opened while the
/// process is known to run, so a reused id can never be mistaken for it.
struct ProcessProbe {
    #[cfg(unix)]
    pid: u32,
    #[cfg(windows)]
    watch: freshell_platform::process_job::ProcessExitWatch,
}

impl ProcessProbe {
    fn open(pid: u32) -> Self {
        Self {
            #[cfg(unix)]
            pid,
            #[cfg(windows)]
            watch: freshell_platform::process_job::ProcessExitWatch::open(pid)
                .expect("open the grandchild while it runs"),
        }
    }

    fn alive(&self) -> bool {
        #[cfg(unix)]
        {
            // SAFETY: signal 0 only probes for existence.
            let result = unsafe { libc::kill(self.pid as i32, 0) };
            result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
        }
        #[cfg(windows)]
        {
            !self
                .watch
                .wait(Duration::ZERO)
                .expect("wait on the grandchild")
        }
    }

    /// Whether the process exits within `budget`.
    #[cfg(windows)]
    async fn exits_within(&self, budget: Duration) -> bool {
        let deadline = std::time::Instant::now() + budget;
        while self.alive() {
            if std::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        true
    }
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
    assert!(grandchild.alive());
    let grace = Duration::from_millis(500);

    let exit = graceful_then_kill(fake.child, fake.stdin, fake.guard, grace).await;

    assert!(
        exit.graceful(),
        "node itself honored the shutdown line: {exit:?}"
    );
    assert!(
        !grandchild.alive(),
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
        assert!(!process_group_exists(pgid), "no group member survives");
    }
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
    assert!(grandchild.alive());

    let exit = graceful_then_kill(fake.child, fake.stdin, fake.guard, SIDECAR_GRACEFUL_EXIT).await;

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
        exit.elapsed < SIDECAR_GRACEFUL_EXIT / 2,
        "the orphaned tree did not get the rest of the grace period: {exit:?}"
    );
    assert!(!grandchild.alive(), "the grandchild was killed: {exit:?}");
    assert_eq!(exit.tree, TreeConfirmation::Confirmed, "{exit:?}");
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
        !grandchild.alive(),
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

/// Whether `pid` is gone, waiting up to five seconds for whoever adopted it to
/// reap it (a killed orphan is briefly a zombie, which `kill(pid, 0)` still
/// finds).
#[cfg(unix)]
async fn process_gone_within_five_seconds(pid: u32) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        // SAFETY: signal 0 only probes for existence.
        let result = unsafe { libc::kill(pid as i32, 0) };
        if result != 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
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

    let confirmation = guard.terminate(&mut child).await;

    assert_eq!(confirmation, TreeConfirmation::Confirmed);
    assert!(
        process_gone_within_five_seconds(member).await,
        "the background member of the group was killed"
    );
    assert!(
        !process_group_exists(leader as i32),
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
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while process_group_exists(pgid) {
        assert!(
            std::time::Instant::now() < deadline,
            "the background member of the group survived the drop"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
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
    process.stdout.write(JSON.stringify({ type: 'created', requestId: msg.requestId, sessionId: 'teardownConfirmSession01' }) + '\n')
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
    assert!(grandchild.alive());

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
        !grandchild.alive(),
        "the grandchild the sidecar left behind was killed"
    );
}
