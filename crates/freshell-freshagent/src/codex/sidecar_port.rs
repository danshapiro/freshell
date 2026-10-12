//! A freshcodex sidecar start that loses its listen port.
//!
//! A start attempt picks its listen port by binding port 0 and releasing it
//! ([`freshell_codex::launch_lifecycle::allocate_loopback_port`]), then tells
//! the app-server to listen there. Another socket on the host can take the
//! port in between (a few starts in ten thousand). The attempt then LOST ITS
//! PORT, which shows one of two ways:
//!
//! - the app-server exits before it listens, and another socket now holds the
//!   port: a listener's bind there fails with "address in use";
//! - a listener answers the readiness connect, but it is not this attempt's:
//!   no process in the spawned app-server's tree owns the listening socket
//!   (another pane's app-server or proxy took the port; Stage 2: LB-30). Its
//!   answers are never taken for this sidecar's.
//!
//! The terminal planner retries a start on a new port the same way
//! (`plan_create_with_retry`). A lost port is retried here with the planner's
//! own retry decision, attempt budget and backoff
//! ([`plan_codex_launch_retry`], [`CODEX_INITIAL_LAUNCH_ATTEMPTS`],
//! [`CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS`]), after the lost attempt is stopped
//! ([`stop_lost_attempt`]). Every other startup failure fails the start at
//! once, as before. Each retry logs WARN `codex_sidecar_port_lost`; a start
//! that fails after a lost port logs ERROR `codex_sidecar_start_failed`.

use std::time::Duration;

use freshell_codex::launch_lifecycle::GONE_WAIT_BOUND;
use freshell_codex::launch_plan::{
    plan_codex_launch_retry, CodexLaunchRetryDecision, CODEX_INITIAL_LAUNCH_ATTEMPTS,
    CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS,
};
use freshell_codex::transport::reap_owned_codex_sidecars;
use freshell_containment::FORCE_GRACE;

use super::PROVIDER;

/// One sidecar start attempt: its number (from 1), its listen port and its
/// ownership tag, both its own.
pub(super) struct Attempt<'a> {
    pub(super) number: u32,
    pub(super) port: u16,
    pub(super) ownership_id: &'a str,
}

/// How a start attempt failed.
pub(super) struct AttemptFailure {
    pub(super) message: String,
    /// The process the attempt spawned (`None` when it never spawned one).
    pub(super) pid: Option<u32>,
    /// `Some` when the attempt lost its port: whether the attempt was then
    /// confirmed stopped ([`stop_lost_attempt`]).
    pub(super) lost_port: Option<bool>,
}

impl AttemptFailure {
    /// Any startup failure but a lost port.
    pub(super) fn failed(message: String, pid: Option<u32>) -> Self {
        Self {
            message,
            pid,
            lost_port: None,
        }
    }
}

/// Whether another socket holds loopback `port` now, so an app-server told to
/// listen there cannot: a listener's bind there fails with "address in use".
/// One bind, released at once.
pub(super) fn loopback_port_taken(port: u16) -> bool {
    matches!(
        std::net::TcpListener::bind(("127.0.0.1", port)),
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse
    )
}

/// Whether the listener on `port` belongs to the attempt's own app-server:
/// the spawned process `pid` or a process it started (the native behind the
/// Node launcher). One read of the socket tables and of the descriptors of
/// that small process tree, done in place like the lane's other one-shot
/// `/proc` reads (a hop to a blocking thread would only reorder the
/// runtime's tasks).
pub(super) fn listener_is_the_attempts(port: u16, pid: Option<u32>) -> bool {
    pid.is_some_and(|pid| freshell_containment::listening_socket_owner(port, &[pid]).is_some())
}

