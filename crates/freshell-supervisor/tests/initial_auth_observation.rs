#![cfg(unix)]

use freshell_runtime_protocol::{
    AdminCommand, AdminResult, ControlRole, DockerDaemonId, Envelope, RequestId,
    ReserveProviderInputsRequest, RuntimeErrorCode, SoulId,
};
use freshell_supervisor::{
    admission::AdmissionPolicy,
    backend::DockerEngineBackend,
    registry::Registry,
    service::{Supervisor, SupervisorConfig},
};
use serde_json::json;
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixListener,
    sync::Notify,
};

struct Daemon {
    requests: Arc<Mutex<Vec<&'static str>>>,
    held: Arc<Notify>,
    dropped: Arc<Notify>,
    release: Arc<Notify>,
    late_reply: Arc<Notify>,
    hold: Arc<AtomicBool>,
    server: tokio::task::JoinHandle<()>,
}

impl Daemon {
    fn start(path: &Path, hold: bool) -> Self {
        let listener = UnixListener::bind(path).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let held = Arc::new(Notify::new());
        let dropped = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let late_reply = Arc::new(Notify::new());
        let hold = Arc::new(AtomicBool::new(hold));
        let server = {
            let requests = requests.clone();
            let held = held.clone();
            let dropped = dropped.clone();
            let release = release.clone();
            let late_reply = late_reply.clone();
            let hold = hold.clone();
            tokio::spawn(async move {
                let daemon = DockerDaemonId::new();
                loop {
                    let (mut stream, _) = listener.accept().await.unwrap();
                    let mut header = Vec::new();
                    let mut byte = [0];
                    while !header.ends_with(b"\r\n\r\n") {
                        assert!(header.len() < 8192);
                        stream.read_exact(&mut byte).await.unwrap();
                        header.push(byte[0]);
                    }
                    let header = String::from_utf8(header).unwrap();
                    let request = header.lines().next().unwrap();
                    assert!(
                        request.starts_with("GET "),
                        "observation may not mutate Docker"
                    );
                    let (status, body) = if request == "GET /v1.47/info HTTP/1.1" {
                        requests.lock().unwrap().push("info");
                        (
                            200,
                            json!({"ID":daemon,"SecurityOptions":["name=rootless"]}),
                        )
                    } else {
                        assert!(request.starts_with("GET /v1.47/volumes/freshell-provider-"));
                        requests.lock().unwrap().push("volume");
                        if hold.swap(false, Ordering::SeqCst) {
                            held.notify_one();
                            let count = stream.read(&mut byte).await.unwrap();
                            assert_eq!(
                                count, 0,
                                "deadline/cancellation must drop the backend socket"
                            );
                            dropped.notify_one();
                            release.notified().await;
                            let _ = stream.write_all(b"HTTP/1.1 404 fixture\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}").await;
                            let _ = stream.shutdown().await;
                            late_reply.notify_one();
                            continue;
                        }
                        (404, json!({}))
                    };
                    let body = body.to_string();
                    stream.write_all(format!("HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
                    stream.shutdown().await.unwrap();
                }
            })
        };
        Self {
            requests,
            held,
            dropped,
            release,
            late_reply,
            hold,
            server,
        }
    }

    async fn release_after_drop(&self) {
        tokio::time::timeout(Duration::from_secs(2), self.dropped.notified())
            .await
            .unwrap();
        self.release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), self.late_reply.notified())
            .await
            .unwrap();
    }

    async fn join(self) {
        assert!(!self.hold.load(Ordering::SeqCst));
        self.server.abort();
        assert!(self.server.await.unwrap_err().is_cancelled());
    }
}

fn open(root: &Path) -> Arc<Supervisor> {
    let binary = root.join("synthetic-host");
    std::fs::write(&binary, b"synthetic host artifact").unwrap();
    Arc::new(
        Supervisor::new(
            Registry::open(root.join("registry"), None).unwrap(),
            Arc::new(DockerEngineBackend::new(root.join("docker.sock"))),
            SupervisorConfig {
                runtime_root: root.join("runtime"),
                control_socket_path: root.join("control.sock"),
                host_binary_path: binary,
                image_ref: format!("sha256:{}", "a".repeat(64)),
                test_run_id: "initial-auth-observation-contract".into(),
                control_secret: "synthetic-control-secret".into(),
                lifecycle_log: root.join("lifecycle.jsonl"),
                admission: AdmissionPolicy::default(),
            },
        )
        .unwrap(),
    )
}

