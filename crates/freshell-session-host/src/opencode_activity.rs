//! Host-owned native activity transport. The provider HTTP/SSE endpoint stays
//! on private container loopback; only typed body-free observations are retained.
use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use freshell_activity::opencode::{
    OpencodeActivityBatch, OpencodeActivityEvent, OpencodeLaneEvent, OpencodeStatus,
};
use freshell_opencode::activity_lane::{
    spawn_opencode_lane_with_readiness, OpencodeLaneDeps, ReqwestLaneHttp, ReqwestLaneStream,
};
use freshell_runtime_protocol::{RuntimeDiagnosticCode, RuntimeError, RuntimeErrorCode};
use tokio::sync::Notify;

const MAX_EVENTS: usize = 256;
const MAX_BYTES: usize = 64 * 1024;
// Reserve space for batch bounds, brackets and up to MAX_EVENTS separators.
const MAX_EVENT_BYTES: usize = MAX_BYTES - 1024;
const VERIFY_INTERVAL: Duration = Duration::from_secs(30);
const INPUT_READY_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy, PartialEq, Eq)]
enum NativeReadiness {
    Connecting,
    Ready,
    Disconnected,
    Exited,
}

#[derive(Clone)]
pub(crate) struct OpencodeInputReadiness(tokio::sync::watch::Receiver<NativeReadiness>);

impl OpencodeInputReadiness {
    pub(crate) fn ensure_ready(&self) -> Result<(), RuntimeError> {
        if *self.0.borrow() == NativeReadiness::Ready {
            Ok(())
        } else {
            Err(disconnected_error())
        }
    }

    pub(crate) async fn wait(self) -> Result<(), RuntimeError> {
        self.wait_with_timeout(INPUT_READY_TIMEOUT).await
    }

    async fn wait_with_timeout(mut self, timeout: Duration) -> Result<(), RuntimeError> {
        let ready = async {
            loop {
                match *self.0.borrow_and_update() {
                    NativeReadiness::Ready => return Ok(()),
                    NativeReadiness::Connecting => {}
                    NativeReadiness::Disconnected | NativeReadiness::Exited => {
                        return Err(disconnected_error())
                    }
                }
                self.0.changed().await.map_err(|_| disconnected_error())?;
            }
        };
        tokio::time::timeout(timeout, ready).await.unwrap_or_else(|_| Err(RuntimeError::new(
            RuntimeErrorCode::RecoveryBlocked, "native OpenCode activity subscription did not become ready before input deadline",
        ).with_diagnostic_code(RuntimeDiagnosticCode::OpencodeActivityReadyTimeout)))
    }
}

fn disconnected_error() -> RuntimeError {
    RuntimeError::new(
        RuntimeErrorCode::RecoveryBlocked,
        "native OpenCode activity subscription is disconnected",
    )
    .with_diagnostic_code(RuntimeDiagnosticCode::OpencodeActivityDisconnected)
}

#[derive(Default)]
struct NativeJournal {
    events: VecDeque<(OpencodeActivityEvent, usize)>,
    bytes: usize,
    head_seq: u64,
    busy_sessions: HashSet<String>,
    diagnostics_dir: Option<PathBuf>,
}

impl NativeJournal {
    fn with_diagnostics(state_dir: PathBuf) -> Self {
        Self {
            diagnostics_dir: Some(state_dir),
            ..Self::default()
        }
    }

