#![cfg(unix)]

//! Headless REST automation uses the owning Codex runtime and shared name store.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "codex-rest-owned-fixture";

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

fn find_file(root: &Path, name: &str) -> Option<PathBuf> {
    for entry in std::fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Some(found) = find_file(&path, name) {
                return Some(found);
            }
        } else if entry.file_name() == name {
            return Some(path);
        }
    }
    None
}

#[tokio::test]
async fn task009_codex_rest_saved_name_binds_to_the_actual_persisted_native_thread() {
    assert_saved_name(SavedNameScenario::Persisted).await;
}

#[tokio::test]
async fn task009_codex_rest_name_survives_a_connected_ws_control_runtime() {
    assert_saved_name(SavedNameScenario::ConnectedControl).await;
}

#[tokio::test]
async fn task009_codex_rest_name_survives_native_hydration_during_dispatch() {
    assert_saved_name(SavedNameScenario::HydrationDuringDispatch).await;
}

#[tokio::test]
async fn task010_codex_rest_adopted_pane_reads_the_established_conversation_name() {
    assert_saved_name(SavedNameScenario::AdoptEstablished).await;
}

#[derive(Clone, Copy)]
enum SavedNameScenario {
    Persisted,
    ConnectedControl,
    HydrationDuringDispatch,
    AdoptEstablished,
}

