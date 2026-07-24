//! The opencode serve **IDLE edge** consumer (`serve-manager.ts:440-520`, `onceIdle`),
//! driven end-to-end through a fully-faked serve — NO real serve, NO live API calls.
//!
//! Covers the completion-signal surface the T2 `provider.emits-idle-signal` invariant
//! grades (`coding-cli.md §3`, baseline `opencode-kimi.json:serverReportedIdle=true`):
//!   * resolve on the SSE `session.idle` edge,
//!   * resolve on the SSE `session.status{type:idle}` edge,
//!   * resolve via the status-map poll FALLBACK (2 consecutive idle polls after observed
//!     running activity) when no SSE idle is delivered,
//!   * reject on sidecar loss,
//!   * reject on the idle timeout.
//!
//! The manager is started against a healthy fake (so `require_base` is instant), then SSE
//! events are injected via `dispatch_event` and status is scripted via the fake HTTP.

use std::sync::Arc;
use std::time::Duration;

use freshell_opencode::events::parse_serve_event;
use freshell_opencode::serve::{
    Endpoint, EventSink, EventSource, EventStreamHandle, OpencodeServeManager, PortAllocator,
    ProcessSpawner, ServeConfig, ServeDeps, ServeError, ServeHttp, ServeHttpRequest,
    ServeHttpResponse, ServeProcess, SpawnRequest,
};
use serde_json::json;

// ── fakes ────────────────────────────────────────────────────────────────────────

/// Healthy `/global/health`; `/session/status` returns a scripted status map so the
/// poll fallback can be exercised deterministically.
struct IdleHttp {
    status_body: Vec<u8>,
}
impl ServeHttp for IdleHttp {
    fn request<'a>(
        &'a self,
        req: ServeHttpRequest,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<ServeHttpResponse, String>> + Send + 'a>,
    > {
        let body = if req.url.contains("/global/health") {
            b"{}".to_vec()
        } else if req.url.contains("/session/status") {
            self.status_body.clone()
        } else {
            b"{}".to_vec()
        };
        Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) })
    }
}

struct FakeAllocator;
impl PortAllocator for FakeAllocator {
    fn allocate(&self) -> Result<Endpoint, String> {
        Ok(Endpoint {
            hostname: "127.0.0.1".into(),
            port: 1,
        })
    }
}

struct NeverExitsProcess;
impl ServeProcess for NeverExitsProcess {
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
    fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
        Ok(Box::new(NeverExitsProcess))
    }
}

struct NoopHandle;
impl EventStreamHandle for NoopHandle {}
struct NoopEventSource;
impl EventSource for NoopEventSource {
    fn connect(&self, _url: String, _sink: EventSink) -> Box<dyn EventStreamHandle> {
        Box::new(NoopHandle)
    }
}

async fn started_manager(
    status_body: serde_json::Value,
    idle_poll_ms: u64,
) -> OpencodeServeManager {
    let deps = ServeDeps {
        spawner: Arc::new(FakeSpawner),
        http: Arc::new(IdleHttp {
            status_body: serde_json::to_vec(&status_body).unwrap(),
        }),
        ports: Arc::new(FakeAllocator),
        events: Arc::new(NoopEventSource),
    };
    let config = ServeConfig {
        idle_poll_interval: Duration::from_millis(idle_poll_ms),
        ..ServeConfig::default()
    };
    let mgr = OpencodeServeManager::new(deps, config);
    mgr.ensure_started()
        .await
        .expect("healthy fake serve starts");
    mgr
}

fn event(value: serde_json::Value) -> freshell_opencode::ParsedServeEvent {
    parse_serve_event(&value).expect("parseable serve event")
}

// ── tests ──────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn resolves_on_sse_session_idle() {
    let mgr = started_manager(json!({}), 500).await;
    let rx = mgr.subscribe("ses_x");
    // Buffered before the wait polls: cannot be missed.
    mgr.dispatch_event(event(
        json!({ "type": "session.idle", "properties": { "sessionID": "ses_x" } }),
    ));

    let result = tokio::time::timeout(
        Duration::from_secs(3),
        mgr.await_idle("ses_x", rx, Duration::from_secs(2), None),
    )
    .await
    .expect("must not hang");
    assert_eq!(
        result,
        Ok(()),
        "the SSE session.idle edge resolves onceIdle"
    );
}

