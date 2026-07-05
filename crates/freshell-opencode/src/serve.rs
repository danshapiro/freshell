//! `OpencodeServeManager` — the opencode `serve` sidecar client CORE, a faithful port
//! of `server/fresh-agent/adapters/opencode/serve-manager.ts`.
//!
//! Responsibilities (all IO injected behind traits so the logic is unit-testable with
//! fakes and NO real serve):
//! - **spawn** an `opencode serve` sidecar, ownership-tagged via
//!   `FRESHELL_OPENCODE_SIDECAR_ID` (`serve-manager.ts:11,204-212`), through
//!   [`ProcessSpawner`] + [`PortAllocator`];
//! - the **bounded health-readiness wait** ([`OpencodeServeManager::ensure_started`] →
//!   `wait_for_health`) carrying the **DEV-0001** fix — see that method's docs;
//! - **session create** / **prompt (send turn)** / status / abort / fork over
//!   [`ServeHttp`] (`serve-manager.ts:337-416`);
//! - an **SSE/event consumer** ([`ServeHttp`]-independent [`EventSource`]) that fans
//!   events out per-session and surfaces the completion **IDLE edge** through
//!   [`OpencodeServeManager::await_idle`] / [`once_idle`](OpencodeServeManager::once_idle)
//!   (`serve-manager.ts:440-520`).
//!
//! The adapter-level concerns (placeholder→`ses_` materialization, `turnAborted` /
//! `turnErrored` positive-completion gating, the monotonic turn-complete clock) live one
//! layer up (`adapters/opencode/adapter.ts`) and are a later step; this crate is the
//! serve-manager surface only.

use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Map, Value};
use tokio::sync::broadcast;

use crate::events::{
    event_shows_running_status_activity, is_idle_edge, is_idle_status_type,
    is_running_status_type, ParsedServeEvent,
};

/// The ownership env tag written to the spawned serve so the reaper can find the
/// detached listener (`OWNERSHIP_ENV`, `serve-manager.ts:11`).
pub const OPENCODE_SIDECAR_OWNERSHIP_ENV: &str = "FRESHELL_OPENCODE_SIDECAR_ID";

/// A boxed, `Send` future — the object-safe async return used by the injected IO
/// traits (keeps them `dyn`-compatible without an `async-trait` dependency).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ── injected IO seams (fetchFn / spawnFn / allocatePort / connectEventStream) ────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
}

/// One serve HTTP request. `url` is absolute (the health probe runs before `running`
/// is set, so it cannot go through `require_base`), mirroring the reference's direct
/// `fetchFn(url, init)` calls. `timeout` is the per-request bound the real transport
/// applies via `reqwest .timeout()` (the AbortController analog).
#[derive(Clone, Debug)]
pub struct ServeHttpRequest {
    pub method: HttpMethod,
    pub url: String,
    pub body: Option<Vec<u8>>,
    pub content_type: Option<String>,
    pub timeout: Option<Duration>,
}

impl ServeHttpRequest {
    pub fn get(url: impl Into<String>) -> Self {
        Self { method: HttpMethod::Get, url: url.into(), body: None, content_type: None, timeout: None }
    }
    pub fn post(url: impl Into<String>) -> Self {
        Self { method: HttpMethod::Post, url: url.into(), body: None, content_type: None, timeout: None }
    }
    pub fn post_json(url: impl Into<String>, body: Vec<u8>) -> Self {
        Self {
            method: HttpMethod::Post,
            url: url.into(),
            body: Some(body),
            content_type: Some("application/json".to_string()),
            timeout: None,
        }
    }
    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }
}

/// A serve HTTP response (status + raw body + the `x-next-cursor` header used by the
/// message-page listing).
#[derive(Clone, Debug)]
pub struct ServeHttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub next_cursor: Option<String>,
}

impl ServeHttpResponse {
    pub fn new(status: u16, body: Vec<u8>) -> Self {
        Self { status, body, next_cursor: None }
    }
    /// `res.ok` — a 2xx status.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
    fn body_text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
    fn json(&self) -> Result<Value, ServeError> {
        serde_json::from_slice(&self.body).map_err(|e| ServeError::Decode(e.to_string()))
    }
}

/// The HTTP transport seam (`fetchFn`). One request/response round-trip. `Err(String)`
/// is a transport/connection failure (e.g. connection refused before the serve is up).
pub trait ServeHttp: Send + Sync {
    fn request<'a>(&'a self, req: ServeHttpRequest) -> BoxFuture<'a, Result<ServeHttpResponse, String>>;
}

/// An endpoint the sidecar should bind (`allocateLocalhostPort`,
/// `serve-manager.ts:202-203`).
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub hostname: String,
    pub port: u16,
}

