use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::Duration;

use freshell_opencode::serve::{ServeConfig, ServeDeps};
use freshell_opencode::transport::{
    LoopbackPortAllocator, ReqwestEventSource, ReqwestServeHttp, TokioProcessSpawner,
};
use freshell_opencode::{observed_user_message_id, OpencodeServeManager};
use serde_json::json;

const EXPECTED_VERSION: &str = "1.18.21";
const NATIVE_MESSAGE_ID: &str = "msg_55c25d96e4445f67b35ea116686e169c";

struct LocalModelEndpoint {
    base_url: String,
    stopping: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

impl LocalModelEndpoint {
    fn start() -> Self {
        let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind local fake model");
        listener
            .set_nonblocking(true)
            .expect("local fake model listener is nonblocking");
        let address = listener.local_addr().expect("fake model address");
        let stopping = Arc::new(AtomicBool::new(false));
        let worker_stopping = stopping.clone();
        let worker = thread::spawn(move || {
            while !worker_stopping.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => respond_to_model_request(stream),
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            base_url: format!("http://{address}/v1"),
            stopping,
            worker: Some(worker),
        }
    }

    fn stop(&mut self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

impl Drop for LocalModelEndpoint {
    fn drop(&mut self) {
        self.stop();
    }
}

fn respond_to_model_request(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let mut request = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(count) => {
                request.extend_from_slice(&chunk[..count]);
                let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n")
                else {
                    continue;
                };
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())
                            .flatten()
                    })
                    .unwrap_or(0);
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
            Err(_) => return,
        }
    }

    let first_line = String::from_utf8_lossy(&request)
        .lines()
        .next()
        .unwrap_or_default()
        .to_string();
    let (status, content_type, body) = if first_line.starts_with("GET /v1/models") {
        (
            "200 OK",
            "application/json",
            br#"{"data":[{"id":"fixture-model","object":"model","created":1,"owned_by":"freshell"}]}"#.to_vec(),
        )
    } else {
        let body = concat!(
            "data: {\"id\":\"chatcmpl-fixture\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture-model\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"done\"},\"finish_reason\":null}]}\n\n",
            "data: {\"id\":\"chatcmpl-fixture\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"fixture-model\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":1,\"completion_tokens\":1,\"total_tokens\":2}}\n\n",
            "data: [DONE]\n\n"
        )
        .as_bytes()
        .to_vec();
        ("200 OK", "text/event-stream", body)
    };
    let response = format!(
        "HTTP/1.1 {status}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
        body.len()
    );
    if stream.write_all(response.as_bytes()).is_ok() {
        let _ = stream.write_all(&body);
        let _ = stream.flush();
    }
}

fn prepare_provider_roots(root: &Path) -> PathBuf {
    for name in ["home", "config", "data", "state", "cache", "project"] {
        fs::create_dir_all(root.join(name)).expect("create synthetic OpenCode root");
    }
    root.join("project")
}

fn assert_pinned_binary(binary: &Path, root: &Path) {
    let output = Command::new(binary)
        .arg("--version")
        .env_clear()
        .env("HOME", root.join("home"))
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_DATA_HOME", root.join("data"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("XDG_CACHE_HOME", root.join("cache"))
        .env("CI", "1")
        .output()
        .expect("run the selected OpenCode binary");
    assert!(output.status.success(), "pinned binary --version succeeds");
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    assert_eq!(version, EXPECTED_VERSION, "contract requires pinned binary");
}

#[tokio::test]
async fn opencode_checkpoint_message_id_persists_after_prompt() {
    let binary = PathBuf::from(
        std::env::var_os("FRESHELL_OPENCODE_CONTRACT_BIN")
            .expect("runner supplies the run-owned pinned OpenCode binary"),
    );
    assert!(binary.is_absolute(), "contract binary path is absolute");
    assert!(binary.is_file(), "contract binary exists");
    let root = PathBuf::from(
        std::env::var_os("FRESHELL_OPENCODE_CONTRACT_ROOT")
            .expect("runner supplies the private synthetic fixture root"),
    );
    assert!(root.is_absolute(), "fixture root is absolute");
    assert!(root.is_dir(), "fixture root exists");
    assert_pinned_binary(&binary, &root);
    let project = prepare_provider_roots(&root);
    let mut model_endpoint = LocalModelEndpoint::start();
    let config_content = json!({
        "provider": {
            "freshell-contract": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Freshell local contract provider",
                "options": {
                    "baseURL": model_endpoint.base_url,
                    "apiKey": "fixture-only"
                },
                "models": {
                    "fixture-model": {
                        "name": "Synthetic fixture model",
                        "limit": {"context": 16384, "output": 1024}
                    }
                }
            }
        }
    })
    .to_string();
    let config = ServeConfig {
        command: binary.display().to_string(),
        env: vec![
            ("HOME".into(), root.join("home").display().to_string()),
            (
                "XDG_CONFIG_HOME".into(),
                root.join("config").display().to_string(),
            ),
            (
                "XDG_DATA_HOME".into(),
                root.join("data").display().to_string(),
            ),
            (
                "XDG_STATE_HOME".into(),
                root.join("state").display().to_string(),
            ),
            (
                "XDG_CACHE_HOME".into(),
                root.join("cache").display().to_string(),
            ),
            ("CI".into(), "1".into()),
            ("NO_COLOR".into(), "1".into()),
            ("OPENCODE_DISABLE_AUTOUPDATE".into(), "1".into()),
            ("OPENCODE_CONFIG_CONTENT".into(), config_content),
        ],
        health_timeout: Duration::from_secs(20),
        health_probe_timeout: Duration::from_secs(2),
        health_retry_interval: Duration::from_millis(100),
        idle_poll_interval: Duration::from_millis(100),
        required_idle_status_polls: 2,
        request_timeout: Duration::from_secs(20),
        ..ServeConfig::default()
    };
    let manager = OpencodeServeManager::new(
        ServeDeps {
            spawner: Arc::new(TokioProcessSpawner),
            http: Arc::new(ReqwestServeHttp::new()),
            ports: Arc::new(LoopbackPortAllocator),
            events: Arc::new(ReqwestEventSource::new()),
        },
        config,
    );

    let operation = tokio::time::timeout(Duration::from_secs(120), async {
        let project_path = project.display().to_string();
        let session = manager
            .create_session(Some("checkpoint contract"), None, Some(&project_path))
            .await
            .expect("create synthetic OpenCode session");
        manager
            .run_turn_with_message_id(
                &session.id,
                "Reply with the word done.",
                Some("freshell-contract/fixture-model"),
                None,
                Some(NATIVE_MESSAGE_ID),
                Duration::from_secs(90),
                Some(project_path),
                None,
                None,
            )
            .await
            .expect("local synthetic model turn settles");
        let messages = manager
            .list_messages(&session.id, &None)
            .await
            .expect("read actual persisted OpenCode history");
        assert_eq!(
            observed_user_message_id(&messages, NATIVE_MESSAGE_ID).as_deref(),
            Some(NATIVE_MESSAGE_ID),
            "OpenCode must persist prompt.messageID as info.id on its user row"
        );
    })
    .await;

    let cleanup = tokio::time::timeout(Duration::from_secs(15), manager.shutdown()).await;
    model_endpoint.stop();
    assert!(
        cleanup.is_ok(),
        "owned OpenCode process cleanup completes in 15s"
    );
    assert!(
        operation.is_ok(),
        "real persistence contract completes in 120s"
    );
    operation.unwrap();
}
