//! Public WS creation -> bound HTTP model discovery, using the real server and
//! owned Codex CLI fixture. Every provider process and HOME belongs to this test.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    io::Write,
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "codex-catalog-owned-fixture";
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// Keep the complete test-owned home only when a scenario unwinds.
/// The normal successful path still removes every fixture artifact.
struct ScenarioArtifacts {
    home: Option<tempfile::TempDir>,
    scenario: String,
}

impl ScenarioArtifacts {
    fn new(scenario: &str) -> Self {
        let parent = std::env::var_os("FRESHELL_CODEX_CATALOG_ARTIFACT_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        std::fs::create_dir_all(&parent).unwrap();
        let home = tempfile::Builder::new()
            .prefix(&format!("freshell-codex-catalog-{scenario}-"))
            .tempdir_in(parent)
            .unwrap();
        Self {
            home: Some(home),
            scenario: scenario.to_string(),
        }
    }

    fn path(&self) -> &Path {
        self.home.as_ref().expect("scenario home is live").path()
    }

    fn event(&self, event: &str, detail: Value) {
        let row = json!({
            "severity": "info",
            "event": event,
            "scenario": self.scenario,
            "harnessPid": std::process::id(),
            "timestampUnixMillis": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis(),
            "home": self.path(),
            "detail": detail,
        });
        if let Err(error) = (|| -> std::io::Result<()> {
            let mut log = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(self.path().join("harness-events.jsonl"))?;
            writeln!(log, "{row}")
        })() {
            eprintln!(
                "{}",
                json!({"severity":"warn","event":"catalog_diagnostics_write_failed","error":error.to_string()})
            );
        }
    }
}

impl Drop for ScenarioArtifacts {
    fn drop(&mut self) {
        if std::thread::panicking() {
            self.event("scenario.failed", json!({}));
            let home = self.home.take().expect("scenario home is live").keep();
            eprintln!(
                "{}",
                json!({
                    "severity":"error",
                    "event":"catalog_diagnostics_retained",
                    "scenario":self.scenario,
                    "home":home,
                    "files":["server.stdout.log","server.stderr.log","native-events.jsonl","requests.jsonl","context-requests.jsonl","harness-events.jsonl"],
                })
            );
        }
    }
}

struct OwnedServer(Child);
impl Drop for OwnedServer {
    fn drop(&mut self) {
        unsafe {
            libc::kill(self.0.id() as libc::pid_t, libc::SIGTERM);
        }
        let end = Instant::now() + Duration::from_secs(10);
        while Instant::now() < end {
            if self.0.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

async fn message(socket: &mut Socket, kind: &str) -> Value {
    let mut observed = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(frame) = socket.next().await {
            if let Message::Text(text) = frame.unwrap() {
                let value: Value = serde_json::from_str(&text).unwrap();
                observed.push(value.clone());
                if value["type"] == kind {
                    return value;
                }
                assert_ne!(value["type"], "freshAgent.create.failed", "{value}");
            }
        }
        panic!("socket closed before {kind}")
    })
    .await;
    result.unwrap_or_else(|_| panic!("socket did not receive {kind}; observed: {observed:?}"))
}

async fn boot(artifacts: &ScenarioArtifacts, behavior: Value) -> (OwnedServer, String, Socket) {
    let home = artifacts.path();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    std::fs::create_dir_all(home.join(".freshell")).unwrap();
    std::fs::write(home.join(".freshell/config.json"), json!({"settings":{"freshAgent":{"enabled":true},"network":{"configured":true,"host":"127.0.0.1"}}}).to_string()).unwrap();
    let bin = std::env::var_os("FRESHELL_SERVER_BIN")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_freshell-server").into());
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs");
    let server = OwnedServer(
        Command::new(bin)
            .current_dir(home)
            .env("PORT", port.to_string())
            .env("AUTH_TOKEN", TOKEN)
            .env("FRESHELL_BIND_HOST", "127.0.0.1")
            .env("HOME", home)
            .env("FRESHELL_HOME", home)
            .env("CODEX_HOME", home.join(".codex"))
            .env("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1")
            .env("CODEX_CMD", format!("node {}", fixture.display()))
            .env("FAKE_CODEX_APP_SERVER_BEHAVIOR", behavior.to_string())
            .env(
                "FAKE_CODEX_APP_SERVER_DIAGNOSTIC_LOG",
                home.join("native-events.jsonl"),
            )
            .env_remove("FRESHELL_MANAGED_RUNTIME_V1")
            .env_remove("FRESHELL_MANAGED_FRESH_AGENT_V1")
            .stdin(Stdio::null())
            .stdout(std::fs::File::create(home.join("server.stdout.log")).unwrap())
            .stderr(std::fs::File::create(home.join("server.stderr.log")).unwrap())
            .spawn()
            .unwrap(),
    );
    let base = format!("http://127.0.0.1:{port}");
    artifacts.event(
        "server.spawned",
        json!({"serverPid":server.0.id(),"base":base}),
    );
    let http = reqwest::Client::new();
    let end = Instant::now() + Duration::from_secs(20);
    loop {
        if http
            .get(format!("{base}/api/health"))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
        {
            break;
        }
        assert!(Instant::now() < end, "owned server did not start");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
        .await
        .unwrap();
    socket.send(Message::Text(json!({"type":"hello","protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION,"token":TOKEN}).to_string())).await.unwrap();
    message(&mut socket, "ready").await;
    artifacts.event(
        "server.ready",
        json!({"serverPid":server.0.id(),"base":base}),
    );
    (server, base, socket)
}

async fn assert_catalog_scenario(scenario: &str) {
    let home = ScenarioArtifacts::new(scenario);
    let log = home.path().join("requests.jsonl");
    let first = json!({"id":"record-sol","model":"gpt-6.1-sol","displayName":"GPT 6.1 Sol","supportedReasoningEfforts":[{"reasoningEffort":"xhigh"}],"defaultReasoningEffort":"xhigh","inputModalities":["text","image"]});
    let second = json!({"id":"opaque-record","model":"provider-current","displayName":"Provider Current","supportedReasoningEfforts":[{"reasoningEffort":"none"},{"reasoningEffort":"ultra"}],"defaultReasoningEffort":"ultra","inputModalities":["text"]});
    let pages = match scenario {
        "loop" => json!([{"data":[first],"nextCursor":"1"},{"data":[second],"nextCursor":"1"}]),
        "malformed" => json!([{"data":[first],"nextCursor":7}]),
        _ => json!([{"data":[first],"nextCursor":"1"},{"data":[second],"nextCursor":null}]),
    };
    let (server, base, mut socket) = boot(&home, json!({"modelCatalogPages":pages,"appendRequestLogPath":log,"ignoreMethods":if scenario=="deadline" {vec!["model/list"]} else {vec![]}})).await;
    home.event("create.requested", json!({"requestId":"catalog-create"}));
    socket.send(Message::Text(json!({"type":"freshAgent.create","requestId":"catalog-create","provider":"codex","sessionType":"freshcodex","cwd":home.path(),"model":"provider-current","effort":"ultra"}).to_string())).await.unwrap();
    let created = message(&mut socket, "freshAgent.created").await;
    home.event("create.received", created.clone());
    let http = reqwest::Client::new();
    let mut url = reqwest::Url::parse(&format!(
        "{base}/api/fresh-agent/model-capabilities/freshcodex"
    ))
    .unwrap();
    url.query_pairs_mut()
        .append_pair("sessionId", created["sessionId"].as_str().unwrap());
    home.event("catalog.requested", json!({"url":url.as_str()}));
    let response = http
        .get(url.clone())
        .header("x-auth-token", TOKEN)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap();
    home.event("catalog.received", json!({"status":status,"body":body}));
    let cached: Option<Value> = if scenario == "valid" {
        Some(
            http.get(url)
                .header("x-auth-token", TOKEN)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap(),
        )
    } else {
        None
    };
    // A failed or timed-out catalog must leave the existing provider usable.
    home.event("send.requested", json!({"requestId":"after-catalog"}));
    socket.send(Message::Text(json!({"type":"freshAgent.send","provider":"codex","sessionType":"freshcodex","sessionId":created["sessionId"],"requestId":"after-catalog","text":"reuse the existing provider"}).to_string())).await.unwrap();
    message(&mut socket, "freshAgent.send.accepted").await;
    home.event("send.accepted", json!({"requestId":"after-catalog"}));
    socket.close(None).await.unwrap();
    drop(server);
    let requests: Vec<Value> = std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    let lists: Vec<_> = requests
        .iter()
        .filter(|r| r["method"] == "model/list")
        .collect();
    if scenario == "valid" {
        assert_eq!(status, 200, "{body}");
        assert_eq!(body["models"][0]["id"], "gpt-6.1-sol");
        assert_eq!(body["models"][1]["id"], "provider-current");
        assert_eq!(body["models"][1]["defaultEffort"], "ultra");
        assert_eq!(
            body["models"][1]["supportedEffortLevels"],
            json!(["none", "ultra"])
        );
        assert_eq!(
            body["models"][0]["inputModalities"],
            json!(["text", "image"])
        );
        assert_eq!(cached.unwrap()["status"], "cached");
        assert_eq!(lists.len(), 2);
        assert!(lists[0]["params"].get("cursor").is_none_or(Value::is_null));
        assert_eq!(lists[1]["params"]["cursor"], "1");
        assert_eq!(lists[0]["params"]["includeHidden"], false);
    } else {
        assert_eq!(status, 503, "{scenario}: {body}");
        assert_eq!(body["status"], "unavailable");
        assert_eq!(body["models"], json!([]));
        assert!(body["error"]["code"]
            .as_str()
            .unwrap()
            .starts_with("CAPABILITY_"));
        assert!(lists.len() <= 2);
    }
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "initialize")
            .count(),
        1,
        "catalog must reuse its registered process"
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "thread/start")
            .count(),
        1
    );
    assert!(!requests.iter().any(|r| r["method"] == "thread/resume"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bound_native_model_catalog_paginates_and_caches() {
    assert_catalog_scenario("valid").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bound_native_model_catalog_rejects_looping_cursors() {
    assert_catalog_scenario("loop").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bound_native_model_catalog_rejects_malformed_cursor() {
    assert_catalog_scenario("malformed").await;
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bound_native_model_catalog_bounds_native_deadline() {
    assert_catalog_scenario("deadline").await;
}

/// Signals only the fixture carrying this scenario's unique ownership tag.
/// The disposable sandbox additionally owns every process created by this test.
struct CompetingProvider {
    ready: std::path::PathBuf,
    ownership_id: String,
}
impl Drop for CompetingProvider {
    fn drop(&mut self) {
        let Ok(ready) = std::fs::read(&self.ready) else {
            return;
        };
        let Ok(ready) = serde_json::from_slice::<Value>(&ready) else {
            return;
        };
        let Some(pid) = ready["pid"].as_u64() else {
            return;
        };
        let Ok(environment) = std::fs::read(format!("/proc/{pid}/environ")) else {
            return;
        };
        let needle = format!("FRESHELL_CODEX_SIDECAR_ID={}", self.ownership_id);
        if environment
            .split(|byte| *byte == 0)
            .any(|entry| entry == needle.as_bytes())
        {
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGKILL);
            }
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bound_native_startup_never_initializes_a_competing_listener() {
    let home = ScenarioArtifacts::new("competing-listener");
    let rival = home.path().join("rival");
    std::fs::create_dir_all(&rival).unwrap();
    let ready = rival.join("ready.json");
    let release = rival.join("release");
    let ownership_id = format!(
        "catalog-rival-{}",
        home.path().file_name().unwrap().to_string_lossy()
    );
    let _rival = CompetingProvider {
        ready: ready.clone(),
        ownership_id: ownership_id.clone(),
    };
    let own_requests = home.path().join("requests.jsonl");
    let (server, _, mut socket) = boot(
        &home,
        json!({
            "appendRequestLogPath":own_requests,
            "startupCompetingListener":{
                "home":rival,"readyPath":ready,"releasePath":release,
                "ownershipId":ownership_id,"requestsPath":rival.join("requests.jsonl"),
                "eventsPath":rival.join("events.jsonl"),
            }
        }),
    )
    .await;
    let own_events = home.path().join("native-events.jsonl");
    let release_task = tokio::spawn(async move {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if std::fs::read_to_string(&own_events)
                .is_ok_and(|events| events.contains("EADDRINUSE"))
            {
                // The intended child has failed its bind. Let the stolen peer's
                // response reach the production publication/liveness check.
                std::fs::write(release, b"release").unwrap();
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    });
    socket.send(Message::Text(json!({"type":"freshAgent.create","requestId":"competing-create","provider":"codex","sessionType":"freshcodex","cwd":home.path()}).to_string())).await.unwrap();
    let outcome = tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(frame) = socket.next().await {
            if let Message::Text(frame) = frame.unwrap() {
                let value: Value = serde_json::from_str(&frame).unwrap();
                if matches!(
                    value["type"].as_str(),
                    Some("freshAgent.created" | "freshAgent.create.failed")
                ) {
                    return value;
                }
            }
        }
        panic!("create socket closed")
    })
    .await
    .unwrap();
    release_task.abort();
    socket.close(None).await.unwrap();
    drop(server);
    let foreign: Vec<Value> = std::fs::read_to_string(rival.join("requests.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    home.event(
        "competing.create_result",
        json!({"outcome":outcome,"foreignRequests":foreign}),
    );
    assert_eq!(
        foreign
            .iter()
            .filter(|row| row["method"] == "initialize")
            .count(),
        1,
        "startup initialized the competing provider: {foreign:?}; {outcome}"
    );
    assert!(
        !foreign.iter().any(|row| row["method"] == "thread/start"),
        "startup used the competing native home: {foreign:?}"
    );
    assert_eq!(outcome["type"], "freshAgent.created", "{outcome}");
    let own: Vec<Value> = std::fs::read_to_string(own_requests)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        own.iter()
            .filter(|row| row["method"] == "initialize")
            .count(),
        1
    );
    assert_eq!(
        own.iter()
            .filter(|row| row["method"] == "thread/start")
            .count(),
        1
    );
    assert!(own
        .iter()
        .all(|row| row["codexHome"] == home.path().join(".codex").to_string_lossy().as_ref()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bound_native_model_catalog_separates_actual_provider_contexts_in_one_registry() {
    let home = ScenarioArtifacts::new("contexts");
    let log = home.path().join("context-requests.jsonl");
    let mut pages = serde_json::Map::new();
    for name in ["a", "b"] {
        let cwd = home.path().join(name);
        std::fs::create_dir_all(&cwd).unwrap();
        pages.insert(cwd.to_string_lossy().into(),json!([{"data":[{"id":"opaque-record","model":format!("model-from-{name}"),"displayName":format!("Context {name}"),"supportedReasoningEfforts":[{"reasoningEffort":"ultra"}],"defaultReasoningEffort":"ultra","inputModalities":["text"]}],"nextCursor":null}]));
    }
    let (server, base, mut socket) = boot(
        &home,
        json!({"uniqueThreadIds":true,"appendRequestLogPath":log,"modelCatalogPagesByCwd":pages}),
    )
    .await;
    let http = reqwest::Client::new();
    let mut identities = Vec::new();
    for name in ["a", "b"] {
        socket.send(Message::Text(json!({"type":"freshAgent.create","requestId":format!("create-context-{name}"),"provider":"codex","sessionType":"freshcodex","cwd":home.path().join(name),"model":format!("model-from-{name}"),"effort":"ultra"}).to_string())).await.unwrap();
        let created = message(&mut socket, "freshAgent.created").await;
        identities.push(created["sessionId"].as_str().unwrap().to_string());
    }
    let mut results = Vec::new();
    for index in [0, 1, 0] {
        let mut url = reqwest::Url::parse(&format!(
            "{base}/api/fresh-agent/model-capabilities/freshcodex"
        ))
        .unwrap();
        url.query_pairs_mut()
            .append_pair("sessionId", &identities[index]);
        // Deliberately no cwd query: the live provider client is the authority,
        // so two contexts must not collide in the default-cwd cache bucket.
        let response = http
            .get(url)
            .header("x-auth-token", TOKEN)
            .send()
            .await
            .unwrap();
        results.push((response.status(), response.json::<Value>().await.unwrap()));
    }
    socket.close(None).await.unwrap();
    drop(server);
    for (index, (status, body)) in results.iter().enumerate() {
        assert!(status.is_success(), "{body}");
        assert_eq!(
            body["models"][0]["id"],
            if index == 1 {
                "model-from-b"
            } else {
                "model-from-a"
            }
        );
    }
    assert_eq!(results[2].1["status"], "cached");
    let requests = std::fs::read_to_string(log)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    let lists = requests
        .iter()
        .filter(|r| r["method"] == "model/list")
        .collect::<Vec<_>>();
    assert_eq!(lists.len(), 2);
    for name in ["a", "b"] {
        assert!(lists
            .iter()
            .any(|row| row["cwd"].as_str() == Some(home.path().join(name).to_str().unwrap())));
    }
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "initialize")
            .count(),
        2
    );
    assert_eq!(
        requests
            .iter()
            .filter(|r| r["method"] == "thread/start")
            .count(),
        2
    );
}