    fn append(&mut self, terminal_id: &str, cycle: u64, stream: u64, event: OpencodeLaneEvent) {
        // Provider error messages, generated titles and arbitrary event bodies
        // cannot enter the metadata journal. Only the abort category matters to
        // the tracker; all other provider errors have identical failure policy.
        let event = match event {
            OpencodeLaneEvent::SessionError {
                session_id,
                error_name,
            } => OpencodeLaneEvent::SessionError {
                session_id,
                error_name: if error_name == "MessageAbortedError" {
                    "MessageAbortedError"
                } else {
                    "ProviderError"
                }
                .into(),
            },
            OpencodeLaneEvent::SnapshotFailed { .. } => OpencodeLaneEvent::SnapshotFailed {
                error: "native_status_probe_failed".into(),
            },
            event => event,
        };
        match &event {
            OpencodeLaneEvent::Status { session_id, status } => {
                if *status == OpencodeStatus::Idle {
                    self.busy_sessions.remove(session_id);
                } else {
                    self.busy_sessions.insert(session_id.clone());
                }
            }
            OpencodeLaneEvent::SessionIdle { session_id } => {
                self.busy_sessions.remove(session_id);
            }
            OpencodeLaneEvent::Snapshot { statuses } => {
                self.busy_sessions = statuses
                    .iter()
                    .filter(|(_, status)| *status != OpencodeStatus::Idle)
                    .map(|(id, _)| id.clone())
                    .collect();
            }
            OpencodeLaneEvent::SnapshotFailed { .. } => self.busy_sessions.clear(),
            _ => {}
        }
        self.head_seq += 1;
        let observed_at = crate::now_millis();
        let mut record = OpencodeActivityEvent {
            seq: self.head_seq,
            at: self
                .events
                .back()
                .map_or(observed_at, |(last, _)| observed_at.max(last.at)),
            cycle,
            stream,
            event,
        };
        let mut bytes = serde_json::to_vec(&record)
            .expect("typed native activity serializes")
            .len();
        if bytes > MAX_EVENT_BYTES {
            self.busy_sessions.clear();
            record.event = OpencodeLaneEvent::SnapshotFailed {
                error: "native_activity_record_too_large".into(),
            };
            bytes = serde_json::to_vec(&record)
                .expect("typed native activity serializes")
                .len();
            if let Some(state_dir) = &self.diagnostics_dir {
                log_diagnostic(
                    state_dir,
                    "managed_opencode.activity_record_refused",
                    serde_json::json!({
                        "terminalId": terminal_id,
                        "reason": "record_too_large"
                    }),
                );
            }
        }
        self.bytes += bytes;
        self.events.push_back((record, bytes));
        let mut evicted = false;
        while self.events.len() > MAX_EVENTS || self.bytes > MAX_EVENT_BYTES {
            let (_, bytes) = self
                .events
                .pop_front()
                .expect("bounded journal is nonempty");
            self.bytes -= bytes;
            evicted = true;
        }
        if evicted && self.head_seq % MAX_EVENTS as u64 == 1 {
            if let Some(state_dir) = &self.diagnostics_dir {
                log_diagnostic(
                    state_dir,
                    "managed_opencode.activity_retention_advanced",
                    serde_json::json!({
                        "terminalId": terminal_id,
                        "headSeq": self.head_seq,
                        "retainedFromSeq": self.batch().retained_from_seq
                    }),
                );
            }
        }
    }

    fn batch(&self) -> OpencodeActivityBatch {
        OpencodeActivityBatch {
            retained_from_seq: self
                .events
                .front()
                .map(|(record, _)| record.seq)
                .unwrap_or(self.head_seq + 1),
            head_seq: self.head_seq,
            events: self
                .events
                .iter()
                .map(|(record, _)| record.clone())
                .collect(),
        }
    }
}

pub(crate) fn log_diagnostic(state_dir: &Path, event: &'static str, data: serde_json::Value) {
    if let Err(error) = crate::append_event(state_dir, event, data) {
        eprintln!(
            "{}",
            serde_json::json!({
                "severity": "error",
                "event": "session_host.diagnostic_write_failed",
                "diagnosticEvent": event,
                "error": error
            })
        );
    }
}

struct AbortTask(tokio::task::JoinHandle<()>);
impl Drop for AbortTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

pub(crate) struct OpencodeActivityRelay {
    journal: Arc<Mutex<NativeJournal>>,
    readiness: OpencodeInputReadiness,
    _task: AbortTask,
}

impl OpencodeActivityRelay {
    pub(crate) fn spawn(
        terminal_id: String,
        state_dir: PathBuf,
        base_url: String,
        exited: Arc<AtomicBool>,
        exit_notify: Arc<Notify>,
    ) -> Self {
        let deps = Arc::new(OpencodeLaneDeps {
            http: Arc::new(ReqwestLaneHttp::new()),
            events: Arc::new(ReqwestLaneStream::new()),
            native_title_observer: None,
        });
        Self::spawn_with_deps(
            terminal_id,
            state_dir,
            base_url,
            exited,
            exit_notify,
            deps,
            VERIFY_INTERVAL,
        )
    }

