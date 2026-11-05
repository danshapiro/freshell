use super::*;

struct CountingHttp {
    inner: StatusPollFakeHttp,
    prompts: AtomicUsize,
}

impl ServeHttp for CountingHttp {
    fn request<'a>(
        &'a self,
        request: ServeHttpRequest,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<Output = Result<ServeHttpResponse, ServeHttpError>> + Send + 'a,
        >,
    > {
        if request.url.contains("/prompt_async") {
            self.prompts.fetch_add(1, Ordering::SeqCst);
        }
        self.inner.request(request)
    }
}

async fn controlled_state() -> (
    FreshOpencodeState,
    OpencodeServeManager,
    Arc<CountingHttp>,
    tokio::sync::broadcast::Receiver<String>,
) {
    let (tx, rx) = tokio::sync::broadcast::channel::<String>(128);
    let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
    let http = Arc::new(CountingHttp {
        inner: StatusPollFakeHttp::new(1000),
        prompts: AtomicUsize::new(0),
    });
    let deps = ServeDeps {
        spawner: Arc::new(TrackedSpawner {
            killed: Arc::new(AtomicBool::new(false)),
        }),
        http: http.clone(),
        ports: Arc::new(FakeAllocator),
        events: Arc::new(NoopEventSource),
    };
    let manager = OpencodeServeManager::new(
        deps,
        ServeConfig {
            idle_poll_interval: Duration::from_millis(15),
            ..ServeConfig::default()
        },
    );
    manager.ensure_started().await.unwrap();
    fresh_agent.set_manager_for_test(manager.clone()).await;
    (FreshOpencodeState::new(fresh_agent), manager, http, rx)
}

async fn wait_for_prompts(http: &CountingHttp, expected: usize) {
    tokio::time::timeout(Duration::from_secs(3), async {
        while http.prompts.load(Ordering::SeqCst) < expected {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("the requested prompt must enter the daemon");
}

fn daemon_event(
    manager: &OpencodeServeManager,
    kind: &str,
    properties: serde_json::Map<String, Value>,
) {
    manager.dispatch_event(freshell_opencode::ParsedServeEvent {
        kind: kind.into(),
        session_id: Some("ses_1".into()),
        properties,
        raw: Default::default(),
    });
}

async fn wait_for_settlement(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Option<Value> {
    tokio::time::timeout(Duration::from_millis(800), async {
        loop {
            let raw = rx.recv().await.unwrap();
            let value: Value = serde_json::from_str(&raw).unwrap();
            if is_event(&value, "freshAgent.turn.settled", None) {
                return value;
            }
        }
    })
    .await
    .ok()
}

#[tokio::test]
async fn clean_send_reports_its_own_correlated_settlement() {
    let (st, mut rx) = state_with_status_poll_and_receiver(1).await;
    st.handle_create(create_msg("settled-clean"), None).await;
    st.handle_send(send_msg("freshopencode-settled-clean", "one"))
        .await;
    let receipt = wait_for_settlement(&mut rx)
        .await
        .expect("the send must settle");
    assert_eq!(receipt["sessionId"], "ses_1");
    assert_eq!(receipt["event"]["requestIds"], json!(["req-one"]));
    assert_eq!(receipt["event"]["outcome"], "completed");
    assert!(receipt["event"].get("message").is_none());
}

#[tokio::test]
async fn stopped_send_reports_interruption_without_claiming_success() {
    let (st, mut rx) = state_with_status_poll_and_receiver(1000).await;
    st.handle_create(create_msg("settled-stop"), None).await;
    st.handle_send(send_msg("freshopencode-settled-stop", "stop me"))
        .await;
    tokio::task::yield_now().await;
    st.handle_interrupt(FreshAgentInterrupt {
        request_id: Some("stop-request".into()),
        provider: AgentProvider::Opencode,
        session_id: "ses_1".into(),
        session_type: SessionType::Freshopencode,
        cwd: None,
    })
    .await;
    let receipt = wait_for_settlement(&mut rx)
        .await
        .expect("the stopped send must settle");
    assert_eq!(receipt["event"]["requestIds"], json!(["req-stop me"]));
    assert_eq!(receipt["event"]["outcome"], "interrupted");
}

#[tokio::test]
async fn provider_error_before_idle_is_reported_for_the_matching_send() {
    let (st, manager, http, mut rx) = controlled_state().await;
    st.handle_create(create_msg("settled-failed"), None).await;
    st.handle_send(send_msg("freshopencode-settled-failed", "failure"))
        .await;
    wait_for_prompts(&http, 1).await;
    let mut properties = serde_json::Map::new();
    properties.insert(
        "error".into(),
        json!({ "message": "PRIVATE_PROVIDER_DETAIL" }),
    );
    daemon_event(&manager, "session.error", properties);
    daemon_event(&manager, "session.idle", Default::default());
    let receipt = wait_for_settlement(&mut rx)
        .await
        .expect("the failed send must settle");
    assert_eq!(receipt["event"]["requestIds"], json!(["req-failure"]));
    assert_eq!(receipt["event"]["outcome"], "failed");
    assert!(!receipt.to_string().contains("PRIVATE_PROVIDER_DETAIL"));
}

#[tokio::test]
async fn overlapping_sends_never_assign_a_session_wide_idle_to_either_request() {
    let (st, manager, http, mut rx) = controlled_state().await;
    st.handle_create(create_msg("settled-overlap"), None).await;
    st.handle_send(send_msg("freshopencode-settled-overlap", "first"))
        .await;
    st.handle_send(send_msg("ses_1", "second")).await;
    wait_for_prompts(&http, 2).await;
    daemon_event(&manager, "session.idle", Default::default());
    let frames = frames_until(&mut rx, |frame| {
        is_event(frame, "freshAgent.turn.complete", None)
    })
    .await;
    assert!(
        !frames
            .iter()
            .any(|frame| is_event(frame, "freshAgent.turn.settled", None)),
        "{frames:?}"
    );
    assert!(
        wait_for_settlement(&mut rx).await.is_none(),
        "an overlapping send must remain unconfirmed"
    );
}

#[tokio::test]
async fn an_earlier_unconfirmed_daemon_turn_cannot_settle_a_later_send() {
    let (st, manager, http, mut rx) = controlled_state().await;
    insert_compact_session(&st, "ses_1", Some("provider/model")).await;
    let session = st.sessions.lock().await.get("ses_1").cloned().unwrap();
    // A prior local idle wait ended, but its daemon-side turn remains live.
    session
        .lock()
        .await
        .daemon_turn_accepted
        .store(true, Ordering::SeqCst);
    st.handle_send(send_msg("ses_1", "later")).await;
    wait_for_prompts(&http, 1).await;
    daemon_event(&manager, "session.idle", Default::default());
    let frames = frames_until(&mut rx, |frame| {
        is_event(frame, "freshAgent.turn.complete", None)
    })
    .await;
    assert!(
        !frames
            .iter()
            .any(|frame| is_event(frame, "freshAgent.turn.settled", None)),
        "{frames:?}"
    );
    assert!(
        wait_for_settlement(&mut rx).await.is_none(),
        "the later request remains unconfirmed"
    );
}
