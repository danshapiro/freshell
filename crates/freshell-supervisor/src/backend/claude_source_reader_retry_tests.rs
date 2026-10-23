//! The Claude source reader against a synthetic Docker daemon whose helper
//! creates can be refused or answered late, as a stalled daemon answers them.
use super::*;
use freshell_platform::claude_inputs::observation::{LocalDecision, NativeObservation};
use freshell_runtime_protocol::{InitialAuthVolumeObservation, ReserveProviderInputsRequest};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::{net::UnixListener, task::JoinSet};

/// How the synthetic daemon answers one helper create, in request order.
#[derive(Clone, Copy, Debug)]
enum Create {
    /// Create the helper and answer at once.
    Now,
    /// Answer with this status and create nothing.
    Refuse(u16),
    /// Create the helper and answer only after this long, as a create that
    /// waits on a host-wide writeback answers.
    Late(Duration),
}

/// The daemon's view: what was asked for and what exists.
#[derive(Default)]
struct Inventory {
    creates: Vec<String>,
    containers: BTreeMap<String, Value>,
    removed: Vec<String>,
}

struct ReaderDaemon {
    inventory: Arc<Mutex<Inventory>>,
    late: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    server: Option<tokio::task::JoinHandle<()>>,
}

impl ReaderDaemon {
    fn start(socket: &Path, daemon: DockerDaemonId, script: Vec<Create>, exit_code: i64) -> Self {
        let inventory = Arc::new(Mutex::new(Inventory::default()));
        let late = Arc::new(Mutex::new(Vec::new()));
        let listener = UnixListener::bind(socket).unwrap();
        let (stop, mut stopped) = tokio::sync::oneshot::channel::<()>();
        let (state, late_jobs) = (inventory.clone(), late.clone());
        let server = tokio::spawn(async move {
            let mut jobs = JoinSet::new();
            loop {
                tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => {
                        let (stream, _) = accepted.unwrap();
                        let (state, late_jobs, daemon, script) =
                            (state.clone(), late_jobs.clone(), daemon.clone(), script.clone());
                        jobs.spawn(answer(stream, state, late_jobs, daemon, script, exit_code));
                    }
                    result = jobs.join_next(), if !jobs.is_empty() => { result.unwrap().unwrap(); }
                }
            }
            jobs.shutdown().await;
        });
        Self {
            inventory,
            late,
            stop: Some(stop),
            server: Some(server),
        }
    }

    /// Stop answering, after every late create has created its helper.
    async fn finish(&mut self) {
        let late = std::mem::take(&mut *self.late.lock().unwrap());
        for job in late {
            tokio::time::timeout(Duration::from_secs(10), job)
                .await
                .unwrap()
                .unwrap();
        }
        let _ = self.stop.take().unwrap().send(());
        tokio::time::timeout(Duration::from_secs(5), self.server.take().unwrap())
            .await
            .unwrap()
            .unwrap();
    }

    fn creates(&self) -> Vec<String> {
        self.inventory.lock().unwrap().creates.clone()
    }

    fn live(&self) -> Vec<String> {
        self.inventory
            .lock()
            .unwrap()
            .containers
            .keys()
            .cloned()
            .collect()
    }

    fn removed(&self) -> Vec<String> {
        self.inventory.lock().unwrap().removed.clone()
    }
}