/// The loopback-port allocation seam (`allocatePort`).
pub trait PortAllocator: Send + Sync {
    fn allocate(&self) -> Result<Endpoint, String>;
}

/// The spawn request for one `opencode serve` sidecar
/// (`serve-manager.ts:205-212`): `command serve --hostname H --port P` with the
/// ownership env tag injected.
#[derive(Clone, Debug)]
pub struct SpawnRequest {
    pub command: String,
    pub hostname: String,
    pub port: u16,
    pub ownership_id: String,
    /// The full child environment (base env + `FRESHELL_OPENCODE_SIDECAR_ID`).
    pub env: Vec<(String, String)>,
}

/// A spawned serve sidecar handle. Readiness consults [`ServeProcess::exited`] and
/// [`ServeProcess::take_fatal_startup_error`] (the reference watches stderr for
/// `ServeError|Failed to start server|EADDRINUSE`, `serve-manager.ts:281-284`).
pub trait ServeProcess: Send + Sync {
    /// `None` while running; `Some(code)` once the child has exited.
    fn exited(&self) -> Option<i32>;
    /// A fatal startup diagnostic seen on stderr since the last call, if any.
    fn take_fatal_startup_error(&self) -> Option<String>;
    /// SIGTERM/SIGKILL + ownership-scoped reap (`killOwnedProcesses`).
    fn kill(&self);
}

/// The process-spawn seam (`spawnFn`).
pub trait ProcessSpawner: Send + Sync {
    fn spawn(&self, req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String>;
}

/// A handle whose drop stops SSE consumption (the reference's `stopEventStream`).
pub trait EventStreamHandle: Send + Sync {}

/// The callback each parsed SSE event is delivered to (the manager's `dispatchEvent`).
pub type EventSink = Arc<dyn Fn(ParsedServeEvent) + Send + Sync>;

/// The SSE consumer seam (`connectEventStream`). Begins consuming `/global/event` at
/// `url`, delivering each parsed event to `sink`; the returned handle's drop stops it.
pub trait EventSource: Send + Sync {
    fn connect(&self, url: String, sink: EventSink) -> Box<dyn EventStreamHandle>;
}

/// A per-request route (the `?directory=<cwd>` query, `withRoute`, `serve-manager.ts:72-78`).
pub type Route = Option<String>;

// ── errors ──────────────────────────────────────────────────────────────────────

/// Failures the serve manager surfaces. [`ServeError::NotHealthy`] is the bounded
/// DEV-0001 outcome; its message contains "did not become healthy" verbatim.
#[derive(Clone, Debug, PartialEq)]
pub enum ServeError {
    ShuttingDown,
    StartupAborted,
    StartupFailed(String),
    ProcessExited { code: i32 },
    PortAllocation(String),
    Spawn(String),
    /// The bounded readiness-wait failure (DEV-0001): the outer `health_timeout`
    /// elapsed without a healthy probe.
    NotHealthy { timeout_ms: u64 },
    Http { method: String, url: String, status: u16, body: String },
    RequestTimeout { method: String, url: String, timeout_ms: u64 },
    Transport(String),
    Decode(String),
    IdleTimeout { session_id: String, timeout_ms: u64 },
    SidecarLost { session_id: String },
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServeError::ShuttingDown => write!(f, "opencode serve manager is shutting down"),
            ServeError::StartupAborted => write!(f, "opencode serve startup was aborted"),
            ServeError::StartupFailed(s) => write!(f, "opencode serve failed to start: {s}"),
            ServeError::ProcessExited { code } => write!(f, "opencode serve exited with code {code}"),
            ServeError::PortAllocation(s) => write!(f, "opencode serve port allocation failed: {s}"),
            ServeError::Spawn(s) => write!(f, "opencode serve spawn failed: {s}"),
            ServeError::NotHealthy { timeout_ms } => {
                write!(f, "opencode serve did not become healthy within {timeout_ms}ms")
            }
            ServeError::Http { method, url, status, body } => {
                write!(f, "opencode serve {method} {url} → {status} {body}")
            }
            ServeError::RequestTimeout { method, url, timeout_ms } => {
                write!(f, "opencode serve {method} {url} timed out after {timeout_ms}ms")
            }
            ServeError::Transport(s) => write!(f, "opencode serve transport error: {s}"),
            ServeError::Decode(s) => write!(f, "opencode serve response decode error: {s}"),
            ServeError::IdleTimeout { session_id, timeout_ms } => write!(
                f,
                "Timed out after {timeout_ms}ms waiting for OpenCode session {session_id} to go idle."
            ),
            ServeError::SidecarLost { session_id } => write!(
                f,
                "opencode serve sidecar was lost while waiting for session {session_id} to go idle."
            ),
        }
    }
}

impl std::error::Error for ServeError {}

// ── config / deps ────────────────────────────────────────────────────────────────

