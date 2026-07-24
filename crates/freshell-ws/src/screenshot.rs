//! UI-screenshot request/response broker (Phase 3.18).
//!
//! Ports the `wsHandler.requestUiScreenshot` round-trip of `server/ws-handler.ts`
//! (line 1045) that `POST /api/screenshots` (`server/agent-api/router.ts:1070`)
//! drives:
//!
//! 1. the REST handler [`register`]s a `requestId` and gets a [`oneshot`] receiver;
//! 2. it [`send_capture`]s a `{type:"ui.command", command:"screenshot.capture",
//!    payload:{requestId, scope, tabId?, paneId?}}` frame onto the shared broadcast
//!    bus (the exact shape `src/lib/ui-commands.ts:73` dispatches), or
//!    [`send_capture_to`] sends it to one connection for a restore delivery fence;
//! 3. the screenshot-capable SPA client renders the DOM (`captureUiScreenshot` /
//!    html2canvas) and replies `{type:"ui.screenshot.result", requestId, ...}`
//!    (`src/lib/ui-commands.ts:51`);
//! 4. the `/ws` inbound loop routes that reply through [`resolve_from`], waking the
//!    awaiting REST handler with the base64 PNG.
//!
//! Ordinary screenshot requests retain broadcast behavior. Restore uses the
//! connection registry plus target-bound requests: a result from any connection
//! other than the selected target is ignored, closing the connection-churn race
//! between the exactly-one-client gate, tab delivery, and acknowledgement.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use freshell_protocol::{ServerMessage, UiCommand};
use serde_json::json;
use tokio::sync::oneshot;

/// A direct per-connection delivery sink. Unlike the terminal registry's
/// fire-and-forget `FrameSink`, restore needs to know whether the outbound
/// channel actually accepted a command.
pub type ClientSink = Arc<dyn Fn(ServerMessage) -> bool + Send + Sync>;

/// The normalized screenshot outcome the REST handler consumes. Mirrors the
/// non-`type`/`requestId` fields of `UiScreenshotResultSchema`.
#[derive(Debug, Clone, Default)]
pub struct ScreenshotResult {
    pub ok: bool,
    pub image_base64: Option<String>,
    pub mime_type: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub changed_focus: Option<bool>,
    pub restored_focus: Option<bool>,
    pub error: Option<String>,
}

struct Inner {
    /// Currently-connected clients that advertised `uiScreenshotV1`, keyed by
    /// the WS connection id and carrying a direct per-connection sink.
    capable: Mutex<HashMap<u64, ClientSink>>,
    /// In-flight requests keyed by `requestId` → the waker for the REST handler.
    pending: Mutex<HashMap<String, PendingRequest>>,
    /// The shared server→client broadcast bus (the capture command is fanned out
    /// here; the capable SPA client receives + answers it).
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
}

struct PendingRequest {
    expected_client_id: Option<u64>,
    sender: oneshot::Sender<ScreenshotResult>,
}

/// A cheaply-cloneable handle shared by every `/ws` connection and the
/// `POST /api/screenshots` endpoint.
#[derive(Clone)]
pub struct ScreenshotBroker {
    inner: Arc<Inner>,
}

impl ScreenshotBroker {
    /// Build a broker over the shared broadcast bus.
    pub fn new(broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>) -> Self {
        Self {
            inner: Arc::new(Inner {
                capable: Mutex::new(HashMap::new()),
                pending: Mutex::new(HashMap::new()),
                broadcast_tx,
            }),
        }
    }

    /// A connection advertising `capabilities.uiScreenshotV1` joined.
    pub fn add_capable_client(&self, connection_id: u64, sink: ClientSink) {
        self.inner
            .capable
            .lock()
            .unwrap()
            .insert(connection_id, sink);
    }

    /// A capability-advertising connection left. Removing an unknown id is a no-op.
    pub fn remove_capable_client(&self, connection_id: u64) {
        self.inner.capable.lock().unwrap().remove(&connection_id);
    }

    /// How many screenshot-capable UI clients are connected right now.
    pub fn capable_client_count(&self) -> i64 {
        self.inner.capable.lock().unwrap().len() as i64
    }

    /// True iff at least one screenshot-capable UI client is connected.
    pub fn has_capable_client(&self) -> bool {
        self.capable_client_count() > 0
    }

    /// Return the stable connection id iff exactly one capable client is
    /// connected at this instant.
    pub fn exclusive_client_id(&self) -> Option<u64> {
        self.client_snapshot().1
    }

    /// Atomically snapshot the capable-client count and exclusive id.
    pub fn client_snapshot(&self) -> (i64, Option<u64>) {
        let capable = self.inner.capable.lock().unwrap();
        let exclusive = (capable.len() == 1)
            .then(|| capable.keys().next().copied())
            .flatten();
        (capable.len() as i64, exclusive)
    }

