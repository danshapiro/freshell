use super::*;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::{sync::Notify, task::JoinSet};

#[derive(Default)]
struct Observed {
    body: Option<Value>,
    creates: usize,
    starts: usize,
    deletes: usize,
    completed: bool,
    removed: bool,
    selected: Vec<Mountpoint>,
    names: Vec<String>,
}

#[derive(Clone)]
struct DockerPeer {
    observed: Arc<Mutex<Observed>>,
    release: Arc<Notify>,
    create_seen: Arc<AtomicBool>,
    daemon: DockerDaemonId,
    fail_first_create: Arc<AtomicBool>,
    gate_creates: bool,
    gate_exchange: bool,
    exchange_release: Arc<Notify>,
}

impl DockerPeer {
    async fn serve(&self, mut stream: UnixStream) {
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(stream.read_u8().await.unwrap());
            assert!(header.len() <= 32 * 1024);
        }
        let header = String::from_utf8(header).unwrap();
        let length = header
            .lines()
            .find_map(|line| line.strip_prefix("Content-Length: "))
            .unwrap()
            .parse::<usize>()
            .unwrap();
        assert!(length <= 1024 * 1024);
        let mut raw = vec![0; length];
        stream.read_exact(&mut raw).await.unwrap();
        let line = header.lines().next().unwrap();
        if line.contains("/containers/create?")
            && self.fail_first_create.swap(false, Ordering::SeqCst)
        {
            self.record_create(line, &raw);
            return; // A transient lost transport, with no Docker object.
        }
        let (status, value) = self.reply(line, &raw).await;
        let raw = value.to_string();
        let response = format!(
            "HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{raw}",
            raw.len()
        );
        // A cancelled caller may already have closed its side of this socket.
        let _ = stream.write_all(response.as_bytes()).await;
    }

    async fn reply(&self, line: &str, raw: &[u8]) -> (u16, Value) {
        if line.contains("/images/") {
            (200, json!({"Config":{"Env":["PATH=/usr/bin"]}}))
        } else if line.contains("/info ") {
            (
                200,
                json!({"ID":self.daemon,"SecurityOptions":["name=rootless"]}),
            )
        } else if line.contains("/volumes/") {
            (
                200,
                json!({"Name":"owned-volume","Driver":"local","Options":{}}),
            )
        } else if line.contains("/containers/create?") {
            self.record_create(line, raw);
            if self.gate_creates {
                self.release.notified().await;
            }
            self.observed.lock().unwrap().completed = true;
            (201, json!({"Id":"c".repeat(64)}))
        } else if line.starts_with("GET") && line.contains("/containers/") {
            let state = self.observed.lock().unwrap();
            if !state.completed || state.removed {
                (404, json!({}))
            } else {
                let body = state.body.as_ref().unwrap();
                (
                    200,
                    json!({"Id":"c".repeat(64),"Config":body,"HostConfig":body["HostConfig"],"State":{"Running":false}}),
                )
            }
        } else if line.contains("/start ") {
            self.start_private_exchange().await;
            (204, json!({}))
        } else if line.contains("/wait?") {
            (200, json!({"StatusCode":0}))
        } else if line.starts_with("DELETE") {
            let mut state = self.observed.lock().unwrap();
            state.deletes += 1;
            state.removed = true;
            (204, json!({}))
        } else {
            panic!("unexpected fixture request: {line}")
        }
    }

    fn record_create(&self, line: &str, raw: &[u8]) {
        let mut state = self.observed.lock().unwrap();
        state.creates += 1;
        state.names.push(line.to_owned());
        state.body = Some(serde_json::from_slice(raw).unwrap());
        state.removed = false;
        state.completed = false;
        self.create_seen.store(true, Ordering::SeqCst);
    }

    async fn start_private_exchange(&self) {
        let body = {
            let mut state = self.observed.lock().unwrap();
            state.starts += 1;
            state.body.as_ref().unwrap().clone()
        };
        let exchange = body["HostConfig"]["Mounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|mount| mount["Target"] == "/run/freshell-input-exchange")
            .unwrap()["Source"]
            .as_str()
            .unwrap();
        let mut channel = UnixStream::connect(Path::new(exchange).join("reply.sock"))
            .await
            .unwrap();
        let observed = self.observed.clone();
        let gate = self.gate_exchange;
        let release = self.exchange_release.clone();
        tokio::spawn(async move {
            let length = channel.read_u32().await.unwrap() as usize;
            assert!(length <= 1024 * 1024);
            let mut raw = vec![0; length];
            channel.read_exact(&mut raw).await.unwrap();
            observed.lock().unwrap().selected = serde_json::from_slice(&raw).unwrap();
            if gate {
                release.notified().await;
            }
            channel.write_all(b"ok").await.unwrap();
        });
    }
}

