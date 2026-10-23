//! One stop for every claude sidecar (C08, C09, G31): a sidecar that ends on
//! its own and a sidecar the server stops both go through
//! `SidecarProcesses::stop` (graceful wait, process-tree guard, `/proc`
//! ownership reap, tree-death confirmation). What differs is the report:
//!
//! * An unrequested end (the consumer's end-of-output path) records the dead
//!   session, stops the tree, and only then reports `exited` and
//!   `SIDECAR_EXITED` (Resume): the old tree is confirmed gone when the pane
//!   learns it may resume. The cause is the stream end the sidecar reported, or
//!   node's own exit status; a signal the stop itself sent is not the cause.
//! * A requested stop (here `handle_kill`) reports nothing about the end.
//! * A tree that outlives the stop's bounded confirmation window does not hold
//!   the report back: the report goes out, and the kill keeps going in the
//!   background until the tree is dead.
//!
//! The sidecar is a small Node fake started through the production create
//! (`handle_create`), so its consumer, eviction and stop are the real ones. It
//! starts two TERM-immune stand-ins for the claude CLI that carry its
//! ownership tag: one inside its process group (the process-tree guard
//! reaches it) and one that left the group with `setsid` (only the `/proc`
//! ownership reap and the confirmation's SIGKILL reach it).

use super::*;

use super::teardown_tests::capture;

/// The durable id the fake's session reports.
const DURABLE: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

/// The fake sidecar; `MODE`, `DIR` and `DURABLE` are prepended.
/// * `stream-ends`: a send makes it report `sdk.stream.ended` (`cli_exited`)
///   and exit 3, as index.mjs does when its SDK stream ends.
/// * `silent`: a send is never answered, so the turn stays in flight.
/// * `output-closes`: a send makes it close its stdout and keep running,
///   ignoring the shutdown line, stdin EOF and SIGTERM.
///
/// Every mode but `output-closes` exits 0 on the shutdown line.
const ENDING_SIDECAR: &str = r#"
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const STAND_IN = "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)"
spawn(process.execPath, ['-e', STAND_IN, path.join(DIR, 'in-group.pid')], { stdio: 'ignore' })
spawn(process.execPath, ['-e', STAND_IN, path.join(DIR, 'left-group.pid')], { stdio: 'ignore', detached: true })
process.on('SIGTERM', () => { if (MODE !== 'output-closes') process.exit(143) })
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type === 'create') {
    const sessionId = 'ending-sidecar-session'
    out({ type: 'created', requestId: msg.requestId, sessionId, protocol: 2 })
    out({ type: 'sdk.session.init', sessionId, cliSessionId: msg.sessionId || DURABLE, model: 'fake-model', cwd: '/tmp', tools: [] })
    out({ type: 'sdk.status', sessionId, status: 'idle' })
  } else if (msg.type === 'send') {
    if (MODE === 'stream-ends') {
      const ended = { type: 'sdk.stream.ended', sessionId: msg.sessionId, reason: 'cli_exited', message: 'Claude Code process exited with code 1' }
      process.stdout.write(JSON.stringify(ended) + '\n', () => process.exit(3))
    } else if (MODE === 'output-closes') {
      fs.closeSync(1)
    }
  } else if (msg.type === 'shutdown' && MODE !== 'output-closes') {
    process.exit(0)
  }
})
setInterval(() => {}, 1000)
"#;

/// A process captured by pid and start time: dead once that pid no longer
/// carries the start time (gone, reused, or a zombie, which runs nothing).
struct Captured {
    pid: i32,
    start: u64,
}

impl Captured {
    fn of(pid: i32) -> Self {
        let start = crate::session_lease::proc_starttime(pid)
            .unwrap_or_else(|| panic!("process {pid} is running"));
        Self { pid, start }
    }

    fn alive(&self) -> bool {
        crate::session_lease::proc_starttime(self.pid) == Some(self.start)
    }

