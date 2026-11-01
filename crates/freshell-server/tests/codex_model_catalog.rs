//! Public WS creation -> bound HTTP model discovery, using the real server and
//! owned Codex CLI fixture. Every provider process and HOME belongs to this test.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    path::Path,
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "codex-catalog-owned-fixture";
type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

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

async fn boot(home: &Path, behavior: Value) -> (OwnedServer, String, Socket) {
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
            .env_remove("FRESHELL_MANAGED_RUNTIME_V1")
            .env_remove("FRESHELL_MANAGED_FRESH_AGENT_V1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let base = format!("http://127.0.0.1:{port}");
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
    (server, base, socket)
}

async fn assert_catalog_scenario(scenario: &str) {
    let home = tempfile::tempdir().unwrap();
    let log = home.path().join("requests.jsonl");
    let first = json!({"id":"record-sol","model":"gpt-6.1-sol","displayName":"GPT 6.1 Sol","supportedReasoningEfforts":[{"reasoningEffort":"xhigh"}],"defaultReasoningEffort":"xhigh","inputModalities":["text","image"]});
    let second = json!({"id":"opaque-record","model":"provider-current","displayName":"Provider Current","supportedReasoningEfforts":[{"reasoningEffort":"none"},{"reasoningEffort":"ultra"}],"defaultReasoningEffort":"ultra","inputModalities":["text"]});
    let pages = match scenario {
        "loop" => json!([{"data":[first],"nextCursor":"1"},{"data":[second],"nextCursor":"1"}]),
        "malformed" => json!([{"data":[first],"nextCursor":7}]),
        _ => json!([{"data":[first],"nextCursor":"1"},{"data":[second],"nextCursor":null}]),
    };
    let (server, base, mut socket) = boot(home.path(), json!({"modelCatalogPages":pages,"appendRequestLogPath":log,"ignoreMethods":if scenario=="deadline" {vec!["model/list"]} else {vec![]}})).await;
    socket.send(Message::Text(json!({"type":"freshAgent.create","requestId":"catalog-create","provider":"codex","sessionType":"freshcodex","cwd":home.path(),"model":"provider-current","effort":"ultra"}).to_string())).await.unwrap();
    let created = message(&mut socket, "freshAgent.created").await;
    let http = reqwest::Client::new();
    let mut url = reqwest::Url::parse(&format!(
        "{base}/api/fresh-agent/model-capabilities/freshcodex"
    ))
    .unwrap();
    url.query_pairs_mut()
        .append_pair("sessionId", created["sessionId"].as_str().unwrap());
    let response = http
        .get(url.clone())
        .header("x-auth-token", TOKEN)
        .send()
        .await
        .unwrap();
    let status = response.status().as_u16();
    let body: Value = response.json().await.unwrap();
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
    socket.send(Message::Text(json!({"type":"freshAgent.send","provider":"codex","sessionType":"freshcodex","sessionId":created["sessionId"],"requestId":"after-catalog","text":"reuse the existing provider"}).to_string())).await.unwrap();
    message(&mut socket, "freshAgent.send.accepted").await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bound_native_model_catalog_separates_actual_provider_contexts_in_one_registry() {
    let home = tempfile::tempdir().unwrap();
    let log = home.path().join("context-requests.jsonl");
    let mut pages = serde_json::Map::new();
    for name in ["a", "b"] {
        let cwd = home.path().join(name);
        std::fs::create_dir_all(&cwd).unwrap();
        pages.insert(cwd.to_string_lossy().into(),json!([{"data":[{"id":"opaque-record","model":format!("model-from-{name}"),"displayName":format!("Context {name}"),"supportedReasoningEfforts":[{"reasoningEffort":"ultra"}],"defaultReasoningEffort":"ultra","inputModalities":["text"]}],"nextCursor":null}]));
    }
    let (server, base, mut socket) = boot(
        home.path(),
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