// A real Docker HTTP peer and the real private helper exchange. Only CREATE's
// acknowledgement is controlled; the helper never runs without an actual START.
struct Fixture {
    root: tempfile::TempDir,
    backend: DockerEngineBackend,
    daemon: DockerDaemonId,
    observed: Arc<Mutex<Observed>>,
    release: Arc<Notify>,
    create_seen: Arc<AtomicBool>,
    peer: tokio::task::JoinHandle<()>,
    clock: tokio::task::JoinHandle<()>,
}

impl Fixture {
    async fn new() -> Self {
        Self::with_options(false, false).await
    }

    async fn with_options(fail_first_create: bool, gate_exchange: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        let socket = root.path().join("docker.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let daemon = DockerDaemonId::new();
        let observed = Arc::new(Mutex::new(Observed::default()));
        let release = Arc::new(Notify::new());
        let create_seen = Arc::new(AtomicBool::new(false));
        let docker = DockerPeer {
            observed: observed.clone(),
            release: release.clone(),
            create_seen: create_seen.clone(),
            daemon: daemon.clone(),
            fail_first_create: Arc::new(AtomicBool::new(fail_first_create)),
            gate_creates: !fail_first_create,
            gate_exchange,
            exchange_release: Arc::new(Notify::new()),
        };
        let peer = tokio::spawn(async move {
            let mut jobs = JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let docker = docker.clone();
                        jobs.spawn(async move {
                            docker.serve(stream).await;
                        });
                    },
                    result = jobs.join_next(), if !jobs.is_empty() => {
                        result.unwrap().unwrap();
                    }
                }
            }
        });
        // Prevent auto-advance while real Unix IO is outstanding. Tests advance
        // the controlled Docker phase explicitly, retaining a real wall bound.
        tokio::time::pause();
        let clock = tokio::spawn(async {
            loop {
                tokio::task::yield_now().await;
            }
        });
        Self {
            root,
            backend: DockerEngineBackend::new(socket),
            daemon,
            observed,
            release,
            create_seen,
            peer,
            clock,
        }
    }

    async fn until(&self, condition: impl Fn() -> bool) {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !condition() {
            assert!(
                std::time::Instant::now() < deadline,
                "fixture phase did not settle"
            );
            tokio::task::yield_now().await;
        }
    }

    fn binary(&self) -> PathBuf {
        let binary = self.root.path().join("host");
        std::fs::write(&binary, b"synthetic helper artifact").unwrap();
        binary
    }

    fn target<'a>(&'a self, binary: &'a Path) -> MountpointHelperTarget<'a> {
        MountpointHelperTarget {
            image: "synthetic-image",
            volume: "owned-volume",
            binary,
            daemon: &self.daemon,
            labels: json!({"com.freshell.soul-id":"synthetic-owner"}),
        }
    }
    fn normal_launch(&self, binary: PathBuf) -> (CreateRuntimeSpec, docker::TerminalMounts) {
        let installation = InstallationId::new();
        let soul = SoulId::new();
        let incarnation = IncarnationId::new();
        let spec = CreateRuntimeSpec {
            initial_input_reservation: Some(crate::registry::BoundInputReservation {
                reservation: crate::registry::OwnedInputReservation {
                    id: "owned-reservation".into(),
                    provider: "opencode".into(),
                    installation_id: installation.clone(),
                    soul_id: soul.clone(),
                    creation_seed_ref: "owned-seed".into(),
                    provider_volume_name: "owned-volume".into(),
                    image_ref: "synthetic-image".into(),
                    binary: binary.clone(),
                    binary_sha256: crate::registry::binary_digest(&binary).unwrap(),
                    prior_observation: None,
                },
                incarnation_id: incarnation.clone(),
                observation: freshell_runtime_protocol::InitialAuthVolumeObservation::Absent {
                    daemon_id: self.daemon.clone(),
                },
            }),
            prior_provider_owner: None,
            installation_id: installation,
            soul_id: soul,
            incarnation_id: incarnation,
            image_ref: "synthetic-image".into(),
            host_binary_path: binary.clone(),
            runtime_dir: self.root.path().into(),
            limits: RuntimeLimits {
                cpu_milli: 500,
                memory_bytes: 128 * 1024 * 1024,
                swap_bytes: 0,
                pids_max: 32,
            },
            test_run_id: "synthetic-mountpoint-lifecycle".into(),
            terminal: None,
            fresh_agent: None,
            opencode_transfer_dir: None,
            provider_volume_name: "owned-volume".into(),
        };
        let mounts = docker::TerminalMounts {
            workspace: self.root.path().into(),
            git_common_dir: None,
            provider_bootstrap_files: vec![],
            provider_secret_files: vec![],
            indexed_secret_sources: BTreeMap::new(),
            provider_user_root: None,
            mcp_capability_file: None,
            input_manifest: None,
            indexed_files: None,
            config_binds: vec![docker::ResolvedProviderConfigBind {
                source: binary.clone(),
                reference: freshell_runtime_protocol::ProviderConfigBind {
                    source_relative_path: ".freshell/templates/source-0".into(),
                    logical_destination: "/home/freshell/provider/config.json".into(),
                    effective_destination: "/home/freshell/provider/config.json".into(),
                },
            }],
            resource_mounts: vec![],
            operator_home: None,
        };
        (spec, mounts)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.peer.abort();
        self.clock.abort();
        tokio::time::resume();
    }
}