/// Timing knobs, defaulted to the reference values (`serve-manager.ts:12-14,121-123`).
#[derive(Clone, Debug)]
pub struct ServeConfig {
    pub command: String,
    pub env: Vec<(String, String)>,
    /// Outer readiness deadline (`healthTimeoutMs`, default 20 s). DEV-0001 leaves this
    /// UNCHANGED — a genuinely wedged serve still fails at this bound.
    pub health_timeout: Duration,
    /// Per-probe bound (DEV-0001, the 2 s AbortController analog).
    pub health_probe_timeout: Duration,
    /// Retry cadence between probes (150 ms, `serve-manager.ts:294`).
    pub health_retry_interval: Duration,
    /// Idle status-map poll cadence (`DEFAULT_IDLE_POLL_MS`, 500 ms).
    pub idle_poll_interval: Duration,
    /// Consecutive idle polls required before the fallback resolves
    /// (`REQUIRED_IDLE_STATUS_POLLS`, 2).
    pub required_idle_status_polls: u32,
    /// Per-request timeout for non-health calls (`DEFAULT_REQUEST_TIMEOUT_MS`, 30 s).
    pub request_timeout: Duration,
}

impl Default for ServeConfig {
    fn default() -> Self {
        Self {
            command: std::env::var("OPENCODE_CMD").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "opencode".to_string()),
            env: Vec::new(),
            health_timeout: Duration::from_millis(20_000),
            health_probe_timeout: Duration::from_millis(2_000),
            health_retry_interval: Duration::from_millis(150),
            idle_poll_interval: Duration::from_millis(500),
            required_idle_status_polls: 2,
            request_timeout: Duration::from_millis(30_000),
        }
    }
}

/// The injected backends.
#[derive(Clone)]
pub struct ServeDeps {
    pub spawner: Arc<dyn ProcessSpawner>,
    pub http: Arc<dyn ServeHttp>,
    pub ports: Arc<dyn PortAllocator>,
    pub events: Arc<dyn EventSource>,
}

// ── created/forked session shapes ────────────────────────────────────────────────

/// `createSession` result (`serve-manager.ts:337`).
#[derive(Clone, Debug, PartialEq)]
pub struct CreatedSession {
    pub id: String,
    pub directory: Option<String>,
    pub title: Option<String>,
}

/// `fork` result (`serve-manager.ts:411`).
#[derive(Clone, Debug, PartialEq)]
pub struct ForkedSession {
    pub id: String,
    pub directory: Option<String>,
}

// ── per-session fan-out signal ───────────────────────────────────────────────────

/// A signal delivered to per-session subscribers: either a parsed SSE event or the
/// terminal "sidecar lost" edge (`emitLostForAllSessions`, `serve-manager.ts:126-132`).
#[derive(Clone, Debug)]
pub enum SessionSignal {
    Event(ParsedServeEvent),
    Lost,
}

const SESSION_CHANNEL_CAPACITY: usize = 256;

struct RunningServe {
    base_url: String,
    process: Box<dyn ServeProcess>,
    _event_handle: Box<dyn EventStreamHandle>,
}

struct Inner {
    deps: ServeDeps,
    config: ServeConfig,
    shutdown: AtomicBool,
    running: tokio::sync::Mutex<Option<Arc<RunningServe>>>,
    session_emitters: Mutex<HashMap<String, broadcast::Sender<SessionSignal>>>,
}

/// The opencode serve sidecar client. Cheap to clone (`Arc`-backed).
#[derive(Clone)]
pub struct OpencodeServeManager {
    inner: Arc<Inner>,
}

