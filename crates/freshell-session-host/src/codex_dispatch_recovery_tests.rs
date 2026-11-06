//! Exercise the authenticated send boundary with an ended native transport.

use super::*;
use async_trait::async_trait;
use freshell_agent_runtime::host_actor::{
    DispatchAck, DispatchFailure, FreshAgentHostActor, FreshAgentProfile, FreshAgentTransport,
    TransportStart,
};
use freshell_runtime_protocol::{
    CommandState, NativeDispatchIdentity, NativeIdentityLaunch, RequestId,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const ORIGINAL: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECOVERED: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

struct NativeRecoveryTransport {
    evidence: std::sync::Mutex<serde_json::Value>,
    live: AtomicBool,
    dispatches: AtomicUsize,
    original_exit_confirmed: AtomicBool,
    accepted_turns: AtomicUsize,
}

#[async_trait]
impl FreshAgentTransport for NativeRecoveryTransport {
    async fn native_identity_evidence(&self) -> Option<serde_json::Value> {
        Some(self.evidence.lock().unwrap().clone())
    }

    async fn start(&self, _: &FreshAgentProfile) -> Result<TransportStart, String> {
        Ok(TransportStart {
            native_session_id: Some(ORIGINAL.into()),
        })
    }

    async fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }

    async fn dispatch(
        &self,
        request: &RequestId,
        text: &str,
        profile: &FreshAgentProfile,
    ) -> Result<DispatchAck, DispatchFailure> {
        assert_eq!(text, "the original native recovery input");
        assert_eq!(profile.native_session_id.as_deref(), Some(ORIGINAL));
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        if !self.original_exit_confirmed.load(Ordering::SeqCst) {
            return Err(DispatchFailure {
                provider_diagnostic: None,
                message: "the original native writer is not confirmed dead".into(),
                acceptance_ambiguous: false,
            });
        }
        self.accepted_turns.fetch_add(1, Ordering::SeqCst);
        let mut evidence = self.evidence.lock().unwrap();
        evidence["nativeSessionId"] = serde_json::json!(RECOVERED);
        evidence["launch"]["evidenceRevision"] =
            serde_json::json!(evidence["launch"]["evidenceRevision"].as_u64().unwrap() + 1);
        evidence["launch"]["requestedNativeSessionId"] = serde_json::json!(RECOVERED);
        evidence["providerEvidence"] = serde_json::json!({
            "source":"native_turn_start_ack", "requestId":request.as_str(),
            "nativeSessionId":RECOVERED,
        });
        self.live.store(true, Ordering::SeqCst);
        Ok(DispatchAck {
            provider_ack_id: Some(request.to_string()),
            native_identity: Some(NativeDispatchIdentity {
                previous_native_session_id: ORIGINAL.into(),
                native_session_id: RECOVERED.into(),
                pending_naming_handle: None,
            }),
        })
    }

    async fn resolve_permission(
        &self,
        _: &str,
        _: serde_json::Value,
    ) -> Result<(), DispatchFailure> {
        unreachable!("native input recovery cannot release another control")
    }

    async fn interrupt(&self) -> Result<(), String> {
        unreachable!("native input recovery cannot interrupt another operation")
    }

    async fn fork(
        &self,
        _: &RequestId,
        _: &str,
        _: Option<serde_json::Value>,
    ) -> Result<freshell_agent_runtime::host_actor::ForkTransition, DispatchFailure> {
        unreachable!("a non-send control cannot use native dispatch recovery authority")
    }

    async fn stop(self: Arc<Self>) -> Result<(), String> {
        self.live.store(false, Ordering::SeqCst);
        Ok(())
    }

    fn take_event_stream(
        &self,
    ) -> Option<tokio::sync::mpsc::Receiver<freshell_runtime_protocol::AgentEvent>> {
        None
    }
}

async fn fixture() -> (
    Arc<HostState>,
    Arc<FreshAgentHostActor>,
    Arc<NativeRecoveryTransport>,
) {
    let state = tests::test_host_state();
    let launch = NativeIdentityLaunch {
        incarnation_id: state.incarnation_id.clone(),
        launch_nonce: "owned-codex-recovery-launch".into(),
        evidence_revision: 7,
        execution_generation: 1,
        requested_native_session_id: Some(ORIGINAL.into()),
    };
    {
        let mut persisted = state.persisted.lock().await;
        persisted.provider = Some("codex".into());
        persisted.host_boot_id = Some(state.host_boot_id.clone());
        persisted.max_execution_generation = launch.execution_generation;
        persisted.grant_id = Some(GrantId::new());
        persisted.worker_pid = Some(123);
        persisted.worker_launch_count = 1;
        persisted.native_identity_launch = Some(launch.clone());
        *state.control_fence.lock().unwrap() = HostControlFence::from(&*persisted);
    }
    let transport = Arc::new(NativeRecoveryTransport {
        evidence: std::sync::Mutex::new(serde_json::json!({
            "launch":launch, "nativeSessionId":ORIGINAL,
        })),
        live: AtomicBool::new(true),
        dispatches: AtomicUsize::new(0),
        original_exit_confirmed: AtomicBool::new(true),
        accepted_turns: AtomicUsize::new(0),
    });
    let profile: FreshAgentProfile = serde_json::from_value(serde_json::json!({
        "provider":"codex", "runtimeVariant":"codex-app-server", "cwd":"/workspace",
        "model":"fixture-model", "effort":"low", "permissionMode":"never", "sandbox":"read-only",
        "providerStoreId":"owned-codex-recovery-store",
    }))
    .unwrap();
    let actor = FreshAgentHostActor::open(
        state.state_dir.join("owned-codex-recovery-actor"),
        profile,
        transport.clone(),
    )
    .await
    .unwrap();
    *state.fresh_agent.lock().await = Some(actor.clone());
    let before = state.persisted.lock().await.clone();
    assert!(current_native_observation(&state, &before).await.is_some());
    (state, actor, transport)
}

