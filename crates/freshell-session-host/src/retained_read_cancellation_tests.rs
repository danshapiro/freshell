use super::*;
use async_trait::async_trait;
use freshell_agent_runtime::host_actor::{
    DispatchAck, DispatchFailure, FreshAgentHostActor, FreshAgentProfile, FreshAgentTransport,
    TransportStart,
};
use freshell_runtime_protocol::{AgentEvent, FreshProvider, RequestId};
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::{io::AsyncWriteExt, sync::Notify, time::Duration};

struct PausedRetainedRead {
    entered: Notify,
    release: Notify,
    dropped: Arc<AtomicUsize>,
    interrupt_entered: Notify,
    interrupt_release: Notify,
    interrupts_completed: AtomicUsize,
}

struct ReadDropGuard(Arc<AtomicUsize>);

impl Drop for ReadDropGuard {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[async_trait]
impl FreshAgentTransport for PausedRetainedRead {
    async fn start(&self, _profile: &FreshAgentProfile) -> Result<TransportStart, String> {
        Ok(TransportStart {
            native_session_id: Some("fixture-thread".into()),
        })
    }

    async fn dispatch(
        &self,
        _request_id: &RequestId,
        _text: &str,
        _profile: &FreshAgentProfile,
    ) -> Result<DispatchAck, DispatchFailure> {
        unreachable!("the read fixture does not send provider input")
    }

    async fn resolve_permission(
        &self,
        _decision_id: &str,
        _decision: serde_json::Value,
    ) -> Result<(), DispatchFailure> {
        unreachable!("the read fixture does not resolve permissions")
    }

    async fn interrupt(&self) -> Result<(), String> {
        self.interrupt_entered.notify_one();
        self.interrupt_release.notified().await;
        self.interrupts_completed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }

    async fn retained_state(&self) -> Result<Option<serde_json::Value>, String> {
        let _drop_guard = ReadDropGuard(self.dropped.clone());
        self.entered.notify_one();
        self.release.notified().await;
        Ok(Some(
            serde_json::json!({"snapshot":{"threadId":"fixture-thread"}}),
        ))
    }

    async fn stop(self: Arc<Self>) -> Result<(), String> {
        Ok(())
    }