#[tokio::test]
async fn provider_mountpoint_normal_creation_allows_slow_docker_acknowledgement() {
    let fixture = Fixture::new().await;
    let binary = fixture.binary();
    let (spec, mounts) = fixture.normal_launch(binary.clone());
    let backend = fixture.backend.clone();
    let daemon = fixture.daemon.clone();
    let operation = tokio::spawn(async move {
        backend
            .prepare_provider_mountpoints(&spec, &mounts, &binary, &daemon)
            .await
    });
    fixture
        .until(|| fixture.create_seen.load(Ordering::SeqCst))
        .await;
    tokio::time::advance(Duration::from_secs(38)).await;
    fixture.release.notify_one();
    fixture.until(|| operation.is_finished()).await;
    let result = operation.await.unwrap();
    // Settle the fake Docker acknowledgement even on RED before inspecting it.
    fixture
        .until(|| fixture.observed.lock().unwrap().completed)
        .await;
    let observed = fixture.observed.lock().unwrap();
    assert!(
        result.is_ok(),
        "healthy delayed Docker creation must prepare the actual selected mountpoint: {result:?}"
    );
    assert_eq!(observed.starts, 1);
    assert_eq!(observed.deletes, 1);
    assert!(observed.removed);
    assert_eq!(observed.selected.len(), 1);
    assert_eq!(observed.selected[0].relative_path, "config.json");
}

