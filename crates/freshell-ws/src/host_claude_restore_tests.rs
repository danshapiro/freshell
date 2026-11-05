use super::*;
use freshell_terminal::registry::{ManagedTerminalDescriptor, ManagedTerminalLaunch};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio_tungstenite::tungstenite::Message as WireMessage;

const SESSION: &str = "11111111-2222-4333-8444-555566667777";

type BeforeSpawn = Box<dyn FnOnce(&str) + Send>;
static BEFORE_SPAWN: std::sync::Mutex<Option<(String, BeforeSpawn)>> = std::sync::Mutex::new(None);

pub(super) fn before_source_revalidation(request: &str, terminal: &str) {
    let hook = {
        let mut pending = BEFORE_SPAWN.lock().unwrap();
        if pending.as_ref().is_some_and(|(id, _)| id == request) {
            pending.take()
        } else {
            None
        }
    };
    if let Some((_, hook)) = hook {
        hook(terminal);
    }
}

struct PresentHostHistory;
impl crate::existence::SessionExistenceProbe for PresentHostHistory {
    fn exists(&self, _: &str, _: &str) -> crate::existence::SessionExistence {
        crate::existence::SessionExistence::Present
    }
    fn ever_observed(&self, _: &str, _: &str) -> bool {
        true
    }
}

struct EmptyManagedHome {
    launches: Arc<AtomicUsize>,
    existing: Option<ManagedTerminalDescriptor>,
}
impl freshell_terminal::registry::ManagedTerminalController for EmptyManagedHome {
    fn lookup_terminal<'a>(
        &'a self,
        terminal_id: &'a str,
        _: Option<String>,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<
        'a,
        Result<Option<ManagedTerminalDescriptor>, String>,
    > {
        Box::pin(async move {
            Ok(self
                .existing
                .as_ref()
                .filter(|row| row.terminal_id == terminal_id)
                .cloned())
        })
    }
    fn launch<'a>(
        &'a self,
        _: ManagedTerminalLaunch,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<
        'a,
        Result<ManagedTerminalDescriptor, freshell_terminal::registry::ManagedTerminalLaunchError>,
    > {
        Box::pin(async move {
            self.launches.fetch_add(1, Ordering::SeqCst);
            Err("owned managed provider home has no original Claude transcript".into())
        })
    }
    fn input<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: String,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<
        'a,
        Result<(), freshell_terminal::registry::ManagedTerminalInputError>,
    > {
        panic!("no managed provider was launched")
    }
    fn resize<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: u16,
        _: u16,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<(), String>> {
        panic!("no managed provider was launched")
    }
    fn stop<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn read_output<'a>(
        &'a self,
        _: ManagedTerminalDescriptor,
        _: i64,
        _: u64,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<
        'a,
        Result<freshell_terminal::registry::ManagedOutputRead, String>,
    > {
        panic!("no managed provider was launched")
    }
}

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn frame_for(socket: &mut Socket, request: &str) -> Result<serde_json::Value, String> {
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(10), socket.next())
            .await
            .map_err(|_| "owned WS response timed out")?
            .ok_or("owned WS closed")?
            .map_err(|error| error.to_string())?;
        let WireMessage::Text(text) = frame else {
            continue;
        };
        let value: serde_json::Value =
            serde_json::from_str(&text).map_err(|error| error.to_string())?;
        if value["requestId"] == request {
            return Ok(value);
        }
    }
}