    fn spawn_with_deps(
        terminal_id: String,
        state_dir: PathBuf,
        base_url: String,
        exited: Arc<AtomicBool>,
        exit_notify: Arc<Notify>,
        deps: Arc<OpencodeLaneDeps>,
        verify_interval: Duration,
    ) -> Self {
        let journal = Arc::new(Mutex::new(NativeJournal::with_diagnostics(
            state_dir.clone(),
        )));
        let shared = journal.clone();
        let changed = Arc::new(Notify::new());
        let changed_sink = changed.clone();
        let observed_terminal = terminal_id.clone();
        let (ready_tx, ready_rx) = tokio::sync::watch::channel(NativeReadiness::Connecting);
        let observed_ready = ready_tx.clone();
        let ever_ready = Arc::new(AtomicBool::new(false));
        let (lane, verify) = spawn_opencode_lane_with_readiness(
            deps,
            Arc::new(move |cycle, stream, event| {
                shared.lock().expect("native activity journal lock").append(
                    &observed_terminal,
                    cycle,
                    stream,
                    event,
                );
                changed_sink.notify_one();
            }),
            terminal_id.clone(),
            base_url,
            Some(Arc::new(move |ready| {
                if *observed_ready.borrow() == NativeReadiness::Exited {
                    return;
                }
                let state = if ready {
                    ever_ready.store(true, Ordering::SeqCst);
                    NativeReadiness::Ready
                } else if ever_ready.load(Ordering::SeqCst) {
                    NativeReadiness::Disconnected
                } else {
                    NativeReadiness::Connecting
                };
                observed_ready.send_replace(state);
            })),
        );
        let lane = AbortTask(lane);
        let shared = journal.clone();
        let diagnostic_terminal_id = terminal_id.clone();
        let task = tokio::spawn(async move {
            let _lane = lane;
            log_diagnostic(
                &state_dir,
                "managed_opencode.activity_lane_started",
                serde_json::json!({"terminalId": diagnostic_terminal_id.clone()}),
            );
            while !exited.load(Ordering::SeqCst) {
                let busy = !shared
                    .lock()
                    .expect("native activity journal lock")
                    .busy_sessions
                    .is_empty();
                tokio::select! {
                    _ = exit_notify.notified() => break,
                    _ = changed.notified() => {},
                    _ = tokio::time::sleep(verify_interval), if busy => {
                        if verify.send(()).is_err() { break; }
                    }
                }
            }
            ready_tx.send_replace(NativeReadiness::Exited);
            log_diagnostic(
                &state_dir,
                "managed_opencode.activity_lane_stopped",
                serde_json::json!({"terminalId": diagnostic_terminal_id}),
            );
        });
        Self {
            journal,
            readiness: OpencodeInputReadiness(ready_rx),
            _task: AbortTask(task),
        }
    }

    pub(crate) fn read(&self) -> OpencodeActivityBatch {
        self.journal
            .lock()
            .expect("native activity journal lock")
            .batch()
    }

    pub(crate) fn input_readiness(&self) -> OpencodeInputReadiness {
        self.readiness.clone()
    }
}

