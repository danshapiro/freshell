//! Session teardown and server shutdown go through the graceful sidecar stop
//! (audit G31): the shutdown request first, escalation only after the grace
//! period, every stop logged as `freshagent.claude.teardown`, and
//! `FreshClaudeState::shutdown` stopping sessions concurrently.

use super::*;

use std::collections::BTreeMap;
use std::sync::Mutex as StdMutex;

use crate::claude_spawn::{SERVER_STOP_GRACE, SIDECAR_GRACEFUL_EXIT};

/// Honors the protocol like `index.mjs`: the shutdown line exits 0.
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

/// Exits 0 on the shutdown line WITHOUT stopping the untagged grandchild it
/// started (the shape that, off Linux, nothing used to reap). The readiness
/// line carries the grandchild's pid.
const FAKE_ORPHANS_GRANDCHILD: &str = r#"
const { spawn } = require('child_process')
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type === 'shutdown') process.exit(0)
})
setInterval(() => {}, 1000)
grandchild.on('spawn', () => process.stdout.write(`ready ${grandchild.pid}\n`))
"#;

/// A wedged sidecar: ignores the shutdown line and stdin EOF; exits on SIGTERM.
const FAKE_IGNORES_SHUTDOWN: &str = r#"
const fs = require('fs')
const out = process.argv[1]
process.on('SIGTERM', () => { fs.appendFileSync(out, 'sigterm\n'); process.exit(143) })
process.stdin.on('data', () => {})
process.stdin.on('end', () => {})
setInterval(() => {}, 1000)
process.stdout.write('ready\n')
"#;

/// Crashes (exit 1) on the shutdown line instead of running a shutdown
/// handler.
const FAKE_CRASHES_ON_SHUTDOWN: &str = r#"
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type === 'shutdown') process.exit(1)
})
setInterval(() => {}, 1000)
process.stdout.write('ready\n')
"#;

fn node() -> String {
    std::env::var("FRESHELL_CLAUDE_NODE").unwrap_or_else(|_| "node".to_string())
}

/// A live `ClaudeSession` whose sidecar is a Node fake spawned the way
/// production spawns the real one (inside its process-tree guard), ready to
/// tear down. Also returns the fake's readiness line.
async fn fake_session(
    script: &str,
    record: &std::path::Path,
    session_id: &str,
) -> (ClaudeSession, String) {
    let mut command = tokio::process::Command::new(node());
    command
        .arg("-e")
        .arg(script)
        .arg(record)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let (mut child, tree_guard) =
        crate::claude_spawn::spawn_guarded(&mut command).expect("spawn the fake sidecar with node");
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
        .await
        .expect("the fake sidecar announces readiness")
        .expect("read the fake sidecar's stdout")
        .expect("the fake sidecar wrote a readiness line");
    assert!(ready.starts_with("ready"), "{ready}");
    // Keep stdout open for the session's lifetime, as the real consumer does.
    let consumer = tokio::spawn(async move {
        let mut lines = lines;
        while let Ok(Some(_)) = lines.next_line().await {}
    });
    let session = ClaudeSession {
        session_type: "freshclaude".into(),
        quiet: Default::default(),
        configuration: ClaudeConfiguration::default(),
        stdin: stdin.into(),
        child,
        tree_guard,
        ownership_id: format!("test-teardown-{session_id}"),
        consumer,
        sidecar_session_id: session_id.to_string(),
        cli_session_id: None,
        owning_operation: None,
        owning_generation: None,
        identity: RuntimeIdentity::new(session_id, Vec::new()),
        pending: Arc::new(std::sync::Mutex::new(ClaudePending::default())),
        ledger: crate::claude_turns::SharedLedger::default(),
        clock: crate::attention::AttentionClock::default(),
        turn_lock: Arc::new(TokioMutex::new(())),
        launch_genesis: None,
    };
    (session, ready)
}