    async fn dies_within(&self, budget: Duration) -> bool {
        let deadline = tokio::time::Instant::now() + budget;
        while self.alive() {
            if tokio::time::Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        true
    }
}

/// A session of the fake sidecar, created through the production create.
struct EndingSession {
    st: FreshClaudeState,
    rx: tokio::sync::broadcast::Receiver<String>,
    /// The pane's id for the session (its map key and envelope id).
    pane: String,
    node: Captured,
    in_group: Captured,
    left_group: Captured,
    /// Every frame read off the bus so far, in order.
    frames: Vec<Value>,
    _dir: tempfile::TempDir,
    _env: tokio::sync::MutexGuard<'static, ()>,
}

impl EndingSession {
    /// Start the fake in `mode`; `confirm_rounds` overrides the stop's
    /// tree-death confirmation budget.
    async fn start(mode: &str, confirm_rounds: Option<u8>) -> Self {
        let env = super::tests::CLAUDE_ENV_LOCK.lock().await;
        let dir = tempfile::tempdir().expect("fake sidecar directory");
        let script = dir.path().join("ending-sidecar.cjs");
        let quoted = |text: &str| serde_json::to_string(text).expect("a JS string");
        std::fs::write(
            &script,
            format!(
                "const MODE = {}\nconst DIR = {}\nconst DURABLE = {}\n{ENDING_SIDECAR}",
                quoted(mode),
                quoted(&dir.path().to_string_lossy()),
                quoted(DURABLE),
            ),
        )
        .expect("write the fake sidecar");
        std::env::set_var("FRESHELL_CLAUDE_SIDECAR", &script);
        std::env::set_var("CLAUDE_CONFIG_DIR", dir.path().join("claude"));
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(256);
        let mut st = FreshClaudeState::new(Arc::new(tx));
        st.set_handoff_confirm_rounds_for_test(confirm_rounds);

        st.handle_create(create_msg("end-of-output"), None).await;
        let created = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let frame = match rx.recv().await {
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(err) => panic!("broadcast recv failed: {err}"),
                    Ok(raw) => serde_json::from_str::<Value>(&raw).expect("a JSON frame"),
                };
                if frame["requestId"] == "end-of-output" {
                    return frame;
                }
            }
        })
        .await
        .expect("the create answers");
        assert_eq!(created["type"], "freshAgent.created", "{created}");
        let pane = created["sessionId"]
            .as_str()
            .expect("the created session id")
            .to_string();
        let node_pid = st
            .sessions
            .lock()
            .await
            .get(&pane)
            .and_then(|session| session.child.id())
            .expect("a live sidecar") as i32;
        let stand_in = |name: &str| {
            let file = dir.path().join(name);
            async move {
                let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
                loop {
                    if let Some(pid) = std::fs::read_to_string(&file)
                        .ok()
                        .and_then(|pid| pid.trim().parse::<i32>().ok())
                    {
                        return Captured::of(pid);
                    }
                    assert!(
                        tokio::time::Instant::now() < deadline,
                        "the sidecar started its {} stand-in",
                        file.display()
                    );
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            }
        };
        let in_group = stand_in("in-group.pid").await;
        let left_group = stand_in("left-group.pid").await;
        Self {
            st,
            rx,
            pane,
            node: Captured::of(node_pid),
            in_group,
            left_group,
            frames: Vec::new(),
            _dir: dir,
            _env: env,
        }
    }

    /// Read frames until one matches `want` (returned) or 20 s pass.
    async fn await_frame(&mut self, what: &str, want: impl Fn(&Value) -> bool) -> Value {
        let found = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                let frame = match self.rx.recv().await {
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(err) => panic!("broadcast recv failed: {err}"),
                    Ok(raw) => serde_json::from_str::<Value>(&raw).expect("a JSON frame"),
                };
                self.frames.push(frame.clone());
                if want(&frame) {
                    return frame;
                }
            }
        })
        .await;
        found.unwrap_or_else(|_| panic!("no {what}; frames: {:?}", self.frames))
    }

    /// Read every frame that arrives within `quiet`.
    async fn drain(&mut self, quiet: Duration) {
        while let Ok(Ok(raw)) = tokio::time::timeout(quiet, self.rx.recv()).await {
            self.frames
                .push(serde_json::from_str(&raw).expect("a JSON frame"));
        }
    }

    /// How many frames about this pane's session match `want`.
    fn count(&self, want: impl Fn(&Value) -> bool) -> usize {
        self.frames
            .iter()
            .filter(|frame| frame["sessionId"] == self.pane.as_str() && want(frame))
            .count()
    }
}