async fn answer(
    mut stream: UnixStream,
    state: Arc<Mutex<Inventory>>,
    late: Arc<Mutex<Vec<tokio::task::JoinHandle<()>>>>,
    daemon: DockerDaemonId,
    script: Vec<Create>,
    exit_code: i64,
) {
    let mut header = Vec::new();
    let mut byte = [0];
    while !header.ends_with(b"\r\n\r\n") {
        stream.read_exact(&mut byte).await.unwrap();
        header.push(byte[0]);
    }
    let header = String::from_utf8(header).unwrap();
    let length = header
        .lines()
        .find_map(|line| line.strip_prefix("Content-Length: "))
        .unwrap()
        .trim()
        .parse::<usize>()
        .unwrap();
    let mut raw = vec![0; length];
    stream.read_exact(&mut raw).await.unwrap();
    let line = header.lines().next().unwrap().to_string();
    let key = |line: &str| {
        line.split("/containers/")
            .nth(1)
            .unwrap()
            .split(['/', '?', ' '])
            .next()
            .unwrap()
            .to_string()
    };
    let (status, response) = if line.contains("/info ") {
        (
            200,
            json!({"ID":daemon,"SecurityOptions":["name=rootless"]}),
        )
    } else if line.starts_with("GET") && line.contains("/volumes/") {
        (404, json!({}))
    } else if line.starts_with("GET") && line.contains("/images/") {
        (200, json!({"Config":{"Env":["PATH=/usr/bin"]}}))
    } else if line.starts_with("POST") && line.contains("/containers/create?") {
        let name = line
            .split("name=")
            .nth(1)
            .unwrap()
            .split_whitespace()
            .next()
            .unwrap()
            .to_string();
        let body: Value = serde_json::from_slice(&raw).unwrap();
        let (index, id) = {
            let mut inventory = state.lock().unwrap();
            inventory.creates.push(name.clone());
            let index = inventory.creates.len() - 1;
            (index, format!("{:064x}", index + 1))
        };
        let container = json!({"Id":id,"Name":format!("/{name}"),"Config":body,
            "HostConfig":body["HostConfig"],"Mounts":[],"State":{"Running":false}});
        match script.get(index).copied().unwrap_or(Create::Now) {
            Create::Refuse(status) => (status, json!({"message":"synthetic refusal"})),
            Create::Now => {
                state.lock().unwrap().containers.insert(name, container);
                (201, json!({"Id":id}))
            }
            Create::Late(delay) => {
                // The daemon finishes this create even when its caller has
                // stopped waiting for the answer.
                let created = state.clone();
                let job = tokio::spawn(async move {
                    tokio::time::sleep(delay).await;
                    created.lock().unwrap().containers.insert(name, container);
                });
                let settled = Arc::new(tokio::sync::Notify::new());
                let notify = settled.clone();
                let watcher = tokio::spawn(async move {
                    let _ = job.await;
                    notify.notify_one();
                });
                late.lock().unwrap().push(watcher);
                settled.notified().await;
                (201, json!({"Id":id}))
            }
        }
    } else if line.starts_with("GET") && line.contains("/containers/") {
        let key = key(&line);
        let found = state
            .lock()
            .unwrap()
            .containers
            .iter()
            .find(|(name, value)| **name == key || value["Id"] == key)
            .map(|(_, value)| value.clone());
        match found {
            Some(value) => (200, value),
            None => (404, json!({})),
        }
    } else if line.starts_with("POST") && line.contains("/start ") {
        let key = key(&line);
        let body = state
            .lock()
            .unwrap()
            .containers
            .values()
            .find(|value| value["Id"] == key)
            .map(|value| value["Config"].clone())
            .unwrap();
        let exchange = body["HostConfig"]["Mounts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|mount| mount["Target"] == "/run/freshell-source-exchange")
            .unwrap()["Source"]
            .as_str()
            .unwrap()
            .to_string();
        let mut channel = UnixStream::connect(Path::new(&exchange).join("reply.sock"))
            .await
            .unwrap();
        let length = channel.read_u32().await.unwrap() as usize;
        let mut raw = vec![0; length];
        channel.read_exact(&mut raw).await.unwrap();
        let request: freshell_platform::claude_inputs::observation::ObservationRequest =
            serde_json::from_slice(&raw).unwrap();
        let reply = ObservationReply {
            request_sha256: format!("{:x}", Sha256::digest(&raw)),
            observation: NativeObservation {
                version: 1,
                native_source_runtime: request.native_source_runtime,
                setting_sources: request.setting_sources,
                uid: 65534,
                euid: 65534,
                gid: 0,
                egid: 0,
                supplementary_groups: vec![],
                local_settings: vec![request.cwd.join(".claude/settings.local.json")],
                cwd: request.cwd,
                home: Some(request.home),
                roots: None,
                local_decision: LocalDecision::NoRoot,
                root_uid: None,
                git_uid: None,
                claude_uid: None,
            },
        };
        let raw = serde_json::to_vec(&reply).unwrap();
        channel.write_u32(raw.len() as u32).await.unwrap();
        channel.write_all(&raw).await.unwrap();
        channel.shutdown().await.unwrap();
        (204, json!({}))
    } else if line.starts_with("POST") && line.contains("/wait?") {
        (200, json!({"StatusCode":exit_code}))
    } else if line.starts_with("DELETE") && line.contains("/containers/") {
        let key = key(&line);
        let mut inventory = state.lock().unwrap();
        let name = inventory
            .containers
            .iter()
            .find(|(name, value)| **name == key || value["Id"] == key)
            .map(|(name, _)| name.clone());
        if let Some(name) = name {
            inventory.containers.remove(&name);
            inventory.removed.push(name);
        }
        (204, json!({}))
    } else {
        (500, json!({}))
    };
    let response = response.to_string();
    let _ = stream
        .write_all(
            format!(
                "HTTP/1.1 {status} fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                response.len()
            )
            .as_bytes(),
        )
        .await;
}

/// A first-creation Claude source request and the owner that authorizes it.
async fn initial_request(
    root: &Path,
    daemon: &DockerDaemonId,
) -> (ClaudeSourceOwner, ObserveClaudeSourcesRequest) {
    let workspace = root.join("workspace");
    std::fs::create_dir(&workspace).unwrap();
    let binary = root.join("synthetic-host");
    std::fs::write(&binary, b"synthetic helper artifact").unwrap();
    let registry = crate::registry::Registry::open(root.join("registry"), None).unwrap();
    let soul = SoulId::new();
    let reservation = registry
        .reserve_initial_inputs(
            ReserveProviderInputsRequest {
                expected_control_epoch: Some(registry.control_epoch()),
                soul_id: soul.clone(),
                provider: "claude".into(),
                creation_seed_ref: "synthetic-seed".into(),
            },
            format!("sha256:{}", "a".repeat(64)),
            binary,
        )
        .await
        .unwrap();
    let request: ObserveClaudeSourcesRequest = serde_json::from_value(json!({
        "expectedControlEpoch":registry.control_epoch(), "soulId":soul, "provider":"claude",
        "authority":{"kind":"initial_reservation","reservationId":reservation.id},
        "workspacePath":workspace,"gitCommonDir":null,"candidate":null,
        "observationRequest":{"version":1,"requestId":uuid::Uuid::new_v4().to_string(),
            "nativeSourceRuntime":"terminal","cwd":workspace,"home":"/home/freshell/provider",
            "settingSources":["local"],"selectorManifestSha256":"b".repeat(64),"planRevision":0}
    }))
    .unwrap();
    let owner = ClaudeSourceOwner::Initial {
        reservation,
        observation: InitialAuthVolumeObservation::Absent {
            daemon_id: daemon.clone(),
        },
    };
    (owner, request)
}

fn lifecycle_events(path: &Path) -> Vec<Value> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

fn named<'a>(events: &'a [Value], name: &str) -> Vec<&'a Value> {
    events
        .iter()
        .filter(|event| event["event"] == name)
        .collect()
}