fn record_of(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// Thread-local capture of `freshagent.claude.teardown` events. The teardown
/// runs inline on the test's current-thread runtime, so `set_default` sees it.
/// Shared with the rollback tests in `claude::tests`.
pub(super) mod capture {
    use super::*;
    use tracing::field::{Field, Visit};
    use tracing::{Event, Subscriber};
    use tracing_subscriber::layer::{Context, SubscriberExt};
    use tracing_subscriber::Layer;

    pub(in crate::claude) type Fields = BTreeMap<String, String>;

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

    struct CaptureLayer(Arc<StdMutex<Vec<(tracing::Level, Fields)>>>);
    impl<S: Subscriber> Layer<S> for CaptureLayer {
        fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
            let mut visitor = Visitor::default();
            event.record(&mut visitor);
            self.0
                .lock()
                .expect("capture lock")
                .push((*event.metadata().level(), visitor.0));
        }
    }

    pub(in crate::claude) fn teardown_events(
        events: &Arc<StdMutex<Vec<(tracing::Level, Fields)>>>,
    ) -> Vec<(tracing::Level, Fields)> {
        events
            .lock()
            .expect("capture lock")
            .iter()
            .filter(|(_, fields)| {
                fields.get("event").map(String::as_str) == Some("freshagent.claude.teardown")
            })
            .cloned()
            .collect()
    }

    #[allow(clippy::type_complexity)]
    pub(in crate::claude) fn install() -> (
        Arc<StdMutex<Vec<(tracing::Level, Fields)>>>,
        tracing::subscriber::DefaultGuard,
    ) {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry().with(CaptureLayer(Arc::clone(&events)));
        (events, tracing::subscriber::set_default(subscriber))
    }
}

#[tokio::test]
async fn teardown_lets_a_sidecar_that_honors_shutdown_exit_without_a_signal() {
    let (events, _guard) = capture::install();
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let (session, _) = fake_session(FAKE_HONORS_SHUTDOWN, &record, "honors").await;

    let started = std::time::Instant::now();
    let _ = teardown_removed_session(session, TREE_DEATH_CONFIRM_ROUNDS).await;

    assert!(started.elapsed() < SIDECAR_GRACEFUL_EXIT);
    assert_eq!(
        record_of(&record),
        "shutdown-handled\n",
        "the sidecar stopped on the shutdown line; no signal raced it"
    );
    let logged = capture::teardown_events(&events);
    assert_eq!(logged.len(), 1, "one teardown event: {logged:?}");
    let (level, fields) = &logged[0];
    assert_eq!(*level, tracing::Level::INFO);
    assert_eq!(fields.get("session_id").map(String::as_str), Some("honors"));
    assert_eq!(fields.get("graceful").map(String::as_str), Some("true"));
    assert!(fields.contains_key("elapsed_ms"), "{fields:?}");
    assert!(fields.contains_key("confirmation"), "{fields:?}");
}

#[tokio::test]
async fn teardown_of_a_sidecar_that_ignores_shutdown_escalates_after_grace_and_says_so() {
    let (events, _guard) = capture::install();
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let (session, _) = fake_session(FAKE_IGNORES_SHUTDOWN, &record, "ignores").await;

    let started = std::time::Instant::now();
    let _ = teardown_removed_session(session, TREE_DEATH_CONFIRM_ROUNDS).await;
    let elapsed = started.elapsed();

    assert!(
        elapsed >= SIDECAR_GRACEFUL_EXIT,
        "the sidecar got the whole grace period before any signal: {elapsed:?}"
    );
    assert!(
        elapsed < SIDECAR_GRACEFUL_EXIT + Duration::from_secs(3),
        "{elapsed:?}"
    );
    #[cfg(unix)]
    assert_eq!(record_of(&record), "sigterm\n");
    let logged = capture::teardown_events(&events);
    assert_eq!(logged.len(), 1, "one teardown event: {logged:?}");
    let (level, fields) = &logged[0];
    assert_eq!(*level, tracing::Level::WARN, "a forced stop is a warning");
    assert_eq!(fields.get("graceful").map(String::as_str), Some("false"));
}