async fn connect(url: &str, token: &str) -> Socket {
    let mut socket = tokio_tungstenite::connect_async(url).await.unwrap().0;
    socket
        .send(WireMessage::Text(
            serde_json::json!({
                "type":"hello", "token":token,
                "protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION,
                "capabilities":{"managedRuntimeV1":true,"paneReconcileV1":true},
            })
            .to_string(),
        ))
        .await
        .unwrap();
    loop {
        let message = tokio::time::timeout(std::time::Duration::from_secs(10), socket.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        if let WireMessage::Text(text) = message {
            let value: serde_json::Value = serde_json::from_str(&text).unwrap();
            if value["type"] == "ready" {
                assert_eq!(value["capabilities"]["managedRuntimeV1"], true);
                break;
            }
        }
    }
    socket
}

async fn restore_case(kind: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let owned = tempfile::tempdir().unwrap();
    let request = format!("owned-host-claude-{kind}");
    let home = owned.path().join("host-home");
    let config = owned.path().join("selected-native-root");
    let cwd = owned.path().join("original-project");
    let project = config.join("projects/original-native-slug");
    std::fs::create_dir_all(&project).unwrap();
    std::fs::create_dir_all(home.join(".claude/projects")).unwrap();
    std::fs::create_dir_all(&cwd).unwrap();
    let transcript = project.join(format!("{SESSION}.jsonl"));
    let native_id = if kind == "wrong_identity" {
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    } else {
        SESSION
    };
    let history_cwd = if kind == "wrong_cwd" {
        let wrong = owned.path().join("other-project");
        std::fs::create_dir_all(&wrong).unwrap();
        wrong
    } else {
        cwd.clone()
    };
    let bytes = format!(
        "{}\n",
        serde_json::json!({"type":"user","sessionId":native_id,"cwd":history_cwd,"message":{"role":"user","content":"owned original conversation sentinel"}})
    );
    if !matches!(kind, "missing" | "managed_existing") {
        std::fs::write(&transcript, &bytes).unwrap();
    }
    if kind == "ambiguous" {
        let duplicate = config.join("projects/another-slug");
        std::fs::create_dir_all(&duplicate).unwrap();
        std::fs::write(duplicate.join(format!("{SESSION}.jsonl")), &bytes).unwrap();
    }
    std::env::set_var("HOME", &home);
    std::env::set_var("CLAUDE_CONFIG_DIR", home.join(".claude"));
    std::env::set_var("CLAUDE_HOME", &config);
    std::env::remove_var("FRESHELL_MANAGED_FRESH_AGENT_V1");
    let receipt = owned.path().join("native-resume-receipts.jsonl");
    let cli = owned.path().join("owned-claude.py");
    let script = r#"#!/usr/bin/python3
import json,os,pathlib,sys,time
args=sys.argv[1:]
assert '--resume' in args and '--session-id' not in args
sid=args[args.index('--resume')+1]
assert sid==@SID@
assert os.environ['HOME']==@HOME@
assert os.environ['CLAUDE_CONFIG_DIR']==@CONFIG@
assert os.getcwd()==@CWD@
source=pathlib.Path(@TRANSCRIPT@)
assert source.read_text()==@BYTES@
with pathlib.Path(@RECEIPT@).open('a') as out:
 out.write(json.dumps({'nativeId':sid,'originalConversationVerified':True,'pid':os.getpid()})+'\n');out.flush()
time.sleep(60)
"#;
    let script = script
        .replace("@SID@", &serde_json::to_string(SESSION).unwrap())
        .replace("@HOME@", &serde_json::to_string(&home).unwrap())
        .replace("@CONFIG@", &serde_json::to_string(&config).unwrap())
        .replace("@CWD@", &serde_json::to_string(&cwd).unwrap())
        .replace("@TRANSCRIPT@", &serde_json::to_string(&transcript).unwrap())
        .replace("@BYTES@", &serde_json::to_string(&bytes).unwrap())
        .replace("@RECEIPT@", &serde_json::to_string(&receipt).unwrap());
    std::fs::write(&cli, script).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut state = super::pane_reconcile_gate_tests::state();
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.registry =
        freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
    state.ownership = Some(ownership);
    state.cli_commands = Arc::new(vec![freshell_platform::CliCommandSpec {
        name: "claude".into(),
        label: "Claude".into(),
        default_cmd: cli.to_string_lossy().into_owned(),
        resume_args: Some(vec!["--resume".into(), "{{sessionId}}".into()]),
        create_session_args: Some(vec!["--session-id".into(), "{{sessionId}}".into()]),
        ..Default::default()
    }]);
    state.session_existence = Arc::new(PresentHostHistory);
    let managed_calls = Arc::new(AtomicUsize::new(0));
    state
        .registry
        .set_managed_controller(Some(Arc::new(EmptyManagedHome {
            launches: Arc::clone(&managed_calls),
            existing: (kind == "managed_existing").then(|| ManagedTerminalDescriptor {
                soul_id: "existing-claude-soul".into(),
                incarnation_id: "existing-claude-incarnation".into(),
                terminal_id: stable_managed_uuid(&request, b"terminal")
                    .simple()
                    .to_string(),
                stream_id: stable_managed_uuid(&request, b"stream").to_string(),
                mode: "claude".into(),
                cwd: cwd.to_string_lossy().into_owned(),
                resume_session_id: Some(SESSION.into()),
                create_request_id: Some(request.clone()),
            }),
        })));
    let registry = state.registry.clone();
    let token = state.auth_token.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    let (stop, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, crate::router(state))
            .with_graceful_shutdown(async {
                stopped.await.ok();
            })
            .await
    });
    let mut socket = connect(&url, &token).await;
    let mut create = serde_json::json!({"type":"terminal.create","requestId":request,"mode":"claude","shell":"system","restore":!matches!(kind,"fresh"|"wire_existing"),"cwd":cwd,"sessionRef":if kind=="fresh" {serde_json::Value::Null} else {serde_json::json!({"provider":"claude","sessionId":SESSION})}});
    if kind == "ownership_blocked" {
        create["observedEpoch"] = serde_json::json!(999_999_999_u64);
        create["observedGeneration"] = serde_json::json!(1);
    }
    let produced_mcp = Arc::new(std::sync::Mutex::new(None));
    if kind == "stale_mcp" {
        let captured = produced_mcp.clone();
        let transcript = transcript.clone();
        *BEFORE_SPAWN.lock().unwrap() = Some((
            request.clone(),
            Box::new(move |terminal| {
                use std::io::Write;
                let file = std::env::temp_dir()
                    .join("freshell-mcp")
                    .join(format!("{terminal}.json"));
                assert!(
                    file.is_file() && file.metadata().unwrap().len() > 0,
                    "actual MCP producer must have created this owned artifact"
                );
                *captured.lock().unwrap() = Some(file);
                let mut original = std::fs::OpenOptions::new()
                    .append(true)
                    .open(transcript)
                    .unwrap();
                original.write_all(b"\n").unwrap();
                original.sync_all().unwrap();
            }),
        ));
    }
    let result=async {
        socket.send(WireMessage::Text(create.to_string())).await.map_err(|e|e.to_string())?;
        let frame=frame_for(&mut socket,&request).await?;
        if kind=="fresh" {
            if managed_calls.load(Ordering::SeqCst)!=1 || receipt.exists() {return Err(format!("fresh create changed routing: {frame:?}"))}
        } else if kind=="managed_existing" {
            let terminal=frame["terminalId"].as_str().ok_or("managed adoption has no terminalID")?;
            if frame["type"]!="terminal.created" || registry.managed_descriptor(terminal).is_none() || managed_calls.load(Ordering::SeqCst)!=0 || receipt.exists() {return Err(format!("existing managed Claude was rerouted: {frame:?}"))}
        } else if kind=="ownership_blocked" {
            if frame["type"]!="error" || managed_calls.load(Ordering::SeqCst)!=0 || !registry.directory().is_empty() || receipt.exists() {return Err(format!("stale owner fence authorized a host writer: {frame:?}"))}
        } else if !matches!(kind,"verified"|"wire_existing") {
            if frame["type"]!="error" || frame["code"]!="RESTORE_UNAVAILABLE" || managed_calls.load(Ordering::SeqCst)!=0 || !registry.directory().is_empty() || receipt.exists() {return Err(format!("unqualified source {kind} did not refuse without spawn: {frame:?}, managedCalls={}",managed_calls.load(Ordering::SeqCst)))}
            if kind=="stale_mcp" {
                let artifact=produced_mcp.lock().unwrap().clone().ok_or("actual MCP producer was not observed")?;
                let leaked=artifact.exists();
                if leaked {std::fs::remove_file(artifact).unwrap();}
                if leaked {return Err("failed source revalidation leaked its actual owned MCP artifact".into());}
                if std::fs::read_to_string(&transcript).unwrap()!=format!("{bytes}\n") {return Err("refusal changed the owned source generation".into());}
            }
        } else {
            if frame["type"]!="terminal.created" {return Err(format!("existing host conversation used an empty managed store: {frame:?}, managedCalls={}",managed_calls.load(Ordering::SeqCst)))}
            let terminal=frame["terminalId"].as_str().ok_or("created has no terminalID")?.to_string();
            if registry.managed_descriptor(&terminal).is_some() || managed_calls.load(Ordering::SeqCst)!=0 {return Err("host compatibility falsely reported a managed provider".into())}
            let mut native=None;
            for _ in 0..100 {
                native=std::fs::read_to_string(&receipt).ok().and_then(|bytes|serde_json::from_str::<serde_json::Value>(bytes.trim()).ok());
                if native.is_some(){break}tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            let native=native.ok_or("owned native CLI did not verify original ID/history/HOME/cwd")?;
            if native["nativeId"]!=SESSION || native["originalConversationVerified"]!=true || native["pid"].as_u64().unwrap_or(0)==0 {return Err("owned native fixture did not verify exact original history".into())}
            let before=std::fs::read_to_string(&receipt).unwrap();
            let mut other=connect(&url,&token).await;
            other.send(WireMessage::Text(create.to_string())).await.map_err(|e|e.to_string())?;
            let adopted=frame_for(&mut other,&request).await?;
            other.close(None).await.ok();
            if adopted["terminalId"]!=terminal || std::fs::read_to_string(&receipt).unwrap()!=before || registry.directory().len()!=1 {return Err(format!("duplicate restore started another writer: {adopted:?}"))}
            if std::fs::read_to_string(&transcript).unwrap()!=bytes {return Err("restore changed the original native history".into())}
        }
        Ok(())
    }.await;
    socket.close(None).await.ok();
    drop(socket);
    registry.kill_all();
    stop.send(()).ok();
    tokio::time::timeout(std::time::Duration::from_secs(10), server)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    result
}

#[test]
fn managed_claude_restore_uses_original_host_conversation_and_preserves_refusals() {
    const CHILD: &str = "FRESHELL_HOST_CLAUDE_RESTORE_TEST_CHILD";
    if std::env::var(CHILD).ok().as_deref() != Some("1") {
        let selector="terminal::host_claude_restore_tests::managed_claude_restore_uses_original_host_conversation_and_preserves_refusals";
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", selector, "--nocapture", "--test-threads=1"])
            .env(CHILD, "1")
            .status()
            .unwrap();
        assert!(
            status.success(),
            "private native/WS restore subprocess failed"
        );
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let failures: Vec<_> = [
        "verified",
        "missing",
        "ambiguous",
        "wrong_identity",
        "wrong_cwd",
        "ownership_blocked",
        "wire_existing",
        "managed_existing",
        "stale_mcp",
        "fresh",
    ]
    .into_iter()
    .filter_map(|kind| {
        runtime
            .block_on(restore_case(kind))
            .err()
            .map(|e| format!("{kind}: {e}"))
    })
    .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