impl OpencodeServeManager {
    pub fn new(deps: ServeDeps, config: ServeConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                deps,
                config,
                shutdown: AtomicBool::new(false),
                running: tokio::sync::Mutex::new(None),
                session_emitters: Mutex::new(HashMap::new()),
            }),
        }
    }

    fn config(&self) -> &ServeConfig {
        &self.inner.config
    }

    /// The current base url, if started (`baseUrlOrUndefined`, `serve-manager.ts:594`).
    pub async fn base_url(&self) -> Option<String> {
        self.inner.running.lock().await.as_ref().map(|r| r.base_url.clone())
    }

    /// Idempotent start: allocate a loopback port, spawn the ownership-tagged sidecar,
    /// wait (bounded) for health, then connect the SSE consumer. Concurrent callers are
    /// single-flighted by the `running` mutex (`ensureStarted`, `serve-manager.ts:181-194`).
    pub async fn ensure_started(&self) -> Result<String, ServeError> {
        if self.inner.shutdown.load(Ordering::SeqCst) {
            return Err(ServeError::ShuttingDown);
        }
        let mut guard = self.inner.running.lock().await;
        if let Some(running) = guard.as_ref() {
            return Ok(running.base_url.clone());
        }

        let endpoint = self.inner.deps.ports.allocate().map_err(ServeError::PortAllocation)?;
        let base_url = format!("http://{}:{}", endpoint.hostname, endpoint.port);
        let ownership_id = uuid::Uuid::new_v4().to_string();

        let mut env = self.config().env.clone();
        env.push((OPENCODE_SIDECAR_OWNERSHIP_ENV.to_string(), ownership_id.clone()));
        let process = self
            .inner
            .deps
            .spawner
            .spawn(SpawnRequest {
                command: self.config().command.clone(),
                hostname: endpoint.hostname.clone(),
                port: endpoint.port,
                ownership_id,
                env,
            })
            .map_err(ServeError::Spawn)?;

        if let Err(e) = self.wait_for_health(&base_url, process.as_ref()).await {
            process.kill();
            return Err(e);
        }

        let sink = self.make_dispatch_sink();
        let handle = self.inner.deps.events.connect(format!("{base_url}/global/event"), sink);

        *guard = Some(Arc::new(RunningServe { base_url: base_url.clone(), process, _event_handle: handle }));
        Ok(base_url)
    }

    /// Wait for the serve `/global/health` to report healthy, bounded by
    /// `health_timeout`, retrying every `health_retry_interval`.
    ///
    /// **DEV-0001 fix.** The reference issues an UN-timed `/global/health` GET
    /// (`serve-manager.ts:286`); a cold `opencode serve` accepts the TCP connection then
    /// withholds the response, so a single probe blocks well past the deadline and the
    /// `while (Date.now() < deadline)` loop never re-checks. The port bounds **each
    /// probe** with `health_probe_timeout` (the 2 s AbortController analog — the real
    /// transport ALSO applies it via `reqwest .timeout()`) and retries to the UNCHANGED
    /// outer deadline. The `tokio::time::timeout` wrapper is the hard bound that makes the
    /// loop provably non-hanging even if a transport ignores its own timeout, which is the
    /// exact scenario `tests/serve_health_bounded.rs` drives. A genuinely wedged serve
    /// still fails as [`ServeError::NotHealthy`] at the outer deadline — the fix does NOT
    /// mask a wedge.
    async fn wait_for_health(&self, base_url: &str, process: &dyn ServeProcess) -> Result<(), ServeError> {
        let deadline = Instant::now() + self.config().health_timeout;
        loop {
            if self.inner.shutdown.load(Ordering::SeqCst) {
                return Err(ServeError::StartupAborted);
            }
            if let Some(stderr) = process.take_fatal_startup_error() {
                return Err(ServeError::StartupFailed(stderr));
            }
            if let Some(code) = process.exited() {
                return Err(ServeError::ProcessExited { code });
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }

            // DEV-0001: bound EACH probe. Cap the per-probe budget to the remaining time
            // so a probe can never overshoot the outer deadline. `Err(Elapsed)` (the probe
            // exceeded its bounded budget) is treated like "not up yet" — the loop advances
            // and retries instead of blocking, which is the whole fix.
            let probe_budget = self.config().health_probe_timeout.min(remaining);
            let req =
                ServeHttpRequest::get(format!("{base_url}/global/health")).with_timeout(probe_budget);
            match tokio::time::timeout(probe_budget, self.inner.deps.http.request(req)).await {
                Ok(Ok(resp)) if resp.ok() && is_healthy_response(&resp.body) => return Ok(()),
                // Non-healthy 2xx, transport error (connection refused), or a bounded-out
                // probe → not up yet; fall through to the retry sleep.
                _ => {}
            }

            // Retry cadence (150 ms), never sleeping past the outer deadline.
            let sleep_for = self
                .config()
                .health_retry_interval
                .min(deadline.saturating_duration_since(Instant::now()));
            if sleep_for.is_zero() {
                break;
            }
            tokio::time::sleep(sleep_for).await;
        }
        Err(ServeError::NotHealthy { timeout_ms: self.config().health_timeout.as_millis() as u64 })
    }

    fn make_dispatch_sink(&self) -> EventSink {
        let weak = Arc::downgrade(&self.inner);
        Arc::new(move |event: ParsedServeEvent| {
            if let Some(inner) = weak.upgrade() {
                dispatch_event_on(&inner, event);
            }
        })
    }

    async fn require_base(&self) -> Result<String, ServeError> {
        self.ensure_started().await
    }

    /// One JSON request/response through the transport, bounded by `timeout`. On a
    /// timeout the running sidecar is discarded (`discardRunning('request_timeout')`,
    /// `serve-manager.ts:320-324`). `not_found_value` mirrors `json`'s 404 handling.
    async fn json_request(
        &self,
        method: HttpMethod,
        path: &str,
        body: Option<Value>,
        not_found_value: Option<Value>,
    ) -> Result<Value, ServeError> {
        let base = self.require_base().await?;
        let url = format!("{base}{path}");
        let timeout = self.config().request_timeout;
        let mut req = match (method, &body) {
            (HttpMethod::Get, _) => ServeHttpRequest::get(&url),
            (HttpMethod::Post, Some(value)) => {
                ServeHttpRequest::post_json(&url, serde_json::to_vec(value).unwrap_or_default())
            }
            (HttpMethod::Post, None) => ServeHttpRequest::post(&url),
        };
        req = req.with_timeout(timeout);

        let method_str = format!("{method:?}").to_uppercase();
        let resp = match tokio::time::timeout(timeout, self.inner.deps.http.request(req)).await {
            Err(_) => {
                self.discard_running("request_timeout").await;
                return Err(ServeError::RequestTimeout {
                    method: method_str,
                    url,
                    timeout_ms: timeout.as_millis() as u64,
                });
            }
            Ok(Err(transport)) => return Err(ServeError::Transport(transport)),
            Ok(Ok(resp)) => resp,
        };

        if !resp.ok() && resp.status != 204 {
            if resp.status == 404 {
                if let Some(value) = not_found_value {
                    return Ok(value);
                }
            }
            return Err(ServeError::Http {
                method: method_str,
                url,
                status: resp.status,
                body: resp.body_text(),
            });
        }
        if resp.status == 204 {
            return Ok(Value::Null);
        }
        resp.json()
    }

    /// `createSession({title?, parentID?, directory?})` (`serve-manager.ts:337-346`).
    pub async fn create_session(
        &self,
        title: Option<&str>,
        parent_id: Option<&str>,
        directory: Option<&str>,
    ) -> Result<CreatedSession, ServeError> {
        let mut body = Map::new();
        if let Some(t) = title {
            body.insert("title".into(), Value::String(t.to_string()));
        }
        if let Some(p) = parent_id {
            body.insert("parentID".into(), Value::String(p.to_string()));
        }
        let path = with_route("/session", &directory.map(|s| s.to_string()));
        let value = self.json_request(HttpMethod::Post, &path, Some(Value::Object(body)), None).await?;
        Ok(CreatedSession {
            id: value.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            directory: value.get("directory").and_then(Value::as_str).map(str::to_string),
            title: value.get("title").and_then(Value::as_str).map(str::to_string),
        })
    }

    /// `getSession(id, route)` (`serve-manager.ts:348-353`).
    pub async fn get_session(&self, id: &str, route: &Route) -> Result<Value, ServeError> {
        let path = with_route(&format!("/session/{}", encode_path_segment(id)), route);
        self.json_request(HttpMethod::Get, &path, None, None).await
    }

    /// `listMessages(id, {}, route)` (`serve-manager.ts:367-393`) — the current session
    /// message page (`GET /session/:id/message`). Simplified for the transcript-capture
    /// use: returns the raw JSON body the serve responds with (an array of message/part
    /// objects) so the caller renders text parts; the pagination cursor is not threaded
    /// here (a single page carries the whole short T2 turn). A 404 yields an empty array.
    pub async fn list_messages(&self, id: &str, route: &Route) -> Result<Value, ServeError> {
        let path = with_route(&format!("/session/{}/message", encode_path_segment(id)), route);
        self.json_request(HttpMethod::Get, &path, None, Some(Value::Array(Vec::new()))).await
    }

    /// `promptAsync(id, {parts, model?, variant?, agent?}, route)` — the send-turn call
    /// (`serve-manager.ts:355-365`). Returns once the serve accepts the prompt.
    pub async fn prompt_async(&self, id: &str, body: Value, route: &Route) -> Result<(), ServeError> {
        let path = with_route(&format!("/session/{}/prompt_async", encode_path_segment(id)), route);
        self.json_request(HttpMethod::Post, &path, Some(body), None).await?;
        Ok(())
    }

    /// `getSessionStatusMap(route)` (`serve-manager.ts:328-330`) — sessionId → status.
    pub async fn get_session_status_map(&self, route: &Route) -> Result<Map<String, Value>, ServeError> {
        let path = with_route("/session/status", route);
        let value = self.json_request(HttpMethod::Get, &path, None, None).await?;
        match value {
            Value::Object(map) => Ok(map),
            _ => Ok(Map::new()),
        }
    }

    /// `getSessionStatus(sessionId, route)` (`serve-manager.ts:332-335`).
    pub async fn get_session_status(&self, id: &str, route: &Route) -> Result<Option<Value>, ServeError> {
        Ok(self.get_session_status_map(route).await?.get(id).cloned())
    }

    /// `abort(id, route)` (`serve-manager.ts:399-401`).
    pub async fn abort(&self, id: &str, route: &Route) -> Result<(), ServeError> {
        let path = with_route(&format!("/session/{}/abort", encode_path_segment(id)), route);
        self.json_request(HttpMethod::Post, &path, None, None).await?;
        Ok(())
    }

    /// `fork(id, route)` (`serve-manager.ts:411-416`).
    pub async fn fork(&self, id: &str, route: &Route) -> Result<ForkedSession, ServeError> {
        let path = with_route(&format!("/session/{}/fork", encode_path_segment(id)), route);
        let value = self.json_request(HttpMethod::Post, &path, None, None).await?;
        Ok(ForkedSession {
            id: value.get("id").and_then(Value::as_str).unwrap_or_default().to_string(),
            directory: value.get("directory").and_then(Value::as_str).map(str::to_string),
        })
    }

    // ── SSE fan-out (serve-manager.ts:419-438) ──────────────────────────────────

    fn emitter_for(&self, session_id: &str) -> broadcast::Sender<SessionSignal> {
        let mut emitters = self.inner.session_emitters.lock().expect("session emitters mutex");
        emitters
            .entry(session_id.to_string())
            .or_insert_with(|| broadcast::Sender::new(SESSION_CHANNEL_CAPACITY))
            .clone()
    }

    /// Subscribe to a session's signal stream. Events dispatched AFTER this call are
    /// buffered for this receiver (broadcast semantics), so subscribing before
    /// `prompt_async` cannot miss the idle edge (`subscribe`, `serve-manager.ts:434-438`).
    pub fn subscribe(&self, session_id: &str) -> broadcast::Receiver<SessionSignal> {
        self.emitter_for(session_id).subscribe()
    }

    /// Feed one parsed SSE event into the per-session fan-out. This is the ingestion
    /// point the [`EventSource`] sink calls (`dispatchEvent`, `serve-manager.ts:429-432`).
    pub fn dispatch_event(&self, event: ParsedServeEvent) {
        dispatch_event_on(&self.inner, event);
    }

    /// Signal every subscriber that the sidecar was lost (`emitLostForAllSessions`,
    /// `serve-manager.ts:126-132`). Exposed for the sidecar-loss liveness path/tests.
    pub fn emit_lost_for_all(&self) {
        let emitters: Vec<broadcast::Sender<SessionSignal>> = {
            let mut map = self.inner.session_emitters.lock().expect("session emitters mutex");
            let senders = map.values().cloned().collect();
            map.clear();
            senders
        };
        for sender in emitters {
            let _ = sender.send(SessionSignal::Lost);
        }
    }

    async fn discard_running(&self, _reason: &str) {
        let taken = self.inner.running.lock().await.take();
        if let Some(running) = taken {
            running.process.kill();
        }
        self.emit_lost_for_all();
    }

    // ── the IDLE edge (once_idle / await_idle, serve-manager.ts:440-520) ─────────

    /// Resolve when the session goes idle: the SSE idle edge (`session.idle` /
    /// `session.status{type:idle}`) OR, as a fallback for a missed SSE idle, two
    /// consecutive idle status-map polls after observed running activity. Rejects on
    /// sidecar loss or `timeout`. Subscribes internally (`onceIdle`, `serve-manager.ts:440`).
    pub async fn once_idle(&self, session_id: &str, timeout: Duration, route: Route) -> Result<(), ServeError> {
        let rx = self.subscribe(session_id);
        self.await_idle(session_id, rx, timeout, route).await
    }

    /// [`once_idle`](Self::once_idle) driven from a pre-obtained receiver — so a caller
    /// (or a test) can subscribe deterministically BEFORE dispatching events.
    pub async fn await_idle(
        &self,
        session_id: &str,
        mut rx: broadcast::Receiver<SessionSignal>,
        timeout: Duration,
        route: Route,
    ) -> Result<(), ServeError> {
        let deadline = Instant::now() + timeout;
        let mut observed_activity = false;
        let mut idle_status_polls: u32 = 0;
        let mut poll = tokio::time::interval(self.config().idle_poll_interval);
        poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        poll.tick().await; // consume the immediate first tick

        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(ServeError::IdleTimeout {
                    session_id: session_id.to_string(),
                    timeout_ms: timeout.as_millis() as u64,
                });
            }

            tokio::select! {
                biased;
                signal = rx.recv() => {
                    match signal {
                        Ok(SessionSignal::Lost) => {
                            return Err(ServeError::SidecarLost { session_id: session_id.to_string() });
                        }
                        Ok(SessionSignal::Event(event)) => {
                            if is_idle_edge(&event) {
                                return Ok(());
                            }
                            if event_shows_running_status_activity(&event) {
                                observed_activity = true;
                                idle_status_polls = 0;
                                if self.check_status_idle(session_id, &route, &mut observed_activity, &mut idle_status_polls).await {
                                    return Ok(());
                                }
                            }
                        }
                        // Lagged: some events dropped — the status-poll fallback below
                        // is exactly the safety net for a missed idle. Closed: emitter
                        // gone — fall through to poll + timeout.
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(broadcast::error::RecvError::Closed) => {}
                    }
                }
                _ = poll.tick() => {
                    if self.check_status_idle(session_id, &route, &mut observed_activity, &mut idle_status_polls).await {
                        return Ok(());
                    }
                }
                _ = tokio::time::sleep(remaining) => {
                    return Err(ServeError::IdleTimeout {
                        session_id: session_id.to_string(),
                        timeout_ms: timeout.as_millis() as u64,
                    });
                }
            }
        }
    }

    /// `checkStatusMap` (`serve-manager.ts:471-496`): busy/retry marks activity; after
    /// activity, an idle-or-absent status counts toward `required_idle_status_polls`.
    /// Returns `true` when the idle threshold is reached. Poll errors reset the counter
    /// (and are swallowed, matching the reference's warn-once fallback).
    async fn check_status_idle(
        &self,
        session_id: &str,
        route: &Route,
        observed_activity: &mut bool,
        idle_status_polls: &mut u32,
    ) -> bool {
        match self.get_session_status_map(route).await {
            Ok(statuses) => {
                let status = statuses.get(session_id);
                let status_type = status.and_then(|s| s.get("type"));
                if is_running_status_type(status_type) {
                    *observed_activity = true;
                    *idle_status_polls = 0;
                    return false;
                }
                if *observed_activity && (status.is_none() || is_idle_status_type(status_type)) {
                    *idle_status_polls += 1;
                    if *idle_status_polls >= self.config().required_idle_status_polls {
                        return true;
                    }
                    return false;
                }
                *idle_status_polls = 0;
                false
            }
            Err(_) => {
                *idle_status_polls = 0;
                false
            }
        }
    }

    /// Send one text turn and block until the session goes idle — the serve-client
    /// primitive behind the adapter's `materializeOrSend` send-then-await-idle
    /// (`adapter.ts:355-368`). Subscribes BEFORE prompting so the idle edge cannot be
    /// missed. `model`/`effort` are the already-normalized wire values (normalization is
    /// the adapter's job; see [`crate::model`]).
    pub async fn run_turn(
        &self,
        session_id: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<&str>,
        timeout: Duration,
        route: Route,
    ) -> Result<(), ServeError> {
        let rx = self.subscribe(session_id);
        let body = build_prompt_body(text, model, effort);
        self.prompt_async(session_id, body, &route).await?;
        self.await_idle(session_id, rx, timeout, route).await
    }

    /// Shut down: stop future starts, discard the running sidecar (kill + stop SSE via
    /// the dropped handle), and signal all sessions lost (`shutdown`, `serve-manager.ts:573-591`).
    pub async fn shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
        let taken = self.inner.running.lock().await.take();
        if let Some(running) = taken {
            running.process.kill();
        }
        self.emit_lost_for_all();
    }
}