    /// Whether the selected capable connection is still registered.
    pub fn has_client(&self, connection_id: u64) -> bool {
        self.inner
            .capable
            .lock()
            .unwrap()
            .contains_key(&connection_id)
    }

    /// Register a pending request, returning the receiver the REST handler awaits.
    pub fn register(&self, request_id: String) -> oneshot::Receiver<ScreenshotResult> {
        self.register_expected(request_id, None)
    }

    /// Register a request that only `connection_id` is permitted to resolve.
    pub fn register_for_client(
        &self,
        request_id: String,
        connection_id: u64,
    ) -> oneshot::Receiver<ScreenshotResult> {
        self.register_expected(request_id, Some(connection_id))
    }

    fn register_expected(
        &self,
        request_id: String,
        expected_client_id: Option<u64>,
    ) -> oneshot::Receiver<ScreenshotResult> {
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(
            request_id,
            PendingRequest {
                expected_client_id,
                sender: tx,
            },
        );
        rx
    }

    /// Drop a pending request without resolving it (timeout / early error).
    pub fn cancel(&self, request_id: &str) {
        self.inner.pending.lock().unwrap().remove(request_id);
    }

    /// Route an inbound `ui.screenshot.result` to its waiting REST handler. Unknown
    /// / already-resolved `requestId`s are ignored (a late duplicate from a second
    /// capable client).
    pub fn resolve_from(&self, connection_id: u64, request_id: &str, result: ScreenshotResult) {
        let mut pending = self.inner.pending.lock().unwrap();
        let matches = pending.get(request_id).is_some_and(|request| {
            request
                .expected_client_id
                .is_none_or(|id| id == connection_id)
        });
        if matches {
            if let Some(request) = pending.remove(request_id) {
                let _ = request.sender.send(result);
            }
        }
    }

    /// Test/compatibility helper for request producers with no target binding.
    /// Target-bound restore requests cannot be resolved through this path.
    pub fn resolve(&self, request_id: &str, result: ScreenshotResult) {
        let mut pending = self.inner.pending.lock().unwrap();
        let is_unbound = pending
            .get(request_id)
            .is_some_and(|request| request.expected_client_id.is_none());
        if is_unbound {
            if let Some(request) = pending.remove(request_id) {
                let _ = request.sender.send(result);
            }
        }
    }

    /// Send one already-typed frame to a specific capable connection. Returns
    /// false when that exact connection is no longer registered.
    pub fn send_to_client(&self, connection_id: u64, frame: ServerMessage) -> bool {
        let sink = self
            .inner
            .capable
            .lock()
            .unwrap()
            .get(&connection_id)
            .cloned();
        if let Some(sink) = sink {
            sink(frame)
        } else {
            false
        }
    }

    /// Broadcast the `screenshot.capture` `ui.command` to every connection; the
    /// capable SPA client renders + replies. Frame shape is byte-compatible with
    /// `ws-handler.ts:1072` (`{type, command, payload:{requestId, scope, tabId?,
    /// paneId?}}`), matching `ui-commands.ts#handleScreenshotCapture`.
    pub fn send_capture(
        &self,
        request_id: &str,
        scope: &str,
        tab_id: Option<&str>,
        pane_id: Option<&str>,
    ) {
        let mut payload = json!({ "requestId": request_id, "scope": scope });
        if let Some(tab_id) = tab_id {
            payload["tabId"] = json!(tab_id);
        }
        if let Some(pane_id) = pane_id {
            payload["paneId"] = json!(pane_id);
        }
        let frame = json!({
            "type": "ui.command",
            "command": "screenshot.capture",
            "payload": payload,
        });
        // A send error only means no live subscribers; the REST side then times out
        // and reports the same "no UI answered" outcome the original would.
        let _ = self.inner.broadcast_tx.send(frame.to_string());
    }

