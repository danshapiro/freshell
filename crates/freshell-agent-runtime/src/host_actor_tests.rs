use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct FakeTransport {
    native: String,
    starts: AtomicUsize,
    dispatches: AtomicUsize,
    decisions: AtomicUsize,
    stops: AtomicUsize,
    ambiguous_dispatch: bool,
    live: std::sync::atomic::AtomicBool,
}

struct MaterializingTransport {
    receiver: std::sync::Mutex<Option<tokio::sync::mpsc::Receiver<AgentEvent>>>,
}

struct SerialTransport {
    in_flight: AtomicUsize,
    max_in_flight: AtomicUsize,
}

#[async_trait]
impl FreshAgentTransport for SerialTransport {
    async fn start(&self, _profile: &FreshAgentProfile) -> Result<TransportStart, String> {
        Ok(TransportStart {
            native_session_id: Some("serial-native".into()),
        })
    }
    async fn dispatch(
        &self,
        _request_id: &RequestId,
        _text: &str,
        _profile: &FreshAgentProfile,
    ) -> Result<DispatchAck, DispatchFailure> {
        let current = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_in_flight.fetch_max(current, Ordering::SeqCst);
        tokio::time::sleep(std::time::Duration::from_millis(15)).await;
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        Ok(DispatchAck {
            provider_ack_id: None,
        })
    }
    async fn resolve_permission(
        &self,
        _decision_id: &str,
        _decision: Value,
    ) -> Result<(), DispatchFailure> {
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), String> {
        Ok(())
    }
    async fn stop(self: Arc<Self>) -> Result<(), String> {
        Ok(())
    }
    fn take_event_stream(&self) -> Option<tokio::sync::mpsc::Receiver<AgentEvent>> {
        None
    }
}

#[async_trait]
impl FreshAgentTransport for MaterializingTransport {
    async fn start(&self, _profile: &FreshAgentProfile) -> Result<TransportStart, String> {
        Ok(TransportStart {
            native_session_id: None,
        })
    }

    async fn dispatch(
        &self,
        _request_id: &RequestId,
        _text: &str,
        _profile: &FreshAgentProfile,
    ) -> Result<DispatchAck, DispatchFailure> {
        unreachable!("materialization fixture does not dispatch")
    }

    async fn resolve_permission(
        &self,
        _decision_id: &str,
        _decision: Value,
    ) -> Result<(), DispatchFailure> {
        unreachable!("materialization fixture has no decisions")
    }

    async fn interrupt(&self) -> Result<(), String> {
        Ok(())
    }

    async fn stop(self: Arc<Self>) -> Result<(), String> {
        Ok(())
    }

    fn take_event_stream(&self) -> Option<tokio::sync::mpsc::Receiver<AgentEvent>> {
        self.receiver.lock().expect("receiver lock").take()
    }
}

impl FakeTransport {
    fn new(native: &str) -> Arc<Self> {
        Arc::new(Self {
            native: native.into(),
            starts: AtomicUsize::new(0),
            dispatches: AtomicUsize::new(0),
            decisions: AtomicUsize::new(0),
            stops: AtomicUsize::new(0),
            ambiguous_dispatch: false,
            live: std::sync::atomic::AtomicBool::new(true),
        })
    }
    fn ambiguous(native: &str) -> Arc<Self> {
        Arc::new(Self {
            ambiguous_dispatch: true,
            ..Self {
                native: native.into(),
                starts: AtomicUsize::new(0),
                dispatches: AtomicUsize::new(0),
                decisions: AtomicUsize::new(0),
                stops: AtomicUsize::new(0),
                ambiguous_dispatch: false,
                live: std::sync::atomic::AtomicBool::new(true),
            }
        })
    }
}

