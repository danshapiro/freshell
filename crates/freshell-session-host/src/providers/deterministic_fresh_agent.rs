//! Deterministic fresh-agent transport used only by managed-runtime qualification.
//!
//! The transport is compiled into the test session host, runs inside the soul,
//! persists only hashes and provider-native identifiers, and owns a real
//! unprivileged child process so supervisor recovery exercises the same
//! process/enclosure boundaries as provider adapters.

use async_trait::async_trait;
use freshell_agent_runtime::{
    host_actor::{
        DispatchAck, DispatchFailure, FreshAgentProfile, FreshAgentTransport, TransportStart,
    },
    ProviderStoreProbe,
};
use freshell_runtime_protocol::{
    AgentEvent, EvidenceStoreState, FreshProvider, RecoveryBlockReason, RequestId, ResumeSpec,
    RetryHint,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::process::Stdio;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::io::AsyncWriteExt;
use tokio::{
    process::{Child, Command},
    sync::{mpsc, Mutex},
};

const STATE_FILE: &str = "provider-native-state.json";
const EVENT_CAPACITY: usize = 128;
pub(crate) const PENDING_CONTROL: &str = "[freshell-fixture:pending-approval]";
pub(crate) const HANG_AFTER_ACCEPT_CONTROL: &str = "[freshell-fixture:hang-after-accept]";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FixtureState {
    schema_version: u32,
    native_session_id: String,
    dispatch_count: u64,
    completion_count: u64,
    pending_decision_id: Option<String>,
    #[serde(default)]
    create_profile: Option<FreshAgentProfile>,
}

pub(crate) struct DeterministicFreshAgentTransport {
    state_dir: PathBuf,
    provider: FreshProvider,
    state: Mutex<FixtureState>,
    child: Mutex<Option<Child>>,
    event_tx: mpsc::Sender<AgentEvent>,
    event_rx: std::sync::Mutex<Option<mpsc::Receiver<AgentEvent>>>,
    run_as_uid: u32,
    run_as_gid: u32,
    helpers: ProviderStateHelpers,
}

impl DeterministicFreshAgentTransport {
    pub(crate) async fn open(
        state_dir: impl Into<PathBuf>,
        profile: &FreshAgentProfile,
        run_as_uid: u32,
        run_as_gid: u32,
    ) -> Result<Arc<Self>, String> {
        let state_dir = state_dir.into();
        let helpers = ProviderStateHelpers::default();
        let state = if let Some(state) =
            read_provider_state(&state_dir, run_as_uid, run_as_gid, &helpers).await?
        {
            state
        } else {
            FixtureState {
                schema_version: 1,
                native_session_id: fixture_native_id(profile),
                dispatch_count: 0,
                completion_count: 0,
                pending_decision_id: None,
                create_profile: None,
            }
        };
        if profile
            .native_session_id
            .as_deref()
            .is_some_and(|expected| expected != state.native_session_id)
        {
            return Err("deterministic provider native identity mismatch".into());
        }
        write_provider_state(&state_dir, &state, run_as_uid, run_as_gid, &helpers).await?;
        let (event_tx, event_rx) = mpsc::channel(EVENT_CAPACITY);
        Ok(Arc::new(Self {
            state_dir,
            provider: profile.provider.clone(),
            state: Mutex::new(state),
            child: Mutex::new(None),
            event_tx,
            event_rx: std::sync::Mutex::new(Some(event_rx)),
            run_as_uid,
            run_as_gid,
            helpers,
        }))
    }

    async fn spawn_provider_process(&self) -> Result<(), String> {
        let mut slot = self.child.lock().await;
        if let Some(child) = slot.as_mut() {
            if child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                return Ok(());
            }
        }
        #[cfg(test)]
        let mut command = {
            let mut command = Command::new("/bin/sleep");
            command.arg("3600");
            command
        };
        #[cfg(not(test))]
        let mut command = {
            let executable = std::env::current_exe().map_err(|error| error.to_string())?;
            let mut command = Command::new(executable);
            command
                .arg("fresh-agent-fixture-worker")
                .arg("--provider")
                .arg(self.provider.as_str())
                .arg("--observation-file")
                .arg(self.state_dir.join("provider-child-observation.json"));
            if let Some(secrets) = freshell_platform::managed_child_secrets::snapshot() {
                command.envs(secrets);
            }
            command
        };
        command.kill_on_drop(true);
        #[cfg(unix)]
        {
            command.uid(self.run_as_uid).gid(self.run_as_gid);
        }
        let child = command
            .spawn()
            .map_err(|error| format!("spawn deterministic provider process: {error}"))?;
        *slot = Some(child);
        Ok(())
    }

    async fn emit_completion(&self, request_id: &RequestId) -> Result<(), DispatchFailure> {
        let (native_session_id, turn_id, message_id) = {
            let mut state = self.state.lock().await;
            state.completion_count = state.completion_count.saturating_add(1);
            let ordinal = state.completion_count;
            let turn_id = format!("turn-{}-{ordinal}", short_hash(request_id.as_str()));
            let message_id = format!("assistant-{}-{ordinal}", short_hash(&turn_id));
            let native = state.native_session_id.clone();
            write_provider_state(
                &self.state_dir,
                &state,
                self.run_as_uid,
                self.run_as_gid,
                &self.helpers,
            )
            .await
            .map_err(non_ambiguous)?;
            (native, turn_id, message_id)
        };
        let completion = json!({"provider":self.provider.as_str(), "nativeId":native_session_id,
            "turnId":turn_id, "messageId":message_id, "requestId":request_id.as_str(), "at":unix_millis()});
        #[cfg(test)]
        write_native_completion(&self.state_dir, &completion).map_err(non_ambiguous)?;
        #[cfg(not(test))]
        provider_state_worker(
            &self.state_dir,
            self.run_as_uid,
            self.run_as_gid,
            &self.helpers,
            "completion",
            Some(
                &serde_json::to_vec(&completion)
                    .map_err(|error| non_ambiguous(error.to_string()))?,
            ),
        )
        .await
        .map_err(non_ambiguous)?;
        // The same completed turn is now saved under this native identity.
        // The existing proxy binds previousSessionId to its presentation ID.
        let (wire_provider, session_type) = match self.provider {
            FreshProvider::Claude => ("claude", "freshclaude"),
            FreshProvider::Kilroy => ("claude", "kilroy"),
            FreshProvider::Codex => ("codex", "freshcodex"),
            FreshProvider::Opencode => ("opencode", "freshopencode"),
        };
        self.event_tx
            .send(AgentEvent::Provider {
                payload: json!({
                    "type":"freshAgent.session.materialized",
                    "provider":wire_provider,
                    "sessionType":session_type,
                    "previousSessionId":native_session_id,
                    "sessionId":native_session_id,
                }),
            })
            .await
            .map_err(|_| non_ambiguous("deterministic event receiver closed"))?;
        self.event_tx
            .send(AgentEvent::Provider {
                payload: json!({
                    "type":"freshAgent.event",
                    "provider":self.provider.as_str(),
                    "sessionId":native_session_id,
                    "event":{
                        "type":"fixture.provider_native.assistant_message",
                        "turnId":turn_id,
                        "assistantMessageId":message_id,
                        "role":"assistant",
                        "text":"deterministic fixture completion"
                    }
                }),
            })
            .await
            .map_err(|_| non_ambiguous("deterministic event receiver closed"))?;
        self.event_tx
            .send(AgentEvent::Provider {
                payload: json!({
                    "type":"freshAgent.turn.complete",
                    "provider":self.provider.as_str(),
                    "sessionId":native_session_id,
                    "turnId":turn_id,
                    "assistantMessageId":message_id,
                    "completionKind":"provider_native_completed",
                    "at":unix_millis()
                }),
            })
            .await
            .map_err(|_| non_ambiguous("deterministic event receiver closed"))
    }
}

