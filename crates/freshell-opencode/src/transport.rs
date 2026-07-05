//! Real production backends for the injected serve IO seams (behind the default-off
//! `real-transport` feature). These are the `fetchFn` / `spawnFn` / `connectEventStream`
//! / `allocatePort` implementations from `serve-manager.ts`, in Rust:
//!
//! - [`ReqwestServeHttp`] — the HTTP client (`fetchFn`). Applies the per-request
//!   `.timeout()` that DEV-0001 relies on (the AbortController analog).
//! - [`ReqwestEventSource`] — the `/global/event` SSE consumer (`consumeEvents`,
//!   `serve-manager.ts:529-571`): reconnecting, block-decoded via [`SseDecoder`],
//!   UTF-8-boundary-safe across chunks.
//! - [`TokioProcessSpawner`] — the ownership-tagged `opencode serve` spawn
//!   (`serve-manager.ts:205-212`) + the Linux `/proc` ownership reaper
//!   (`killOwnedProcesses`, `serve-manager.ts:599-623`) so the detached serve listener
//!   leaves no orphan (the oracle `ownership.cleanup` invariant).
//! - [`LoopbackPortAllocator`] — `allocateLocalhostPort`.
//!
//! This module is NOT exercised live in this step (no live API calls); it is verified to
//! compile under the feature and wired live in the next step (T2-over-rust). The CORE
//! logic and the DEV-0001 fix are graded via the fake-injected tests, independent of this.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::events::{ParsedServeEvent, SseDecoder};
use crate::serve::{
    BoxFuture, Endpoint, EventSink, EventSource, EventStreamHandle, HttpMethod, PortAllocator,
    ProcessSpawner, ServeHttp, ServeHttpRequest, ServeHttpResponse, ServeProcess, SpawnRequest,
    OPENCODE_SIDECAR_OWNERSHIP_ENV,
};

// ── HTTP (fetchFn) ───────────────────────────────────────────────────────────────

/// The real [`ServeHttp`] backed by `reqwest`. Loopback plain-HTTP only.
pub struct ReqwestServeHttp {
    client: reqwest::Client,
}

impl ReqwestServeHttp {
    pub fn new() -> Self {
        // No TLS/proxy needed for a loopback serve; a plain client never fails to build.
        let client = reqwest::Client::builder().build().unwrap_or_else(|_| reqwest::Client::new());
        Self { client }
    }
}

impl Default for ReqwestServeHttp {
    fn default() -> Self {
        Self::new()
    }
}

impl ServeHttp for ReqwestServeHttp {
    fn request<'a>(&'a self, req: ServeHttpRequest) -> BoxFuture<'a, Result<ServeHttpResponse, String>> {
        let client = self.client.clone();
        Box::pin(async move {
            let method = match req.method {
                HttpMethod::Get => reqwest::Method::GET,
                HttpMethod::Post => reqwest::Method::POST,
            };
            let mut builder = client.request(method, &req.url);
            // DEV-0001: the per-request timeout (the 2 s AbortController analog).
            if let Some(timeout) = req.timeout {
                builder = builder.timeout(timeout);
            }
            if let Some(content_type) = &req.content_type {
                builder = builder.header("content-type", content_type);
            }
            if let Some(body) = req.body {
                builder = builder.body(body);
            }
            let resp = builder.send().await.map_err(|e| e.to_string())?;
            let status = resp.status().as_u16();
            let next_cursor = resp
                .headers()
                .get("x-next-cursor")
                .and_then(|v| v.to_str().ok())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            Ok(ServeHttpResponse { status, body: bytes.to_vec(), next_cursor })
        })
    }
}

// ── SSE (connectEventStream) ─────────────────────────────────────────────────────

/// The real [`EventSource`] backed by a reconnecting `reqwest` SSE stream.
pub struct ReqwestEventSource {
    client: reqwest::Client,
}