impl Drop for EndingSession {
    fn drop(&mut self) {
        std::env::remove_var("FRESHELL_CLAUDE_SIDECAR");
        std::env::remove_var("CLAUDE_CONFIG_DIR");
        // A failed assertion must not leave the TERM-immune stand-ins behind.
        for process in [&self.node, &self.in_group, &self.left_group] {
            if process.alive() {
                // SAFETY: the pid still carries the start time captured from
                // this test's own process; kill only signals it.
                unsafe {
                    libc::kill(process.pid, libc::SIGKILL);
                }
            }
        }
    }
}

fn create_msg(request_id: &str) -> FreshAgentCreate {
    FreshAgentCreate {
        pane_id: None,
        naming_handle: None,
        observed_epoch: None,
        observed_generation: None,
        request_id: request_id.to_string(),
        session_type: SessionType::Freshclaude,
        provider: Some(freshell_protocol::AgentProvider::Claude),
        cwd: None,
        legacy_restore_context: None,
        resume_session_id: None,
        session_ref: None,
        model: None,
        model_selection: None,
        permission_mode: None,
        sandbox: None,
        effort: None,
        plugins: None,
        tab_id: None,
    }
}

fn send_msg(session_id: &str, text: &str) -> FreshAgentSend {
    FreshAgentSend {
        provider: freshell_protocol::AgentProvider::Claude,
        session_id: session_id.to_string(),
        session_type: SessionType::Freshclaude,
        text: text.to_string(),
        cwd: None,
        images: None,
        request_id: None,
        settings: None,
        observed_epoch: None,
        observed_generation: None,
        checkpoint_intent: None,
    }
}

fn kill_msg(session_id: &str) -> FreshAgentKill {
    FreshAgentKill {
        observed_epoch: None,
        observed_generation: None,
        provider: freshell_protocol::AgentProvider::Claude,
        session_id: session_id.to_string(),
        session_type: SessionType::Freshclaude,
        cwd: None,
    }
}

fn is_exited_status(frame: &Value) -> bool {
    frame["type"] == "freshAgent.event"
        && frame["event"]["type"] == "freshAgent.status"
        && frame["event"]["status"] == "exited"
}

fn is_sidecar_exited(frame: &Value) -> bool {
    frame["type"] == "freshAgent.event"
        && frame["event"]["type"] == "freshAgent.error"
        && frame["event"]["code"] == "SIDECAR_EXITED"
}

/// Either half of the exit report (`exited` comes first).
fn is_exit_report(frame: &Value) -> bool {
    is_exited_status(frame) || is_sidecar_exited(frame)
}

fn is_turn_complete(frame: &Value) -> bool {
    frame["event"]["type"] == "freshAgent.turn.complete"
}

/// The captured records whose message starts with `message`, in order.
fn records(
    events: &Arc<std::sync::Mutex<Vec<(tracing::Level, capture::Fields)>>>,
    message: &str,
) -> Vec<capture::Fields> {
    events
        .lock()
        .expect("capture lock")
        .iter()
        .filter(|(_, fields)| {
            fields
                .get("message")
                .is_some_and(|logged| logged.starts_with(message))
        })
        .map(|(_, fields)| fields.clone())
        .collect()
}

/// Where the first record whose message starts with `message` was logged.
fn logged_at(
    events: &Arc<std::sync::Mutex<Vec<(tracing::Level, capture::Fields)>>>,
    message: &str,
) -> Option<usize> {
    events
        .lock()
        .expect("capture lock")
        .iter()
        .position(|(_, fields)| {
            fields
                .get("message")
                .is_some_and(|logged| logged.starts_with(message))
        })
}

