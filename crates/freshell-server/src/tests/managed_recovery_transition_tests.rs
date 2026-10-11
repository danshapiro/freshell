use super::*;
#[derive(Clone)]
pub(crate) struct CaptureLogs(pub(crate) Arc<std::sync::Mutex<Vec<serde_json::Value>>>);
#[derive(Default)]
struct Fields(serde_json::Map<String, serde_json::Value>);
impl tracing::field::Visit for Fields {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.0.insert(field.name().into(), value.into());
    }
    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
        self.0
            .insert(field.name().into(), format!("{value:?}").into());
    }
}
impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for CaptureLogs {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        let mut fields = Fields::default();
        event.record(&mut fields);
        self.0.lock().unwrap().push(
            serde_json::json!({"severity":event.metadata().level().as_str(),"fields":fields.0}),
        );
    }
}
#[tokio::test]
async fn managed_runtime_recovery_transition_changes_cause_only_and_redacts_failed_payload() {
    use tracing::instrument::WithSubscriber;
    use tracing_subscriber::prelude::*;
    let bytes = Arc::new(std::sync::Mutex::new(vec![]));
    let capture = bytes.clone();
    let subscriber = tracing_subscriber::registry().with(CaptureLogs(capture));
    let (before_retry,soul)=async {
        let soul=SoulId::new();let incarnation=freshell_runtime_protocol::IncarnationId::new();
        let controller=ServerManagedRuntimeController {client:RuntimeClient::new("/unused-transition-fixture","synthetic"),recovery:Arc::default()};
        let mut view:RuntimeView=serde_json::from_value(serde_json::json!({"soulId":soul,"incarnationId":incarnation,
            "launchState":"running","cleanupState":"none","desiredState":"running","recoveryState":"blocked",
            "intentRevision":1,"executionGeneration":1,"terminalId":"transition-terminal","terminalStreamId":"actual-epoch",
            "terminalMode":"opencode","terminalCwd":"/workspace","recoveryReason":"ambiguous_identity",
            "incidentId":"incident-first","recoveryAttemptId":"recovery-first"})).unwrap();
        for _ in 0..40 {controller.hydrate(view.clone()).await;}
        view.incident_id=Some(freshell_runtime_protocol::IncidentId::parse("incident-second").unwrap());
        for _ in 0..40 {controller.hydrate(view.clone()).await;}
        let before_retry=bytes.lock().unwrap().len();
        let sequence=controller.begin_recovery(&soul,true).await.unwrap();
        controller.publish_recovery(&soul,sequence,&Err(ClientError::Runtime(RuntimeErrorCode::HostUnreachable,"raw secret=synthetic-sensitive-error".into()))).await;
        for _ in 0..40 {controller.publish_recovery(&soul,sequence,&Err(ClientError::Runtime(RuntimeErrorCode::HostUnreachable,"raw secret=synthetic-sensitive-error".into()))).await;}
        let sequence=controller.begin_recovery(&soul,true).await.unwrap();
        controller.publish_recovery(&soul,sequence,&Err(ClientError::Runtime(RuntimeErrorCode::InvalidRequest,"raw secret=synthetic-sensitive-error".into()))).await;
        let sequence=controller.begin_recovery(&soul,true).await.unwrap();
        view.recovery_state=RecoveryState::Live;view.recovery_reason=None;
        controller.publish_recovery(&soul,sequence,&Ok(RecoveryResult {outcome:RecoveryOutcome::AlreadyLive,view,probe:None,
            prior_incarnation_id:None,attempt_id:None,expected_native_session_id:None,observed_native_session_id:None,incident_id:None})).await;
        (before_retry,soul)
    }.with_subscriber(subscriber).await;
    assert_eq!(
        before_retry, 1,
        "unchanged lifecycle and classified cause do not log metadata-only updates"
    );
    let events = bytes.lock().unwrap().clone();
    assert!(!serde_json::to_string(&events)
        .unwrap()
        .contains("synthetic-sensitive-error"));
    assert_eq!(events.len(), 7);
    for event in events {
        assert_eq!(
            event["fields"]["event"],
            "managed_runtime.recovery_transition"
        );
        assert_eq!(event["fields"]["soul_id"], soul.as_str());
        assert_eq!(event["fields"]["terminal_id"], "transition-terminal");
        for field in ["incarnation_id", "from", "to", "cause"] {
            assert!(!event["fields"][field].is_null());
        }
    }
}