fn request(supervisor: &Supervisor, soul: &SoulId, seed: &str) -> Envelope<AdminCommand> {
    let mut envelope = Envelope::new(
        RequestId::new(),
        ControlRole::Web,
        AdminCommand::ReserveProviderInputs(ReserveProviderInputsRequest {
            expected_control_epoch: Some(supervisor.registry().control_epoch()),
            soul_id: soul.clone(),
            provider: "amplifier".into(),
            creation_seed_ref: seed.into(),
        }),
    );
    envelope.auth = Some("synthetic-control-secret".into());
    envelope
}

fn state(root: &Path) -> (String, Option<String>, u8) {
    rusqlite::Connection::open(root.join("registry/runtime.sqlite3"))
        .unwrap()
        .query_row(
            "SELECT reservation_id,observation,consumed FROM provider_input_preparations",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap()
}

async fn complete_same_reservation(
    supervisor: &Supervisor,
    daemon: &Daemon,
    soul: &SoulId,
    expected: Option<&str>,
    root: &Path,
) {
    let result = supervisor
        .dispatch(request(supervisor, soul, "seed"))
        .await
        .result
        .unwrap();
    let AdminResult::ProviderInputReservation(receipt) = result else {
        panic!("unexpected reservation reply")
    };
    if let Some(expected) = expected {
        assert_eq!(receipt.reservation_id, expected);
    }
    let (_, observation, consumed) = state(root);
    assert!(observation.is_some());
    assert_eq!(consumed, 0);
    assert!(
        supervisor.registry().inventory().await.unwrap().is_empty(),
        "observation must not launch a runtime"
    );
    let before = daemon.requests.lock().unwrap().len();
    assert_eq!(
        supervisor
            .dispatch(request(supervisor, soul, "different-seed"))
            .await
            .result
            .unwrap_err()
            .code,
        RuntimeErrorCode::RequestIdConflict
    );
    assert_eq!(
        daemon.requests.lock().unwrap().len(),
        before,
        "changed creation authority must fail before backend observation"
    );
}

#[tokio::test]
async fn initial_auth_observation_completes_real_io_before_recording_reserved_absence() {
    let root = tempfile::tempdir().unwrap();
    let daemon = Daemon::start(&root.path().join("docker.sock"), false);
    let supervisor = open(root.path());
    complete_same_reservation(&supervisor, &daemon, &SoulId::new(), None, root.path()).await;
    assert_eq!(*daemon.requests.lock().unwrap(), ["info", "volume", "info"]);
    daemon.join().await;
}

#[tokio::test]
async fn initial_auth_observation_original_deadline_drops_socket_and_rejects_late_commit() {
    let root = tempfile::tempdir().unwrap();
    let daemon = Daemon::start(&root.path().join("docker.sock"), true);
    let supervisor = open(root.path());
    let soul = SoulId::new();
    let started = Instant::now();
    let response = tokio::time::timeout(
        Duration::from_secs(12),
        supervisor.dispatch(request(&supervisor, &soul, "seed")),
    )
    .await
    .unwrap();
    let error = response.result.unwrap_err();
    assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
    assert_eq!(error.message, "initial auth source observation timed out");
    assert!(started.elapsed() >= Duration::from_secs(10));
    let prior = state(root.path());
    assert!(prior.1.is_none());
    assert_eq!(prior.2, 0);
    assert_eq!(*daemon.requests.lock().unwrap(), ["info", "volume"]);
    daemon.release_after_drop().await;
    assert_eq!(
        state(root.path()),
        prior,
        "late bytes must not publish or consume a source observation"
    );
    complete_same_reservation(&supervisor, &daemon, &soul, Some(&prior.0), root.path()).await;
    println!(
        "{}",
        json!({"severity":"info","event":"initial_auth_observation.deadline_verified","elapsedMs":started.elapsed().as_millis()})
    );
    daemon.join().await;
}

#[tokio::test]
async fn initial_auth_observation_cancellation_releases_ownership_without_late_commit() {
    let root = tempfile::tempdir().unwrap();
    let daemon = Daemon::start(&root.path().join("docker.sock"), true);
    let supervisor = open(root.path());
    let soul = SoulId::new();
    let envelope = request(&supervisor, &soul, "seed");
    let operation = {
        let supervisor = supervisor.clone();
        tokio::spawn(async move { supervisor.dispatch(envelope).await })
    };
    tokio::time::timeout(Duration::from_secs(2), daemon.held.notified())
        .await
        .unwrap();
    let prior = state(root.path());
    operation.abort();
    assert!(operation.await.unwrap_err().is_cancelled());
    daemon.release_after_drop().await;
    assert_eq!(state(root.path()), prior);
    assert!(prior.1.is_none());
    assert_eq!(prior.2, 0);
    complete_same_reservation(&supervisor, &daemon, &soul, Some(&prior.0), root.path()).await;
    daemon.join().await;
}