/// Wait until the background reaper reports how its removal ended.
async fn reaper_outcome(path: &Path) -> Vec<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        let events = lifecycle_events(path);
        let settled = events.iter().any(|event| {
            event["event"] == "supervisor.helper.late_create.removed"
                || event["event"] == "supervisor.helper.late_create.unconfirmed"
        });
        if settled || tokio::time::Instant::now() >= deadline {
            return events;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn claude_source_reader_retries_a_create_the_daemon_refused_transiently() {
    let temp = tempfile::tempdir().unwrap();
    let daemon_id = DockerDaemonId::new();
    let (owner, request) = initial_request(temp.path(), &daemon_id).await;
    let mut daemon = ReaderDaemon::start(
        &temp.path().join("docker.sock"),
        daemon_id,
        vec![Create::Refuse(500), Create::Now],
        0,
    );
    let log = temp.path().join("lifecycle.jsonl");
    let backend =
        DockerEngineBackend::new(temp.path().join("docker.sock")).with_lifecycle_log(&log);
    let result = tokio::time::timeout(
        Duration::from_secs(20),
        backend.observe_claude_sources(&owner, &request, "synthetic-run"),
    )
    .await
    .unwrap();
    daemon.finish().await;
    assert!(result.is_ok(), "a refused create is retried: {result:?}");
    assert_eq!(daemon.creates().len(), 2, "one retry after the refusal");
    assert!(daemon.live().is_empty(), "the successful helper is removed");
    let events = lifecycle_events(&log);
    let retries = named(&events, "supervisor.helper.retry");
    assert_eq!(retries.len(), 1, "{events:?}");
    let retry = &retries[0]["data"];
    assert_eq!(retry["severity"], "warn");
    assert_eq!(retry["helper"], "claude_source_reader");
    assert_eq!(retry["cause"], "refused");
    assert_eq!(retry["step"], "create");
    assert_eq!(retry["attempt"], 1);
    assert_eq!(
        retry["requestId"],
        json!(request.observation_request.request_id)
    );
    assert_eq!(named(&events, "supervisor.helper.recovered").len(), 1);
    assert!(
        named(&events, "supervisor.helper.create_slow").is_empty(),
        "prompt creates are not reported as slow"
    );
}

#[tokio::test]
async fn claude_source_reader_keeps_final_failures_final() {
    for (script, exit_code) in [
        (vec![Create::Refuse(409)], 0),
        (vec![Create::Refuse(400)], 0),
        (vec![Create::Now], 1),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let daemon_id = DockerDaemonId::new();
        let (owner, request) = initial_request(temp.path(), &daemon_id).await;
        let mut daemon = ReaderDaemon::start(
            &temp.path().join("docker.sock"),
            daemon_id,
            script.clone(),
            exit_code,
        );
        let log = temp.path().join("lifecycle.jsonl");
        let backend =
            DockerEngineBackend::new(temp.path().join("docker.sock")).with_lifecycle_log(&log);
        let result = tokio::time::timeout(
            Duration::from_secs(20),
            backend.observe_claude_sources(&owner, &request, "synthetic-run"),
        )
        .await
        .unwrap();
        daemon.finish().await;
        assert!(result.is_err(), "{script:?}/{exit_code}: {result:?}");
        assert_eq!(
            daemon.creates().len(),
            1,
            "{script:?}/{exit_code}: a final failure is never retried"
        );
        assert!(daemon.live().is_empty(), "{script:?}/{exit_code}");
        assert!(named(&lifecycle_events(&log), "supervisor.helper.retry").is_empty());
    }
}

#[tokio::test]
async fn claude_source_reader_removes_a_helper_whose_create_answered_after_its_deadline() {
    let temp = tempfile::tempdir().unwrap();
    let daemon_id = DockerDaemonId::new();
    let (owner, request) = initial_request(temp.path(), &daemon_id).await;
    let mut daemon = ReaderDaemon::start(
        &temp.path().join("docker.sock"),
        daemon_id,
        vec![Create::Late(Duration::from_millis(900))],
        0,
    );
    let log = temp.path().join("lifecycle.jsonl");
    let backend =
        DockerEngineBackend::new(temp.path().join("docker.sock")).with_lifecycle_log(&log);
    let result = backend
        .read_claude_source_helper(
            &owner,
            &request,
            "synthetic-run",
            HelperDeadlines::after(Duration::from_millis(150), Duration::from_millis(150)),
        )
        .await;
    assert!(result.is_err(), "the helper's deadline passed: {result:?}");
    let creates = daemon.creates();
    assert_eq!(creates.len(), 1);
    // Docker creates the helper after the reader stopped waiting. Nothing
    // else will ever ask for it, so the reader's own cleanup must remove it.
    let events = reaper_outcome(&log).await;
    daemon.finish().await;
    assert_eq!(daemon.removed(), creates, "the late helper is removed");
    assert!(daemon.live().is_empty(), "no helper is left behind");
    let deferred = named(&events, "supervisor.helper.late_create.deferred");
    assert_eq!(deferred.len(), 1, "{events:?}");
    assert_eq!(deferred[0]["data"]["severity"], "warn");
    assert_eq!(deferred[0]["data"]["names"], json!(creates));
    let removed = named(&events, "supervisor.helper.late_create.removed");
    assert_eq!(removed.len(), 1, "{events:?}");
    assert_eq!(removed[0]["data"]["severity"], "info");
}

/// A small policy with the production shape, so stalls resolve in tests.
const QUICK: helper_lifecycle::HelperRetryPolicy = helper_lifecycle::HelperRetryPolicy {
    attempt: Duration::from_millis(250),
    total: Duration::from_millis(6_000),
    cleanup: Duration::from_millis(250),
    backoff: [Duration::from_millis(50), Duration::from_millis(100)],
    min_attempt: Duration::from_millis(200),
};

#[tokio::test]
async fn claude_source_reader_retries_after_a_stalled_create_answers_and_removes_it_first() {
    let temp = tempfile::tempdir().unwrap();
    let daemon_id = DockerDaemonId::new();
    let (owner, request) = initial_request(temp.path(), &daemon_id).await;
    let mut daemon = ReaderDaemon::start(
        &temp.path().join("docker.sock"),
        daemon_id,
        vec![Create::Late(Duration::from_millis(700)), Create::Now],
        0,
    );
    let log = temp.path().join("lifecycle.jsonl");
    let backend =
        DockerEngineBackend::new(temp.path().join("docker.sock")).with_lifecycle_log(&log);
    let result = backend
        .observe_claude_sources_with(&QUICK, &owner, &request, "synthetic-run")
        .await;
    let creates = daemon.creates();
    let removed = daemon.removed();
    daemon.finish().await;
    assert!(result.is_ok(), "the retry reads the sources: {result:?}");
    assert_eq!(creates.len(), 2);
    // The stalled helper was settled and removed before the retry began, so
    // the daemon never held two of this read's helpers at once.
    assert_eq!(removed, creates, "both helpers are removed, in order");
    assert!(daemon.live().is_empty());
    let events = lifecycle_events(&log);
    let retries = named(&events, "supervisor.helper.retry");
    assert_eq!(retries.len(), 1, "{events:?}");
    assert_eq!(retries[0]["data"]["cause"], "timed_out");
    assert!(named(&events, "supervisor.helper.late_create.deferred").is_empty());
    assert_eq!(named(&events, "supervisor.helper.recovered").len(), 1);
}

#[tokio::test]
async fn claude_source_reader_reports_exhaustion_after_its_bounded_attempts() {
    let temp = tempfile::tempdir().unwrap();
    let daemon_id = DockerDaemonId::new();
    let (owner, request) = initial_request(temp.path(), &daemon_id).await;
    let mut daemon = ReaderDaemon::start(
        &temp.path().join("docker.sock"),
        daemon_id,
        vec![Create::Refuse(503); 5],
        0,
    );
    let log = temp.path().join("lifecycle.jsonl");
    let backend =
        DockerEngineBackend::new(temp.path().join("docker.sock")).with_lifecycle_log(&log);
    let result = backend
        .observe_claude_sources_with(&QUICK, &owner, &request, "synthetic-run")
        .await;
    daemon.finish().await;
    assert!(result.is_err());
    assert_eq!(daemon.creates().len(), 3, "three attempts at most");
    let events = lifecycle_events(&log);
    assert_eq!(
        named(&events, "supervisor.helper.retry").len(),
        2,
        "{events:?}"
    );
    let exhausted = named(&events, "supervisor.helper.retry_exhausted");
    assert_eq!(exhausted.len(), 1, "{events:?}");
    let exhausted = &exhausted[0]["data"];
    assert_eq!(exhausted["severity"], "error");
    assert_eq!(exhausted["attempt"], 3);
    assert_eq!(exhausted["maxAttempts"], 3);
    assert_eq!(exhausted["cause"], "refused");
    assert_eq!(exhausted["soulId"], json!(request.soul_id));
}

#[tokio::test]
async fn claude_source_reader_stays_inside_its_total_budget_and_reaps_what_outlives_it() {
    let temp = tempfile::tempdir().unwrap();
    let daemon_id = DockerDaemonId::new();
    let (owner, request) = initial_request(temp.path(), &daemon_id).await;
    let mut daemon = ReaderDaemon::start(
        &temp.path().join("docker.sock"),
        daemon_id,
        vec![Create::Late(Duration::from_millis(2_500))],
        0,
    );
    let log = temp.path().join("lifecycle.jsonl");
    let backend =
        DockerEngineBackend::new(temp.path().join("docker.sock")).with_lifecycle_log(&log);
    let policy = helper_lifecycle::HelperRetryPolicy {
        total: Duration::from_millis(1_000),
        ..QUICK
    };
    let started = tokio::time::Instant::now();
    let result = backend
        .observe_claude_sources_with(&policy, &owner, &request, "synthetic-run")
        .await;
    let elapsed = started.elapsed();
    assert!(result.is_err());
    assert!(
        elapsed < Duration::from_millis(1_500),
        "the read returns inside its total budget, not when Docker answers: {elapsed:?}"
    );
    let creates = daemon.creates();
    assert_eq!(creates.len(), 1, "no retry once the budget has no room");
    let events = reaper_outcome(&log).await;
    daemon.finish().await;
    assert_eq!(
        daemon.removed(),
        creates,
        "the reaper removes the late helper"
    );
    assert_eq!(
        named(&events, "supervisor.helper.late_create.deferred").len(),
        1
    );
    assert_eq!(
        named(&events, "supervisor.helper.late_create.removed").len(),
        1
    );
    let exhausted = named(&events, "supervisor.helper.retry_exhausted");
    assert_eq!(exhausted.len(), 1, "{events:?}");
    assert_eq!(exhausted[0]["data"]["cause"], "timed_out");
}

#[tokio::test]
async fn a_helper_create_docker_answers_slowly_is_logged_with_its_latency() {
    let temp = tempfile::tempdir().unwrap();
    let daemon_id = DockerDaemonId::new();
    let (owner, request) = initial_request(temp.path(), &daemon_id).await;
    let mut daemon = ReaderDaemon::start(
        &temp.path().join("docker.sock"),
        daemon_id,
        vec![Create::Late(Duration::from_millis(5_300))],
        0,
    );
    let log = temp.path().join("lifecycle.jsonl");
    let backend =
        DockerEngineBackend::new(temp.path().join("docker.sock")).with_lifecycle_log(&log);
    let result = backend
        .read_claude_source_helper(
            &owner,
            &request,
            "synthetic-run",
            HelperDeadlines::after(Duration::from_secs(10), Duration::from_secs(1)),
        )
        .await;
    let creates = daemon.creates();
    daemon.finish().await;
    assert!(
        result.is_ok(),
        "a slow create inside the budget still reads: {result:?}"
    );
    let events = lifecycle_events(&log);
    let slow = named(&events, "supervisor.helper.create_slow");
    assert_eq!(slow.len(), 1, "{events:?}");
    let slow = &slow[0]["data"];
    assert_eq!(slow["severity"], "warn");
    assert_eq!(slow["name"], json!(creates[0]));
    assert_eq!(slow["status"], 201);
    assert!(slow["elapsedMs"].as_u64().unwrap() >= 5_000, "{slow}");
}