fn helper_exchange(observed: &Observed) -> PathBuf {
    observed.body.as_ref().unwrap()["HostConfig"]["Mounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|mount| mount["Target"] == "/run/freshell-input-exchange")
        .unwrap()["Source"]
        .as_str()
        .unwrap()
        .into()
}

#[tokio::test]
async fn provider_mountpoint_cancellation_reconciles_pending_create_before_absence() {
    let fixture = Fixture::new().await;
    let binary = fixture.binary();
    let mut operation = Box::pin(tokio::time::timeout(
        Duration::from_secs(1),
        fixture.backend.run_launch_mountpoint_helper(
            fixture.target(&binary),
            vec![],
            HelperDeadlines::after(Duration::from_secs(90), Duration::from_secs(5)),
        ),
    ));
    let driver = async {
        fixture
            .until(|| fixture.create_seen.load(Ordering::SeqCst))
            .await;
        tokio::time::advance(Duration::from_millis(1001)).await;
    };
    let (result, ()) = tokio::join!(&mut operation, driver);
    assert!(result.is_err());
    drop(operation);
    let exchange = helper_exchange(&fixture.observed.lock().unwrap());
    let held_until_create_settles = exchange.is_dir();
    let premature_delete = fixture.observed.lock().unwrap().deletes;
    fixture.release.notify_one();
    fixture
        .until(|| fixture.observed.lock().unwrap().completed)
        .await;
    let removed = settle_background_removal(&fixture).await;
    let observed = fixture.observed.lock().unwrap();
    assert!(
        held_until_create_settles,
        "late CREATE must retain its exact exchange mount"
    );
    assert_eq!(
        premature_delete, 0,
        "an interim404 cannot settle pending CREATE"
    );
    assert!(
        removed,
        "dropping the caller must still remove the exact late helper"
    );
    assert_eq!(observed.creates, 1);
    assert_eq!(observed.starts, 0, "a retired late helper must never START");
    assert_eq!(observed.deletes, 1);
    assert!(!exchange.exists());
}

async fn settle_background_removal(fixture: &Fixture) -> bool {
    let exchange = helper_exchange(&fixture.observed.lock().unwrap());
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while (!fixture.observed.lock().unwrap().removed || exchange.exists())
        && std::time::Instant::now() < deadline
    {
        tokio::task::yield_now().await;
    }
    fixture.observed.lock().unwrap().removed && !exchange.exists()
}

#[tokio::test]
async fn provider_mountpoint_hung_create_remains_bounded_and_retires_without_start() {
    let fixture = Fixture::new().await;
    let binary = fixture.binary();
    let backend = fixture.backend.clone();
    let daemon = fixture.daemon.clone();
    let operation = tokio::spawn(async move {
        backend
            .run_launch_mountpoint_helper(
                MountpointHelperTarget {
                    image: "synthetic-image",
                    volume: "owned-volume",
                    binary: &binary,
                    daemon: &daemon,
                    labels: json!({"com.freshell.soul-id":"synthetic-owner"}),
                },
                vec![],
                HelperDeadlines::after(Duration::from_secs(2), Duration::from_secs(1)),
            )
            .await
    });
    fixture
        .until(|| fixture.create_seen.load(Ordering::SeqCst))
        .await;
    let exchange = helper_exchange(&fixture.observed.lock().unwrap());
    tokio::time::advance(Duration::from_millis(2001)).await;
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_millis(1001)).await;
    fixture.until(|| operation.is_finished()).await;
    assert!(
        operation.await.unwrap().is_err(),
        "hung CREATE is finitely bounded"
    );
    let held_until_create_settles = exchange.is_dir();
    fixture.release.notify_one();
    fixture
        .until(|| fixture.observed.lock().unwrap().completed)
        .await;
    let removed = settle_background_removal(&fixture).await;
    let observed = fixture.observed.lock().unwrap();
    assert!(
        held_until_create_settles,
        "the reaper retains the exchange until helper absence"
    );
    assert!(removed);
    assert_eq!(observed.creates, 1);
    assert_eq!(observed.starts, 0);
    assert_eq!(observed.deletes, 1);
    assert!(!exchange.exists());
}