/// The failure of an attempt that lost its port, once the attempt is stopped
/// so nothing of it is left and nothing of it can confuse the retry. The
/// shape of a Force stop, on the planner's unit-less attempt's means (the
/// ownership tag and the exact child):
///
/// 1. Every process carrying the attempt's ownership tag gets SIGTERM
///    (Linux; elsewhere the tag cannot be read), the native behind the Node
///    launcher included, while the launcher still holds the tree together.
/// 2. The exact spawned child's exit is awaited for up to [`FORCE_GRACE`]:
///    the launcher exits once its native has, so this exit also says the
///    native is gone.
/// 3. A child still running is killed, and its exit awaited, bounded by
///    [`GONE_WAIT_BOUND`].
///
/// Then the attempt's tracking record is removed.
pub(super) async fn stop_lost_attempt(
    child: &mut tokio::process::Child,
    pid: Option<u32>,
    ownership_id: &str,
    reason: String,
) -> AttemptFailure {
    reap_owned_codex_sidecars(ownership_id);
    let grace = if cfg!(target_os = "linux") {
        FORCE_GRACE
    } else {
        Duration::ZERO
    };
    let mut exited = matches!(tokio::time::timeout(grace, child.wait()).await, Ok(Ok(_)));
    if !exited {
        let _ = child.start_kill();
        exited = matches!(
            tokio::time::timeout(GONE_WAIT_BOUND, child.wait()).await,
            Ok(Ok(_))
        );
    }
    crate::codex_sidecar_tracking::scrub_sidecar_record(ownership_id);
    AttemptFailure {
        message: reason,
        pid,
        lost_port: Some(exited),
    }
}

/// After a failed attempt: the delay before the next attempt, or the start's
/// error. Only an attempt that lost its port and was confirmed stopped is
/// retried, on the planner's schedule (logged WARN
/// `codex_sidecar_port_lost`). The start fails once the planner's budget is
/// spent, when the lost attempt was not confirmed stopped (attempts never
/// overlap), and at once on any other failure; a start that fails after a
/// lost port logs ERROR `codex_sidecar_start_failed`.
pub(super) fn after_failed_attempt(
    attempt: &Attempt<'_>,
    failure: AttemptFailure,
) -> Result<Duration, String> {
    let error = match failure.lost_port {
        None if attempt.number == 1 => return Err(failure.message),
        None => failure.message,
        Some(false) => format!(
            "{}; the attempt that lost its port was not confirmed stopped within {}s, \
             so no further attempt starts",
            failure.message,
            GONE_WAIT_BOUND.as_secs()
        ),
        Some(true) => match plan_codex_launch_retry(
            attempt.number,
            CODEX_INITIAL_LAUNCH_ATTEMPTS,
            CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS,
            false,
        ) {
            CodexLaunchRetryDecision::Retry { delay_ms } => {
                tracing::warn!(
                    target: "freshell_freshagent::codex",
                    event = "codex_sidecar_port_lost",
                    provider = PROVIDER,
                    attempt = attempt.number,
                    attempts = CODEX_INITIAL_LAUNCH_ATTEMPTS,
                    port = attempt.port,
                    pid = failure.pid.unwrap_or(0),
                    ownership_id = %attempt.ownership_id,
                    retry_delay_ms = delay_ms,
                    reason = %failure.message,
                    "codex_sidecar_port_lost: another socket took the sidecar's listen \
                     port; the attempt is stopped and the start retries on a new port"
                );
                return Ok(Duration::from_millis(delay_ms));
            }
            CodexLaunchRetryDecision::GiveUp => format!(
                "{}; the codex app-server lost its listen port on all {} attempts",
                failure.message, attempt.number
            ),
        },
    };
    tracing::error!(
        target: "freshell_freshagent::codex",
        event = "codex_sidecar_start_failed",
        provider = PROVIDER,
        attempt = attempt.number,
        attempts = CODEX_INITIAL_LAUNCH_ATTEMPTS,
        port = attempt.port,
        pid = failure.pid.unwrap_or(0),
        ownership_id = %attempt.ownership_id,
        reason = %error,
        "codex_sidecar_start_failed: the codex app-server sidecar did not start after a \
         lost listen port"
    );
    Err(error)
}

#[cfg(all(test, target_os = "linux"))]
#[path = "../../../freshell-containment/tests/support/capture.rs"]
#[allow(dead_code)]
mod capture;