#[async_trait]
impl FreshAgentTransport for DeterministicFreshAgentTransport {
    async fn start(&self, profile: &FreshAgentProfile) -> Result<TransportStart, String> {
        {
            let mut state = self.state.lock().await;
            let metadata = json!({"provider":self.provider.as_str(),
                "nativeId":state.native_session_id, "cwd":profile.cwd,
                "at":unix_millis(),
                "allowCreate":state.dispatch_count == 0 && state.completion_count == 0
                    && state.pending_decision_id.is_none()});
            #[cfg(test)]
            write_native_history(&self.state_dir, &metadata, false)?;
            #[cfg(not(test))]
            provider_state_worker(
                &self.state_dir,
                self.run_as_uid,
                self.run_as_gid,
                &self.helpers,
                "initialize",
                Some(&serde_json::to_vec(&metadata).map_err(|error| error.to_string())?),
            )
            .await?;
            state.create_profile = Some(profile.clone());
            write_provider_state(
                &self.state_dir,
                &state,
                self.run_as_uid,
                self.run_as_gid,
                &self.helpers,
            )
            .await?;
        }
        // Failed metadata reads/writes never leave a newly spawned worker.
        self.spawn_provider_process().await?;
        Ok(TransportStart {
            native_session_id: Some(self.state.lock().await.native_session_id.clone()),
        })
    }

    async fn dispatch(
        &self,
        request_id: &RequestId,
        text: &str,
        _profile: &FreshAgentProfile,
    ) -> Result<DispatchAck, DispatchFailure> {
        self.spawn_provider_process().await.map_err(non_ambiguous)?;
        {
            let mut state = self.state.lock().await;
            state.dispatch_count = state.dispatch_count.saturating_add(1);
            if text == PENDING_CONTROL {
                if !matches!(self.provider, FreshProvider::Claude | FreshProvider::Kilroy) {
                    return Err(non_ambiguous(
                        "this deterministic provider has no approval flow",
                    ));
                }
                let decision_id = format!("decision-{}", short_hash(request_id.as_str()));
                state.pending_decision_id = Some(decision_id.clone());
                write_provider_state(
                    &self.state_dir,
                    &state,
                    self.run_as_uid,
                    self.run_as_gid,
                    &self.helpers,
                )
                .await
                .map_err(non_ambiguous)?;
                drop(state);
                self.event_tx
                    .send(AgentEvent::PermissionRequested {
                        decision_id: decision_id.clone(),
                        payload: json!({
                            "type":"freshAgent.permission.request",
                            "requestId":decision_id,
                            "subtype":"fixture",
                            "tool":{"name":"Read","input":{"file_path":"fixture-only"}}
                        }),
                    })
                    .await
                    .map_err(|_| non_ambiguous("deterministic event receiver closed"))?;
                return Ok(DispatchAck {
                    provider_ack_id: Some(request_id.as_str().into()),
                });
            }
            write_provider_state(
                &self.state_dir,
                &state,
                self.run_as_uid,
                self.run_as_gid,
                &self.helpers,
            )
            .await
            .map_err(non_ambiguous)?;
        }
        if text != HANG_AFTER_ACCEPT_CONTROL {
            self.emit_completion(request_id).await?;
        }
        Ok(DispatchAck {
            provider_ack_id: Some(request_id.as_str().into()),
        })
    }

    async fn resolve_permission(
        &self,
        decision_id: &str,
        _decision: Value,
    ) -> Result<(), DispatchFailure> {
        let request = {
            let mut state = self.state.lock().await;
            if state.pending_decision_id.as_deref() != Some(decision_id) {
                return Err(non_ambiguous("deterministic decision identity mismatch"));
            }
            state.pending_decision_id = None;
            write_provider_state(
                &self.state_dir,
                &state,
                self.run_as_uid,
                self.run_as_gid,
                &self.helpers,
            )
            .await
            .map_err(non_ambiguous)?;
            RequestId::parse(format!("resolved-{decision_id}"))
                .map_err(|error| non_ambiguous(error.to_string()))?
        };
        self.emit_completion(&request).await
    }

    async fn interrupt(&self) -> Result<(), String> {
        Ok(())
    }

    async fn snapshot(&self) -> Result<Value, String> {
        let state = self.state.lock().await.clone();
        // Fixture transcript setup lives in the same owned native store that
        // the history route reads. Current fixture state supplies live gates.
        let mut snapshot = read_provider_snapshot(
            &self.state_dir,
            self.provider.as_str(),
            &state.native_session_id,
            self.run_as_uid,
            self.run_as_gid,
            &self.helpers,
        )
        .await?;
        let provider = if self.provider == FreshProvider::Kilroy {
            "claude"
        } else {
            self.provider.as_str()
        };
        snapshot["extensions"][provider]
            .as_object_mut()
            .ok_or("fixture provider metadata unavailable")?
            .remove("nativeHistoryAvailable");
        snapshot["extensions"][provider]["ownerKind"] = json!("fresh-agent");
        snapshot["extensions"][provider]["statusFromLiveState"] = json!(true);
        snapshot["status"] = json!(if state.pending_decision_id.is_some() {
            "permission"
        } else if state.dispatch_count > state.completion_count {
            "running"
        } else {
            "idle"
        });
        snapshot["capabilities"]["send"] = json!(state.pending_decision_id.is_none());
        snapshot["capabilities"]["interrupt"] =
            json!(state.dispatch_count > state.completion_count);
        Ok(snapshot)
    }

    async fn is_live(&self) -> bool {
        let mut slot = self.child.lock().await;
        match slot.as_mut() {
            Some(child) => child.try_wait().ok().flatten().is_none(),
            None => false,
        }
    }

    async fn stop(self: Arc<Self>) -> Result<(), String> {
        let helper_result = self.helpers.settle().await;
        if let Some(mut child) = self.child.lock().await.take() {
            child.kill().await.map_err(|error| error.to_string())?;
            let _ = child.wait().await;
        }
        helper_result
    }

    fn take_event_stream(&self) -> Option<mpsc::Receiver<AgentEvent>> {
        self.event_rx.lock().expect("event receiver lock").take()
    }
}