#[tokio::test]
async fn ended_codex_send_commits_native_transition_before_reply() {
    let (state, actor, transport) = fixture().await;
    let before = state.persisted.lock().await.clone();
    transport.live.store(false, Ordering::SeqCst);
    assert!(current_native_observation(&state, &before).await.is_none());
    let request = RequestId::new();
    let result = dispatch(
        tests::authenticated_host_envelope(
            &state,
            HostCommand::FreshAgentSend {
                incarnation_id: state.incarnation_id.clone(),
                request_id: request.clone(),
                text: "the original native recovery input".into(),
                settings: None,
                checkpoint_logical_attempt_id: None,
                codex_dispatch_recovery_source: None,
            },
        ),
        &state,
    )
    .await;
    assert!(
        matches!(
            result,
            Ok(HostResult::FreshAgentCommand {
                state: CommandState::ProviderAcked,
                native_identity: Some(ref identity),
                ..
            }) if identity.previous_native_session_id == ORIGINAL
                && identity.native_session_id == RECOVERED
        ),
        "the authenticated original send must reach typed recovery: {result:?}"
    );
    assert_eq!(transport.dispatches.load(Ordering::SeqCst), 1);
    assert_eq!(transport.accepted_turns.load(Ordering::SeqCst), 1);
    let persisted = state.persisted.lock().await.clone();
    let current = current_native_observation(&state, &persisted)
        .await
        .expect("the accepted source is observable before the reply");
    assert_eq!(current.native_session_id, RECOVERED);
    assert_eq!(
        persisted.native_identity_launch.unwrap().evidence_revision,
        8
    );
    actor.stop().await.unwrap();
}

#[tokio::test]
async fn ended_codex_send_never_bypasses_source_binding_stop_or_original_writer_proof() {
    for scenario in [
        "missing-evidence",
        "wrong-generation",
        "wrong-root",
        "stop",
        "unconfirmed-exit",
    ] {
        let (state, actor, transport) = fixture().await;
        transport.live.store(false, Ordering::SeqCst);
        match scenario {
            "missing-evidence" => *transport.evidence.lock().unwrap() = serde_json::Value::Null,
            "wrong-generation" => {
                transport.evidence.lock().unwrap()["launch"]["executionGeneration"] =
                    serde_json::json!(2)
            }
            "wrong-root" => {
                transport.evidence.lock().unwrap()["nativeSessionId"] = serde_json::json!(RECOVERED)
            }
            "stop" => state.control_fence.lock().unwrap().stopped = true,
            "unconfirmed-exit" => transport
                .original_exit_confirmed
                .store(false, Ordering::SeqCst),
            _ => unreachable!(),
        }
        let result = dispatch(
            tests::authenticated_host_envelope(
                &state,
                HostCommand::FreshAgentSend {
                    incarnation_id: state.incarnation_id.clone(),
                    request_id: RequestId::new(),
                    text: "the original native recovery input".into(),
                    settings: None,
                    checkpoint_logical_attempt_id: None,
                    codex_dispatch_recovery_source: None,
                },
            ),
            &state,
        )
        .await;
        assert!(
            result.is_err(),
            "{scenario} cannot accept native work: {result:?}"
        );
        assert_eq!(
            transport.accepted_turns.load(Ordering::SeqCst),
            0,
            "{scenario}"
        );
        assert_eq!(
            actor.profile().await.native_session_id.as_deref(),
            Some(ORIGINAL)
        );
        actor.stop().await.unwrap();
    }
}

#[tokio::test]
async fn ended_codex_non_send_controls_still_require_current_native_observation() {
    let (state, actor, transport) = fixture().await;
    transport.live.store(false, Ordering::SeqCst);
    let result = dispatch(
        tests::authenticated_host_envelope(
            &state,
            HostCommand::FreshAgentFork {
                incarnation_id: state.incarnation_id.clone(),
                request_id: RequestId::new(),
                parent_session_id: ORIGINAL.into(),
                input: None,
            },
        ),
        &state,
    )
    .await;
    assert!(
        result.is_err(),
        "native recovery authority is limited to the original send"
    );
    assert_eq!(transport.accepted_turns.load(Ordering::SeqCst), 0);
    actor.stop().await.unwrap();
}