    /// Send the capture fence only to `connection_id`.
    pub fn send_capture_to(
        &self,
        connection_id: u64,
        request_id: &str,
        scope: &str,
        tab_id: Option<&str>,
        pane_id: Option<&str>,
    ) -> bool {
        let mut payload = json!({ "requestId": request_id, "scope": scope });
        if let Some(tab_id) = tab_id {
            payload["tabId"] = json!(tab_id);
        }
        if let Some(pane_id) = pane_id {
            payload["paneId"] = json!(pane_id);
        }
        self.send_to_client(
            connection_id,
            ServerMessage::UiCommand(UiCommand {
                command: "screenshot.capture".to_string(),
                payload: Some(payload),
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn broker() -> ScreenshotBroker {
        let tx = Arc::new(tokio::sync::broadcast::channel::<String>(16).0);
        ScreenshotBroker::new(tx)
    }

    #[test]
    fn capability_count_tracks_and_clamps() {
        let b = broker();
        let sink: ClientSink = Arc::new(|_| true);
        assert!(!b.has_capable_client());
        b.add_capable_client(1, sink.clone());
        b.add_capable_client(2, sink);
        assert_eq!(b.capable_client_count(), 2);
        assert!(b.has_capable_client());
        assert_eq!(b.exclusive_client_id(), None);
        b.remove_capable_client(1);
        assert_eq!(b.capable_client_count(), 1);
        assert_eq!(b.exclusive_client_id(), Some(2));
        b.remove_capable_client(2);
        b.remove_capable_client(2);
        assert_eq!(b.capable_client_count(), 0);
        assert!(!b.has_capable_client());
    }

    #[tokio::test]
    async fn register_resolve_delivers_result() {
        let b = broker();
        let rx = b.register("req-1".to_string());
        b.resolve(
            "req-1",
            ScreenshotResult {
                ok: true,
                image_base64: Some("QUJD".to_string()),
                width: Some(10),
                height: Some(20),
                ..Default::default()
            },
        );
        let got = rx.await.expect("resolved");
        assert!(got.ok);
        assert_eq!(got.image_base64.as_deref(), Some("QUJD"));
        assert_eq!(got.width, Some(10));
        assert_eq!(got.height, Some(20));
    }

    #[tokio::test]
    async fn resolve_unknown_request_is_ignored() {
        let b = broker();
        // No panic, no effect.
        b.resolve(
            "nope",
            ScreenshotResult {
                ok: true,
                ..Default::default()
            },
        );
        // A cancelled request never resolves.
        let rx = b.register("req-2".to_string());
        b.cancel("req-2");
        b.resolve(
            "req-2",
            ScreenshotResult {
                ok: true,
                ..Default::default()
            },
        );
        assert!(rx.await.is_err(), "cancelled sender dropped");
    }

    #[tokio::test]
    async fn target_bound_request_ignores_another_client() {
        let b = broker();
        let mut rx = b.register_for_client("targeted".to_string(), 7);
        b.resolve_from(
            8,
            "targeted",
            ScreenshotResult {
                ok: true,
                ..Default::default()
            },
        );
        assert!(rx.try_recv().is_err(), "wrong client must not resolve");
        b.resolve_from(
            7,
            "targeted",
            ScreenshotResult {
                ok: true,
                ..Default::default()
            },
        );
        assert!(rx.await.expect("target resolved").ok);
    }

    #[test]
    fn direct_capture_reaches_only_the_selected_client() {
        let b = broker();
        let seen_1 = Arc::new(Mutex::new(Vec::new()));
        let seen_2 = Arc::new(Mutex::new(Vec::new()));
        for (id, seen) in [(1, seen_1.clone()), (2, seen_2.clone())] {
            b.add_capable_client(
                id,
                Arc::new(move |message| {
                    seen.lock().unwrap().push(message);
                    true
                }),
            );
        }
        assert!(b.send_capture_to(1, "req-direct", "view", None, None));
        assert_eq!(seen_1.lock().unwrap().len(), 1);
        assert!(seen_2.lock().unwrap().is_empty());
    }

    #[test]
    fn direct_send_reports_a_closed_outbound_channel() {
        let b = broker();
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        drop(rx);
        b.add_capable_client(7, Arc::new(move |message| tx.send(message).is_ok()));
        assert!(
            !b.send_to_client(
                7,
                ServerMessage::UiCommand(UiCommand {
                    command: "tab.create".to_string(),
                    payload: None,
                }),
            ),
            "a registered sink with a closed channel is not successful delivery"
        );
    }

    #[test]
    fn send_capture_frame_matches_ui_command_shape() {
        let b = broker();
        let mut rx = b.inner.broadcast_tx.subscribe();
        b.send_capture("req-9", "view", None, None);
        let frame = rx.try_recv().expect("frame broadcast");
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v["type"], "ui.command");
        assert_eq!(v["command"], "screenshot.capture");
        assert_eq!(v["payload"]["requestId"], "req-9");
        assert_eq!(v["payload"]["scope"], "view");
        assert!(v["payload"].get("tabId").is_none());

        // Pane scope carries tabId + paneId.
        b.send_capture("req-10", "pane", Some("tab-1"), Some("pane-1"));
        let frame = rx.try_recv().expect("frame broadcast");
        let v: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(v["payload"]["tabId"], "tab-1");
        assert_eq!(v["payload"]["paneId"], "pane-1");
    }
}