    fn take_event_stream(&self) -> Option<tokio::sync::mpsc::Receiver<AgentEvent>> {
        None
    }
}

async fn fixture() -> (tempfile::TempDir, Arc<HostState>, Arc<PausedRetainedRead>) {
    let root = tempfile::tempdir().unwrap();
    let state = Arc::new(HostState {
        incarnation_id: IncarnationId::new(),
        host_boot_id: HostBootId::new(),
        state_dir: root.path().join("host"),
        secret: b"0123456789abcdef0123456789abcdef".to_vec(),
        requested_limits: RuntimeLimits {
            cpu_milli: 500,
            memory_bytes: 128 * 1024 * 1024,
            swap_bytes: 0,
            pids_max: 64,
        },
        control_fence: std::sync::Mutex::new(HostControlFence::default()),
        persisted: Mutex::new(PersistedHostState::default()),
        child: Mutex::new(None),
        pty: Mutex::new(None),
        fresh_agent: Mutex::new(None),
        fresh_native_command: Mutex::new(()),
        provider_config_paths: ProviderConfigPaths::default(),
        opencode_transfer_mount: PathBuf::from(OPENCODE_TRANSFER_MOUNT),
        bootstrap_root: PathBuf::from("/run/freshell-bootstrap"),
    });
    let transport = Arc::new(PausedRetainedRead {
        entered: Notify::new(),
        release: Notify::new(),
        dropped: Arc::new(AtomicUsize::new(0)),
        interrupt_entered: Notify::new(),
        interrupt_release: Notify::new(),
        interrupts_completed: AtomicUsize::new(0),
    });
    let actor = FreshAgentHostActor::open(
        state.state_dir.join("agent"),
        FreshAgentProfile {
            naming_handle: None,
            collaboration_mode: None,
            provider: FreshProvider::Codex,
            runtime_variant: "fixture".into(),
            cwd: "/workspace".into(),
            model: Some("fixture-model".into()),
            effort: None,
            permission_mode: None,
            sandbox: None,
            provider_store_id: "fixture-store".into(),
            native_session_id: None,
            plugins: None,
            model_selection: None,
            session_ref: None,
            provider_launch_context: None,
            provider_secret_references: Vec::new(),
        },
        transport.clone(),
    )
    .await
    .unwrap();
    *state.fresh_agent.lock().await = Some(actor);
    (root, state, transport)
}

async fn start_read(
    state: Arc<HostState>,
) -> (UnixStream, tokio::task::JoinHandle<Result<(), String>>) {
    let (mut client, server) = UnixStream::pair().unwrap();
    let handler = tokio::spawn(handle_connection(server, state.clone()));
    write_frame(
        &mut client,
        &tests::authenticated_host_envelope(
            &state,
            HostCommand::FreshAgentReadEvents {
                incarnation_id: state.incarnation_id.clone(),
                after_sequence: 0,
                max_events: 1,
            },
        ),
    )
    .await
    .unwrap();
    (client, handler)
}

#[tokio::test]
async fn disconnected_retained_read_drops_host_work_and_preserves_later_journal_reads() {
    let (_root, state, transport) = fixture().await;
    let (client, mut handler) = start_read(state.clone()).await;
    tokio::time::timeout(Duration::from_secs(3), transport.entered.notified())
        .await
        .unwrap();
    drop(client);
    let result = tokio::time::timeout(Duration::from_secs(1), &mut handler).await;
    let cancelled = transport.dropped.load(Ordering::SeqCst) == 1;
    if result.is_err() {
        handler.abort();
        let _ = handler.await;
    }
    assert!(matches!(&result, Ok(Ok(Ok(())))) && cancelled,
        "closing the requesting connection must cleanly cancel the host's retained read: {result:?}");

    let (mut client, handler) = start_read(state.clone()).await;
    tokio::time::timeout(Duration::from_secs(3), transport.entered.notified())
        .await
        .unwrap();
    transport.release.notify_one();
    let reply: HostReply = tokio::time::timeout(Duration::from_secs(3), read_frame(&mut client))
        .await
        .unwrap()
        .unwrap();
    let HostResult::FreshAgentEvents(batch) = reply.result.unwrap() else {
        panic!("expected journal read")
    };
    assert!(batch.events.iter().any(|row| matches!(&row.event, AgentEvent::Started { native_session_id } if native_session_id == "fixture-thread")));
    handler.await.unwrap().unwrap();
}

#[tokio::test]
async fn half_closed_request_keeps_waiting_for_its_journal_reply() {
    let (_root, state, transport) = fixture().await;
    let (mut client, mut handler) = start_read(state).await;
    tokio::time::timeout(Duration::from_secs(3), transport.entered.notified())
        .await
        .unwrap();
    client.shutdown().await.unwrap();
    let finished_early = tokio::time::timeout(Duration::from_millis(500), &mut handler)
        .await
        .is_ok();
    transport.release.notify_one();
    let reply: Result<HostReply, _> =
        tokio::time::timeout(Duration::from_secs(3), read_frame(&mut client))
            .await
            .unwrap();
    if !finished_early {
        handler.await.unwrap().unwrap();
    }
    assert!(
        !finished_early,
        "closing only the client's write side must not cancel a connected reader"
    );
    assert!(matches!(
        reply.unwrap().result,
        Ok(HostResult::FreshAgentEvents(_))
    ));
}

#[tokio::test]
async fn fully_disconnecting_after_a_half_close_still_cancels_the_read() {
    let (_root, state, transport) = fixture().await;
    let (mut client, mut handler) = start_read(state).await;
    tokio::time::timeout(Duration::from_secs(3), transport.entered.notified())
        .await
        .unwrap();
    client.shutdown().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(250), &mut handler)
            .await
            .is_err(),
        "a half-closed client is still waiting for its reply"
    );
    drop(client);
    let result = tokio::time::timeout(Duration::from_secs(2), &mut handler).await;
    let cancelled = transport.dropped.load(Ordering::SeqCst) == 1;
    if result.is_err() {
        handler.abort();
        let _ = handler.await;
    }
    assert!(
        matches!(&result, Ok(Ok(Ok(())))) && cancelled,
        "closing the remaining read side must cancel the host work: {result:?}"
    );
}

#[tokio::test]
async fn disconnected_interrupt_continues_its_mutating_host_work() {
    let (_root, state, transport) = fixture().await;
    let (mut client, server) = UnixStream::pair().unwrap();
    let mut handler = tokio::spawn(handle_connection(server, state.clone()));
    write_frame(
        &mut client,
        &tests::authenticated_host_envelope(
            &state,
            HostCommand::FreshAgentInterrupt {
                incarnation_id: state.incarnation_id.clone(),
                request_id: None,
            },
        ),
    )
    .await
    .unwrap();
    tokio::time::timeout(
        Duration::from_secs(3),
        transport.interrupt_entered.notified(),
    )
    .await
    .unwrap();
    drop(client);
    let finished_early = tokio::time::timeout(Duration::from_millis(500), &mut handler)
        .await
        .is_ok();
    transport.interrupt_release.notify_one();
    if !finished_early {
        let joined = tokio::time::timeout(Duration::from_secs(3), handler)
            .await
            .unwrap();
        assert!(
            joined.is_ok(),
            "the host handler must not panic after a disconnected interrupt"
        );
    }
    assert!(
        !finished_early,
        "a dropped caller must not cancel an already-dispatched interrupt"
    );
    assert_eq!(transport.interrupts_completed.load(Ordering::SeqCst), 1);
}
