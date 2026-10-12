use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use freshell_opencode::serve::{
    Endpoint, EventSink, EventSource, EventStreamHandle, HttpMethod, PortAllocator, ProcessSpawner,
    ServeConfig, ServeDeps, ServeError, ServeHttp, ServeHttpError, ServeHttpRequest,
    ServeHttpResponse, ServeProcess, SpawnRequest,
};
use freshell_opencode::{observed_user_message_id, OpencodeServeManager};
use serde_json::{json, Value};

const CHECKPOINT_MESSAGE_ID: &str = "msg_0123456789abcdef0123456789abcdef";

#[derive(Default)]
struct FakeProviderState {
    prompt_body: Mutex<Option<Value>>,
    persisted_messages: Mutex<Value>,
    status_poll: AtomicUsize,
}

struct FakeHttp(Arc<FakeProviderState>);

impl ServeHttp for FakeHttp {
    fn request<'a>(
        &'a self,
        request: ServeHttpRequest,
    ) -> freshell_opencode::serve::BoxFuture<'a, Result<ServeHttpResponse, ServeHttpError>> {
        let state = self.0.clone();
        Box::pin(async move {
            if request.url.contains("/global/health") {
                return Ok(ServeHttpResponse::new(200, b"{}".to_vec()));
            }
            if request.method == HttpMethod::Post && request.url.contains("/prompt_async") {
                let body: Value =
                    serde_json::from_slice(request.body.as_deref().expect("prompt body is sent"))
                        .expect("prompt body is JSON");
                let native_id = body["messageID"]
                    .as_str()
                    .unwrap_or("provider-generated")
                    .to_string();
                *state.prompt_body.lock().unwrap() = Some(body);
                *state.persisted_messages.lock().unwrap() = json!([{
                    "info": {"id": native_id, "role": "user"},
                    "parts": [{"type": "text", "text": "synthetic prompt"}]
                }]);
                return Ok(ServeHttpResponse::new(200, b"{}".to_vec()));
            }
            if request.method == HttpMethod::Get && request.url.contains("/session/status") {
                let poll = state.status_poll.fetch_add(1, Ordering::SeqCst);
                let body = if poll == 0 {
                    json!({"ses_checkpoint": {"type": "busy"}})
                } else {
                    json!({"ses_checkpoint": {"type": "idle"}})
                };
                return Ok(ServeHttpResponse::new(
                    200,
                    serde_json::to_vec(&body).unwrap(),
                ));
            }
            if request.method == HttpMethod::Get && request.url.contains("/message") {
                let body = state.persisted_messages.lock().unwrap().clone();
                return Ok(ServeHttpResponse::new(
                    200,
                    serde_json::to_vec(&body).unwrap(),
                ));
            }
            Ok(ServeHttpResponse::new(200, b"{}".to_vec()))
        })
    }
}

struct FakeProcess;

impl ServeProcess for FakeProcess {
    fn exited(&self) -> Option<i32> {
        None
    }

    fn take_fatal_startup_error(&self) -> Option<String> {
        None
    }

    fn kill(&self) {}
}

struct FakeSpawner;

impl ProcessSpawner for FakeSpawner {
    fn spawn(&self, _request: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
        Ok(Box::new(FakeProcess))
    }
}

struct FakePorts;

impl PortAllocator for FakePorts {
    fn allocate(&self) -> Result<Endpoint, String> {
        Ok(Endpoint {
            hostname: "127.0.0.1".into(),
            port: 43127,
        })
    }
}

struct FakeEventHandle;

impl EventStreamHandle for FakeEventHandle {}

struct FakeEvents;

impl EventSource for FakeEvents {
    fn connect(&self, _url: String, _sink: EventSink) -> Box<dyn EventStreamHandle> {
        Box::new(FakeEventHandle)
    }
}

async fn fake_manager() -> (OpencodeServeManager, Arc<FakeProviderState>) {
    let state = Arc::new(FakeProviderState::default());
    let manager = OpencodeServeManager::new(
        ServeDeps {
            spawner: Arc::new(FakeSpawner),
            http: Arc::new(FakeHttp(state.clone())),
            ports: Arc::new(FakePorts),
            events: Arc::new(FakeEvents),
        },
        ServeConfig {
            health_timeout: Duration::from_secs(1),
            health_probe_timeout: Duration::from_millis(100),
            health_retry_interval: Duration::from_millis(1),
            idle_poll_interval: Duration::from_millis(1),
            request_timeout: Duration::from_secs(1),
            ..ServeConfig::default()
        },
    );
    (manager, state)
}

#[tokio::test]
async fn opencode_checkpoint_message_id_in_prompt_body() -> Result<(), ServeError> {
    let (manager, state) = fake_manager().await;
    manager
        .run_turn_with_message_id(
            "ses_checkpoint",
            "synthetic prompt",
            Some("local/fake"),
            None,
            Some(CHECKPOINT_MESSAGE_ID),
            Duration::from_secs(1),
            None,
            None,
            None,
        )
        .await?;

    let prompt_body = state.prompt_body.lock().unwrap().clone().unwrap();
    assert_eq!(prompt_body["messageID"], CHECKPOINT_MESSAGE_ID);
    let persisted = manager.list_messages("ses_checkpoint", &None).await?;
    assert_eq!(
        observed_user_message_id(&persisted, CHECKPOINT_MESSAGE_ID).as_deref(),
        Some(CHECKPOINT_MESSAGE_ID),
        "the production prompt path is joined only after the fake serve exposes its persisted user row"
    );
    manager.shutdown().await;
    Ok(())
}

#[test]
fn opencode_checkpoint_message_id_binds_observed_native_row() {
    let messages = json!([
        {"info": {"id": "msg_assistant", "role": "assistant"}},
        {"info": {"id": CHECKPOINT_MESSAGE_ID, "role": "user"}},
    ]);
    assert_eq!(
        observed_user_message_id(&messages, CHECKPOINT_MESSAGE_ID).as_deref(),
        Some(CHECKPOINT_MESSAGE_ID)
    );
    assert_eq!(
        observed_user_message_id(&messages, "msg_abcdefabcdefabcdefabcdefabcdefab"),
        None,
        "a supplied ID is not binding evidence when history does not show it"
    );
    let assistant_only = json!([{"info": {"id": CHECKPOINT_MESSAGE_ID, "role": "assistant"}}]);
    assert_eq!(
        observed_user_message_id(&assistant_only, CHECKPOINT_MESSAGE_ID),
        None,
        "an ID on an assistant row is not a submitted user turn"
    );
    let ambiguous = json!([
        {"info": {"id": CHECKPOINT_MESSAGE_ID, "role": "user"}},
        {"info": {"id": CHECKPOINT_MESSAGE_ID, "role": "user"}},
    ]);
    assert_eq!(
        observed_user_message_id(&ambiguous, CHECKPOINT_MESSAGE_ID),
        None,
        "duplicate matching user rows remain ambiguous"
    );
}