#[tokio::test]
async fn teardown_of_a_sidecar_that_crashes_on_its_way_down_is_logged_as_abnormal() {
    let (events, _guard) = capture::install();
    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let (session, _) = fake_session(FAKE_CRASHES_ON_SHUTDOWN, &record, "crashes").await;

    let _ = teardown_removed_session(session, TREE_DEATH_CONFIRM_ROUNDS).await;

    let logged = capture::teardown_events(&events);
    assert_eq!(logged.len(), 1, "one teardown event: {logged:?}");
    let (level, fields) = &logged[0];
    assert_eq!(*level, tracing::Level::WARN, "a crash is a warning");
    assert_eq!(fields.get("graceful").map(String::as_str), Some("false"));
    assert_eq!(
        fields.get("stop").map(String::as_str),
        Some("abnormal_exit"),
        "{fields:?}"
    );
    assert_eq!(fields.get("exit_code").map(String::as_str), Some("1"));
}

/// The server's whole stop (WS drain, terminals, every provider's sidecars,
/// the codex launch manager, the layout flush) must finish inside a 5 s hard
/// ceiling (`SHUTDOWN_HARD_TIMEOUT` in freshell-server), so wedged claude
/// sidecars may not take a whole session grace period of it.
#[tokio::test]
async fn server_shutdown_stops_every_session_concurrently_within_its_share_of_the_stop_budget() {
    let (events, _guard) = capture::install();
    let dir = tempfile::tempdir().unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    let state = FreshClaudeState::new(Arc::new(tx));
    for index in 0..3 {
        let session_id = format!("wedged-{index}");
        let record = dir.path().join(format!("{session_id}.txt"));
        let (session, _) = fake_session(FAKE_IGNORES_SHUTDOWN, &record, &session_id).await;
        state.sessions.lock().await.insert(session_id, session);
    }

    let started = std::time::Instant::now();
    state.shutdown().await;
    let elapsed = started.elapsed();

    assert!(
        elapsed >= SERVER_STOP_GRACE,
        "each sidecar got the server-stop grace period before any signal: {elapsed:?}"
    );
    assert!(
        elapsed < SIDECAR_GRACEFUL_EXIT,
        "three wedged sidecars cost one server-stop grace period, not three, and less \
         than a session's: {elapsed:?}"
    );
    assert!(state.sessions.lock().await.is_empty());
    let logged = capture::teardown_events(&events);
    assert_eq!(
        logged.len(),
        3,
        "one teardown event per session: {logged:?}"
    );
    assert!(logged
        .iter()
        .all(|(_, fields)| fields.get("graceful").map(String::as_str) == Some("false")));
}

/// G31: the untagged grandchild a sidecar leaves behind is outside the Linux
/// `/proc` ownership reap; only the process-tree guard reaches it.
#[cfg(unix)]
#[tokio::test]
async fn teardown_kills_a_grandchild_the_sidecar_left_behind() {
    use crate::process_probe::ProcessProbe;

    let dir = tempfile::tempdir().unwrap();
    let record = dir.path().join("record.txt");
    let (session, ready) = fake_session(FAKE_ORPHANS_GRANDCHILD, &record, "orphans").await;
    let grandchild = ProcessProbe::open(
        ready
            .strip_prefix("ready ")
            .and_then(|pid| pid.trim().parse().ok())
            .expect("the readiness line carries the grandchild pid"),
    );
    assert!(grandchild.running());

    let confirmation = teardown_removed_session(session, TREE_DEATH_CONFIRM_ROUNDS).await;

    // The orphaned grandchild may still be a zombie its adopter has not
    // reaped yet; `kill(pid, 0)` would find that, the probe does not.
    assert!(
        grandchild.exited(),
        "the grandchild did not outlive the teardown"
    );
    assert_eq!(confirmation.label(), "confirmed");
}

/// G31: production sidecars are spawned inside their own process group.
#[cfg(unix)]
#[tokio::test]
async fn spawn_sidecar_runs_the_sidecar_inside_its_own_process_group() {
    let _env = super::tests::CLAUDE_ENV_LOCK.lock().await;
    let dir = tempfile::tempdir().unwrap();
    let script = dir.path().join("idle-sidecar.mjs");
    std::fs::write(&script, "setInterval(() => {}, 1000)\n").unwrap();
    std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
    let spawned = spawn_sidecar(None, None, "freshclaude").await;
    std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");

    let SpawnedSidecar {
        mut child,
        stdin,
        mut tree_guard,
        ..
    } = spawned.expect("spawn the sidecar");
    let pid = child.id().expect("a live sidecar") as i32;
    assert_eq!(
        // SAFETY: getpgid only reads the process table.
        unsafe { libc::getpgid(pid) },
        pid,
        "the kernel has the sidecar leading its own process group"
    );
    assert_eq!(
        tree_guard.process_group(),
        Some(pid),
        "the guard owns that group"
    );
    drop(stdin);
    assert_eq!(
        tree_guard.terminate(&mut child).await,
        crate::claude_spawn::TreeConfirmation::Confirmed
    );
}

