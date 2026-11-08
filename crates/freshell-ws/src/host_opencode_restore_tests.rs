use super::*;
use freshell_terminal::registry::{ManagedTerminalDescriptor, ManagedTerminalLaunch};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio_tungstenite::tungstenite::Message as WireMessage;

const SESSION: &str = "ses_original_host_restore";

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
    lookup_error: Option<String>,
    native_owned: Arc<AtomicBool>,
    native_lookup_error: bool,
}
impl freshell_terminal::registry::ManagedTerminalController for EmptyManagedHome {
    fn owns_native_session<'a>(
        &'a self,
        provider: &'a str,
        session_id: &'a str,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<'a, Result<bool, String>> {
        Box::pin(async move {
            assert_eq!((provider, session_id), ("opencode", SESSION));
            if self.native_lookup_error {
                return Err("owned native inventory unavailable".into());
            }
            Ok(self.native_owned.load(Ordering::SeqCst))
        })
    }
    fn lookup_terminal<'a>(
        &'a self,
        terminal_id: &'a str,
        _: Option<String>,
    ) -> freshell_terminal::registry::ManagedTerminalFuture<
        'a,
        Result<Option<ManagedTerminalDescriptor>, String>,
    > {
        Box::pin(async move {
            if let Some(error) = &self.lookup_error {
                return Err(error.clone());
            }
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
            Err("owned managed provider home has no original OpenCode transcript".into())
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

fn create_native_database(path: &std::path::Path, session: Option<&str>, cwd: &std::path::Path) {
    let database = rusqlite::Connection::open(path).unwrap();
    database.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY, directory TEXT NOT NULL, project_id TEXT NOT NULL, workspace_id TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, title TEXT, version TEXT);").unwrap();
    if let Some(session) = session {
        database.execute("INSERT INTO session VALUES(?1,?2,'owned-original-project',NULL,1,2,'original metadata','1.19.5')",
            rusqlite::params![session,cwd.to_str().unwrap()]).unwrap();
    }
}

async fn restore_case(kind: &str) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let owned = tempfile::tempdir().unwrap();
    let request = format!("owned-host-opencode-{kind}");
    let home = owned.path().join("host-home");
    let cwd = owned.path().join("original-project");
    let other_cwd = owned.path().join("other-project");
    let config = home.join("original-config");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&other_cwd).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    let data_base = if kind == "xdg" {
        home.join("original-data")
    } else {
        home.join(".local/share")
    };
    let data = data_base.join("opencode");
    std::fs::create_dir_all(&data).unwrap();
    let database = data.join("opencode.db");
    create_native_database(
        &database,
        if matches!(
            kind,
            "missing" | "managed_existing" | "restore_missing_identity"
        ) {
            None
        } else if kind == "wrong_identity" {
            Some("ses_other_original")
        } else {
            Some(SESSION)
        },
        if kind == "wrong_cwd" {
            &other_cwd
        } else {
            &cwd
        },
    );
    if kind == "ambiguous" {
        create_native_database(&data.join("opencode-dev.db"), Some(SESSION), &cwd);
    }
    std::env::set_var("HOME", &home);
    std::env::set_var("XDG_CONFIG_HOME", &config);
    for key in ["OPENCODE_DB", "OPENCODE_TEST_HOME", "XDG_DATA_HOME"] {
        std::env::remove_var(key);
    }
    if kind == "xdg" {
        std::env::set_var("XDG_DATA_HOME", &data_base);
    }
    if kind == "unsupported_override" {
        std::env::set_var("OPENCODE_DB", &database);
    }
    std::env::remove_var("FRESHELL_MANAGED_FRESH_AGENT_V1");
    let project_config = cwd.join(".opencode/opencode.json");
    std::fs::create_dir_all(project_config.parent().unwrap()).unwrap();
    std::fs::write(&project_config, r#"{"model":"owned-original/model"}"#).unwrap();
    let receipt = owned.path().join("native-resume-receipts.jsonl");
    let cli = owned.path().join("owned-opencode.py");
    let script = r#"#!/usr/bin/python3
import json,os,pathlib,sqlite3,sys,time
args=sys.argv[1:]
assert '--session' in args and '--continue' not in args
sid=args[args.index('--session')+1]
assert sid==@SID@
assert os.environ['HOME']==@HOME@
assert os.environ['XDG_CONFIG_HOME']==@CONFIG@
assert 'OPENCODE_DB' not in os.environ
assert os.getcwd()==@CWD@
data=pathlib.Path(os.environ.get('XDG_DATA_HOME',str(pathlib.Path(os.environ['HOME'])/'.local/share')))/'opencode'/'opencode.db'
assert str(data)==@DATABASE@
con=sqlite3.connect(data.as_uri()+'?mode=ro',uri=True)
con.execute('PRAGMA query_only=ON')
assert con.execute('SELECT id,directory,project_id,time_created FROM session WHERE id=?',(sid,)).fetchone()==(sid,@CWD@,'owned-original-project',1)
con.close()
with pathlib.Path(@RECEIPT@).open('a') as out:
 out.write(json.dumps({'nativeId':sid,'originalConversationVerified':True,'pid':os.getpid(),'database':str(data)})+'\n');out.flush()
time.sleep(60)
"#;
    let script = script
        .replace("@SID@", &serde_json::to_string(SESSION).unwrap())
        .replace("@HOME@", &serde_json::to_string(&home).unwrap())
        .replace("@CONFIG@", &serde_json::to_string(&config).unwrap())
        .replace("@CWD@", &serde_json::to_string(&cwd).unwrap())
        .replace("@DATABASE@", &serde_json::to_string(&database).unwrap())
        .replace("@RECEIPT@", &serde_json::to_string(&receipt).unwrap());
    std::fs::write(&cli, script).unwrap();
    std::fs::set_permissions(&cli, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut state = super::pane_reconcile_gate_tests::state();
    let ownership = Arc::new(freshell_ownership::RuntimeOwnershipRegistry::new());
    state.registry =
        freshell_terminal::TerminalRegistry::new().with_ownership(Arc::clone(&ownership));
    state.ownership = Some(ownership);
    let mut specification = freshell_platform::CliCommandSpec {
        name: "opencode".into(),
        label: "OpenCode".into(),
        default_cmd: cli.to_string_lossy().into_owned(),
        resume_args: Some(vec!["--session".into(), "{{sessionId}}".into()]),
        ..Default::default()
    };
    if kind == "child_env_changed" {
        specification.base_env.insert(
            "HOME".into(),
            owned
                .path()
                .join("unrelated-home")
                .to_string_lossy()
                .into_owned(),
        );
    }
    state.cli_commands = Arc::new(vec![specification]);
    state.session_existence = Arc::new(PresentHostHistory);
    let managed_calls = Arc::new(AtomicUsize::new(0));
    let native_owned = Arc::new(AtomicBool::new(matches!(
        kind,
        "managed_other_key" | "managed_other_key_stopped" | "managed_other_key_recovery_pending"
    )));
    state
        .registry
        .set_managed_controller(Some(Arc::new(EmptyManagedHome {
            launches: Arc::clone(&managed_calls),
            native_owned: Arc::clone(&native_owned),
            native_lookup_error: kind == "managed_native_lookup_error",
            lookup_error: match kind {
                "managed_lookup_error" => Some("owned inventory unavailable".into()),
                "managed_stopped" => Some("managed terminal is stopped".into()),
                "managed_recovery_pending" => Some("managed terminal recovery is pending".into()),
                _ => None,
            },
            existing: (kind == "managed_existing").then(|| ManagedTerminalDescriptor {
                soul_id: "existing-opencode-soul".into(),
                incarnation_id: "existing-opencode-incarnation".into(),
                terminal_id: stable_managed_uuid(&request, b"terminal")
                    .simple()
                    .to_string(),
                stream_id: stable_managed_uuid(&request, b"stream").to_string(),
                mode: "opencode".into(),
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
    let fresh = matches!(kind, "fresh" | "preallocated");
    let mut create = serde_json::json!({"type":"terminal.create","requestId":request,"mode":"opencode","shell":"system",
        "restore":!fresh&&kind!="wire_existing","cwd":cwd,
        "sessionRef":if kind=="fresh"||kind=="restore_missing_identity" {serde_json::Value::Null}
        else {serde_json::json!({"provider":"opencode","sessionId":if kind=="preallocated" {"freshopencode-owned"}else{SESSION}})}});
    if kind == "ownership_blocked" {
        create["observedEpoch"] = serde_json::json!(999_999_999_u64);
        create["observedGeneration"] = serde_json::json!(1);
    }
    let mcp_observed = Arc::new(std::sync::Mutex::new(false));
    let held_wal = Arc::new(std::sync::Mutex::new(None::<rusqlite::Connection>));
    if matches!(
        kind,
        "late_missing"
            | "late_cwd_mcp"
            | "late_duplicate"
            | "db_replaced"
            | "unrelated_wal"
            | "managed_late_owner"
            | "late_identity"
            | "mutable_title"
    ) {
        let database = database.clone();
        let data = data.clone();
        let other_cwd = other_cwd.clone();
        let cwd = cwd.clone();
        let mode = kind.to_string();
        let observed = mcp_observed.clone();
        let wal = held_wal.clone();
        let managed_claim = Arc::clone(&native_owned);
        *BEFORE_SPAWN.lock().unwrap() = Some((
            request.clone(),
            Box::new(move |_| {
                if mode == "late_cwd_mcp" {
                    let path = cwd.join(".opencode/.freshell-mcp-state.json");
                    if path.is_file() {
                        let value: serde_json::Value =
                            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
                        *observed.lock().unwrap() = value["refCount"].as_i64().unwrap_or(0) > 0;
                    }
                }
                if mode == "managed_late_owner" {
                    managed_claim.store(true, Ordering::SeqCst);
                } else if mode == "db_replaced" {
                    std::fs::rename(&database, data.join("preserved-original.db")).unwrap();
                    create_native_database(&database, Some(SESSION), &cwd);
                } else if mode == "late_duplicate" {
                    create_native_database(&data.join("opencode-late.db"), Some(SESSION), &cwd);
                } else {
                    let connection = rusqlite::Connection::open(&database).unwrap();
                    if mode == "unrelated_wal" {
                        connection
                            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;")
                            .unwrap();
                        connection.execute("INSERT INTO session VALUES('ses_unrelated',?1,'unrelated',NULL,3,4,'unrelated','1.19.5')",[cwd.to_str().unwrap()]).unwrap();
                        *wal.lock().unwrap() = Some(connection);
                    } else if mode == "late_missing" {
                        connection
                            .execute("DELETE FROM session WHERE id=?1", [SESSION])
                            .unwrap();
                    } else if mode == "late_identity" {
                        connection.execute("UPDATE session SET project_id='other-project-identity' WHERE id=?1", [SESSION]).unwrap();
                    } else if mode == "mutable_title" {
                        connection.execute("UPDATE session SET title='changed-title',time_updated=3 WHERE id=?1", [SESSION]).unwrap();
                    } else {
                        connection
                            .execute(
                                "UPDATE session SET directory=?1 WHERE id=?2",
                                rusqlite::params![other_cwd.to_str().unwrap(), SESSION],
                            )
                            .unwrap();
                    }
                }
            }),
        ));
    }
    let result = async {
        socket.send(WireMessage::Text(create.to_string())).await.map_err(|e|e.to_string())?;
        let frame=frame_for(&mut socket,&request).await?;
        if fresh {
            if managed_calls.load(Ordering::SeqCst)!=1||receipt.exists(){return Err(format!("fresh/preallocated routing changed: {frame:?}"))}
        } else if kind=="managed_existing" {
            let terminal=frame["terminalId"].as_str().ok_or("managed adoption has no terminalID")?;
            if frame["type"]!="terminal.created"||registry.managed_descriptor(terminal).is_none()||managed_calls.load(Ordering::SeqCst)!=0||receipt.exists(){return Err(format!("existing managed OpenCode rerouted: {frame:?}"))}
        } else if kind.starts_with("managed_")||kind=="ownership_blocked" {
            if frame["type"]!="error"||managed_calls.load(Ordering::SeqCst)!=0||!registry.directory().is_empty()||receipt.exists(){return Err(format!("owned managed/ownership refusal fell through to a host writer: {frame:?}"))}
        } else if !matches!(kind,"verified"|"wire_existing"|"xdg"|"unrelated_wal"|"mutable_title") {
            if frame["type"]!="error"||frame["code"]!="RESTORE_UNAVAILABLE"||managed_calls.load(Ordering::SeqCst)!=0||!registry.directory().is_empty()||receipt.exists(){return Err(format!("unqualified source {kind} did not refuse without spawn: {frame:?}, managedCalls={}",managed_calls.load(Ordering::SeqCst)))}
            if kind=="late_cwd_mcp" {
                if !*mcp_observed.lock().unwrap(){return Err("actual MCP producer was not observed".into())}
                if cwd.join(".opencode/.freshell-mcp-state.json").exists(){return Err("late source refusal leaked owned MCP state".into())}
                let value:serde_json::Value=serde_json::from_str(&std::fs::read_to_string(&project_config).unwrap()).unwrap();
                if value["mcp"].get("freshell").is_some()||value["model"]!="owned-original/model"{return Err("late refusal changed original config or retained injected MCP entry".into())}
            }
        } else {
            if frame["type"]!="terminal.created"{return Err(format!("original host OpenCode used an empty/downgraded managed store: {frame:?}, managedCalls={}",managed_calls.load(Ordering::SeqCst)))}
            let terminal=frame["terminalId"].as_str().ok_or("created has no terminalID")?.to_string();
            if registry.managed_descriptor(&terminal).is_some()||managed_calls.load(Ordering::SeqCst)!=0{return Err("host restore falsely claimed managed ownership".into())}
            let mut native=None;
            for _ in 0..100 {
                native=std::fs::read_to_string(&receipt).ok().and_then(|b|serde_json::from_str::<serde_json::Value>(b.trim()).ok());
                if native.is_some(){break}tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            let native=native.ok_or("owned native CLI did not verify original ID/database/HOME/cwd")?;
            if native["nativeId"]!=SESSION||native["originalConversationVerified"]!=true||native["pid"].as_u64().unwrap_or(0)==0{return Err("fakeCLI did not verify original native source".into())}
            let before=std::fs::read_to_string(&receipt).unwrap();
            let mut other=connect(&url,&token).await;
            other.send(WireMessage::Text(create.to_string())).await.map_err(|e|e.to_string())?;
            let adopted=frame_for(&mut other,&request).await?;other.close(None).await.ok();
            if adopted["terminalId"]!=terminal||std::fs::read_to_string(&receipt).unwrap()!=before||registry.directory().len()!=1{return Err(format!("duplicate restored another writer: {adopted:?}"))}
            if kind=="unrelated_wal" && (held_wal.lock().unwrap().is_none()||!data.join("opencode.db-wal").is_file()) {
                return Err("unrelated committed WAL mutation was not exercised".into())
            }
        }
        Ok(())
    }.await;
    *BEFORE_SPAWN.lock().unwrap() = None;
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
fn managed_opencode_restore_uses_original_host_history_and_preserves_fences() {
    const CHILD: &str = "FRESHELL_HOST_OPENCODE_RESTORE_TEST_CHILD";
    if std::env::var(CHILD).ok().as_deref() != Some("1") {
        let selector="terminal::host_opencode_restore_tests::managed_opencode_restore_uses_original_host_history_and_preserves_fences";
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", selector, "--nocapture", "--test-threads=1"])
            .env(CHILD, "1")
            .status()
            .unwrap();
        assert!(
            status.success(),
            "private native/WS OpenCode restore subprocess failed"
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
        "wire_existing",
        "xdg",
        "unrelated_wal",
        "mutable_title",
        "missing",
        "wrong_identity",
        "wrong_cwd",
        "ambiguous",
        "unsupported_override",
        "child_env_changed",
        "late_missing",
        "late_cwd_mcp",
        "late_duplicate",
        "late_identity",
        "db_replaced",
        "managed_existing",
        "managed_lookup_error",
        "managed_stopped",
        "managed_recovery_pending",
        "managed_other_key",
        "managed_other_key_stopped",
        "managed_other_key_recovery_pending",
        "managed_native_lookup_error",
        "managed_late_owner",
        "ownership_blocked",
        "restore_missing_identity",
        "fresh",
        "preallocated",
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