#[async_trait]
impl FreshAgentTransport for FakeTransport {
    async fn start(&self, _profile: &FreshAgentProfile) -> Result<TransportStart, String> {
        self.starts.fetch_add(1, Ordering::SeqCst);
        Ok(TransportStart {
            native_session_id: Some(self.native.clone()),
        })
    }
    async fn dispatch(
        &self,
        _request_id: &RequestId,
        _text: &str,
        _profile: &FreshAgentProfile,
    ) -> Result<DispatchAck, DispatchFailure> {
        self.dispatches.fetch_add(1, Ordering::SeqCst);
        if self.ambiguous_dispatch {
            Err(DispatchFailure {
                message: "reply lost".into(),
                acceptance_ambiguous: true,
            })
        } else {
            Ok(DispatchAck {
                provider_ack_id: Some("ack-1".into()),
            })
        }
    }
    async fn resolve_permission(
        &self,
        _decision_id: &str,
        _decision: Value,
    ) -> Result<(), DispatchFailure> {
        self.decisions.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    async fn interrupt(&self) -> Result<(), String> {
        Ok(())
    }
    async fn is_live(&self) -> bool {
        self.live.load(Ordering::SeqCst)
    }
    async fn stop(self: Arc<Self>) -> Result<(), String> {
        self.stops.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
    fn take_event_stream(&self) -> Option<tokio::sync::mpsc::Receiver<AgentEvent>> {
        None
    }
}

fn profile(provider: FreshProvider, store: &str, native: Option<&str>) -> FreshAgentProfile {
    FreshAgentProfile {
        runtime_variant: provider.as_str().into(),
        provider,
        cwd: "/workspace".into(),
        model: Some("fixture-model".into()),
        effort: Some("low".into()),
        permission_mode: Some("ask".into()),
        sandbox: Some("workspace-write".into()),
        provider_store_id: store.into(),
        native_session_id: native.map(str::to_string),
    }
}

#[tokio::test]
async fn dropping_gateway_cursor_neither_stops_transport_nor_changes_native_identity() {
    let dir = tempfile::tempdir().unwrap();
    let transport = FakeTransport::new("native-1");
    let actor = FreshAgentHostActor::open(
        dir.path(),
        profile(FreshProvider::Claude, "store-a", None),
        transport.clone(),
    )
    .await
    .unwrap();
    let cursor = actor.read_events(0, 20).await;
    drop(cursor);
    assert_eq!(
        actor.profile().await.native_session_id.as_deref(),
        Some("native-1")
    );
    assert_eq!(transport.stops.load(Ordering::SeqCst), 0);
    assert_eq!(transport.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn transport_liveness_is_observed_without_transferring_ownership() {
    let dir = tempfile::tempdir().unwrap();
    let transport = FakeTransport::new("native-live");
    let actor = FreshAgentHostActor::open(
        dir.path(),
        profile(FreshProvider::Codex, "store-live", None),
        transport.clone(),
    )
    .await
    .unwrap();
    assert!(actor.is_live().await);
    transport.live.store(false, Ordering::SeqCst);
    assert!(!actor.is_live().await);
    assert_eq!(transport.stops.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn pending_permission_persists_and_is_answered_exactly_once_after_gateway_restart() {
    let dir = tempfile::tempdir().unwrap();
    let transport = FakeTransport::new("thread-7");
    let actor = FreshAgentHostActor::open(
        dir.path(),
        profile(FreshProvider::Codex, "store-a", None),
        transport.clone(),
    )
    .await
    .unwrap();
    let sequence = actor
        .record_permission("permission-1".into(), serde_json::json!({"tool":"shell"}))
        .await
        .unwrap();
    assert_eq!(
        actor
            .record_permission("permission-1".into(), serde_json::json!({"tool":"shell"}))
            .await
            .unwrap(),
        sequence
    );
    assert_eq!(
        actor
            .record_permission(
                "permission-1".into(),
                serde_json::json!({"tool":"different"})
            )
            .await,
        Err(ActorError::RequestConflict)
    );
    drop(actor.read_events(0, 20).await);
    actor
        .resolve_permission("permission-1", serde_json::json!({"decision":"accept"}))
        .await
        .unwrap();
    actor
        .resolve_permission("permission-1", serde_json::json!({"decision":"accept"}))
        .await
        .unwrap();
    assert_eq!(transport.decisions.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn ambiguous_accepted_input_is_never_dispatched_twice() {
    let dir = tempfile::tempdir().unwrap();
    let transport = FakeTransport::ambiguous("ses_1");
    let actor = FreshAgentHostActor::open(
        dir.path(),
        profile(FreshProvider::Opencode, "store-a", None),
        transport.clone(),
    )
    .await
    .unwrap();
    let request = RequestId::parse("request-ambiguous").unwrap();
    assert_eq!(
        actor
            .dispatch(request.clone(), "do work".into(), None)
            .await,
        Err(ActorError::AmbiguousDispatch)
    );
    assert_eq!(
        actor.dispatch(request, "do work".into(), None).await,
        Err(ActorError::AmbiguousDispatch)
    );
    assert_eq!(transport.dispatches.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn one_state_directory_has_only_one_writer() {
    let dir = tempfile::tempdir().unwrap();
    let first = FreshAgentHostActor::open(
        dir.path(),
        profile(FreshProvider::Claude, "store-a", None),
        FakeTransport::new("native-1"),
    )
    .await
    .unwrap();
    let second = FreshAgentHostActor::open(
        dir.path(),
        profile(FreshProvider::Claude, "store-a", Some("native-1")),
        FakeTransport::new("native-1"),
    )
    .await;
    assert!(matches!(second, Err(ActorError::WriterBusy)));
    drop(first);
}

#[tokio::test]
async fn exact_native_identity_and_profile_are_reused_on_host_actor_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let initial = profile(FreshProvider::Kilroy, "kilroy-store", None);
    let actor =
        FreshAgentHostActor::open(dir.path(), initial, FakeTransport::new("claude-native-9"))
            .await
            .unwrap();
    actor
        .dispatch(
            RequestId::parse("settings-update").unwrap(),
            "continue".into(),
            Some(FreshAgentTurnSettings {
                cwd: None,
                model: Some("updated-model".into()),
                effort: Some("high".into()),
                permission_mode: None,
                sandbox: None,
            }),
        )
        .await
        .unwrap();
    let recovered_profile = actor.profile().await;
    assert_eq!(recovered_profile.model.as_deref(), Some("updated-model"));
    drop(actor);
    let actor = FreshAgentHostActor::open(
        dir.path(),
        recovered_profile.clone(),
        FakeTransport::new("claude-native-9"),
    )
    .await
    .unwrap();
    assert_eq!(actor.profile().await, recovered_profile);
    drop(actor);
    let wrong = FreshAgentHostActor::open(
        dir.path(),
        profile(FreshProvider::Kilroy, "kilroy-store", Some("wrong")),
        FakeTransport::new("wrong"),
    )
    .await;
    assert!(matches!(wrong, Err(ActorError::NativeIdentityMismatch)));

    let mut wrong_profile = recovered_profile;
    wrong_profile.model = Some("different-model".into());
    let wrong = FreshAgentHostActor::open(
        dir.path(),
        wrong_profile,
        FakeTransport::new("claude-native-9"),
    )
    .await;
    assert!(matches!(wrong, Err(ActorError::NativeIdentityMismatch)));
}

#[tokio::test]
async fn independent_souls_have_independent_transports_and_bounded_journals() {
    let root = tempfile::tempdir().unwrap();
    let a_transport = FakeTransport::new("ses_a");
    let b_transport = FakeTransport::new("ses_b");
    let a = FreshAgentHostActor::open_with_bounds(
        root.path().join("a"),
        profile(FreshProvider::Opencode, "store-a", None),
        a_transport.clone(),
        450,
        3,
    )
    .await
    .unwrap();
    let b = FreshAgentHostActor::open_with_bounds(
        root.path().join("b"),
        profile(FreshProvider::Opencode, "store-b", None),
        b_transport.clone(),
        450,
        3,
    )
    .await
    .unwrap();
    for index in 0..10 {
        a.record_event(AgentEvent::Provider {
            payload: serde_json::json!({"index":index,"text":"xxxxxxxxxxxxxxxxxxxxxxxx"}),
        })
        .await
        .unwrap();
    }

    let batch = a.read_events(0, 100).await;
    assert!(batch.reset_required);
    assert!(batch.events.len() <= 3);
    assert_eq!(
        b.profile().await.native_session_id.as_deref(),
        Some("ses_b")
    );
    assert_eq!(a_transport.starts.load(Ordering::SeqCst), 1);
    assert_eq!(b_transport.starts.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn durable_event_sequences_are_contiguous_for_gateway_cursors() {
    let dir = tempfile::tempdir().unwrap();
    let actor = FreshAgentHostActor::open(
        dir.path(),
        profile(FreshProvider::Claude, "sequence-store", None),
        FakeTransport::new("sequence-native"),
    )
    .await
    .unwrap();
    actor.record_event(AgentEvent::Interrupted).await.unwrap();
    actor.record_event(AgentEvent::Interrupted).await.unwrap();

    let sequences = actor
        .read_events(0, 10)
        .await
        .events
        .into_iter()
        .map(|event| event.sequence)
        .collect::<Vec<_>>();
    assert_eq!(sequences, vec![1, 2, 3]);
}

#[tokio::test]
async fn unresolved_permission_event_survives_bounded_journal_pressure() {
    let dir = tempfile::tempdir().unwrap();
    let actor = FreshAgentHostActor::open_with_bounds(
        dir.path(),
        profile(FreshProvider::Claude, "decision-store", None),
        FakeTransport::new("decision-native"),
        2_000,
        2,
    )
    .await
    .unwrap();
    actor
        .record_permission(
            "permission-retained".into(),
            serde_json::json!({"tool":"shell"}),
        )
        .await
        .unwrap();
    for index in 0..10 {
        actor
            .record_event(AgentEvent::Provider {
                payload: serde_json::json!({"index":index}),
            })
            .await
            .unwrap();
    }

    let batch = actor.read_events(0, 10).await;
    assert!(batch.reset_required);
    assert!(batch.events.iter().any(|entry| matches!(
        &entry.event,
        AgentEvent::PermissionRequested { decision_id, .. }
            if decision_id == "permission-retained"
    )));
    assert!(batch.events.len() <= 2);
}

#[tokio::test]
async fn concurrent_gateways_share_one_ordered_provider_command_lane() {
    let dir = tempfile::tempdir().unwrap();
    let transport = Arc::new(SerialTransport {
        in_flight: AtomicUsize::new(0),
        max_in_flight: AtomicUsize::new(0),
    });
    let actor = FreshAgentHostActor::open(
        dir.path(),
        profile(FreshProvider::Codex, "serial-store", None),
        transport.clone(),
    )
    .await
    .unwrap();
    let one = actor.dispatch(RequestId::parse("serial-one").unwrap(), "one".into(), None);
    let two = actor.dispatch(RequestId::parse("serial-two").unwrap(), "two".into(), None);
    let (one, two) = tokio::join!(one, two);
    assert_eq!(one.unwrap(), CommandState::ProviderAcked);
    assert_eq!(two.unwrap(), CommandState::ProviderAcked);
    assert_eq!(transport.max_in_flight.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn every_fresh_provider_materializes_native_identity_through_the_host_event_pump() {
    for (index, provider) in [
        FreshProvider::Claude,
        FreshProvider::Kilroy,
        FreshProvider::Codex,
        FreshProvider::Opencode,
    ]
    .into_iter()
    .enumerate()
    {
        let dir = tempfile::tempdir().unwrap();
        let (sender, receiver) = tokio::sync::mpsc::channel(1);
        let actor = FreshAgentHostActor::open(
            dir.path(),
            profile(provider, &format!("store-{index}"), None),
            Arc::new(MaterializingTransport {
                receiver: std::sync::Mutex::new(Some(receiver)),
            }),
        )
        .await
        .unwrap();
        let native = format!("native-{index}");
        sender
            .send(AgentEvent::Started {
                native_session_id: native.clone(),
            })
            .await
            .unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(1), async {
            loop {
                if actor.profile().await.native_session_id.as_deref() == Some(native.as_str()) {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }
}