/// The captured records whose message starts with `prefix`.
fn records_starting(
    events: &Arc<StdMutex<Vec<(tracing::Level, capture::Fields)>>>,
    prefix: &str,
) -> Vec<(tracing::Level, capture::Fields)> {
    events
        .lock()
        .expect("capture lock")
        .iter()
        .filter(|(_, fields)| {
            fields
                .get("message")
                .is_some_and(|message| message.starts_with(prefix))
        })
        .cloned()
        .collect()
}

/// A kill-and-confirm window that confirms the tree dead on its
/// `dies_on`-th run, recording when each run started.
struct ScriptedWindow {
    runs: Vec<std::time::Instant>,
    dies_on: usize,
}

impl TreeDeathWindow for ScriptedWindow {
    async fn confirm_dead(&mut self) -> bool {
        self.runs.push(std::time::Instant::now());
        self.runs.len() >= self.dies_on
    }

    fn lingering(&self) -> usize {
        1
    }
}

/// A tree that outlives a whole window survived SIGKILL: it is stuck in the
/// kernel. The detached escalation keeps going until it is dead (the kill's
/// deferred stop commit waits on that), but it backs off between windows
/// instead of rescanning `/proc` every 25 ms and warning every 0.6 s for
/// the rest of the server's life, and it says when the tree finally died.
#[tokio::test]
async fn the_detached_escalation_backs_off_between_windows_until_the_tree_dies() {
    let (events, _guard) = capture::install();
    let mut window = ScriptedWindow {
        runs: Vec::new(),
        dies_on: 4,
    };

    assert!(escalate_until_dead(&mut window, "backoff").await);

    assert_eq!(window.runs.len(), 4, "it ran until the tree died");
    let gaps: Vec<Duration> = window.runs.windows(2).map(|w| w[1] - w[0]).collect();
    for (gap, floor) in gaps.iter().zip([500, 1_000, 2_000]) {
        assert!(
            *gap >= Duration::from_millis(floor),
            "the pause doubles from half a second: {gaps:?}"
        );
    }
    let continues = records_starting(&events, "freshagent.claude.teardown_escalation_continues");
    assert_eq!(
        continues
            .iter()
            .map(|(level, fields)| (
                *level,
                fields.get("windows").cloned(),
                fields.get("next_window_in_ms").cloned()
            ))
            .collect::<Vec<_>>(),
        [("1", "500"), ("2", "1000"), ("3", "2000")]
            .map(|(windows, pause)| (
                tracing::Level::WARN,
                Some(windows.to_string()),
                Some(pause.to_string())
            ))
            .to_vec(),
        "one warning per unconfirmed window, naming the next pause"
    );
    let confirmed = records_starting(&events, "freshagent.claude.teardown_escalation_confirmed");
    assert_eq!(confirmed.len(), 1, "{confirmed:?}");
    assert_eq!(confirmed[0].0, tracing::Level::INFO);
    assert_eq!(confirmed[0].1.get("windows").map(String::as_str), Some("4"));
}

/// Once backed off, an unkillable tree costs one window (24 rounds of 25 ms)
/// and one warning a minute.
#[test]
fn the_pause_between_escalation_windows_doubles_up_to_a_minute() {
    assert_eq!(escalation_pause(1), Duration::from_millis(500));
    assert_eq!(escalation_pause(2), Duration::from_secs(1));
    assert_eq!(escalation_pause(3), Duration::from_secs(2));
    assert_eq!(escalation_pause(7), Duration::from_secs(32));
    assert_eq!(escalation_pause(8), Duration::from_secs(60));
    assert_eq!(escalation_pause(u32::MAX), Duration::from_secs(60));
}