#[tokio::test]
async fn resolves_on_sse_status_idle() {
    let mgr = started_manager(json!({}), 500).await;
    let rx = mgr.subscribe("ses_x");
    mgr.dispatch_event(event(
        json!({ "type": "session.status", "properties": { "sessionID": "ses_x", "status": { "type": "idle" } } }),
    ));

    let result = tokio::time::timeout(
        Duration::from_secs(3),
        mgr.await_idle("ses_x", rx, Duration::from_secs(2), None),
    )
    .await
    .expect("must not hang");
    assert_eq!(
        result,
        Ok(()),
        "the SSE session.status{{idle}} edge resolves onceIdle"
    );
}

#[tokio::test]
async fn resolves_via_status_poll_fallback_after_activity() {
    // No SSE idle is ever delivered — only a busy activity edge. The status-map poll must
    // then carry the resolution: 2 consecutive idle polls after observed activity.
    let mgr = started_manager(json!({ "ses_x": { "type": "idle" } }), 15).await;
    let rx = mgr.subscribe("ses_x");
    // A running-activity edge (busy) marks activity and triggers the fallback counter.
    mgr.dispatch_event(event(
        json!({ "type": "session.status", "properties": { "sessionID": "ses_x", "status": { "type": "busy" } } }),
    ));

    let result = tokio::time::timeout(
        Duration::from_secs(3),
        mgr.await_idle("ses_x", rx, Duration::from_secs(2), None),
    )
    .await
    .expect("must not hang");
    assert_eq!(
        result,
        Ok(()),
        "the idle status-poll fallback resolves onceIdle when SSE idle is missed"
    );
}

#[tokio::test]
async fn does_not_resolve_from_status_idle_without_prior_activity() {
    // Guard against a false-green: an idle status with NO observed running activity must
    // NOT resolve (the reference requires observedActivity before counting idle polls).
    // With no SSE activity and no idle edge, onceIdle must time out.
    let mgr = started_manager(json!({ "ses_x": { "type": "idle" } }), 15).await;
    let rx = mgr.subscribe("ses_x");

    let result = tokio::time::timeout(
        Duration::from_secs(3),
        mgr.await_idle("ses_x", rx, Duration::from_millis(150), None),
    )
    .await
    .expect("must not hang");
    assert!(
        matches!(result, Err(ServeError::IdleTimeout { .. })),
        "idle status without prior activity must not resolve, got {result:?}"
    );
}

#[tokio::test]
async fn rejects_on_sidecar_lost() {
    let mgr = started_manager(json!({}), 500).await;
    let rx = mgr.subscribe("ses_x");
    mgr.emit_lost_for_all();

    let result = tokio::time::timeout(
        Duration::from_secs(3),
        mgr.await_idle("ses_x", rx, Duration::from_secs(2), None),
    )
    .await
    .expect("must not hang");
    assert!(
        matches!(result, Err(ServeError::SidecarLost { .. })),
        "a lost sidecar rejects onceIdle, got {result:?}"
    );
}

#[tokio::test]
async fn rejects_on_idle_timeout() {
    // No events, no idle status, no activity → the bounded idle wait times out.
    let mgr = started_manager(json!({}), 500).await;
    let rx = mgr.subscribe("ses_x");

    let result = tokio::time::timeout(
        Duration::from_secs(3),
        mgr.await_idle("ses_x", rx, Duration::from_millis(120), None),
    )
    .await
    .expect("must not hang");
    match result {
        Err(ServeError::IdleTimeout {
            session_id,
            timeout_ms,
        }) => {
            assert_eq!(session_id, "ses_x");
            assert_eq!(timeout_ms, 120);
        }
        other => panic!("expected IdleTimeout, got {other:?}"),
    }
}