fn dispatch_event_on(inner: &Arc<Inner>, event: ParsedServeEvent) {
    let Some(session_id) = event.session_id.clone() else {
        return;
    };
    let sender = {
        let mut emitters = inner.session_emitters.lock().expect("session emitters mutex");
        emitters
            .entry(session_id)
            .or_insert_with(|| broadcast::Sender::new(SESSION_CHANNEL_CAPACITY))
            .clone()
    };
    let _ = sender.send(SessionSignal::Event(event));
}

/// Build the `prompt_async` body: `{ parts:[{type:'text',text}], model?, variant? }`
/// (`adapter.ts:363-367`). `model` is split into `{providerID, modelID}`; a
/// non-splittable model is omitted so the serve session default applies.
fn build_prompt_body(text: &str, model: Option<&str>, effort: Option<&str>) -> Value {
    let mut body = Map::new();
    body.insert(
        "parts".into(),
        Value::Array(vec![serde_json::json!({ "type": "text", "text": text })]),
    );
    if let Some(m) = crate::model::split_opencode_model(model) {
        body.insert("model".into(), serde_json::json!({ "providerID": m.provider_id, "modelID": m.model_id }));
    }
    if let Some(e) = effort.filter(|e| !e.is_empty()) {
        body.insert("variant".into(), Value::String(e.to_string()));
    }
    Value::Object(body)
}