fn field<'a>(fields: &'a capture::Fields, name: &str) -> Option<&'a str> {
    fields.get(name).map(String::as_str)
}

/// C08 + G31: a sidecar whose SDK stream ended reports it and exits 3. Its
/// whole tree (the CLI stand-in in its group AND the one that left the group)
/// is dead by the time the pane hears `exited`, with no waiting on the test's
/// side; the pane hears it once, with the reported cause, and the cut-off turn
/// rings exactly once, from Rust (C18: the sidecar mints no edge of its own).
#[cfg(target_os = "linux")]
#[tokio::test]
async fn eof_drains_old_waiting_before_reaping_and_preserves_a_replacements_waiting() {
    use std::sync::atomic::{AtomicBool, Ordering};
    #[derive(Default)]
    struct Observer(AtomicBool);
    impl crate::claude_edges::AttentionObserver for Observer {
        fn on_waiting(&self, _: &str, _: &str, _: i64) {
            self.0.store(true, Ordering::SeqCst);
        }
        fn on_pending_drained(&self, _: &str) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let mut session = EndingSession::start("stream-ends", None).await;
    let observer = Arc::new(Observer::default());
    session.st.clone().with_attention_observer(observer.clone());
    let pending = session.st.sessions.lock().await[&session.pane]
        .pending
        .clone();
    session
        .st
        .publish_pending_frame(
            &session.pane,
            &pending,
            &json!({"type":"sdk.permission.request", "requestId":"old", "tool":{"name":"Bash"}}),
            "freshclaude",
        )
        .await;
    assert!(observer.0.load(Ordering::SeqCst));
    let hold = session.st.hold_exit_reports();
    session
        .st
        .handle_send(send_msg(&session.pane, "end while waiting"))
        .await;
    tokio::time::timeout(Duration::from_secs(10), hold.parked())
        .await
        .unwrap();
    let old_waiting_was_drained = !observer.0.load(Ordering::SeqCst);

    // A resumed runtime raises another request while the old process tree is
    // still being reaped. Finishing that old death must not drain this interval.
    tests::insert_fake_claude_session_with_pending(&session.st, &session.pane, None, &[]).await;
    let replacement = session.st.sessions.lock().await[&session.pane]
        .pending
        .clone();
    session.st.publish_pending_frame(&session.pane, &replacement,
        &json!({"type":"sdk.question.request", "requestId":"new", "questions":[{"question":"Continue?"}]}),
        "freshclaude").await;
    hold.release();
    session
        .await_frame("the old lost turn's edge", is_turn_complete)
        .await;
    let new_waiting_survived = observer.0.load(Ordering::SeqCst);
    session.st.shutdown().await;
    assert!(
        old_waiting_was_drained,
        "EOF must drain old pending attention before teardown awaits"
    );
    assert!(
        new_waiting_survived,
        "old teardown must not clear the resumed runtime's waiting interval"
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_stream_end_is_reported_once_its_whole_tree_is_confirmed_gone() {
    let (events, _log) = capture::install();
    let mut session = EndingSession::start("stream-ends", None).await;
    assert!(session.in_group.alive() && session.left_group.alive());

    session
        .st
        .handle_send(send_msg(&session.pane, "a turn whose stream ends"))
        .await;
    let first = session.await_frame("the exit report", is_exit_report).await;

    assert!(
        is_exited_status(&first),
        "`exited` leads the report: {first}"
    );
    assert!(!session.node.alive(), "node is reaped before the report");
    assert!(
        !session.in_group.alive(),
        "the CLI stand-in in node's group is dead before the report"
    );
    assert!(
        !session.left_group.alive(),
        "the CLI stand-in that left node's group is dead before the report"
    );
    let report = session
        .await_frame("SIDECAR_EXITED", is_sidecar_exited)
        .await;
    assert_eq!(
        report["event"]["cause"],
        json!({ "reason": "cli_exited", "message": "Claude Code process exited with code 1" }),
        "the reported stream end is the cause: {report}"
    );
    session.drain(Duration::from_millis(300)).await;
    assert_eq!(session.count(is_exited_status), 1, "{:?}", session.frames);
    assert_eq!(session.count(is_sidecar_exited), 1, "{:?}", session.frames);
    assert_eq!(
        session.count(is_turn_complete),
        1,
        "the cut-off turn rings once: {:?}",
        session.frames
    );
    assert!(session.st.dead_sessions.find(&session.pane).is_some());

    let logged = records(&events, "freshagent.claude.sidecar_exit");
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert_eq!(field(&logged[0], "reason"), Some("cli_exited"));
    assert_eq!(field(&logged[0], "stop"), Some("abnormal_exit"));
    assert_eq!(field(&logged[0], "confirmation"), Some("confirmed"));
    assert_eq!(field(&logged[0], "exit_status"), Some("code 3"));
    assert_eq!(field(&logged[0], "rings"), Some("true"));
}

/// C09 + G31: node killed mid-turn reports no stream end. Its exit status is
/// the cause (SIGKILL), its tree is dead before the report, and the cut-off
/// turn rings exactly once, from Rust.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_node_killed_mid_turn_reports_its_signal_after_the_tree_is_gone_and_rings_once() {
    let (events, _log) = capture::install();
    let mut session = EndingSession::start("silent", None).await;
    session
        .st
        .handle_send(send_msg(&session.pane, "a turn the sidecar dies in"))
        .await;
    let busy = session
        .st
        .sessions
        .lock()
        .await
        .get(&session.pane)
        .map(|live| live.ledger.lock().expect("turn ledger lock").busy());
    assert_eq!(busy, Some(true), "the turn is in flight");

    // SAFETY: the sidecar is this test's own child.
    unsafe {
        libc::kill(session.node.pid, libc::SIGKILL);
    }
    let first = session.await_frame("the exit report", is_exit_report).await;

    assert!(
        is_exited_status(&first),
        "`exited` leads the report: {first}"
    );
    assert!(!session.in_group.alive(), "the in-group stand-in is dead");
    assert!(
        !session.left_group.alive(),
        "the stand-in that left is dead"
    );
    let report = session
        .await_frame("SIDECAR_EXITED", is_sidecar_exited)
        .await;
    let cause = &report["event"]["cause"];
    assert_eq!(cause["reason"], "sidecar_exited", "{report}");
    assert_eq!(cause["signal"], "SIGKILL", "{report}");
    assert!(cause.get("exitCode").is_none(), "{report}");
    session.drain(Duration::from_millis(300)).await;
    assert_eq!(session.count(is_exited_status), 1, "{:?}", session.frames);
    assert_eq!(session.count(is_sidecar_exited), 1, "{:?}", session.frames);
    assert_eq!(
        session.count(is_turn_complete),
        1,
        "the cut-off turn rings once: {:?}",
        session.frames
    );

    let logged = records(&events, "freshagent.claude.sidecar_exit");
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert_eq!(field(&logged[0], "stop"), Some("abnormal_exit"));
    assert_eq!(field(&logged[0], "exit_status"), Some("SIGKILL"));
    assert_eq!(field(&logged[0], "confirmation"), Some("confirmed"));
    assert_eq!(field(&logged[0], "rings"), Some("true"));
}

/// G31: a sidecar that closed its output but kept running, deaf to the
/// shutdown line and SIGTERM, is killed by the stop after the grace period.
/// The SIGKILL is the stop's own doing, so the cause names no exit code or
/// signal; the log still records the status.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_sidecar_the_stop_had_to_kill_reports_no_signal_as_its_cause() {
    let (events, _log) = capture::install();
    let mut session = EndingSession::start("output-closes", None).await;
    session
        .st
        .handle_send(send_msg(&session.pane, "a turn whose output goes away"))
        .await;

    let first = session.await_frame("the exit report", is_exit_report).await;

    assert!(
        is_exited_status(&first),
        "`exited` leads the report: {first}"
    );
    assert!(
        !session.node.alive(),
        "the stop killed node before the report"
    );
    assert!(!session.in_group.alive(), "the in-group stand-in is dead");
    assert!(
        !session.left_group.alive(),
        "the stand-in that left is dead"
    );
    let report = session
        .await_frame("SIDECAR_EXITED", is_sidecar_exited)
        .await;
    assert_eq!(
        report["event"]["cause"],
        json!({ "reason": "sidecar_exited", "message": "the agent process ended" }),
        "the stop's own kill is not the cause: {report}"
    );

    let logged = records(&events, "freshagent.claude.sidecar_exit");
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert_eq!(field(&logged[0], "stop"), Some("forced"));
    assert_eq!(field(&logged[0], "exit_status"), Some("SIGKILL"));
    assert_eq!(field(&logged[0], "confirmation"), Some("confirmed"));
}

/// G31: the same sidecar stopped on request (a pane kill) goes through the
/// same stop, so its whole tree dies, but nothing about the end is reported
/// and no dead session is recorded.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_requested_stop_kills_the_same_tree_and_reports_nothing() {
    let (events, _log) = capture::install();
    let mut session = EndingSession::start("stream-ends", None).await;

    session.st.handle_kill(kill_msg(&session.pane)).await;

    assert!(!session.node.alive(), "node stopped");
    assert!(!session.in_group.alive(), "the in-group stand-in is dead");
    assert!(
        !session.left_group.alive(),
        "the stand-in that left is dead"
    );
    session.drain(Duration::from_millis(500)).await;
    assert_eq!(session.count(is_exit_report), 0, "{:?}", session.frames);
    assert_eq!(session.count(is_turn_complete), 0, "{:?}", session.frames);
    assert!(session.st.dead_sessions.find(&session.pane).is_none());
    assert!(session.st.dead_sessions.find(&session.pane).is_none());
    assert!(records(&events, "freshagent.claude.sidecar_exit").is_empty());
    let teardowns = capture::teardown_events(&events);
    assert_eq!(teardowns.len(), 1, "{teardowns:?}");
    assert_eq!(field(&teardowns[0].1, "confirmation"), Some("confirmed"));
}