#[cfg(all(test, target_os = "linux"))]
#[path = "../../../freshell-codex/tests/support/reserved_port.rs"]
#[allow(dead_code)]
mod reserved_port;

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;

    use freshell_codex::launch_plan::{CodexSidecarLaunchContext, CODEX_INITIAL_LAUNCH_ATTEMPTS};
    use freshell_codex::sidecar_store::{set_codex_sidecar_store, CodexSidecarStore};
    use freshell_codex::StartThreadParams;
    use serde_json::{json, Value};
    use tracing::Level;

    use super::capture;
    use super::reserved_port::ReservedPort;
    use crate::codex::tests::{configure_fake_codex_cmd, ENV_LOCK};
    use crate::codex::FreshCodexState;
    use crate::session_lease::proc_starttime;

    const PORT_LOST: &str = "codex_sidecar_port_lost";
    const START_FAILED: &str = "codex_sidecar_start_failed";

    fn fake_app_server_script() -> String {
        format!(
            "{}/../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs",
            env!("CARGO_MANIFEST_DIR")
        )
    }

    /// A tempdir sidecar store installed as the process-global handle (where
    /// every start attempt writes its tracking record); the disabled store is
    /// put back on drop. Installed only under [`ENV_LOCK`], which every test
    /// that starts a sidecar holds.
    struct TrackingStore {
        _dir: tempfile::TempDir,
        store: Arc<CodexSidecarStore>,
    }

    impl TrackingStore {
        fn install() -> Self {
            let dir = tempfile::tempdir().expect("a temp sidecar store");
            let store = Arc::new(CodexSidecarStore::new(dir.path().to_path_buf()));
            set_codex_sidecar_store(store.clone());
            Self { _dir: dir, store }
        }

        fn ownership_ids(&self) -> Vec<String> {
            self.store
                .load_all()
                .into_iter()
                .map(|record| record.ownership_id)
                .collect()
        }

        fn ws_url_of(&self, ownership_id: &str) -> Option<String> {
            self.store
                .load_all()
                .into_iter()
                .find(|record| record.ownership_id == ownership_id)
                .map(|record| record.ws_url)
        }
    }

    impl Drop for TrackingStore {
        fn drop(&mut self) {
            set_codex_sidecar_store(Arc::new(CodexSidecarStore::disabled()));
        }
    }

    /// Where every fake app-server this state starts records whether it
    /// listened or lost its port (`FAKE_CODEX_LISTEN_RECORD_DIR`).
    struct ListenRecords(tempfile::TempDir);

    impl ListenRecords {
        fn new() -> Self {
            Self(tempfile::tempdir().expect("a temp listen record dir"))
        }

        fn state(&self) -> FreshCodexState {
            let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
            FreshCodexState::new(
                Arc::new("tok".to_string()),
                Arc::new(tx),
                json!({ "freshAgent": { "enabled": true } }),
            )
            .with_sidecar_launch_context(CodexSidecarLaunchContext {
                env: [(
                    "FAKE_CODEX_LISTEN_RECORD_DIR".to_string(),
                    self.0.path().display().to_string(),
                )]
                .into(),
                ..Default::default()
            })
        }

        /// Each fake's record, by its pid.
        fn by_pid(&self) -> BTreeMap<u32, Value> {
            std::fs::read_dir(self.0.path())
                .expect("the listen record dir")
                .flatten()
                .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
                .map(|entry| {
                    let record: Value = serde_json::from_slice(
                        &std::fs::read(entry.path()).expect("a listen record"),
                    )
                    .expect("a JSON listen record");
                    (record["pid"].as_u64().expect("a pid") as u32, record)
                })
                .collect()
        }
    }

    /// The processes the start attempts spawned, in order, each with its
    /// start time (the `on_spawned` hook's evidence).
    #[derive(Clone, Default)]
    struct Spawned(Arc<StdMutex<Vec<(u32, u64)>>>);

    impl Spawned {
        fn hook(&self) -> impl Fn(u32) + Send + Sync {
            let spawned = self.0.clone();
            move |pid| {
                let start = proc_starttime(pid as i32).expect("a spawned process's start time");
                spawned.lock().unwrap().push((pid, start));
            }
        }

        fn all(&self) -> Vec<(u32, u64)> {
            self.0.lock().unwrap().clone()
        }
    }

    /// Whether the process that had this pid and start time is gone (exited
    /// and reaped).
    fn gone((pid, start): (u32, u64)) -> bool {
        proc_starttime(pid as i32) != Some(start)
    }

    /// The processes whose environment carries the sidecar ownership tag
    /// `ownership_id` (read-only `/proc` scan).
    fn processes_carrying(ownership_id: &str) -> Vec<u32> {
        let needle = freshell_codex::durability::ownership_needle(ownership_id);
        std::fs::read_dir("/proc")
            .expect("/proc")
            .flatten()
            .filter_map(|entry| entry.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| {
                std::fs::read(format!("/proc/{pid}/environ")).is_ok_and(|environ| {
                    environ
                        .split(|byte| *byte == 0)
                        .any(|var| var == needle.as_bytes())
                })
            })
            .filter(|pid| proc_starttime(*pid as i32).is_some())
            .collect()
    }

    /// Test helper: whether every process carrying `ownership_id` is gone
    /// within a bound (a SIGTERM the product sends is not awaited for
    /// processes other than the one it spawned).
    async fn nothing_carries(ownership_id: &str) -> bool {
        for _ in 0..250 {
            if processes_carrying(ownership_id).is_empty() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        false
    }

    /// A loopback port held by a socket bound to it (without `SO_REUSEADDR`)
    /// that never listens: an app-server told to listen there fails its bind,
    /// and nothing answers a probe.
    fn port_held_by_a_socket_that_never_listens() -> (tokio::net::TcpSocket, u16) {
        let socket = tokio::net::TcpSocket::new_v4().expect("a socket");
        socket
            .bind("127.0.0.1:0".parse().unwrap())
            .expect("bind a loopback port");
        let port = socket.local_addr().expect("the bound port").port();
        (socket, port)
    }

    fn port_of(ws_url: &str) -> u16 {
        ws_url
            .rsplit(':')
            .next()
            .and_then(|port| port.parse().ok())
            .expect("a ws url with a port")
    }

    /// Another app-server, started by the test (so outside every start
    /// attempt's process tree), listening on a port the kernel gave it. It
    /// answers a readiness probe and logs every thread operation it serves.
    struct AnsweringListener {
        child: tokio::process::Child,
        port: u16,
        thread_operations: PathBuf,
        _home: tempfile::TempDir,
    }

    impl AnsweringListener {
        async fn start() -> Self {
            let home = tempfile::tempdir().expect("the listener's temp home");
            let codex_home = home.path().join("codex-home");
            std::fs::create_dir_all(&codex_home).expect("the listener's CODEX_HOME");
            let port_file = home.path().join("port");
            let thread_operations = home.path().join("thread-operations.jsonl");
            let mut child = tokio::process::Command::new("node")
                .arg(fake_app_server_script())
                .args(["app-server", "--listen", "ws://127.0.0.1:0"])
                .env("CODEX_HOME", &codex_home)
                .env("FAKE_CODEX_APP_SERVER_PORT_FILE", &port_file)
                .env(
                    "FAKE_CODEX_APP_SERVER_BEHAVIOR",
                    json!({ "appendThreadOperationLogPath": thread_operations }).to_string(),
                )
                .env_remove("FAKE_CODEX_LISTEN_RECORD_DIR")
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .expect("start the answering listener");
            // Test helper: a bounded wait for the port file the fake writes
            // once it listens.
            let port = tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    if let Ok(text) = std::fs::read_to_string(&port_file) {
                        if let Ok(port) = text.trim().parse::<u16>() {
                            return port;
                        }
                    }
                    if let Ok(Some(status)) = child.try_wait() {
                        panic!("the answering listener exited before it listened: {status}");
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("the answering listener listens");
            Self {
                child,
                port,
                thread_operations,
                _home: home,
            }
        }

        fn thread_operations(&self) -> Vec<Value> {
            std::fs::read_to_string(&self.thread_operations)
                .unwrap_or_default()
                .lines()
                .map(|line| serde_json::from_str(line).expect("a thread operation"))
                .collect()
        }

        async fn stop(mut self) {
            let _ = self.child.start_kill();
            let _ = self.child.wait().await;
        }
    }

    fn events_named(captured: &capture::Captured, name: &str) -> Vec<capture::Event> {
        captured
            .0
            .lock()
            .unwrap()
            .iter()
            .filter(|event| event.event == name)
            .cloned()
            .collect()
    }

    /// Stops a start's own app-server (the test's own child, by its handle).
    async fn stop_sidecar(
        client: Arc<freshell_codex::CodexAppServerClient>,
        mut child: tokio::process::Child,
    ) {
        client.close().await;
        let _ = child.start_kill();
        let _ = child.wait().await;
    }

    /// The first chosen port is held by a socket that never listens: the
    /// app-server exits before it listens while another socket holds its
    /// port. That attempt is stopped and the pane is created on a retry, on a
    /// new port.
    #[tokio::test]
    async fn a_pane_whose_first_port_another_socket_holds_starts_on_a_new_port() {
        let _env = ENV_LOCK.lock().await;
        // Each attempt's app-server first starts a helper process (carrying
        // the attempt's ownership tag), which outlives an app-server that
        // exits.
        configure_fake_codex_cmd(r#"{"spawnNativeChild": true}"#);
        let store = TrackingStore::install();
        let records = ListenRecords::new();
        let state = records.state();
        let (holder, taken) = port_held_by_a_socket_that_never_listens();
        state.force_sidecar_listen_ports_for_tests([taken]);
        let (captured, _capture) = capture::install();
        let mut bus = state.broadcast_tx.subscribe();

        state
            .handle_create(
                freshell_protocol::FreshAgentCreate {
                    naming_handle: None,
                    observed_epoch: None,
                    observed_generation: None,
                    request_id: "req-lost-port".to_string(),
                    session_type: freshell_protocol::SessionType::Freshcodex,
                    provider: Some(freshell_protocol::AgentProvider::Codex),
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
                },
                None,
            )
            .await;
        let frame: Value = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                let frame: Value =
                    serde_json::from_str(&bus.recv().await.expect("the bus")).expect("json");
                if frame["type"] == "freshAgent.created"
                    || frame["type"] == "freshAgent.create.failed"
                {
                    return frame;
                }
            }
        })
        .await
        .expect("the create answers");
        assert_eq!(frame["type"], "freshAgent.created", "{frame}");

        let listened = records.by_pid();
        let lost: Vec<_> = listened
            .values()
            .filter(|record| record["listenError"] == "EADDRINUSE")
            .collect();
        assert_eq!(lost.len(), 1, "one attempt lost its port: {listened:?}");
        assert_eq!(lost[0]["port"], taken, "on the port the other socket holds");
        let served: Vec<_> = listened
            .values()
            .filter(|record| record["listening"] == true)
            .collect();
        assert_eq!(served.len(), 1, "one attempt listened: {listened:?}");
        let served_port = served[0]["port"].as_u64().unwrap() as u16;
        assert_ne!(served_port, taken, "the retry listens on a new port");

        let retries = events_named(&captured, PORT_LOST);
        assert_eq!(retries.len(), 1, "one retry: {retries:?}");
        let retry = &retries[0];
        assert_eq!(retry.level, Level::WARN);
        assert_eq!(retry.fields["attempt"], "1");
        assert_eq!(retry.fields["port"], taken.to_string());
        assert_eq!(retry.fields["pid"], lost[0]["pid"].to_string());
        assert!(
            retry.fields["reason"].contains("exited before listening")
                && retry.fields["reason"].contains(&format!("port {taken}")),
            "{retry:?}"
        );
        assert!(events_named(&captured, START_FAILED).is_empty());

        let lost_pid = lost[0]["pid"].as_u64().unwrap() as i32;
        assert!(
            proc_starttime(lost_pid).is_none(),
            "the lost attempt's app-server is gone"
        );
        let lost_tag = &retry.fields["ownership_id"];
        assert!(
            nothing_carries(lost_tag).await,
            "nothing the lost attempt started is left: {:?}",
            processes_carrying(lost_tag)
        );
        let tracked = store.ownership_ids();
        assert!(
            !tracked.contains(lost_tag),
            "the lost attempt's record is removed: {tracked:?}"
        );
        let retry_tag = tracked
            .iter()
            .find(|id| store.ws_url_of(id).map(|url| port_of(&url)) == Some(served_port))
            .unwrap_or_else(|| panic!("the retry is tracked: {tracked:?}"))
            .clone();

        state.shutdown().await;
        assert!(
            nothing_carries(&retry_tag).await,
            "the shutdown leaves nothing of the retry: {:?}",
            processes_carrying(&retry_tag)
        );
        drop(holder);
    }

    /// The first chosen port is taken by a listener that ANSWERS the
    /// readiness probe (another app-server, outside the attempt's process
    /// tree). It is detected as a lost port and the start retries on a new
    /// port: the other listener is never taken for this sidecar, and never
    /// signalled.
    #[tokio::test]
    async fn a_listener_that_answers_on_the_chosen_port_is_never_taken_for_the_sidecar() {
        let _env = ENV_LOCK.lock().await;
        configure_fake_codex_cmd("{}");
        let store = TrackingStore::install();
        let records = ListenRecords::new();
        let state = records.state();
        let mut other = AnsweringListener::start().await;
        state.force_sidecar_listen_ports_for_tests([other.port]);
        let (captured, _capture) = capture::install();
        let spawned = Spawned::default();
        let hook = spawned.hook();

        let (client, _notifications, ownership_id, child) = state
            .spawn_sidecar_notifying(None, Some(&hook))
            .await
            .expect("the start succeeds on a new port");

        let attempts = spawned.all();
        assert_eq!(attempts.len(), 2, "one more attempt: {attempts:?}");
        assert!(
            gone(attempts[0]),
            "the attempt whose port was taken is stopped before the retry"
        );
        assert_eq!(child.id(), Some(attempts[1].0), "the retry's app-server");
        let served = &records.by_pid()[&attempts[1].0];
        assert_eq!(served["listening"], true);
        let served_port = served["port"].as_u64().unwrap() as u16;
        assert_ne!(served_port, other.port);
        assert_eq!(
            store.ws_url_of(&ownership_id).map(|url| port_of(&url)),
            Some(served_port)
        );

        let retries = events_named(&captured, PORT_LOST);
        assert_eq!(retries.len(), 1, "{retries:?}");
        assert_eq!(retries[0].level, Level::WARN);
        assert_eq!(retries[0].fields["attempt"], "1");
        assert_eq!(retries[0].fields["port"], other.port.to_string());
        assert_eq!(retries[0].fields["pid"], attempts[0].0.to_string());
        assert!(
            retries[0].fields["reason"].contains("not this sidecar's"),
            "{:?}",
            retries[0]
        );
        assert!(
            !store
                .ownership_ids()
                .contains(&retries[0].fields["ownership_id"]),
            "the first attempt's record is removed"
        );

        // The client talks to this start's own app-server: a thread started
        // through it never reaches the other listener.
        client
            .start_thread(StartThreadParams::default())
            .await
            .expect("a thread starts on the sidecar");
        assert_eq!(other.thread_operations(), Vec::<Value>::new());
        assert!(
            matches!(other.child.try_wait(), Ok(None)),
            "the other listener was never signalled"
        );

        stop_sidecar(client, child).await;
        other.stop().await;
    }

    /// An app-server that exits before listening while its port is free
    /// failed for another reason: the start fails at once with the same
    /// error as before, and is never retried. (The port is one the kernel
    /// never gives out, so no other socket can take it during the test.)
    #[tokio::test]
    async fn a_start_that_fails_for_another_reason_is_never_retried() {
        let _env = ENV_LOCK.lock().await;
        // One argv token for the script: `CODEX_CMD` is whitespace-split.
        std::env::set_var("CODEX_CMD", "node -e process.exit(3) --");
        let _store = TrackingStore::install();
        let records = ListenRecords::new();
        let state = records.state();
        let reserved = ReservedPort::new();
        state.force_sidecar_listen_ports_for_tests([reserved.port()]);
        let (captured, _capture) = capture::install();
        let spawned = Spawned::default();
        let hook = spawned.hook();

        let Err(error) = state.spawn_sidecar_notifying(None, Some(&hook)).await else {
            panic!("the start fails");
        };

        assert_eq!(
            error,
            "codex app-server exited before listening: exit status: 3"
        );
        assert_eq!(spawned.all().len(), 1, "never retried");
        assert!(events_named(&captured, PORT_LOST).is_empty());
        assert!(events_named(&captured, START_FAILED).is_empty());
    }

    /// Every attempt loses its port: the start gives up after the planner's
    /// attempt budget with a clear failure, every attempt stopped.
    #[tokio::test]
    async fn a_port_lost_on_every_attempt_fails_after_the_planners_budget() {
        let _env = ENV_LOCK.lock().await;
        configure_fake_codex_cmd("{}");
        let store = TrackingStore::install();
        let records = ListenRecords::new();
        let state = records.state();
        let (holders, taken): (Vec<_>, Vec<u16>) = (0..CODEX_INITIAL_LAUNCH_ATTEMPTS)
            .map(|_| port_held_by_a_socket_that_never_listens())
            .unzip();
        state.force_sidecar_listen_ports_for_tests(taken.clone());
        let (captured, _capture) = capture::install();
        let spawned = Spawned::default();
        let hook = spawned.hook();

        let Err(error) = state.spawn_sidecar_notifying(None, Some(&hook)).await else {
            panic!("the start fails");
        };

        let attempts = spawned.all();
        assert_eq!(attempts.len() as u32, CODEX_INITIAL_LAUNCH_ATTEMPTS);
        assert!(
            attempts.iter().all(|attempt| gone(*attempt)),
            "every attempt stopped"
        );
        let lost: BTreeMap<u32, u16> = records
            .by_pid()
            .into_iter()
            .map(|(pid, record)| {
                assert_eq!(record["listenError"], "EADDRINUSE", "{record}");
                (pid, record["port"].as_u64().unwrap() as u16)
            })
            .collect();
        let lost_ports: Vec<u16> = attempts.iter().map(|(pid, _)| lost[pid]).collect();
        assert_eq!(lost_ports, taken, "each attempt on its own port, in order");
        assert!(
            error.contains("exited before listening")
                && error.contains(&format!(
                    "lost its listen port on all {CODEX_INITIAL_LAUNCH_ATTEMPTS} attempts"
                )),
            "{error}"
        );

        let retries = events_named(&captured, PORT_LOST);
        assert_eq!(
            retries.len() as u32,
            CODEX_INITIAL_LAUNCH_ATTEMPTS - 1,
            "{retries:?}"
        );
        for (index, retry) in retries.iter().enumerate() {
            assert_eq!(retry.level, Level::WARN);
            assert_eq!(retry.fields["attempt"], (index + 1).to_string());
            assert_eq!(retry.fields["port"], taken[index].to_string());
        }
        let failed = events_named(&captured, START_FAILED);
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert_eq!(failed[0].level, Level::ERROR);
        assert_eq!(
            failed[0].fields["attempt"],
            CODEX_INITIAL_LAUNCH_ATTEMPTS.to_string()
        );
        assert_eq!(failed[0].fields["port"], taken.last().unwrap().to_string());
        let tracked = store.ownership_ids();
        assert!(
            retries
                .iter()
                .chain(&failed)
                .all(|event| !tracked.contains(&event.fields["ownership_id"])),
            "no attempt is tracked: {tracked:?}"
        );
        drop(holders);
    }
}