async fn assert_saved_name(scenario: SavedNameScenario) {
    let home = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let project = workspace.path();
    std::fs::create_dir_all(home.path().join(".freshell")).unwrap();
    std::fs::write(
        home.path().join(".freshell/config.json"),
        json!({"settings":{
            "freshAgent":{"enabled":true},"codingCli":{"enabledProviders":["codex"]},"network":{"configured":true,"host":"127.0.0.1"}
        }})
        .to_string(),
    )
    .unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs");
    let wrapper = workspace.path().join("codex.mjs");
    std::fs::write(&wrapper, format!(r#"#!/usr/bin/env node
import {{ randomUUID }} from 'node:crypto'
import path from 'node:path'
const threadId=randomUUID()
const now=new Date()
const rollout=path.join(process.env.CODEX_HOME,'sessions',String(now.getUTCFullYear()),String(now.getUTCMonth()+1).padStart(2,'0'),String(now.getUTCDate()).padStart(2,'0'),`rollout-${{threadId}}.jsonl`)
process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR=JSON.stringify({{
  ...JSON.parse(process.env.FAKE_CODEX_APP_SERVER_BEHAVIOR),threadStartThreadId:threadId,
  writeRolloutOnMethods:{{'turn/start':{{path:rollout,record:{{type:'session_meta',payload:{{id:threadId,cwd:process.cwd()}}}}}}}},
}})
await import({})
"#,json!(fixture))).unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
    let log = std::fs::File::create(home.path().join("server.log")).unwrap();
    let bin = std::env::var_os("FRESHELL_SERVER_BIN")
        .unwrap_or_else(|| env!("CARGO_BIN_EXE_freshell-server").into());
    let mut server = OwnedServer(
        Command::new(bin)
            .current_dir(home.path())
            .env("PORT", port.to_string())
            .env("AUTH_TOKEN", TOKEN)
            .env("FRESHELL_BIND_HOST", "127.0.0.1")
            .env("HOME", home.path())
            .env("FRESHELL_HOME", home.path())
            .env("CODEX_HOME", home.path().join(".codex"))
            .env("CODEX_CMD", &wrapper)
            .env("FAKE_CODEX_APP_SERVER_ALLOW_DURABLE_WRITES", "1")
            .env(
                "FAKE_CODEX_APP_SERVER_BEHAVIOR",
                json!({"recordTurns":true,"echoRequestedModel":true}).to_string(),
            )
            .env_remove("FRESHELL_MANAGED_RUNTIME_V1")
            .env_remove("FRESHELL_MANAGED_FRESH_AGENT_V1")
            .stdin(Stdio::null())
            .stdout(log.try_clone().unwrap())
            .stderr(log)
            .spawn()
            .unwrap(),
    );
    let base = format!("http://127.0.0.1:{port}");
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
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
        assert!(
            server.0.try_wait().unwrap().is_none(),
            "owned server exited"
        );
        assert!(Instant::now() < end, "owned server did not start");
        tokio::time::sleep(Duration::from_millis(30)).await;
    }
    let mut control_socket = None;
    if matches!(scenario, SavedNameScenario::ConnectedControl) {
        let (mut socket, _) = tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}/ws"))
            .await
            .unwrap();
        socket.send(Message::Text(json!({"type":"hello","protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION,"token":TOKEN}).to_string())).await.unwrap();
        async fn frame(
            socket: &mut tokio_tungstenite::WebSocketStream<
                tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
            >,
            wanted: &str,
        ) -> Value {
            tokio::time::timeout(Duration::from_secs(10), async {
                loop {
                    if let Message::Text(raw) = socket.next().await.unwrap().unwrap() {
                        let value: Value = serde_json::from_str(&raw).unwrap();
                        assert_ne!(value["type"], "freshAgent.create.failed", "{value}");
                        if value["type"] == wanted {
                            break value;
                        }
                    }
                }
            })
            .await
            .unwrap()
        }
        frame(&mut socket, "ready").await;
        socket.send(Message::Text(json!({"type":"freshAgent.create","requestId":"control-create","provider":"codex","sessionType":"freshcodex","cwd":project,"namingHandle":"nh-ws-control"}).to_string())).await.unwrap();
        let control = frame(&mut socket, "freshAgent.created").await;
        socket.send(Message::Text(json!({"type":"freshAgent.send","requestId":"control-send","provider":"codex","sessionType":"freshcodex","sessionId":control["sessionId"],"text":"normal native control"}).to_string())).await.unwrap();
        frame(&mut socket, "freshAgent.send.accepted").await;
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot: Value = http
                .get(format!(
                    "{base}/api/fresh-agent/threads/freshcodex/codex/{}",
                    control["sessionId"].as_str().unwrap()
                ))
                .header("x-auth-token", TOKEN)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            if snapshot["status"] == "idle"
                && snapshot["turns"]
                    .as_array()
                    .is_some_and(|rows| rows.len() == 2)
            {
                break;
            }
            assert!(Instant::now() < end, "control turn must settle normally");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        control_socket = Some(socket);
    }
    let created: Value = http
        .post(format!("{base}/api/tabs"))
        .header("x-auth-token", TOKEN)
        .json(&json!({"agent":"codex","cwd":project,"model":"provider-current","effort":"xhigh","collaborationMode":"plan","sandbox":"workspace-write","permissionMode":"on-request"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let thread = created["data"]["sessionRef"]["sessionId"].as_str().unwrap();
    uuid::Uuid::parse_str(thread).unwrap();
    let pane = created["data"]["paneId"].as_str().unwrap();
    let send_http = http.clone();
    let send_url = format!("{base}/api/panes/{pane}/send-keys");
    let sending = tokio::spawn(async move {
        send_http.post(send_url).header("x-auth-token",TOKEN)
            .json(&json!({"data":"persist native naming metadata\r","requestId":"task009-name-send","timeout":3}))
            .send().await.unwrap().error_for_status().unwrap().json::<Value>().await.unwrap()
    });
    if matches!(scenario, SavedNameScenario::HydrationDuringDispatch) {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            let snapshot: Value = http
                .get(format!(
                    "{base}/api/fresh-agent/threads/freshcodex/codex/{thread}"
                ))
                .header("x-auth-token", TOKEN)
                .send()
                .await
                .unwrap()
                .error_for_status()
                .unwrap()
                .json()
                .await
                .unwrap();
            if snapshot["turns"]
                .as_array()
                .is_some_and(|rows| rows.len() == 2)
            {
                break;
            }
            assert!(Instant::now() < end, "native turn must become readable");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    let sent = sending.await.unwrap();
    assert_eq!(sent["data"]["status"], "idle", "{sent}");
    let metadata_deadline = Instant::now() + Duration::from_secs(5);
    let rollout = loop {
        if let Some(path) = find_file(
            &home.path().join(".codex/sessions"),
            &format!("rollout-{thread}.jsonl"),
        ) {
            break path;
        }
        assert!(
            Instant::now() < metadata_deadline,
            "the executable native fake must persist its actual rollout"
        );
        tokio::time::sleep(Duration::from_millis(5)).await;
    };
    let persisted = std::fs::read_to_string(&rollout).unwrap();
    let meta: Value = serde_json::from_str(persisted.lines().next().unwrap()).unwrap();
    assert_eq!(meta["type"], "session_meta");
    assert_eq!(meta["payload"]["id"], thread);
    assert_eq!(meta["payload"]["cwd"], project.to_str().unwrap());
    let snapshot_deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let snapshot: Value = http
            .get(format!(
                "{base}/api/fresh-agent/threads/freshcodex/codex/{thread}"
            ))
            .header("x-auth-token", TOKEN)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        if snapshot["status"] == "idle"
            && snapshot["turns"]
                .as_array()
                .is_some_and(|rows| rows.len() == 2)
        {
            break;
        }
        assert!(
            Instant::now() < snapshot_deadline,
            "the owning runtime must consume normal completion: {snapshot}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    // Other background writers and canonical live adoption must not detach
    // this conversation's pending-to-durable naming binding.
    let split: Value = http
        .post(format!("{base}/api/panes/{pane}/split"))
        .header("x-auth-token", TOKEN)
        .json(&json!({"agent":"codex","direction":"vertical","cwd":project}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_ne!(split["data"]["sessionRef"], created["data"]["sessionRef"]);
    let other: Value = http
        .post(format!("{base}/api/tabs"))
        .header("x-auth-token", TOKEN)
        .json(&json!({"agent":"codex","cwd":project}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let adopted: Value = http
        .post(format!("{base}/api/tabs"))
        .header("x-auth-token", TOKEN)
        .json(&json!({"agent":"codex","sessionRef":other["data"]["sessionRef"]}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(adopted["data"]["sessionRef"], other["data"]["sessionRef"]);
    let renamed: Value = http
        .patch(format!("{base}/api/panes/{pane}"))
        .header("x-auth-token", TOKEN)
        .json(&json!({"name":"Task009 saved Codex","nameIntent":"user"}))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    let end = Instant::now() + Duration::from_secs(5);
    loop {
        let names: Value = http
            .post(format!("{base}/api/session-names/read"))
            .header("x-auth-token", TOKEN)
            .json(&json!({"refs":[{"kind":"session","provider":"codex","sessionId":thread}]}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let record = &names["names"][0]["record"];
        if record["ref"] == json!({"kind":"session","provider":"codex","sessionId":thread})
            && record["name"] == "Task009 saved Codex"
            && record["source"] == "manual"
        {
            break;
        }
        let saved_names = find_file(home.path(), "session-names.json")
            .map(|path| std::fs::read_to_string(path).unwrap());
        assert!(Instant::now()<end,"valid UUID/native metadata and idle owning snapshot established; rename={renamed}; reads={names}; persisted name document={saved_names:?}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if matches!(scenario, SavedNameScenario::AdoptEstablished) {
        let adopted: Value = http
            .post(format!("{base}/api/tabs"))
            .header("x-auth-token", TOKEN)
            .json(&json!({"agent":"codex","cwd":project,
                "sessionRef":{"provider":"codex","sessionId":thread},
                "namingHandle":"nh-established-adoption"}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let tab = adopted["data"]["tabId"].as_str().unwrap();
        let layout: Value = http
            .get(format!("{base}/api/layout/snapshot"))
            .header("x-auth-token", TOKEN)
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        let content = &layout["data"]["layouts"][tab]["content"];
        assert_eq!(
            content["sessionRef"],
            json!({"provider":"codex","sessionId":thread}),
            "{layout}"
        );
        // Follow the published pane's naming identity, just as a fresh browser
        // does; an unrelated newly admitted pending handle cannot hide Resume's
        // established durable record.
        let name_ref = content.get("nameRef").cloned().unwrap_or_else(|| {
            content
                .get("namingHandle")
                .map(|handle| json!({"kind":"pending","id":handle}))
                .unwrap_or_else(|| json!({"kind":"session","provider":"codex","sessionId":thread}))
        });
        let names: Value = http
            .post(format!("{base}/api/session-names/read"))
            .header("x-auth-token", TOKEN)
            .json(&json!({"refs":[name_ref]}))
            .send()
            .await
            .unwrap()
            .error_for_status()
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(names["names"][0]["record"]["name"], "Task009 saved Codex",
            "the REST-published adopted pane must resolve the established manual name; pane={content}; names={names}");
        assert_eq!(
            names["names"][0]["record"]["ref"],
            json!({"kind":"session","provider":"codex","sessionId":thread}),
            "{names}"
        );
        assert_eq!(names["names"][0]["record"]["source"], "manual", "{names}");
    }
    if let Some(mut socket) = control_socket {
        let _ = socket.close(None).await;
    }
}