/// G31: a tree the stop cannot confirm gone within its bounded window (here a
/// window of no rounds, which the stand-in that left node's group outlives)
/// does not hold the report back. The pane hears `exited` and SIDECAR_EXITED
/// once each, and the detached escalation keeps killing the tree until it is
/// dead. The report is logged before the escalation confirms that death, so
/// the report did not wait for it.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn a_tree_the_stop_cannot_confirm_gone_is_reported_and_killed_in_the_background() {
    let (events, _log) = capture::install();
    let mut session = EndingSession::start("stream-ends", Some(0)).await;

    session
        .st
        .handle_send(send_msg(&session.pane, "a turn whose stream ends"))
        .await;
    session
        .await_frame("SIDECAR_EXITED", is_sidecar_exited)
        .await;

    assert!(
        !session.in_group.alive(),
        "the process-tree guard killed node's group before the report"
    );
    assert!(
        session
            .left_group
            .dies_within(Duration::from_secs(10))
            .await,
        "the background escalation kills the stand-in that left the group"
    );
    session.drain(Duration::from_millis(300)).await;
    assert_eq!(session.count(is_exited_status), 1, "{:?}", session.frames);
    assert_eq!(session.count(is_sidecar_exited), 1, "{:?}", session.frames);

    let logged = records(&events, "freshagent.claude.sidecar_exit");
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert_eq!(field(&logged[0], "confirmation"), Some("not_confirmed"));
    assert_eq!(
        records(&events, "freshagent.claude.teardown_unconfirmed").len(),
        1,
        "the unconfirmed stop is an error record"
    );
    let reported = logged_at(&events, "freshagent.claude.sidecar_exit").expect("reported");
    let confirmed = logged_at(&events, "freshagent.claude.teardown_escalation_confirmed")
        .expect("the escalation confirms the tree's death");
    assert!(
        reported < confirmed,
        "the report went out before the background kill finished"
    );
}
