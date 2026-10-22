//! Real production backend for the injected [`WsTransport`](crate::app_server::WsTransport)
//! seam (behind the default-off `real-transport` feature): the `ws` client from
//! `server/coding-cli/codex-app-server/client.ts:1`, in Rust via `tokio-tungstenite`, plus
//! the Linux `/proc` ownership reaper (`runtime.ts:452-586`).
//!
//! - [`TungsteniteTransport`] — connects to `ws://127.0.0.1:<port>` (the app-server listener,
//!   `runtime.ts:1246-1261`); one JSON message per text frame.
//! - [`reap_owned_codex_sidecars`] — SIGTERM any process carrying our
//!   `FRESHELL_CODEX_SIDECAR_ID` tag (`runtime.ts:494`), the codex analog of
//!   `freshell-opencode`'s `/proc` reaper — the "ownership-safe, no-orphans" machinery the
//!   oracle's `ownership.cleanup` invariant demands.
//!
//! This module is NOT exercised live in this step (no live API calls); it is verified to
//! compile under the feature and wired live in the next step (T2-over-rust, 3.8b). The CORE
//! and the completion gating are graded via the fake-injected tests, independent of this.

use std::sync::Mutex;

use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::Mutex as TokioMutex;
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::Error as TungsteniteError;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{connect_async_with_config, MaybeTlsStream, WebSocketStream};

use crate::app_server::{BoxFuture, WsTransport};
use crate::ws_config::lane_ws_config;

type WsStream = WebSocketStream<MaybeTlsStream<TcpStream>>;
type WsSink = futures_util::stream::SplitSink<WsStream, Message>;
type WsSource = futures_util::stream::SplitStream<WsStream>;

/// The real WebSocket transport backed by `tokio-tungstenite`. Loopback plain-WS only (no
/// TLS features pulled).
pub struct TungsteniteTransport {
    write: TokioMutex<WsSink>,
    read: TokioMutex<WsSource>,
    /// Diagnostics seam (plan 2026-10-20-codex-proxy-ws-frame-cap.md §5.4): the
    /// rendered text of the most recent `recv` error. `recv` still collapses
    /// every error to `None` for callers (the public
    /// `CodexAppServerError::Closed` mapping is unchanged), but the CAUSE is
    /// retained here so an over-cap response is assertable in tests and pairs
    /// with the production `tracing::warn!` in the same arm.
    last_recv_error: Mutex<Option<String>>,
}

impl TungsteniteTransport {
    /// Connect to the app-server WS endpoint (`ensureSocket`, `client.ts:521-556`).
    /// Read caps come from [`lane_ws_config`] — the independent, conservative
    /// lane constant (plan §4.1); `disable_nagle = false` matches bare
    /// `connect_async` exactly.
    pub async fn connect(ws_url: &str) -> Result<Self, String> {
        Self::connect_with_config(ws_url, lane_ws_config()).await
    }

    /// Connect with an explicit [`WebSocketConfig`] — the seam the over-cap
    /// lane tests use to inject a tiny cap (plan §5.4). Production callers use
    /// [`connect`], which installs [`lane_ws_config`] unchanged.
    pub async fn connect_with_config(
        ws_url: &str,
        config: WebSocketConfig,
    ) -> Result<Self, String> {
        let (stream, _response) = connect_async_with_config(ws_url, Some(config), false)
            .await
            .map_err(|e| e.to_string())?;
        let (write, read) = stream.split();
        Ok(Self {
            write: TokioMutex::new(write),
            read: TokioMutex::new(read),
            last_recv_error: Mutex::new(None),
        })
    }

    /// The rendered cause of the most recent `recv` error, if the stream has
    /// errored (plan §5.4 test seam; pairs with the production warn in the
    /// `recv` error arm).
    pub fn last_recv_error(&self) -> Option<String> {
        self.last_recv_error
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
    }
}

impl WsTransport for TungsteniteTransport {
    fn send(&self, text: String) -> BoxFuture<'_, Result<(), String>> {
        Box::pin(async move {
            self.write
                .lock()
                .await
                .send(Message::Text(text))
                .await
                .map_err(|e| e.to_string())
        })
    }

    fn recv(&self) -> BoxFuture<'_, Option<String>> {
        Box::pin(async move {
            let mut read = self.read.lock().await;
            loop {
                match read.next().await {
                    Some(Ok(Message::Text(text))) => return Some(text),
                    // Codex uses text frames; tolerate a binary frame as UTF-8 for robustness.
                    Some(Ok(Message::Binary(bytes))) => {
                        return Some(String::from_utf8_lossy(&bytes).into_owned())
                    }
                    // Ping/Pong/Frame are transport-level noise — keep reading.
                    Some(Ok(_)) => continue,
                    Some(Err(e)) => {
                        // Plan §4.3.1 lane observability (Goal 3): the actual
                        // error text — for a Capacity error it renders
                        // "Message too long: {size} > {max_size}", carrying the
                        // configured limit — goes to the production log...
                        let error_text = e.to_string();
                        tracing::warn!(
                            target: "freshell_codex::transport",
                            error = %error_text,
                            capacity = matches!(e, TungsteniteError::Capacity(_)),
                            "codex_lane_ws_recv_failed"
                        );
                        // ...and is retained on the seam so tests assert the CAUSE.
                        if let Ok(mut slot) = self.last_recv_error.lock() {
                            *slot = Some(error_text);
                        }
                        return None;
                    }
                    // A close frame ends the stream (→ fail pending).
                    None => return None,
                }
            }
        })
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        Box::pin(async move {
            let _ = self.write.lock().await.close().await;
        })
    }
}

/// `killOwnedProcesses` analog for codex (`runtime.ts:452-586`): SIGTERM any process whose
/// `/proc/<pid>/environ` carries our `FRESHELL_CODEX_SIDECAR_ID=<ownership_id>` tag — the
/// detached app-server sidecar we own. Linux `/proc`-based, best-effort and platform-guarded;
/// we only signal processes carrying OUR unique tag, so no unrelated process is touched.
#[cfg(target_os = "linux")]
pub fn reap_owned_codex_sidecars(ownership_id: &str) {
    let needle = crate::durability::ownership_needle(ownership_id);
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(pid) = name.parse::<i32>() else {
            continue;
        };
        let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else {
            continue;
        };
        let carries_tag = environ
            .split(|&b| b == 0)
            .any(|var| var == needle.as_bytes());
        if carries_tag {
            // SIGTERM (15). Safe: only processes carrying OUR tag are signaled.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
pub fn reap_owned_codex_sidecars(_ownership_id: &str) {
    // Non-Linux: the direct child is reaped via the spawner's kill-on-drop; the `/proc`
    // environ scan is Linux-only (matches the reference's platform guard, runtime.ts:361-367).
}