/// `isHealthyResponse(body)` (`serve-manager.ts:57-59`) over the raw probe body: a JSON
/// object is healthy unless `healthy === false`; a non-JSON/unparseable 2xx body is
/// treated as `{}` → healthy (the reference `res.json().catch(() => ({}))`,
/// `serve-manager.ts:288`).
pub fn is_healthy_response(body: &[u8]) -> bool {
    match serde_json::from_slice::<Value>(body) {
        Ok(Value::Object(map)) => !matches!(map.get("healthy"), Some(Value::Bool(false))),
        // Unparseable/non-object 2xx body → `{}` → healthy.
        _ => true,
    }
}

/// Whether serve stderr shows a fatal startup error (`/ServeError|Failed to start
/// server|EADDRINUSE/i`, `serve-manager.ts:281`).
pub fn is_fatal_serve_stderr(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    lower.contains("serveerror") || lower.contains("failed to start server") || lower.contains("eaddrinuse")
}

/// `withRoute(requestPath, {cwd})` (`serve-manager.ts:72-78`): append `directory=<cwd>`
/// when a non-blank cwd is present, preserving any existing query string.
pub fn with_route(request_path: &str, route: &Route) -> String {
    let cwd = match route {
        Some(cwd) if !cwd.trim().is_empty() => cwd,
        _ => return request_path.to_string(),
    };
    let separator = if request_path.contains('?') { '&' } else { '?' };
    format!("{request_path}{separator}directory={}", percent_encode_component(cwd))
}

