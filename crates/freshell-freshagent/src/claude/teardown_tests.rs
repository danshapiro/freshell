//! Session teardown and server shutdown go through the graceful sidecar stop
//! (audit G31): the shutdown request first, escalation only after the grace
//! period, every stop logged as `freshagent.claude.teardown`, and
//! `FreshClaudeState::shutdown` stopping sessions concurrently.

use super::*;

use std::collections::BTreeMap;
use std::sync::Mutex as StdMutex;

use crate::claude_spawn::SIDECAR_GRACEFUL_EXIT;

/// Honors the protocol like `index.mjs`: the shutdown line exits 0.
const FAKE_HONORS_SHUTDOWN: &str = r#"
const fs = require('fs')
const out = process.argv[1]
process.on('SIGTERM', () => { fs.appendFileSync(out, 'sigterm\n'); process.exit(143) })
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  if (JSON.parse(line).type === 'shutdown') {
    fs.appendFileSync(out, 'shutdown-handled\n')
    process.exit(0)
  }
})
setInterval(() => {}, 1000)
process.stdout.write('ready\n')
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

fn node() -> String {
    std::env::var("FRESHELL_CLAUDE_NODE").unwrap_or_else(|_| "node".to_string())
}

/// A live `ClaudeSession` whose sidecar is a Node fake, ready to tear down.
async fn fake_session(script: &str, record: &std::path::Path, session_id: &str) -> ClaudeSession {
    let mut child = tokio::process::Command::new(node())
        .arg("-e")
        .arg(script)
        .arg(record)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn the fake sidecar with node");
    let stdin = child.stdin.take().expect("piped stdin");
    let stdout = child.stdout.take().expect("piped stdout");
    let mut lines = BufReader::new(stdout).lines();
    let ready = tokio::time::timeout(Duration::from_secs(20), lines.next_line())
        .await
        .expect("the fake sidecar announces readiness")
        .expect("read the fake sidecar's stdout");
    assert_eq!(ready.as_deref(), Some("ready"));
    // Keep stdout open for the session's lifetime, as the real consumer does.
    let consumer = tokio::spawn(async move {
        let mut lines = lines;
        while let Ok(Some(_)) = lines.next_line().await {}
    });
    ClaudeSession {
        configuration: ClaudeConfiguration::default(),
        stdin,
        child,
        ownership_id: format!("test-teardown-{session_id}"),
        consumer,
        sidecar_session_id: session_id.to_string(),
        cli_session_id: None,
        owning_operation: None,
        owning_generation: None,
        broadcast_id: Arc::new(std::sync::Mutex::new(session_id.to_string())),
        pending: Arc::new(std::sync::Mutex::new(ClaudePending::default())),
        in_turn: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        turn_tracker: Arc::new(std::sync::Mutex::new(TurnTracker::default())),
        result_idle_pair_pending: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        last_synthesized_complete_at: Arc::new(std::sync::Mutex::new(None)),
        turn_lock: Arc::new(TokioMutex::new(())),
        rollback_probe_slot: Arc::new(std::sync::Mutex::new(None)),
        last_status: Arc::new(std::sync::Mutex::new("idle".to_string())),
    }
}

fn record_of(path: &std::path::Path) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// Thread-local capture of `freshagent.claude.teardown` events. The teardown
/// runs inline on the test's current-thread runtime, so `set_default` sees it.
mod capture {
    use super::*;
    use tracing::field::{Field, Visit};
    use tracing::{Event, Subscriber};
    use tracing_subscriber::layer::{Context, SubscriberExt};
    use tracing_subscriber::Layer;

    pub(super) type Fields = BTreeMap<String, String>;

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

    pub(super) fn teardown_events(
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
    pub(super) fn install() -> (
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
    let session = fake_session(FAKE_HONORS_SHUTDOWN, &record, "honors").await;

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
    let session = fake_session(FAKE_IGNORES_SHUTDOWN, &record, "ignores").await;

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
async fn server_shutdown_stops_every_session_concurrently_within_one_grace_period() {
    let (events, _guard) = capture::install();
    let dir = tempfile::tempdir().unwrap();
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
    let state = FreshClaudeState::new(Arc::new(tx));
    for index in 0..3 {
        let session_id = format!("wedged-{index}");
        let record = dir.path().join(format!("{session_id}.txt"));
        let session = fake_session(FAKE_IGNORES_SHUTDOWN, &record, &session_id).await;
        state.sessions.lock().await.insert(session_id, session);
    }

    let started = std::time::Instant::now();
    state.shutdown().await;
    let elapsed = started.elapsed();

    assert!(
        elapsed >= SIDECAR_GRACEFUL_EXIT,
        "each sidecar got its grace period: {elapsed:?}"
    );
    assert!(
        elapsed < SIDECAR_GRACEFUL_EXIT * 2,
        "three wedged sidecars cost about one grace period, not three: {elapsed:?}"
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