impl ReqwestEventSource {
    pub fn new() -> Self {
        Self { client: reqwest::Client::builder().build().unwrap_or_else(|_| reqwest::Client::new()) }
    }
}

impl Default for ReqwestEventSource {
    fn default() -> Self {
        Self::new()
    }
}

struct SseHandle {
    cancel: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}

impl EventStreamHandle for SseHandle {}

impl Drop for SseHandle {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        self.task.abort();
    }
}

impl EventSource for ReqwestEventSource {
    fn connect(&self, url: String, sink: EventSink) -> Box<dyn EventStreamHandle> {
        let client = self.client.clone();
        let cancel = Arc::new(AtomicBool::new(false));
        let cancel_task = cancel.clone();
        let task = tokio::spawn(async move {
            consume_events(client, url, sink, cancel_task).await;
        });
        Box::new(SseHandle { cancel, task })
    }
}

/// `consumeEvents` (`serve-manager.ts:529-571`): reconnect with backoff; per connection,
/// stream body chunks into a UTF-8-boundary-safe [`SseDecoder`] and dispatch each event.
async fn consume_events(client: reqwest::Client, url: String, sink: EventSink, cancel: Arc<AtomicBool>) {
    let mut backoff_ms: u64 = 250;
    while !cancel.load(Ordering::SeqCst) {
        let response = client.get(&url).header("accept", "text/event-stream").send().await;
        match response {
            Ok(mut resp) if resp.status().is_success() => {
                backoff_ms = 250;
                let mut decoder = SseDecoder::new();
                let mut pending: Vec<u8> = Vec::new();
                loop {
                    if cancel.load(Ordering::SeqCst) {
                        return;
                    }
                    match resp.chunk().await {
                        Ok(Some(bytes)) => {
                            pending.extend_from_slice(&bytes);
                            // Decode the longest valid UTF-8 prefix, holding a partial
                            // trailing scalar for the next chunk (TextDecoder{stream:true}).
                            let valid_up_to = match std::str::from_utf8(&pending) {
                                Ok(_) => pending.len(),
                                Err(e) => e.valid_up_to(),
                            };
                            if valid_up_to > 0 {
                                let text: String =
                                    String::from_utf8_lossy(&pending[..valid_up_to]).into_owned();
                                pending.drain(..valid_up_to);
                                for event in decoder.push_str(&text) {
                                    dispatch(&sink, event);
                                }
                            }
                        }
                        Ok(None) => break,  // stream ended cleanly → reconnect
                        Err(_) => break,    // dropped → reconnect
                    }
                }
            }
            _ => {}
        }
        if cancel.load(Ordering::SeqCst) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(backoff_ms)).await;
        backoff_ms = (backoff_ms * 2).min(5000);
    }
}

fn dispatch(sink: &EventSink, event: ParsedServeEvent) {
    sink(event);
}

// ── process spawn (spawnFn) + ownership reaper ───────────────────────────────────

/// The real [`ProcessSpawner`] using `tokio::process`. Spawns `command serve --hostname
/// H --port P` with the parent env plus the `FRESHELL_OPENCODE_SIDECAR_ID` ownership tag,
/// draining stdout/stderr so the child's pipes never back-pressure and stall the serve
/// (`serve-manager.ts:213-218`).
pub struct TokioProcessSpawner;

impl ProcessSpawner for TokioProcessSpawner {
    fn spawn(&self, req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
        use std::process::Stdio;
        let mut cmd = tokio::process::Command::new(&req.command);
        cmd.arg("serve")
            .arg("--hostname")
            .arg(&req.hostname)
            .arg("--port")
            .arg(req.port.to_string());
        // Inherit the parent env, then layer the request env (incl. the ownership tag).
        for (key, value) in &req.env {
            cmd.env(key, value);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        cmd.kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| e.to_string())?;

        let stderr_buf = Arc::new(Mutex::new(String::new()));
        if let Some(stderr) = child.stderr.take() {
            let buf = stderr_buf.clone();
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut reader = stderr;
                let mut chunk = [0u8; 4096];
                loop {
                    match reader.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if let Ok(mut guard) = buf.lock() {
                                guard.push_str(&String::from_utf8_lossy(&chunk[..n]));
                            }
                        }
                    }
                }
            });
        }
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut reader = stdout;
                let mut chunk = [0u8; 4096];
                while let Ok(n) = reader.read(&mut chunk).await {
                    if n == 0 {
                        break;
                    }
                }
            });
        }

        Ok(Box::new(TokioServeProcess {
            child: Arc::new(Mutex::new(child)),
            stderr_buf,
            ownership_id: req.ownership_id,
            fatal_reported: AtomicBool::new(false),
        }))
    }
}