/// Read only the native loopback endpoint already carried in the CLI argv.
/// No provider endpoint is forwarded to the web server or published on a host port.
pub(crate) fn endpoint(args: &[String]) -> Option<String> {
    let hostname = args
        .windows(2)
        .find(|pair| pair[0] == "--hostname")?
        .get(1)?;
    let port = args
        .windows(2)
        .find(|pair| pair[0] == "--port")?
        .get(1)?
        .parse::<u16>()
        .ok()?;
    if hostname != "127.0.0.1" || port == 0 {
        return None;
    }
    Some(format!("http://127.0.0.1:{port}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn native_input_wait_is_bounded_and_timeout_does_not_claim_readiness() {
        let (_source, state) = tokio::sync::watch::channel(NativeReadiness::Connecting);
        let readiness = OpencodeInputReadiness(state);
        let error = readiness
            .clone()
            .wait_with_timeout(Duration::from_millis(10))
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RecoveryBlocked);
        assert_eq!(
            error.diagnostic_code,
            Some(RuntimeDiagnosticCode::OpencodeActivityReadyTimeout)
        );
        assert!(readiness.ensure_ready().is_err());
    }

    #[tokio::test]
    async fn native_input_subscription_loss_and_provider_exit_fail_closed() {
        for state in [NativeReadiness::Disconnected, NativeReadiness::Exited] {
            let (source, receiver) = tokio::sync::watch::channel(NativeReadiness::Connecting);
            let readiness = OpencodeInputReadiness(receiver);
            let waiter = tokio::spawn(readiness.clone().wait());
            source.send_replace(state);
            let error = waiter.await.unwrap().unwrap_err();
            assert_eq!(
                error.diagnostic_code,
                Some(RuntimeDiagnosticCode::OpencodeActivityDisconnected)
            );
            assert!(readiness.ensure_ready().is_err());
        }
    }

    #[test]
    fn journal_reads_preserve_the_original_observation_time() {
        let mut journal = NativeJournal::default();
        let before = crate::now_millis();
        journal.append(
            "owned",
            1,
            1,
            OpencodeLaneEvent::SessionIdle {
                session_id: "ses_native".into(),
            },
        );
        let recorded = journal.batch().events[0].at;
        assert!(recorded >= before && recorded <= crate::now_millis());
        assert_eq!(journal.batch().events[0].at, recorded);
        let wire = serde_json::to_vec(&journal.batch()).unwrap();
        let replay: OpencodeActivityBatch = serde_json::from_slice(&wire).unwrap();
        assert_eq!(replay.events[0].at, recorded);
    }

    #[test]
    fn metadata_retention_is_bounded_ordered_and_reports_the_exact_lost_prefix() {
        let mut journal = NativeJournal::default();
        journal.batch().validate().unwrap();
        for _ in 0..MAX_EVENTS + 5 {
            journal.append(
                "owned",
                1,
                1,
                OpencodeLaneEvent::SessionIdle {
                    session_id: "ses_native".into(),
                },
            );
        }
        let retained = journal.batch();
        retained.validate().unwrap();
        assert_eq!(retained.head_seq, MAX_EVENTS as u64 + 5);
        assert_eq!(retained.retained_from_seq, 6);
        assert_eq!(retained.events.len(), MAX_EVENTS);
        assert!(serde_json::to_vec(&retained).unwrap().len() <= MAX_BYTES);
    }

    #[test]
    fn error_journal_retains_only_abort_or_failure_classifications() {
        let mut journal = NativeJournal::default();
        for error_name in ["MessageAbortedError", "synthetic-provider-error-body"] {
            journal.append(
                "owned",
                1,
                1,
                OpencodeLaneEvent::SessionError {
                    session_id: "ses_native".into(),
                    error_name: error_name.into(),
                },
            );
        }
        journal.append(
            "owned",
            1,
            1,
            OpencodeLaneEvent::SnapshotFailed {
                error: "synthetic-http-error-body".into(),
            },
        );
        let batch = journal.batch();
        let encoded = serde_json::to_string(&batch).unwrap();
        assert!(encoded.contains("MessageAbortedError"));
        assert!(encoded.contains("ProviderError"));
        assert!(!encoded.contains("synthetic-"));
    }

    #[test]
    fn metadata_byte_limit_never_serializes_an_unbounded_snapshot() {
        let mut journal = NativeJournal::default();
        journal.append(
            "owned",
            1,
            1,
            OpencodeLaneEvent::Snapshot {
                statuses: (0..4000)
                    .map(|index| (format!("ses_{index:064}"), OpencodeStatus::Busy))
                    .collect(),
            },
        );
        assert!(serde_json::to_vec(&journal.batch()).unwrap().len() <= MAX_BYTES);
        assert!(matches!(
            journal.batch().events[0].event,
            OpencodeLaneEvent::SnapshotFailed { .. }
        ));
    }

    #[test]
    fn refused_and_evicted_activity_records_leave_safe_jsonl_diagnostics() {
        let owned = tempfile::tempdir().unwrap();
        let state_dir = owned.path().join("host-state");
        let mut journal = NativeJournal::with_diagnostics(state_dir.clone());
        let private_session_id =
            format!("private-provider-session-{}", "x".repeat(MAX_EVENT_BYTES));
        journal.append(
            "terminal-safe",
            1,
            1,
            OpencodeLaneEvent::Status {
                session_id: private_session_id.clone(),
                status: OpencodeStatus::Busy,
            },
        );
        for index in 0..MAX_EVENTS {
            journal.append(
                "terminal-safe",
                1,
                1,
                OpencodeLaneEvent::SessionIdle {
                    session_id: format!("session-{index}"),
                },
            );
        }

        let lifecycle = std::fs::read_to_string(state_dir.join("host-lifecycle.jsonl")).unwrap();
        let events: Vec<serde_json::Value> = lifecycle
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert!(events.iter().any(|record| {
            record["event"] == "managed_opencode.activity_record_refused"
                && record["data"]["reason"] == "record_too_large"
                && record["data"]["terminalId"] == "terminal-safe"
        }));
        assert!(events.iter().any(|record| {
            record["event"] == "managed_opencode.activity_retention_advanced"
                && record["data"]["retainedFromSeq"] == 2
        }));
        assert!(!lifecycle.contains("private-provider-session-"));
    }

    #[test]
    fn only_the_cli_private_loopback_endpoint_is_accepted() {
        let args = |host: &str| {
            vec![
                "--hostname".into(),
                host.into(),
                "--port".into(),
                "4096".into(),
            ]
        };
        assert_eq!(
            endpoint(&args("127.0.0.1")).as_deref(),
            Some("http://127.0.0.1:4096")
        );
        assert!(endpoint(&args("0.0.0.0")).is_none());
        assert!(endpoint(&[]).is_none());
    }
}