#[tokio::test]
async fn provider_mountpoint_work_keeps_its_own_bound_after_fast_creation() {
    let fixture = Fixture::with_options(false, true).await;
    let binary = fixture.binary();
    let backend = fixture.backend.clone();
    let daemon = fixture.daemon.clone();
    let operation = tokio::spawn(async move {
        backend
            .run_launch_mountpoint_helper(
                MountpointHelperTarget {
                    image: "synthetic-image",
                    volume: "owned-volume",
                    binary: &binary,
                    daemon: &daemon,
                    labels: json!({"com.freshell.soul-id":"synthetic-owner"}),
                },
                vec![Mountpoint {
                    relative_path: "config.json".into(),
                    directory: false,
                }],
                HelperDeadlines::after(Duration::from_secs(90), Duration::from_secs(5)),
            )
            .await
    });
    fixture
        .until(|| fixture.create_seen.load(Ordering::SeqCst))
        .await;
    fixture.release.notify_one();
    fixture
        .until(|| !fixture.observed.lock().unwrap().selected.is_empty())
        .await;
    tokio::time::advance(Duration::from_secs(31)).await;
    for _ in 0..100 {
        tokio::task::yield_now().await;
    }
    let bounded_work = operation.is_finished();
    if !bounded_work {
        tokio::time::advance(Duration::from_secs(65)).await;
    }
    fixture.until(|| operation.is_finished()).await;
    assert!(operation.await.unwrap().is_err());
    let observed = fixture.observed.lock().unwrap();
    assert!(
        bounded_work,
        "hung helper work must not borrow unused CREATE time"
    );
    assert_eq!(observed.starts, 1);
    assert_eq!(observed.deletes, 1);
    assert!(observed.removed);
}

#[tokio::test]
async fn provider_mountpoint_lost_create_transport_with_no_object_can_retry() {
    let fixture = Fixture::with_options(true, false).await;
    let binary = fixture.binary();
    let first = fixture
        .backend
        .run_launch_mountpoint_helper(
            fixture.target(&binary),
            vec![],
            HelperDeadlines::after(Duration::from_secs(90), Duration::from_secs(5)),
        )
        .await;
    assert!(
        first.is_err(),
        "lost CREATE acknowledgement fails only that attempt"
    );
    let retry = fixture
        .backend
        .run_launch_mountpoint_helper(
            fixture.target(&binary),
            vec![],
            HelperDeadlines::after(Duration::from_secs(90), Duration::from_secs(5)),
        )
        .await;
    assert!(
        retry.is_ok(),
        "transient failed transport with no object remains recoverable: {retry:?}"
    );
    let observed = fixture.observed.lock().unwrap();
    assert_eq!(
        observed.creates, 2,
        "confirmed old absence permits one new helper"
    );
    assert_ne!(observed.names[0], observed.names[1]);
    assert_eq!(observed.starts, 1, "cleanup cannot START a retired helper");
    assert_eq!(observed.deletes, 1);
    assert!(observed.removed);
}

#[tokio::test]
async fn provider_mountpoint_empty_selection_retry_does_not_reactivate_old_helper() {
    let fixture = Fixture::new().await;
    let binary = fixture.binary();
    let (spec, mounts) = fixture.normal_launch(binary.clone());
    let (backend, first_spec, first_mounts, first_binary, daemon) = (
        fixture.backend.clone(),
        spec.clone(),
        mounts.clone(),
        binary.clone(),
        fixture.daemon.clone(),
    );
    let first = tokio::spawn(async move {
        tokio::time::timeout(
            Duration::from_secs(1),
            backend.prepare_provider_mountpoints(
                &first_spec,
                &first_mounts,
                &first_binary,
                &daemon,
            ),
        )
        .await
    });
    fixture
        .until(|| fixture.create_seen.load(Ordering::SeqCst))
        .await;
    tokio::time::advance(Duration::from_millis(1001)).await;
    fixture.until(|| first.is_finished()).await;
    assert!(first.await.unwrap().is_err());
    let mut empty = mounts;
    empty.config_binds.clear();
    fixture
        .backend
        .prepare_provider_mountpoints(&spec, &empty, &binary, &fixture.daemon)
        .await
        .unwrap();
    // The empty request needs no mountpoint helper; the old one is independently
    // owned by the reaper and cannot be revived by this successful request.
    fixture.release.notify_one();
    fixture
        .until(|| fixture.observed.lock().unwrap().completed)
        .await;
    let removed = settle_background_removal(&fixture).await;
    let observed = fixture.observed.lock().unwrap();
    assert!(removed);
    assert_eq!(observed.creates, 1);
    assert_eq!(observed.starts, 0);
    assert_eq!(observed.deletes, 1);
    assert!(observed.removed);
}