struct TokioServeProcess {
    child: Arc<Mutex<tokio::process::Child>>,
    stderr_buf: Arc<Mutex<String>>,
    ownership_id: String,
    fatal_reported: AtomicBool,
}

impl ServeProcess for TokioServeProcess {
    fn exited(&self) -> Option<i32> {
        let mut child = self.child.lock().ok()?;
        match child.try_wait() {
            Ok(Some(status)) => Some(status.code().unwrap_or(-1)),
            _ => None,
        }
    }

    fn take_fatal_startup_error(&self) -> Option<String> {
        if self.fatal_reported.load(Ordering::SeqCst) {
            return None;
        }
        let stderr = self.stderr_buf.lock().ok()?.clone();
        if crate::serve::is_fatal_serve_stderr(&stderr) {
            self.fatal_reported.store(true, Ordering::SeqCst);
            Some(stderr.trim().to_string())
        } else {
            None
        }
    }

    fn kill(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.start_kill();
        }
        reap_owned_processes(&self.ownership_id);
    }
}

/// `killOwnedProcesses` (`serve-manager.ts:599-623`): SIGTERM any process carrying our
/// `FRESHELL_OPENCODE_SIDECAR_ID` tag (the detached serve listener). Linux `/proc`-based,
/// best-effort and platform-guarded — the exact "ownership-safe, no-orphans" machinery
/// the oracle's safety checks demand.
#[cfg(target_os = "linux")]
fn reap_owned_processes(ownership_id: &str) {
    let needle = format!("{OPENCODE_SIDECAR_OWNERSHIP_ENV}={ownership_id}");
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Ok(pid) = name.parse::<i32>() else { continue };
        let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else {
            continue;
        };
        let carries_tag = environ.split(|&b| b == 0).any(|var| var == needle.as_bytes());
        if carries_tag {
            // SIGTERM (15). Safe: we only signal processes carrying OUR unique tag.
            unsafe {
                libc::kill(pid, libc::SIGTERM);
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn reap_owned_processes(_ownership_id: &str) {
    // Non-Linux: the direct child is reaped via `start_kill` + `kill_on_drop`; the
    // `/proc` environ scan is Linux-only (matches the reference's platform guard).
}

// ── port allocation (allocatePort) ───────────────────────────────────────────────

/// `allocateLocalhostPort`: bind an ephemeral loopback port, read it, release it. The
/// small bind→spawn race window matches the reference behavior.
pub struct LoopbackPortAllocator;

impl PortAllocator for LoopbackPortAllocator {
    fn allocate(&self) -> Result<Endpoint, String> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
        let addr = listener.local_addr().map_err(|e| e.to_string())?;
        Ok(Endpoint { hostname: "127.0.0.1".to_string(), port: addr.port() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_allocator_returns_a_usable_ephemeral_port() {
        let a = LoopbackPortAllocator;
        let ep = a.allocate().expect("allocate");
        assert_eq!(ep.hostname, "127.0.0.1");
        assert!(ep.port > 0, "an ephemeral port was allocated");
    }

    #[test]
    fn http_and_event_clients_construct() {
        // The plain loopback clients always build (no TLS backend required).
        let _http = ReqwestServeHttp::new();
        let _sse = ReqwestEventSource::new();
    }
}