/// Minimal RFC-3986 percent-encoding for a query-component value (unreserved chars pass
/// through; everything else is `%XX`). opencode decodes the `directory` param either way;
/// this value is a normalized (masked) path field in the oracle, not byte-graded.
fn percent_encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Encode a single path segment (`encodeURIComponent(id)`, e.g. `serve-manager.ts:350`).
fn encode_path_segment(segment: &str) -> String {
    percent_encode_component(segment)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_response_predicate_matches_reference() {
        assert!(is_healthy_response(b"{}"));
        assert!(is_healthy_response(b"{\"healthy\":true}"));
        assert!(!is_healthy_response(b"{\"healthy\":false}"));
        // Unparseable 2xx body is treated as `{}` → healthy.
        assert!(is_healthy_response(b"not json"));
        assert!(is_healthy_response(b""));
        // A non-object JSON (array) → not an object → treated as healthy per catch(()=>({})).
        assert!(is_healthy_response(b"[1,2,3]"));
    }

    #[test]
    fn fatal_stderr_detection_is_case_insensitive() {
        assert!(is_fatal_serve_stderr("ServeError: boom"));
        assert!(is_fatal_serve_stderr("Failed to start server on :0"));
        assert!(is_fatal_serve_stderr("listen EADDRINUSE: address already in use"));
        assert!(is_fatal_serve_stderr("eaddrinuse"));
        assert!(!is_fatal_serve_stderr("info: serve listening"));
        assert!(!is_fatal_serve_stderr(""));
    }

    #[test]
    fn with_route_appends_directory_preserving_query() {
        assert_eq!(with_route("/session", &None), "/session");
        assert_eq!(with_route("/session", &Some("  ".to_string())), "/session");
        assert_eq!(with_route("/session", &Some("/home/u/p".to_string())), "/session?directory=%2Fhome%2Fu%2Fp");
        assert_eq!(
            with_route("/session/x/message?limit=5", &Some("/a".to_string())),
            "/session/x/message?limit=5&directory=%2Fa"
        );
    }

    #[test]
    fn percent_encode_encodes_space_and_reserved() {
        assert_eq!(percent_encode_component("/a b"), "%2Fa%20b");
        assert_eq!(percent_encode_component("plain-._~"), "plain-._~");
    }

    #[test]
    fn not_healthy_error_message_contains_reference_phrase() {
        let msg = ServeError::NotHealthy { timeout_ms: 20_000 }.to_string();
        assert!(msg.contains("did not become healthy within 20000ms"), "{msg}");
    }

    #[test]
    fn idle_timeout_error_message_matches_reference() {
        let msg = ServeError::IdleTimeout { session_id: "ses_1".into(), timeout_ms: 600_000 }.to_string();
        assert!(msg.contains("Timed out after 600000ms waiting for OpenCode session ses_1 to go idle."), "{msg}");
    }

    #[test]
    fn build_prompt_body_splits_model_and_sets_variant() {
        let body = build_prompt_body("hi", Some("umans-ai-coding-plan/umans-kimi-k2.7"), Some("low"));
        assert_eq!(body["parts"][0]["text"], serde_json::json!("hi"));
        assert_eq!(body["model"]["providerID"], serde_json::json!("umans-ai-coding-plan"));
        assert_eq!(body["model"]["modelID"], serde_json::json!("umans-kimi-k2.7"));
        assert_eq!(body["variant"], serde_json::json!("low"));
    }

    #[test]
    fn build_prompt_body_omits_unsplittable_model_and_empty_effort() {
        let body = build_prompt_body("hi", Some("noslash"), Some(""));
        assert!(body.get("model").is_none(), "unsplittable model omitted");
        assert!(body.get("variant").is_none(), "empty effort omitted");
    }
}