pub(crate) async fn run_worker(args: &[String]) -> Result<(), String> {
    if args.len() != 4 || args[0] != "--provider" || args[2] != "--observation-file" {
        return Err("fresh-agent fixture worker requires --provider <exact-provider>".into());
    }
    match args[1].as_str() {
        "claude" | "kilroy" | "codex" | "opencode" => {}
        _ => return Err("fresh-agent fixture worker provider is not allowlisted".into()),
    }
    let child_key = match args[1].as_str() {
        "claude" => "ANTHROPIC_API_KEY",
        "codex" => "OPENAI_API_KEY",
        "opencode" => "OPENROUTER_API_KEY",
        _ => "ANTHROPIC_API_KEY",
    };
    let child_digest = std::env::var(child_key)
        .ok()
        .map(|value| format!("{:x}", Sha256::digest(value.as_bytes())));
    fs::write(
        &args[3],
        serde_json::to_vec(&json!({
            "argv": ["fresh-agent-fixture-worker", "--provider", args[1]],
            "env": {(child_key): child_digest},
            "onecliControlPresent": std::env::var_os("ONECLI_URL").is_some(),
        }))
        .map_err(|error| format!("record redacted fixture worker observation: {error}"))?,
    )
    .map_err(|error| format!("write redacted fixture worker observation: {error}"))?;
    loop {
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

/// Read-only recovery qualification for the deterministic provider state. The
/// caller supplies the soul-scoped directory so tests can prove identity
/// semantics without touching a real provider home.
pub(crate) async fn probe_resume(
    resume_spec: &ResumeSpec,
    state_dir: &Path,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<ProviderStoreProbe, String> {
    let Some(state) = read_provider_state(
        state_dir,
        run_as_uid,
        run_as_gid,
        &ProviderStateHelpers::default(),
    )
    .await?
    else {
        return Ok(ProviderStoreProbe::DefinitivelyUnavailable {
            reason: "deterministic provider state is absent".into(),
            evidence: vec!["fixtureState=missing".into()],
            store_state: EvidenceStoreState::Missing,
            negative_paths: Vec::new(),
        });
    };
    if state.schema_version != 1 {
        return Ok(ProviderStoreProbe::Blocked {
            reason: RecoveryBlockReason::IncompatibleBinary,
            retry_hint: RetryHint {
                automatic_after_ms: None,
                manual_retry: true,
                repair: Some("use a session host compatible with fixture schema 1".into()),
            },
            evidence: vec![format!("fixtureSchema={}", state.schema_version)],
        });
    }
    if state.native_session_id != resume_spec.provider_session.native_session_id {
        return Ok(ProviderStoreProbe::DefinitivelyUnavailable {
            reason: "deterministic provider state belongs to another native identity".into(),
            evidence: vec!["fixtureIdentity=wrong".into()],
            store_state: EvidenceStoreState::PresentReadable,
            negative_paths: Vec::new(),
        });
    }
    Ok(ProviderStoreProbe::Ready {
        evidence: vec![
            "fixtureTransport=deterministic".into(),
            "fixtureIdentity=exact".into(),
            format!("fixtureDispatchCount={}", state.dispatch_count),
            format!("fixtureCompletionCount={}", state.completion_count),
        ],
    })
}

fn fixture_native_id(profile: &FreshAgentProfile) -> String {
    if matches!(
        profile.provider,
        FreshProvider::Claude | FreshProvider::Kilroy
    ) {
        return uuid::Uuid::new_v4().to_string();
    }
    format!(
        "fixture-native-{}-{}",
        profile.provider.as_str(),
        short_hash(&profile.provider_store_id)
    )
}

fn short_hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..12]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn write_state(state_dir: &Path, state: &FixtureState) -> Result<(), String> {
    fs::create_dir_all(state_dir).map_err(|error| error.to_string())?;
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    let path = state_dir.join(STATE_FILE);
    let temporary = state_dir.join(format!(".{STATE_FILE}.{}.tmp", std::process::id()));
    fs::write(&temporary, bytes).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn read_state(state_dir: &Path) -> Result<Option<FixtureState>, String> {
    let path = state_dir.join(STATE_FILE);
    if !path.exists() {
        return Ok(None);
    }
    serde_json::from_slice(&fs::read(&path).map_err(|error| error.to_string())?)
        .map(Some)
        .map_err(|error| format!("decode deterministic provider state: {error}"))
}

/// Save the turn emitted by this deterministic transport in its own native
/// store. Production calls run inside the existing provider-UID state worker.
fn write_native_completion(state_dir: &Path, completion: &Value) -> Result<(), String> {
    write_native_history(state_dir, completion, true)
}

/// Initialize only fixture metadata before the first Send, or append the
/// fixture's completed turn. Both operations use the provider-UID worker.
fn write_native_history(state_dir: &Path, input: &Value, completed: bool) -> Result<(), String> {
    use std::io::Write;
    let home = state_dir
        .parent()
        .ok_or("fixture provider home unavailable")?;
    let provider = input["provider"]
        .as_str()
        .ok_or("fixture provider missing")?;
    let id = input["nativeId"]
        .as_str()
        .filter(|id| !id.is_empty() && !id.contains(['/', '\\']))
        .ok_or("fixture native identity invalid")?;
    let path = match provider {
        "claude" | "kilroy" => home
            .join(".claude/projects/managed-fixture")
            .join(format!("{id}.jsonl")),
        "codex" => home
            .join(".codex/sessions")
            .join(format!("rollout-fixture-{id}.jsonl")),
        "opencode" => home.join(".local/share/opencode/opencode.db"),
        _ => return Err("unsupported fixture native provider".into()),
    };
    if !completed {
        if path.try_exists().map_err(|error| error.to_string())? {
            // Never repair an unreadable or mismatched existing store by
            // replacing it with an empty positive snapshot.
            if provider != "opencode" {
                use std::io::BufRead;
                let mut first = String::new();
                std::io::BufReader::new(fs::File::open(&path).map_err(|error| error.to_string())?)
                    .read_line(&mut first)
                    .map_err(|error| error.to_string())?;
                let metadata: Value =
                    serde_json::from_str(&first).map_err(|error| error.to_string())?;
                let owner = if provider == "codex" {
                    metadata["payload"]["id"].as_str()
                } else {
                    metadata["sessionId"].as_str()
                };
                if owner != Some(id) {
                    return Err("fixture native history identity mismatch".into());
                }
            }
            freshell_freshagent::native_history::read(provider, home, id)?;
            return Ok(());
        }
        if input["allowCreate"] != true {
            return Err("existing fixture native history is absent".into());
        }
    }
    fs::create_dir_all(path.parent().ok_or("fixture native parent unavailable")?)
        .map_err(|error| error.to_string())?;
    if provider == "opencode" {
        // The runtime image already includes Python for its owned SQLite
        // fixtures. Use the same provider UID, no migration or host-home IO.
        let script = r#"import sqlite3,json,sys
c=json.load(sys.stdin); db=sqlite3.connect(sys.argv[1]); native=c['nativeId']; at=c['at']
db.executescript('CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER); CREATE TABLE IF NOT EXISTS message(id TEXT PRIMARY KEY,session_id TEXT,time_created INTEGER,data TEXT); CREATE TABLE IF NOT EXISTS part(id TEXT PRIMARY KEY,session_id TEXT,message_id TEXT,time_created INTEGER,data TEXT);')
db.execute('INSERT INTO session VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET time_updated=excluded.time_updated',(native,'Deterministic fixture history',at))
if c['completed']:
 for role,key,text in [('user','user-'+c['requestId'],'deterministic fixture request'),('assistant',c['messageId'],'deterministic fixture completion')]:
  data={'id':key,'sessionID':native,'role':role,'time':{'created':at,'completed':at}}
  db.execute('INSERT OR IGNORE INTO message VALUES(?,?,?,?)',(key,native,at,json.dumps(data)))
  part={'id':'part-'+key,'sessionID':native,'messageID':key,'type':'text','text':text}
  db.execute('INSERT OR IGNORE INTO part VALUES(?,?,?,?,?)',('part-'+key,native,key,at,json.dumps(part)))
db.commit(); db.close()
"#;
        #[cfg(test)]
        let script = script.replace("db.executescript(", "if c.get('writerGate'):\n import socket\n gate=socket.socket(socket.AF_UNIX); gate.settimeout(10); gate.connect(c['writerGate']); gate.sendall(b'R'); gate.recv(1); gate.close()\ndb.executescript(");
        let mut child = std::process::Command::new("python3")
            .arg("-c")
            .arg(script)
            .arg(&path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|error| error.to_string())?;
        let mut input = input.clone();
        input["completed"] = json!(completed);
        let write_result = child
            .stdin
            .take()
            .ok_or_else(|| "fixture native writer stdin unavailable".to_string())
            .and_then(|mut stdin| {
                stdin
                    .write_all(&serde_json::to_vec(&input).map_err(|error| error.to_string())?)
                    .map_err(|error| error.to_string())
            });
        let status = child.wait().map_err(|error| error.to_string())?;
        write_result?;
        return if status.success() {
            Ok(())
        } else {
            Err("fixture native SQLite writer failed".into())
        };
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    if file.metadata().map_err(|error| error.to_string())?.len() == 0 {
        let cwd = input["cwd"].as_str().unwrap_or("/workspace");
        let metadata = if provider == "codex" {
            json!({"type":"session_meta","payload":{"id":id,"cwd":cwd}})
        } else {
            json!({"type":"system","subtype":"init","sessionId":id,"cwd":cwd})
        };
        writeln!(file, "{metadata}").map_err(|error| error.to_string())?;
    }
    if !completed {
        return file.sync_all().map_err(|error| error.to_string());
    }
    let completion = input;
    let user_id = format!(
        "user-{}",
        short_hash(
            completion["requestId"]
                .as_str()
                .ok_or("fixture request missing")?
        )
    );
    let message_id = completion["messageId"]
        .as_str()
        .ok_or("fixture message missing")?;
    let text = "deterministic fixture completion";
    let records = match provider {
        "claude" | "kilroy" => vec![
            json!({"type":"user","uuid":user_id,"sessionId":id,"cwd":"/workspace","message":{"role":"user","content":"deterministic fixture request"}}),
            json!({"type":"assistant","uuid":message_id,"parentUuid":user_id,"sessionId":id,"message":{"id":message_id,"role":"assistant","content":[{"type":"text","text":text}],"stop_reason":"end_turn"}}),
        ],
        "codex" => vec![
            json!({"type":"turn_context","payload":{"turn_id":completion["turnId"]}}),
            json!({"type":"response_item","payload":{"type":"message","id":user_id,"role":"user","content":[{"type":"input_text","text":"deterministic fixture request"}]}}),
            json!({"type":"response_item","payload":{"type":"message","id":message_id,"role":"assistant","content":[{"type":"output_text","text":text}]}}),
            json!({"type":"event_msg","payload":{"type":"task_complete","turn_id":completion["turnId"]}}),
        ],
        _ => return Err("unsupported fixture native provider".into()),
    };
    for record in records {
        writeln!(file, "{record}").map_err(|error| error.to_string())?;
    }
    file.sync_all().map_err(|error| error.to_string())
}

#[cfg(test)]
async fn read_provider_state(
    state_dir: &Path,
    _run_as_uid: u32,
    _run_as_gid: u32,
    _helpers: &ProviderStateHelpers,
) -> Result<Option<FixtureState>, String> {
    read_state(state_dir)
}

#[cfg(test)]
async fn write_provider_state(
    state_dir: &Path,
    state: &FixtureState,
    _run_as_uid: u32,
    _run_as_gid: u32,
    _helpers: &ProviderStateHelpers,
) -> Result<(), String> {
    write_state(state_dir, state)
}

#[cfg(not(test))]
async fn read_provider_state(
    state_dir: &Path,
    run_as_uid: u32,
    run_as_gid: u32,
    helpers: &ProviderStateHelpers,
) -> Result<Option<FixtureState>, String> {
    let output =
        provider_state_worker(state_dir, run_as_uid, run_as_gid, helpers, "read", None).await?;
    serde_json::from_slice(&output)
        .map_err(|error| format!("decode provider-state worker reply: {error}"))
}

#[cfg(test)]
async fn read_provider_snapshot(
    state_dir: &Path,
    provider: &str,
    native_id: &str,
    _: u32,
    _: u32,
    _helpers: &ProviderStateHelpers,
) -> Result<Value, String> {
    freshell_freshagent::native_history::read(
        provider,
        state_dir
            .parent()
            .ok_or("fixture provider home unavailable")?,
        native_id,
    )
}

#[cfg(not(test))]
async fn read_provider_snapshot(
    state_dir: &Path,
    provider: &str,
    native_id: &str,
    run_as_uid: u32,
    run_as_gid: u32,
    helpers: &ProviderStateHelpers,
) -> Result<Value, String> {
    let input = serde_json::to_vec(&json!({"provider":provider,"nativeId":native_id}))
        .map_err(|error| error.to_string())?;
    let output = provider_state_worker(
        state_dir,
        run_as_uid,
        run_as_gid,
        helpers,
        "snapshot",
        Some(&input),
    )
    .await?;
    serde_json::from_slice(&output).map_err(|error| format!("decode provider snapshot: {error}"))
}

#[cfg(not(test))]
async fn write_provider_state(
    state_dir: &Path,
    state: &FixtureState,
    run_as_uid: u32,
    run_as_gid: u32,
    helpers: &ProviderStateHelpers,
) -> Result<(), String> {
    let input = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    provider_state_worker(
        state_dir,
        run_as_uid,
        run_as_gid,
        helpers,
        "write",
        Some(&input),
    )
    .await
    .map(|_| ())
}

#[cfg(not(test))]
async fn provider_state_worker(
    state_dir: &Path,
    run_as_uid: u32,
    run_as_gid: u32,
    helpers: &ProviderStateHelpers,
    operation: &str,
    input: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    if state_dir != Path::new("/home/freshell/provider/.freshell-fixture") {
        return Err("deterministic provider state path is not the mounted provider home".into());
    }
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let current_uid = unsafe { libc::geteuid() };
    let current_gid = unsafe { libc::getegid() };
    let mut command = if run_as_uid == current_uid && run_as_gid == current_gid {
        Command::new(&executable)
    } else {
        let mut command = Command::new("/usr/bin/setpriv");
        command
            .arg("--reuid")
            .arg(run_as_uid.to_string())
            .arg("--regid")
            .arg(run_as_gid.to_string())
            .arg("--clear-groups")
            .arg("--no-new-privs")
            .arg("--")
            .arg(executable);
        command
    };
    command
        .arg("fresh-agent-fixture-state-worker")
        .arg(operation)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    helpers.run(command, input.map(<[u8]>::to_vec)).await
}

type HelperTask = tokio::task::JoinHandle<Result<Vec<u8>, String>>;

/// A cancelled request leaves its helper join handle with the transport.
/// The worker itself waits for its SQLite child before this task can finish.
#[derive(Default)]
struct ProviderStateHelpers {
    task: Mutex<Option<HelperTask>>,
}

impl ProviderStateHelpers {
    async fn settle(&self) -> Result<(), String> {
        Self::join(&mut *self.task.lock().await).await.map(|_| ())
    }

    async fn join(slot: &mut Option<HelperTask>) -> Result<Vec<u8>, String> {
        let Some(task) = slot.as_mut() else {
            return Ok(Vec::new());
        };
        // Await by reference: cancellation must not take or drop the handle.
        let result = task
            .await
            .map_err(|error| format!("join provider-state worker: {error}"));
        *slot = None;
        result?
    }

    async fn run(&self, command: Command, input: Option<Vec<u8>>) -> Result<Vec<u8>, String> {
        let mut slot = self.task.lock().await;
        Self::join(&mut slot).await?;
        *slot = Some(tokio::spawn(wait_for_state_worker(command, input)));
        Self::join(&mut slot).await
    }
}

async fn wait_for_state_worker(
    mut command: Command,
    input: Option<Vec<u8>>,
) -> Result<Vec<u8>, String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn provider-state worker: {error}"))?;
    let write_result = if let Some(input) = input {
        match child.stdin.take() {
            Some(mut stdin) => stdin
                .write_all(&input)
                .await
                .map_err(|error| format!("write provider-state worker: {error}")),
            None => Err("provider-state worker has no stdin".to_string()),
        }
    } else {
        Ok(())
    };
    drop(child.stdin.take());
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("wait for provider-state worker: {error}"))?;
    write_result?;
    if !output.status.success() {
        return Err(format!(
            "provider-state worker exited {:?}: {}",
            output.status.code(),
            String::from_utf8_lossy(&output.stderr).trim(),
        ));
    }
    Ok(output.stdout)
}

pub(crate) fn run_state_worker(args: &[String]) -> Result<(), String> {
    let state_dir = Path::new("/home/freshell/provider/.freshell-fixture");
    match args {
        [operation] if operation == "read" => {
            serde_json::to_writer(std::io::stdout(), &read_state(state_dir)?)
                .map_err(|error| error.to_string())
        }
        [operation] if operation == "write" => {
            let state: FixtureState = serde_json::from_reader(std::io::stdin())
                .map_err(|error| format!("decode provider-state write: {error}"))?;
            write_state(state_dir, &state)
        }
        [operation] if operation == "completion" => {
            let completion: Value =
                serde_json::from_reader(std::io::stdin()).map_err(|error| error.to_string())?;
            write_native_completion(state_dir, &completion)
        }
        [operation] if operation == "initialize" => {
            let metadata: Value =
                serde_json::from_reader(std::io::stdin()).map_err(|error| error.to_string())?;
            write_native_history(state_dir, &metadata, false)
        }
        [operation] if operation == "snapshot" => {
            let input: Value =
                serde_json::from_reader(std::io::stdin()).map_err(|error| error.to_string())?;
            let snapshot = freshell_freshagent::native_history::read(
                input["provider"]
                    .as_str()
                    .ok_or("fixture snapshot provider missing")?,
                state_dir
                    .parent()
                    .ok_or("fixture provider home unavailable")?,
                input["nativeId"]
                    .as_str()
                    .ok_or("fixture snapshot identity missing")?,
            )?;
            serde_json::to_writer(std::io::stdout(), &snapshot).map_err(|error| error.to_string())
        }
        _ => Err(
            "fixture state worker requires read, write, initialize, completion or snapshot".into(),
        ),
    }
}

fn non_ambiguous(message: impl ToString) -> DispatchFailure {
    DispatchFailure {
        message: message.to_string(),
        acceptance_ambiguous: false,
    }
}

fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::FreshAgentTurnSettings;

    #[test]
    fn controlled_sqlite_helper_child() {
        let Some(home) = std::env::var_os("FRESHELL_CONTROLLED_HELPER_HOME") else {
            return;
        };
        let home = PathBuf::from(home);
        let input: Value =
            serde_json::from_slice(&fs::read(home.join("input.json")).unwrap()).unwrap();
        write_native_history(&home.join("fixture"), &input, false).unwrap();
    }

    #[tokio::test]
    async fn cancelled_native_helper_is_joined_before_stop() {
        assert_cancelled_native_helper(false, false).await;
    }

    #[tokio::test]
    async fn cancelled_native_helper_is_joined_before_reuse() {
        assert_cancelled_native_helper(true, false).await;
    }

    #[tokio::test]
    async fn cancelled_native_helper_input_error_is_joined_before_stop() {
        assert_cancelled_native_helper(false, true).await;
    }

    fn controlled_writer_command(home: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .arg("--exact")
            .arg("providers::deterministic_fresh_agent::tests::controlled_sqlite_helper_child")
            .arg("--nocapture")
            .env_clear()
            .env("FRESHELL_CONTROLLED_HELPER_HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command
    }

    async fn assert_cancelled_native_helper(reuse: bool, input_error: bool) {
        use std::{
            future::Future,
            task::{Context, Poll, Waker},
        };
        use tokio::io::AsyncReadExt;
        let home = tempfile::tempdir().unwrap();
        let profile = initial_profile(FreshProvider::Opencode);
        let transport = DeterministicFreshAgentTransport::open(
            home.path().join("fixture"),
            &profile,
            unsafe { libc::getuid() },
            unsafe { libc::getgid() },
        )
        .await
        .unwrap();
        let root = transport.state.lock().await.native_session_id.clone();
        let socket = home.path().join("writer.sock");
        let listener = tokio::net::UnixListener::bind(&socket).unwrap();
        fs::write(
            home.path().join("input.json"),
            serde_json::to_vec(&json!({
                "provider":"opencode", "nativeId":root, "cwd":profile.cwd,
                "at":1, "allowCreate":true, "writerGate":socket,
            }))
            .unwrap(),
        )
        .unwrap();
        // The exact Rust test child never reads stdin: a large write must fail
        // with BrokenPipe after that child has joined its SQLite writer.
        let input = input_error.then(|| vec![b'x'; 1024 * 1024]);
        let outcome: Result<_, String> = async {
            let mut operation = Box::pin(transport.helpers.run(controlled_writer_command(home.path()), input));
            let (mut writer, _) = tokio::select! {
                result = &mut operation => return Err(format!("helper exited before controlled SQLite IO: {result:?}")),
                result = tokio::time::timeout(Duration::from_secs(10), listener.accept()) => result.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?,
            };
            let mut ready = [0];
            writer.read_exact(&mut ready).await.map_err(|e| e.to_string())?;
            // Python has opened this exact SQLite file and is blocked on our socket.
            // Drop the owning request, then poll its next owner at this boundary.
            drop(operation);
            let mut next: std::pin::Pin<Box<dyn Future<Output = Result<(), String>>>> = if reuse {
                Box::pin(async { transport.helpers.run(controlled_writer_command(home.path()), None).await.map(|_| ()) })
            } else {
                Box::pin(transport.clone().stop())
            };
            let next_poll = next.as_mut().poll(&mut Context::from_waker(Waker::noop()));
            let owner_waited = matches!(next_poll, Poll::Pending);
            writer.write_all(b"C").await.map_err(|e| e.to_string())?;
            drop(writer);
            let result = match next_poll {
                Poll::Pending => next.await,
                Poll::Ready(result) => result,
            };
            Ok((ready, owner_waited, result))
        }.await;
        // Finally join every owned helper even after a handoff/IO error or RED.
        let settlement = transport.helpers.settle().await;
        let stop = transport.clone().stop().await;
        let (ready, owner_waited, result) = outcome.unwrap();
        settlement.unwrap();
        stop.unwrap();
        assert_eq!(ready, [b'R']);
        if input_error {
            assert!(result
                .unwrap_err()
                .starts_with("write provider-state worker:"));
        } else {
            result.unwrap();
        }
        assert!(transport.helpers.task.lock().await.is_none());
        let saved =
            freshell_freshagent::native_history::read("opencode", home.path(), &root).unwrap();
        assert_eq!(saved["turns"], json!([]));
        assert_eq!(saved["threadId"], root);
        assert!(
            owner_waited,
            "owner completed while its cancelled operation's SQLite writer was still blocked"
        );
    }

    fn initial_profile(provider: FreshProvider) -> FreshAgentProfile {
        FreshAgentProfile {
            runtime_variant: match provider {
                FreshProvider::Claude | FreshProvider::Kilroy => "claude-sdk",
                FreshProvider::Codex => "codex-app-server",
                FreshProvider::Opencode => "opencode-per-soul-http",
            }
            .into(),
            provider,
            cwd: "/workspace/fixture".into(),
            model: None,
            effort: None,
            permission_mode: None,
            sandbox: Some("workspace-write".into()),
            provider_store_id: "initial-owned-fixture".into(),
            native_session_id: None,
            plugins: None,
            model_selection: None,
            session_ref: None,
            provider_launch_context: None,
            provider_secret_references: Vec::new(),
        }
    }

    async fn assert_initial_actor_snapshot(provider: FreshProvider) {
        let home = tempfile::tempdir().unwrap();
        let profile = initial_profile(provider.clone());
        let transport = DeterministicFreshAgentTransport::open(
            home.path().join("fixture"),
            &profile,
            unsafe { libc::getuid() },
            unsafe { libc::getgid() },
        )
        .await
        .unwrap();
        let root = transport.state.lock().await.native_session_id.clone();
        let actor = freshell_agent_runtime::host_actor::FreshAgentHostActor::open(
            home.path().join("actor"),
            profile.clone(),
            transport.clone(),
        )
        .await
        .unwrap();
        let worker = transport.child.lock().await.as_ref().unwrap().id();
        let snapshot = actor.snapshot().await;
        let history =
            freshell_freshagent::native_history::read(provider.as_str(), home.path(), &root);
        let persisted = read_state(&home.path().join("fixture")).unwrap().unwrap();
        let current_profile = actor.profile().await;
        let events = actor.read_events(0, 20).await;
        assert!(transport.is_live().await);
        assert_eq!(transport.child.lock().await.as_ref().unwrap().id(), worker);
        transport.clone().stop().await.unwrap();
        assert!(!transport.is_live().await);

        // Assert only after synchronously joining this test's sole worker,
        // including on the expected pre-repair missing-history failure.
        let snapshot = snapshot
            .expect("initial actor snapshot before any Send must read zero-turn native metadata");
        let history = history.unwrap();
        let (wire_provider, session_type) = match provider {
            FreshProvider::Claude => ("claude", "freshclaude"),
            FreshProvider::Kilroy => ("claude", "kilroy"),
            FreshProvider::Codex => ("codex", "freshcodex"),
            FreshProvider::Opencode => ("opencode", "freshopencode"),
        };
        assert_eq!(snapshot["threadId"], root);
        assert_eq!(snapshot["provider"], wire_provider);
        assert_eq!(snapshot["sessionType"], session_type);
        assert_eq!(snapshot["turns"], json!([]));
        assert_eq!(snapshot["status"], "idle");
        assert_eq!(snapshot["capabilities"]["send"], true);
        assert_eq!(snapshot["capabilities"]["interrupt"], false);
        assert_eq!(snapshot["pendingApprovals"], json!([]));
        assert_eq!(snapshot["pendingQuestions"], json!([]));
        assert_eq!(
            snapshot["extensions"][wire_provider]["ownerKind"],
            "fresh-agent"
        );
        assert_eq!(
            snapshot["extensions"][wire_provider]["statusFromLiveState"],
            true
        );
        assert!(snapshot["extensions"][wire_provider]
            .get("nativeHistoryAvailable")
            .is_none());
        assert_eq!(history["capabilities"]["send"], false);
        assert_eq!(history["extensions"][wire_provider]["ownerKind"], "vacant");
        assert_eq!(history["turns"], json!([]));
        assert_eq!(persisted.native_session_id, root);
        assert_eq!(persisted.dispatch_count, 0);
        assert_eq!(persisted.completion_count, 0);
        assert!(persisted.pending_decision_id.is_none());
        assert_eq!(persisted.create_profile, Some(profile.clone()));
        let mut expected_profile = profile;
        expected_profile.native_session_id = Some(root);
        assert_eq!(current_profile, expected_profile);
        assert!(!events.events.iter().any(|entry| matches!(
            entry.event,
            AgentEvent::Provider { .. } | AgentEvent::PermissionRequested { .. }
        )));
    }

    #[tokio::test]
    async fn initial_actor_snapshot_before_send_claude() {
        assert_initial_actor_snapshot(FreshProvider::Claude).await;
    }

    #[tokio::test]
    async fn initial_actor_snapshot_before_send_kilroy() {
        assert_initial_actor_snapshot(FreshProvider::Kilroy).await;
    }

    #[tokio::test]
    async fn initial_actor_snapshot_before_send_codex() {
        assert_initial_actor_snapshot(FreshProvider::Codex).await;
    }

    #[tokio::test]
    async fn initial_actor_snapshot_before_send_opencode() {
        assert_initial_actor_snapshot(FreshProvider::Opencode).await;
    }

    fn native_path(home: &Path, provider: &FreshProvider, id: &str) -> PathBuf {
        match provider {
            FreshProvider::Claude | FreshProvider::Kilroy => home
                .join(".claude/projects/managed-fixture")
                .join(format!("{id}.jsonl")),
            FreshProvider::Codex => home
                .join(".codex/sessions")
                .join(format!("rollout-fixture-{id}.jsonl")),
            FreshProvider::Opencode => home.join(".local/share/opencode/opencode.db"),
        }
    }

    #[tokio::test]
    async fn metadata_start_preserves_completed_store_on_actor_reopen() {
        for provider in [
            FreshProvider::Claude,
            FreshProvider::Kilroy,
            FreshProvider::Codex,
            FreshProvider::Opencode,
        ] {
            let home = tempfile::tempdir().unwrap();
            let profile = initial_profile(provider.clone());
            let transport = DeterministicFreshAgentTransport::open(
                home.path().join("fixture"),
                &profile,
                unsafe { libc::getuid() },
                unsafe { libc::getgid() },
            )
            .await
            .unwrap();
            let actor = freshell_agent_runtime::host_actor::FreshAgentHostActor::open(
                home.path().join("actor"),
                profile,
                transport.clone(),
            )
            .await
            .unwrap();
            actor
                .dispatch(
                    RequestId::parse("completed-before-reopen").unwrap(),
                    "one owned turn".into(),
                    None::<FreshAgentTurnSettings>,
                )
                .await
                .unwrap();
            let saved_profile = actor.profile().await;
            let native_id = saved_profile.native_session_id.as_deref().unwrap();
            let before = actor.snapshot().await.unwrap();
            let path = native_path(home.path(), &provider, native_id);
            let bytes = fs::read(&path).unwrap();
            actor.stop().await.unwrap();
            assert!(!transport.is_live().await);
            drop(transport);

            let reopened = DeterministicFreshAgentTransport::open(
                home.path().join("fixture"),
                &saved_profile,
                unsafe { libc::getuid() },
                unsafe { libc::getgid() },
            )
            .await
            .unwrap();
            let actor = freshell_agent_runtime::host_actor::FreshAgentHostActor::open(
                home.path().join("actor"),
                saved_profile.clone(),
                reopened.clone(),
            )
            .await
            .unwrap();
            let after = actor.snapshot().await;
            let state = reopened.state.lock().await.clone();
            let current_profile = actor.profile().await;
            actor.stop().await.unwrap();
            assert!(!reopened.is_live().await);
            let after = after.unwrap();
            assert_eq!(before, after);
            assert!(!after["turns"].as_array().unwrap().is_empty());
            assert_eq!(
                fs::read(path).unwrap(),
                bytes,
                "startup must not rewrite existing history"
            );
            assert_eq!(state.native_session_id, native_id);
            assert_eq!(state.dispatch_count, 1);
            assert_eq!(state.completion_count, 1);
            assert!(state.pending_decision_id.is_none());
            assert_eq!(state.create_profile, Some(saved_profile.clone()));
            assert_eq!(current_profile, saved_profile);
        }
    }

    #[tokio::test]
    async fn metadata_start_refuses_existing_wrong_root_or_unreadable_store() {
        for provider in [
            FreshProvider::Claude,
            FreshProvider::Kilroy,
            FreshProvider::Codex,
            FreshProvider::Opencode,
        ] {
            for unreadable in [false, true] {
                let home = tempfile::tempdir().unwrap();
                let profile = initial_profile(provider.clone());
                let transport = DeterministicFreshAgentTransport::open(
                    home.path().join("fixture"),
                    &profile,
                    unsafe { libc::getuid() },
                    unsafe { libc::getgid() },
                )
                .await
                .unwrap();
                let id = transport.state.lock().await.native_session_id.clone();
                let path = native_path(home.path(), &provider, &id);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                let before = if unreadable {
                    // A directory cannot be read as a JSONL/SQLite file,
                    // regardless of the test runner's privilege level.
                    fs::create_dir(&path).unwrap();
                    None
                } else if provider == FreshProvider::Opencode {
                    let connection = rusqlite::Connection::open(&path).unwrap();
                    connection.execute_batch("CREATE TABLE session(id TEXT PRIMARY KEY,title TEXT,time_updated INTEGER); INSERT INTO session VALUES('wrong-root','other history',1);").unwrap();
                    drop(connection);
                    Some(fs::read(&path).unwrap())
                } else {
                    let row = if provider == FreshProvider::Codex {
                        json!({"type":"session_meta","payload":{"id":"wrong-root","cwd":profile.cwd}})
                    } else {
                        json!({"type":"system","sessionId":"wrong-root","cwd":profile.cwd})
                    };
                    fs::write(&path, format!("{row}\n")).unwrap();
                    Some(fs::read(&path).unwrap())
                };
                let started = transport.start(&profile).await;
                let snapshot = transport.snapshot().await;
                assert!(
                    transport.child.lock().await.is_none(),
                    "failed initialization must not spawn a worker"
                );
                assert!(!transport.is_live().await);
                assert!(
                    started.is_err(),
                    "wrong/unreadable existing history must refuse startup"
                );
                // Claude's existing history reader trusts its selected filename;
                // startup adds the metadata-root check instead of hiding that
                // mismatch behind a fabricated empty positive.
                if unreadable || !matches!(provider, FreshProvider::Claude | FreshProvider::Kilroy)
                {
                    assert!(snapshot.is_err());
                }
                if let Some(before) = before {
                    assert_eq!(fs::read(&path).unwrap(), before);
                } else {
                    assert!(path.is_dir());
                }
                let state = transport.state.lock().await;
                assert_eq!(state.native_session_id, id);
                assert_eq!((state.dispatch_count, state.completion_count), (0, 0));
                assert!(state.create_profile.is_none());
                assert!(state.pending_decision_id.is_none());
            }
        }
    }

    #[tokio::test]
    async fn fixture_native_identity_is_store_and_provider_specific() {
        let profile = FreshAgentProfile {
            provider: FreshProvider::Codex,
            runtime_variant: "codex-app-server".into(),
            cwd: "/workspace".into(),
            model: Some("gpt-5.6-luna".into()),
            effort: Some("low".into()),
            permission_mode: None,
            sandbox: Some("workspace-write".into()),
            provider_store_id: "soul-a".into(),
            native_session_id: None,
            plugins: None,
            model_selection: None,
            session_ref: None,
            provider_launch_context: None,
            provider_secret_references: Vec::new(),
        };
        assert_eq!(fixture_native_id(&profile), fixture_native_id(&profile));
        let mut other = profile.clone();
        other.provider_store_id = "soul-b".into();
        assert_ne!(fixture_native_id(&profile), fixture_native_id(&other));
        for provider in [
            FreshProvider::Claude,
            FreshProvider::Kilroy,
            FreshProvider::Codex,
            FreshProvider::Opencode,
        ] {
            let root = tempfile::tempdir().unwrap();
            let state_dir = root.path().join("provider");
            let mut saved_profile = profile.clone();
            saved_profile.provider = provider;
            let old_id = format!(
                "fixture-native-{}-preserved",
                saved_profile.provider.as_str()
            );
            let old = FixtureState {
                schema_version: 1,
                native_session_id: old_id.clone(),
                dispatch_count: 7,
                completion_count: 6,
                pending_decision_id: Some("pending-preserved".into()),
                create_profile: Some(saved_profile.clone()),
            };
            write_provider_state(
                &state_dir,
                &old,
                unsafe { libc::getuid() },
                unsafe { libc::getgid() },
                &ProviderStateHelpers::default(),
            )
            .await
            .unwrap();
            saved_profile.native_session_id = Some(old_id.clone());
            let reopened = DeterministicFreshAgentTransport::open(
                &state_dir,
                &saved_profile,
                unsafe { libc::getuid() },
                unsafe { libc::getgid() },
            )
            .await
            .unwrap();
            let preserved = reopened.state.lock().await;
            assert_eq!(preserved.native_session_id, old_id);
            assert_eq!(preserved.dispatch_count, 7);
            assert_eq!(preserved.completion_count, 6);
            assert_eq!(preserved.pending_decision_id, old.pending_decision_id);
            assert_eq!(preserved.create_profile, old.create_profile);
            drop(preserved);
            // An existing dispatched fixture cannot replace missing saved
            // history with new zero-turn metadata during startup.
            let started = reopened.start(&saved_profile).await;
            let spawned = reopened.is_live().await;
            reopened.clone().stop().await.unwrap();
            assert!(started.is_err());
            assert!(!spawned);
            assert!(freshell_freshagent::native_history::read(
                saved_profile.provider.as_str(),
                root.path(),
                &old_id,
            )
            .is_err());
        }
    }

    #[test]
    fn fixture_control_inputs_are_exact_not_substring_commands() {
        assert_ne!(format!("prefix {PENDING_CONTROL}"), PENDING_CONTROL);
        assert_ne!(
            format!("{HANG_AFTER_ACCEPT_CONTROL} suffix"),
            HANG_AFTER_ACCEPT_CONTROL
        );
    }

    #[tokio::test]
    async fn provider_native_completion_crosses_the_durable_actor_once() {
        let mut native_ids = std::collections::HashSet::new();
        for provider in [
            FreshProvider::Claude,
            FreshProvider::Kilroy,
            FreshProvider::Codex,
            FreshProvider::Opencode,
        ] {
            let root = tempfile::tempdir().unwrap();
            let profile = FreshAgentProfile {
                provider: provider.clone(),
                runtime_variant: "opencode-per-soul-http".into(),
                cwd: "/workspace".into(),
                model: Some("opencode/big-pickle".into()),
                effort: None,
                permission_mode: None,
                sandbox: Some("workspace-write".into()),
                provider_store_id: "soul-native-proof".into(),
                native_session_id: None,
                plugins: None,
                model_selection: None,
                session_ref: None,
                provider_launch_context: None,
                provider_secret_references: Vec::new(),
            };
            let transport = DeterministicFreshAgentTransport::open(
                root.path().join("provider"),
                &profile,
                unsafe { libc::getuid() },
                unsafe { libc::getgid() },
            )
            .await
            .unwrap();
            let actor = freshell_agent_runtime::host_actor::FreshAgentHostActor::open(
                root.path().join("actor"),
                profile.clone(),
                transport.clone(),
            )
            .await
            .unwrap();
            let request = RequestId::parse("request-fixture-native-proof").unwrap();
            let state = actor
                .dispatch(
                    request,
                    "complete deterministically".into(),
                    None::<FreshAgentTurnSettings>,
                )
                .await
                .unwrap();
            assert_eq!(
                state,
                freshell_runtime_protocol::CommandState::ProviderAcked
            );
            tokio::task::yield_now().await;
            let events = actor.read_events(0, 20).await;
            assert!(events.events.iter().any(|entry| matches!(
                &entry.event,
                AgentEvent::Provider { payload }
                    if payload.get("completionKind").and_then(Value::as_str)
                        == Some("provider_native_completed")
            )));
            let persisted: Value = serde_json::from_slice(
                &fs::read(root.path().join("provider").join(STATE_FILE)).unwrap(),
            )
            .unwrap();
            assert_eq!(persisted["dispatchCount"], 1);
            assert_eq!(persisted["completionCount"], 1);
            assert!(!persisted.to_string().contains("complete deterministically"));
            let native_id = persisted["nativeSessionId"].as_str().unwrap();
            let saved = freshell_freshagent::native_history::read(
                provider.as_str(),
                root.path(),
                native_id,
            )
            .expect("the actual fixture completion must be saved in its owned native store");
            assert!(native_ids.insert(native_id.to_owned()));
            eprintln!(
                "{}",
                json!({"severity":"info", "event":"fixture.native_history.identity",
                    "provider":saved["provider"], "sessionType":saved["sessionType"],
                    "nativeSessionId":saved["threadId"]})
            );
            if matches!(provider, FreshProvider::Claude | FreshProvider::Kilroy) {
                let canonical = uuid::Uuid::parse_str(native_id)
                    .expect("actual saved Claude fixture identity must be a canonical native UUID");
                assert_eq!(canonical.get_version(), Some(uuid::Version::Random));
                assert_eq!(canonical.get_variant(), uuid::Variant::RFC4122);
            }
            let mut resumed_profile = profile.clone();
            resumed_profile.native_session_id = Some(native_id.to_owned());
            let reopened = DeterministicFreshAgentTransport::open(
                root.path().join("provider"),
                &resumed_profile,
                unsafe { libc::getuid() },
                unsafe { libc::getgid() },
            )
            .await
            .unwrap();
            let reopened_state = reopened.state.lock().await;
            assert_eq!(reopened_state.native_session_id, native_id);
            assert_eq!(reopened_state.dispatch_count, 1);
            assert_eq!(reopened_state.completion_count, 1);
            drop(reopened_state);
            let provider_events: Vec<_> = events
                .events
                .iter()
                .filter_map(|entry| {
                    if let AgentEvent::Provider { payload } = &entry.event {
                        Some(payload)
                    } else {
                        None
                    }
                })
                .collect();
            let materialized = provider_events
                .iter()
                .position(|payload| payload["type"] == "freshAgent.session.materialized")
                .expect(
                    "saved fixture native identity must materialize through the existing UI event",
                );
            let assistant = provider_events
                .iter()
                .position(|payload| payload["type"] == "freshAgent.event")
                .unwrap();
            let completed = provider_events
                .iter()
                .position(|payload| payload["type"] == "freshAgent.turn.complete")
                .unwrap();
            assert!(materialized < assistant && assistant < completed);
            assert_eq!(saved["threadId"], native_id);
            for event in [materialized, assistant, completed] {
                assert_eq!(provider_events[event]["sessionId"], saved["threadId"]);
            }
            assert_eq!(provider_events[materialized]["provider"], saved["provider"]);
            assert_eq!(
                provider_events[materialized]["sessionType"],
                saved["sessionType"]
            );
            for event in [assistant, completed] {
                assert_eq!(provider_events[event]["provider"], provider.as_str());
            }
            assert_eq!(
                provider_events[materialized]["previousSessionId"],
                native_id
            );
            assert_eq!(
                provider_events[assistant]["event"]["assistantMessageId"],
                provider_events[completed]["assistantMessageId"]
            );
            assert_eq!(
                provider_events[completed]["completionKind"],
                "provider_native_completed"
            );
            assert!(saved["turns"]
                .as_array()
                .unwrap()
                .iter()
                .any(|turn| { turn["summary"] == "deterministic fixture completion" }));
            transport.stop().await.unwrap();
        }
    }

    #[tokio::test]
    async fn recovery_probe_requires_the_exact_persisted_native_identity() {
        let root = tempfile::tempdir().unwrap();
        let state = FixtureState {
            schema_version: 1,
            native_session_id: "fixture-native-codex-exact".into(),
            dispatch_count: 3,
            completion_count: 2,
            pending_decision_id: None,
            create_profile: None,
        };
        write_state(root.path(), &state).unwrap();
        let mut spec = fixture_resume_spec("fixture-native-codex-exact");
        assert!(matches!(
            probe_resume(&spec, root.path(), unsafe { libc::getuid() }, unsafe { libc::getgid() }).await.unwrap(),
            ProviderStoreProbe::Ready { evidence }
                if evidence.iter().any(|item| item == "fixtureIdentity=exact")
        ));

        spec.provider_session.native_session_id = "fixture-native-codex-wrong".into();
        assert!(matches!(
            probe_resume(&spec, root.path(), unsafe { libc::getuid() }, unsafe {
                libc::getgid()
            })
            .await
            .unwrap(),
            ProviderStoreProbe::DefinitivelyUnavailable {
                store_state: EvidenceStoreState::PresentReadable,
                ..
            }
        ));
    }

    fn fixture_resume_spec(native_session_id: &str) -> ResumeSpec {
        ResumeSpec {
            claude_fork: None,
            schema_version: freshell_runtime_protocol::RESUME_SPEC_SCHEMA_VERSION,
            provider_session: freshell_runtime_protocol::ProviderSessionRef {
                provider: "codex".into(),
                provider_store_id: "fixture-store".into(),
                native_session_id: native_session_id.into(),
            },
            mode: "freshcodex".into(),
            runtime_variant: "codex-app-server".into(),
            fixture_transport: Some(
                freshell_runtime_protocol::FreshAgentFixtureTransport::Deterministic,
            ),
            opencode_adoption_baseline: None,
            program: "freshell-session-host fresh-agent".into(),
            resume_argv: Vec::new(),
            provider_home: "/home/freshell/provider".into(),
            provider_volume: None,
            cwd: "/workspace".into(),
            workspace_path: "/workspace".into(),
            project_key: Some("fixture-project".into()),
            runtime_profile: None,
            environment: std::collections::BTreeMap::new(),
            model: Some("gpt-test".into()),
            reasoning_effort: Some("low".into()),
            permission_mode: None,
            image_ref: None,
            provider_version: Some("fixture".into()),
            credential_references: Vec::new(),
            identity_provenance: freshell_runtime_protocol::IdentityProvenance::FixtureObserved,
            durable_position: freshell_runtime_protocol::DurablePosition::default(),
            checkpoint_references: Vec::new(),
            creation_seed_ref: "fixture-seed".into(),
            checkpoint_revision: 0,
            allocation_state: freshell_runtime_protocol::AllocationState::VerifiedDurable,
            evidence_revision: 1,
            never_dispatched: false,
        }
    }
}
