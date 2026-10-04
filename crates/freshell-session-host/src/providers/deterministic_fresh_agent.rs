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
#[cfg(not(test))]
use std::process::Stdio;
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
#[cfg(not(test))]
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
}

impl DeterministicFreshAgentTransport {
    pub(crate) async fn open(
        state_dir: impl Into<PathBuf>,
        profile: &FreshAgentProfile,
        run_as_uid: u32,
        run_as_gid: u32,
    ) -> Result<Arc<Self>, String> {
        let state_dir = state_dir.into();
        let state =
            if let Some(state) = read_provider_state(&state_dir, run_as_uid, run_as_gid).await? {
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
        write_provider_state(&state_dir, &state, run_as_uid, run_as_gid).await?;
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
            write_provider_state(&self.state_dir, &state, self.run_as_uid, self.run_as_gid)
                .await
                .map_err(non_ambiguous)?;
            (native, turn_id, message_id)
        };
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
        self.spawn_provider_process().await?;
        {
            let mut state = self.state.lock().await;
            state.create_profile = Some(profile.clone());
            write_provider_state(&self.state_dir, &state, self.run_as_uid, self.run_as_gid).await?;
        }
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
                write_provider_state(&self.state_dir, &state, self.run_as_uid, self.run_as_gid)
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
            write_provider_state(&self.state_dir, &state, self.run_as_uid, self.run_as_gid)
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
            write_provider_state(&self.state_dir, &state, self.run_as_uid, self.run_as_gid)
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
        if let Some(mut child) = self.child.lock().await.take() {
            child.kill().await.map_err(|error| error.to_string())?;
            let _ = child.wait().await;
        }
        Ok(())
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
    let Some(state) = read_provider_state(state_dir, run_as_uid, run_as_gid).await? else {
        return Ok(ProviderStoreProbe::DefinitivelyUnavailable {
            reason: "deterministic provider state is absent".into(),
            evidence: vec!["fixtureState=missing".into()],
            store_state: EvidenceStoreState::Missing,
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

#[cfg(test)]
async fn read_provider_state(
    state_dir: &Path,
    _run_as_uid: u32,
    _run_as_gid: u32,
) -> Result<Option<FixtureState>, String> {
    read_state(state_dir)
}

#[cfg(test)]
async fn write_provider_state(
    state_dir: &Path,
    state: &FixtureState,
    _run_as_uid: u32,
    _run_as_gid: u32,
) -> Result<(), String> {
    write_state(state_dir, state)
}

#[cfg(not(test))]
async fn read_provider_state(
    state_dir: &Path,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<Option<FixtureState>, String> {
    let output = provider_state_worker(state_dir, run_as_uid, run_as_gid, "read", None).await?;
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
) -> Result<Value, String> {
    let input = serde_json::to_vec(&json!({"provider":provider,"nativeId":native_id}))
        .map_err(|error| error.to_string())?;
    let output =
        provider_state_worker(state_dir, run_as_uid, run_as_gid, "snapshot", Some(&input)).await?;
    serde_json::from_slice(&output).map_err(|error| format!("decode provider snapshot: {error}"))
}

#[cfg(not(test))]
async fn write_provider_state(
    state_dir: &Path,
    state: &FixtureState,
    run_as_uid: u32,
    run_as_gid: u32,
) -> Result<(), String> {
    let input = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    provider_state_worker(state_dir, run_as_uid, run_as_gid, "write", Some(&input))
        .await
        .map(|_| ())
}

#[cfg(not(test))]
async fn provider_state_worker(
    state_dir: &Path,
    run_as_uid: u32,
    run_as_gid: u32,
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
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn provider-state worker: {error}"))?;
    if let Some(input) = input {
        child
            .stdin
            .take()
            .ok_or_else(|| "provider-state worker has no stdin".to_string())?
            .write_all(input)
            .await
            .map_err(|error| format!("write provider-state worker: {error}"))?;
    }
    drop(child.stdin.take());
    let output = child
        .wait_with_output()
        .await
        .map_err(|error| format!("wait for provider-state worker: {error}"))?;
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
        _ => Err("fixture state worker requires read, write or snapshot".into()),
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
    fn fixture_native_identity_is_store_and_provider_specific() {
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
        let root = tempfile::tempdir().unwrap();
        let profile = FreshAgentProfile {
            provider: FreshProvider::Opencode,
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
            profile,
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
        transport.stop().await.unwrap();
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
