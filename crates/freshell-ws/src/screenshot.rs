//! UI-screenshot request/response broker (Phase 3.18).
//!
//! Ports the `wsHandler.requestUiScreenshot` round-trip of `server/ws-handler.ts`
//! (line 1045) that `POST /api/screenshots` (`server/agent-api/router.ts:1070`)
//! drives:
//!
//! 1. the REST handler [`register`]s a `requestId` and gets a [`oneshot`] receiver;
//! 2. it [`send_capture`]s a `{type:"ui.command", command:"screenshot.capture",
//!    payload:{requestId, scope, tabId?, paneId?}}` frame onto the shared broadcast
//!    bus (the exact shape `src/lib/ui-commands.ts:73` dispatches);
//! 3. the screenshot-capable SPA client renders the DOM (`captureUiScreenshot` /
//!    html2canvas) and replies `{type:"ui.screenshot.result", requestId, ...}`
//!    (`src/lib/ui-commands.ts:51`);
//! 4. the `/ws` inbound loop routes that reply through [`resolve`], waking the
//!    awaiting REST handler with the base64 PNG.
//!
//! The original targets ONE specific socket (the layout-source connection, requiring
//! the `uiScreenshotV1` capability). The port broadcasts the capture command instead:
//! only a screenshot-capable client answers (others ignore an unknown `ui.command`),
//! the broker resolves on the FIRST `requestId` match and drops the request, and a
//! [`capable_client_count`] gate reproduces the original's `NO_SCREENSHOT_CLIENT`
//! rejection when no capable UI is connected. This is behaviourally equivalent for
//! the single-UI e2e and harmless for multi-client (duplicate late replies are
//! dropped). Purely additive — the handshake + terminal byte path (oracle T0/T1) are
//! untouched.

use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::json;
use tokio::sync::oneshot;

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
    /// Number of currently-connected clients that advertised `uiScreenshotV1`.
    capable: AtomicI64,
    /// In-flight requests keyed by `requestId` → the waker for the REST handler.
    pending: Mutex<HashMap<String, oneshot::Sender<ScreenshotResult>>>,
    /// The shared server→client broadcast bus (the capture command is fanned out
    /// here; the capable SPA client receives + answers it).
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
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
                capable: AtomicI64::new(0),
                pending: Mutex::new(HashMap::new()),
                broadcast_tx,
            }),
        }
    }

    /// A connection advertising `capabilities.uiScreenshotV1` joined.
    pub fn add_capable_client(&self) {
        self.inner.capable.fetch_add(1, Ordering::SeqCst);
    }

    /// A capability-advertising connection left (never drops below zero).
    pub fn remove_capable_client(&self) {
        // `fetch_update` clamps at 0 so an accidental double-decrement can't make
        // the gate report "no client" while one is still connected.
        let _ = self
            .inner
            .capable
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                Some(if n > 0 { n - 1 } else { 0 })
            });
    }

    /// How many screenshot-capable UI clients are connected right now.
    pub fn capable_client_count(&self) -> i64 {
        self.inner.capable.load(Ordering::SeqCst)
    }

    /// True iff at least one screenshot-capable UI client is connected.
    pub fn has_capable_client(&self) -> bool {
        self.capable_client_count() > 0
    }

    /// Register a pending request, returning the receiver the REST handler awaits.
    pub fn register(&self, request_id: String) -> oneshot::Receiver<ScreenshotResult> {
        let (tx, rx) = oneshot::channel();
        self.inner.pending.lock().unwrap().insert(request_id, tx);
        rx
    }

    /// Drop a pending request without resolving it (timeout / early error).
    pub fn cancel(&self, request_id: &str) {
        self.inner.pending.lock().unwrap().remove(request_id);
    }

    /// Route an inbound `ui.screenshot.result` to its waiting REST handler. Unknown
    /// / already-resolved `requestId`s are ignored (a late duplicate from a second
    /// capable client).
    pub fn resolve(&self, request_id: &str, result: ScreenshotResult) {
        if let Some(tx) = self.inner.pending.lock().unwrap().remove(request_id) {
            let _ = tx.send(result);
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
        assert!(!b.has_capable_client());
        b.add_capable_client();
        b.add_capable_client();
        assert_eq!(b.capable_client_count(), 2);
        assert!(b.has_capable_client());
        b.remove_capable_client();
        assert_eq!(b.capable_client_count(), 1);
        // Over-decrement clamps at 0 (never negative).
        b.remove_capable_client();
        b.remove_capable_client();
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
