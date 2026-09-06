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

use serde_json::{json, Map, Value};
use tokio::sync::broadcast;

use crate::events::{
    event_shows_running_status_activity, is_idle_edge, is_idle_status_type, is_running_status_type,
    ParsedServeEvent,
};

/// The ownership env tag written to the spawned serve so the reaper can find the
/// detached listener (`OWNERSHIP_ENV`, `serve-manager.ts:11`).
pub const OPENCODE_SIDECAR_OWNERSHIP_ENV: &str = "FRESHELL_OPENCODE_SIDECAR_ID";

/// kata 1wxv Task 3 (decision 1 — conversation rollback NEVER touches files): the
/// env-var lane the vendored opencode 1.18.21 CLI merges as an inline config document
/// (parsed with the highest-precedence "local" scope — `loaded custom config from
/// OPENCODE_CONFIG_CONTENT`).
pub const OPENCODE_CONFIG_CONTENT_ENV: &str = "OPENCODE_CONFIG_CONTENT";

/// The managed fresh-agent serve's pinned config: opencode snapshots DISABLED via the
/// vendored CLI's verified config key (`snapshot: false`, 1.18.21). Probe-verified at
/// Stage 2: with snapshots enabled, native `revert` re-applies FILE state for
/// patch-carrying turns — as long as the managed sidecar carries this, conversation
/// rollback can never touch the working tree (the Task 7 byte-identical-tree e2e is
/// the behavioral arbiter).
pub const OPENCODE_SNAPSHOTS_DISABLED_CONFIG: &str = "{\"snapshot\": false}";

/// Delta-r1 F3: the effective snapshots-disabled `OPENCODE_CONFIG_CONTENT` value.
/// A user could legitimately populate this env var with inline config (the repo
/// documents server plugins flowing through it), so the managed launch MERGES the
/// snapshots pin INTO an inherited JSON document instead of replacing it:
/// - `None`/absent → exactly [`OPENCODE_SNAPSHOTS_DISABLED_CONFIG`];
/// - a JSONC OBJECT → the same document with top-level `"snapshot": false` forced
///   (a user-supplied `snapshot` key is overwritten — conversation rollback must
///   never re-apply file state; that pin is the entire point of the decision).
///   Focused ep1-r4 F1: the inherited document is normalized through
///   [`jsonc_to_strict_json`] FIRST because OpenCode parses this lane with its
///   JSONC parser (1.18.21 `ConfigParse.jsonc` → `jsonc-parser` with
///   `allowTrailingComma`) — the merge accepts EXACTLY the same dialect the
///   vendored CLI would, never replacing valid comment/trailing-comma config;
/// - MALFORMED (unparseable even after JSONC normalization, or a JSON value that
///   isn't an object — a document with no
///   top-level key space can't take the pin) → replaced by the bare pin document,
///   with a structured warning naming ONLY the replaced value's byte length.
///   Focused ep1-r2 F5: inline config can carry credential-shaped fields (API
///   keys, authorization headers), so the warning NEVER logs any content
///   substring.
pub fn merged_opencode_config_content(inherited: Option<&str>) -> String {
    match inherited.filter(|raw| !raw.is_empty()) {
        None => OPENCODE_SNAPSHOTS_DISABLED_CONFIG.to_string(),
        Some(raw) => match serde_json::from_str::<Value>(&jsonc_to_strict_json(raw)) {
            Ok(Value::Object(mut map)) => {
                map.insert("snapshot".to_string(), Value::Bool(false));
                Value::Object(map).to_string()
            }
            _ => {
                tracing::warn!(
                    replaced_value_bytes_len = raw.len(),
                    "freshell_opencode.config_content.malformed_inline_config_replaced"
                );
                OPENCODE_SNAPSHOTS_DISABLED_CONFIG.to_string()
            }
        },
    }
}

/// Focused ep1-r4 F1: normalize the JSONC dialect OpenCode's own config loader
/// accepts for this lane (1.18.21 `ConfigParse.jsonc` — `jsonc-parser` with
/// `allowTrailingComma: true`) into the strict JSON `serde_json` parses, so the
/// merge accepts EXACTLY the same documents the vendored CLI would have:
///   (1) strip `//` line and TERMINATED `/* */` block comments (each replaced
///       by ONE space so adjacent value tokens are never fused — `1/**/2` →
///       `1 2`, not `12`); string-literal-aware, so a URL's `//`, a `\"`
///       before a closer, or a literal `/*` inside a quoted string survive
///       VERBATIM; an UNTERMINATED block comment's tail survives VERBATIM too
///       (jsonc-parser rejects it lexically) — stripping it to EOF could leave
///       a VALID strict document, silently accepting malformed JSONC
///       (ep2-r4);
///   (2) drop a comma whose next non-whitespace character is `}` or `]`
///       (whitespace between the comma and the closer — including a stripped
///       comment's space — is left in place).
/// Anything still unparseable after normalization keeps the existing
/// content-free malformed path above (the warning NEVER logs content — F5).
fn jsonc_to_strict_json(raw: &str) -> String {
    let stripped = {
        // Pass (1): comment strip, one left-to-right scan.
        let chars: Vec<char> = raw.chars().collect();
        let mut out = String::with_capacity(raw.len());
        let mut i = 0;
        let mut in_string = false;
        while i < chars.len() {
            let c = chars[i];
            if in_string {
                out.push(c);
                // `\` escapes the NEXT char verbatim (it can never end the string).
                if c == '\\' && i + 1 < chars.len() {
                    out.push(chars[i + 1]);
                    i += 1;
                } else if c == '"' {
                    in_string = false;
                }
                i += 1;
            } else if c == '"' {
                in_string = true;
                out.push(c);
                i += 1;
            } else if c == '/' && chars.get(i + 1) == Some(&'/') {
                // Line comment: ONE space; runs to (never consuming) the line
                // break — LF or bare CR alike (ep2-r1 F3: jsonc-parser, the
                // parser the vendored CLI's ConfigParse.jsonc delegates to,
                // ends line comments on either), or to EOF.
                out.push(' ');
                i += 2;
                while i < chars.len() && chars[i] != '\n' && chars[i] != '\r' {
                    i += 1;
                }
            } else if c == '/' && chars.get(i + 1) == Some(&'*') {
                // Block comment: ONE space; runs through the closer. An
                // UNTERMINATED block comment keeps its tail VERBATIM (ep2-r4:
                // stripping to EOF can leave a VALID strict document —
                // `{"a":1}/* dangling` → `{"a":1} ` — silently accepting
                // malformed JSONC into the merge. The parser OpenCode actually
                // delegates to errors lexically on it; the merge must accept
                // exactly the same document set, so the tail survives verbatim
                // and the strict parse rejects it).
                let comment_start = i;
                out.push(' ');
                i += 2;
                let mut closed = false;
                while i < chars.len() {
                    if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                        i += 2;
                        closed = true;
                        break;
                    }
                    i += 1;
                }
                if !closed {
                    out.extend(chars[comment_start..].iter());
                }
            } else {
                out.push(c);
                i += 1;
            }
        }
        out
    };
    // Pass (2): trailing-comma drop over the comment-stripped text.
    let chars: Vec<char> = stripped.chars().collect();
    let mut out = String::with_capacity(stripped.len());
    let mut i = 0;
    let mut in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
        } else if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
        } else if c == ',' {
            let mut j = i + 1;
            while matches!(chars.get(j), Some(' ' | '\t' | '\n' | '\r')) {
                j += 1;
            }
            if matches!(chars.get(j), Some('}' | ']')) {
                i += 1; // trailing comma: drop it, keep the whitespace run
            } else {
                out.push(c);
                i += 1;
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

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
        Self {
            method: HttpMethod::Get,
            url: url.into(),
            body: None,
            content_type: None,
            timeout: None,
        }
    }
    pub fn post(url: impl Into<String>) -> Self {
        Self {
            method: HttpMethod::Post,
            url: url.into(),
            body: None,
            content_type: None,
            timeout: None,
        }
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
        Self {
            status,
            body,
            next_cursor: None,
        }
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

/// The transport-local failure classes for one HTTP exchange (ep1-r3 F2): the
/// ONLY distinction that matters downstream is whether the request provably
/// NEVER reached the server. OpenCode ≥1.18.21's summarize handler runs
/// `revertSvc.cleanup` FIRST and its later stages atomically, so once the POST
/// may have left the client, ANY failure is possibly-mutated — while a
/// connect-phase refusal (DNS/connect failed before a byte was written) proves
/// the server never saw the request, so none of its side effects ran.
#[derive(Clone, Debug, PartialEq)]
pub enum ServeHttpError {
    /// The request provably never reached the server: the transport's connect
    /// phase failed BEFORE any byte left the client (connect refused / DNS).
    Undelivered(String),
    /// Every other exchange failure: mid-flight reset, post-headers body loss,
    /// in-handler failure surfaces — the request MAY have reached the server.
    Ambiguous(String),
}

impl std::fmt::Display for ServeHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ServeHttpError::Undelivered(s) | ServeHttpError::Ambiguous(s) => f.write_str(s),
        }
    }
}

impl std::error::Error for ServeHttpError {}

/// The HTTP transport seam (`fetchFn`). One request/response round-trip. The
/// `Err` side is a [`ServeHttpError`]: `Undelivered` ONLY for a provable
/// connect-phase refusal (never a byte sent), `Ambiguous` for everything else
/// (e.g. connection reset mid-exchange — the serve may have received it).
pub trait ServeHttp: Send + Sync {
    fn request<'a>(
        &'a self,
        req: ServeHttpRequest,
    ) -> BoxFuture<'a, Result<ServeHttpResponse, ServeHttpError>>;
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
    /// The catalog probe spawns `serve --pure` (`model-catalog.ts:173`); the
    /// long-lived session sidecar must NOT (it defaults config off).
    pub pure: bool,
    /// The catalog probe's working directory (`model-catalog.ts:178`) so
    /// project-level `opencode.json` provider config resolves; `None` for the
    /// session sidecar (its cwd scoping rides the `?directory=` route param).
    pub cwd: Option<String>,
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
    ProcessExited {
        code: i32,
    },
    PortAllocation(String),
    Spawn(String),
    /// The bounded readiness-wait failure (DEV-0001): the outer `health_timeout`
    /// elapsed without a healthy probe.
    NotHealthy {
        timeout_ms: u64,
    },
    Http {
        method: String,
        url: String,
        status: u16,
        body: String,
    },
    RequestTimeout {
        method: String,
        url: String,
        timeout_ms: u64,
    },
    Transport(String),
    /// The transport's connect phase refused BEFORE a byte left the client
    /// ([`ServeHttpError::Undelivered`]) — the serve provably never saw the
    /// request (ep1-r3 F2: the ONLY failure class downstream may treat as
    /// "no side effects ran").
    Undelivered(String),
    Decode(String),
    IdleTimeout {
        session_id: String,
        timeout_ms: u64,
    },
    SidecarLost {
        session_id: String,
    },
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
            ServeError::Undelivered(s) => {
                write!(f, "opencode serve request never reached the server: {s}")
            }
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

impl ServeError {
    /// TRUE exactly when this failure PROVES the request never left the client
    /// process — the downstream rollback-redo compensation predicate
    /// (ep1-r3 F2, widened by focused ep2-r1 F3). Two provable families:
    ///
    /// - [`ServeError::Undelivered`] — the transport's connect phase refused
    ///   BEFORE a byte left the client (the serve provably never saw the
    ///   request);
    /// - EVERY startup-phase failure — [`ServeError::ShuttingDown`],
    ///   [`ServeError::StartupAborted`], [`ServeError::StartupFailed`],
    ///   [`ServeError::ProcessExited`], [`ServeError::PortAllocation`],
    ///   [`ServeError::Spawn`], [`ServeError::NotHealthy`]: all raised from
    ///   `ensure_started`/`wait_for_health` BEFORE the request is even
    ///   constructed, so no POST could exist.
    ///
    /// Everything else is post-dispatch or ambiguous — an answered non-2xx
    /// ([`ServeError::Http`]; OpenCode ≥1.18.21 summarize runs
    /// `revertSvc.cleanup` FIRST, so the tail may already be gone), a
    /// mid-flight [`ServeError::RequestTimeout`], an ongoing-connection
    /// [`ServeError::Transport`] (the ambiguous transport leg), a
    /// [`ServeError::Decode`] (answer bytes arrived), and the post-send
    /// [`ServeError::IdleTimeout`]/[`ServeError::SidecarLost`] — and must keep
    /// the redo destroy intact FOREVER (error-after-send ≠ tail survived).
    pub fn never_dispatched(&self) -> bool {
        matches!(
            self,
            ServeError::Undelivered(_)
                | ServeError::ShuttingDown
                | ServeError::StartupAborted
                | ServeError::StartupFailed(_)
                | ServeError::ProcessExited { .. }
                | ServeError::PortAllocation(_)
                | ServeError::Spawn(_)
                | ServeError::NotHealthy { .. }
        )
    }
}

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
            command: std::env::var("OPENCODE_CMD")
                .ok()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "opencode".to_string()),
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
        self.inner
            .running
            .lock()
            .await
            .as_ref()
            .map(|r| r.base_url.clone())
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

        let endpoint = self
            .inner
            .deps
            .ports
            .allocate()
            .map_err(ServeError::PortAllocation)?;
        let base_url = format!("http://{}:{}", endpoint.hostname, endpoint.port);
        let ownership_id = uuid::Uuid::new_v4().to_string();

        let mut env = self.config().env.clone();
        env.push((
            OPENCODE_SIDECAR_OWNERSHIP_ENV.to_string(),
            ownership_id.clone(),
        ));
        // kata 1wxv Task 3 (decision 1): the MANAGED fresh-agent serve ALWAYS carries
        // opencode snapshots disabled. Delta-r1 F3: MERGE the pin into any inherited
        // inline config instead of replacing it (a user-supplied `snapshot` key is
        // overwritten — conversation rollback (revert/unrevert) must never re-apply
        // file state, but sibling keys — e.g. the server plugins this repo documents
        // under this var — must survive). The inherited value is the LAST
        // config-supplied entry if present, else the process env's; the spawn env
        // ends with EXACTLY ONE entry (the merged value).
        let inherited = {
            let from_config = env
                .iter()
                .rev()
                .find(|(key, _)| key == OPENCODE_CONFIG_CONTENT_ENV)
                .map(|(_, v)| v.clone());
            env.retain(|(key, _)| key != OPENCODE_CONFIG_CONTENT_ENV);
            from_config.or_else(|| std::env::var(OPENCODE_CONFIG_CONTENT_ENV).ok())
        };
        env.push((
            OPENCODE_CONFIG_CONTENT_ENV.to_string(),
            merged_opencode_config_content(inherited.as_deref()),
        ));
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
                pure: false,
                cwd: None,
            })
            .map_err(ServeError::Spawn)?;

        if let Err(e) = self.wait_for_health(&base_url, process.as_ref()).await {
            process.kill();
            return Err(e);
        }

        let sink = self.make_dispatch_sink();
        let handle = self
            .inner
            .deps
            .events
            .connect(format!("{base_url}/global/event"), sink);

        *guard = Some(Arc::new(RunningServe {
            base_url: base_url.clone(),
            process,
            _event_handle: handle,
        }));
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
    async fn wait_for_health(
        &self,
        base_url: &str,
        process: &dyn ServeProcess,
    ) -> Result<(), ServeError> {
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
            let req = ServeHttpRequest::get(format!("{base_url}/global/health"))
                .with_timeout(probe_budget);
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
        Err(ServeError::NotHealthy {
            timeout_ms: self.config().health_timeout.as_millis() as u64,
        })
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
        self.json_request_maybe_witnessed(method, path, body, not_found_value, None)
            .await
    }

    /// [`json_request`] with an optional dispatch witness: when present, the
    /// flag flips exactly once the URL exists and the HTTP send is issued —
    /// after this call's own `require_base` — the TRUE dispatch point (ep4-r6
    /// F3: arming the witness between two require_base calls misclassifies an
    /// abort that lands inside the second one's wait as "dispatched").
    async fn json_request_maybe_witnessed(
        &self,
        method: HttpMethod,
        path: &str,
        body: Option<Value>,
        not_found_value: Option<Value>,
        dispatch_witness: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
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
        let resp = match {
            if let Some(witness) = &dispatch_witness {
                witness.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            tokio::time::timeout(timeout, self.inner.deps.http.request(req))
        }
        .await
        {
            Err(_) => {
                self.discard_running("request_timeout").await;
                return Err(ServeError::RequestTimeout {
                    method: method_str,
                    url,
                    timeout_ms: timeout.as_millis() as u64,
                });
            }
            Ok(Err(transport)) => {
                return Err(match transport {
                    // ep1-r3 F2: keep the delivery truth lossless — a provable
                    // connect-phase refusal is NOT a generic transport error.
                    ServeHttpError::Undelivered(s) => ServeError::Undelivered(s),
                    ServeHttpError::Ambiguous(s) => ServeError::Transport(s),
                });
            }
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
        let value = self
            .json_request(HttpMethod::Post, &path, Some(Value::Object(body)), None)
            .await?;
        Ok(CreatedSession {
            id: value
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            directory: value
                .get("directory")
                .and_then(Value::as_str)
                .map(str::to_string),
            title: value
                .get("title")
                .and_then(Value::as_str)
                .map(str::to_string),
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
        let path = with_route(
            &format!("/session/{}/message", encode_path_segment(id)),
            route,
        );
        self.json_request(HttpMethod::Get, &path, None, Some(Value::Array(Vec::new())))
            .await
    }

    /// `promptAsync(id, {parts, model?, variant?, agent?}, route)` — the send-turn call
    /// (`serve-manager.ts:355-365`). Returns once the serve accepts the prompt.
    pub async fn prompt_async(
        &self,
        id: &str,
        body: Value,
        route: &Route,
    ) -> Result<(), ServeError> {
        let path = with_route(
            &format!("/session/{}/prompt_async", encode_path_segment(id)),
            route,
        );
        self.json_request(HttpMethod::Post, &path, Some(body), None)
            .await?;
        Ok(())
    }

    /// `getSessionStatusMap(route)` (`serve-manager.ts:328-330`) — sessionId → status.
    pub async fn get_session_status_map(
        &self,
        route: &Route,
    ) -> Result<Map<String, Value>, ServeError> {
        let path = with_route("/session/status", route);
        let value = self
            .json_request(HttpMethod::Get, &path, None, None)
            .await?;
        match value {
            Value::Object(map) => Ok(map),
            _ => Ok(Map::new()),
        }
    }

    /// `getSessionStatus(sessionId, route)` (`serve-manager.ts:332-335`).
    pub async fn get_session_status(
        &self,
        id: &str,
        route: &Route,
    ) -> Result<Option<Value>, ServeError> {
        Ok(self.get_session_status_map(route).await?.get(id).cloned())
    }

    /// `abort(id, route)` (`serve-manager.ts:399-401`).
    pub async fn abort(&self, id: &str, route: &Route) -> Result<(), ServeError> {
        let path = with_route(
            &format!("/session/{}/abort", encode_path_segment(id)),
            route,
        );
        self.json_request(HttpMethod::Post, &path, None, None)
            .await?;
        Ok(())
    }

    /// `GET /config` — the serve's global config, returned verbatim. The fresh-agent
    /// compact path consumes only its `model` key (probed on 1.18.18: present,
    /// string-or-null) as the model-pair fallback when a session carries no splittable
    /// model of its own.
    pub async fn get_config(&self, route: &Route) -> Result<Value, ServeError> {
        let path = with_route("/config", route);
        self.json_request(HttpMethod::Get, &path, None, None).await
    }

    /// `POST /session/:id/summarize` — the compact RPC. VALIDATED opencode 1.18.18
    /// contract (`/doc` schema + live probes): the body REQUIRES `{providerID,
    /// modelID}` (400 when missing) and is `additionalProperties:false`, so the body is
    /// EXACTLY those two keys — the manager stores no session metadata, hence the model
    /// pair is an EXPLICIT parameter the caller resolved upstream. The 200 `boolean`
    /// result is not consumed by the fresh-agent path.
    ///
    /// kata 1wxv ep4-r5 (abort-window boundary): `dispatched_witness` flips to
    /// `true` exactly when the drive crosses from the cancellable leg into the
    /// request leg — AFTER `require_base` (the serve is running; aborts in the
    /// cold-start leg are still provably no-side-effects) and BEFORE the HTTP
    /// call is issued. An aborted drive past this point is ambiguous-possibly-
    /// mutated and must never be compensated by ledger restore.
    pub async fn compact(
        &self,
        id: &str,
        provider_id: &str,
        model_id: &str,
        route: &Route,
        dispatched_witness: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) -> Result<(), ServeError> {
        let path = with_route(
            &format!("/session/{}/summarize", encode_path_segment(id)),
            route,
        );
        // The witness flips INSIDE the request leg at the true send point —
        // after its own `require_base` (the serve is running; aborts in the
        // cold-start leg are still provably no-side-effects) and right where
        // the HTTP call is issued (an abort inside the request leg's shared
        // lock waits doesn't falsely look dispatched — ep4-r6 F3).
        self.json_request_maybe_witnessed(
            HttpMethod::Post,
            &path,
            Some(json!({ "providerID": provider_id, "modelID": model_id })),
            None,
            dispatched_witness,
        )
        .await?;
        Ok(())
    }

    /// `fork(id, route)` (`serve-manager.ts:411-416`) + the Task 5 selected-turn knob:
    /// the probed opencode 1.18.18 `POST /session/:id/fork` body schema is
    /// `{messageID?: ^msg…}` with `additionalProperties:false` (GET /doc), so the body
    /// carries EXACTLY `messageID` when `message_id` is `Some` and is omitted entirely
    /// when `None` (the legacy no-body shape). Callers gate the client-supplied value
    /// to the `^msg` shape before passing it here — the strict schema must never
    /// receive an unknown/malformed key.
    pub async fn fork(
        &self,
        id: &str,
        route: &Route,
        message_id: Option<&str>,
    ) -> Result<ForkedSession, ServeError> {
        let path = with_route(&format!("/session/{}/fork", encode_path_segment(id)), route);
        let body = message_id.map(|mid| json!({ "messageID": mid }));
        let value = self
            .json_request(HttpMethod::Post, &path, body, None)
            .await?;
        Ok(ForkedSession {
            id: value
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            directory: value
                .get("directory")
                .and_then(Value::as_str)
                .map(str::to_string),
        })
    }

    /// `POST /session/:id/revert` (opencode 1.18.21, kata 1wxv Task 3) —
    /// message-targeted conversation rollback: `{messageID}` marks that message AND
    /// everything after it as reverted (the boundary is INCLUSIVE of the named
    /// message; an assistant target normalizes to its parent user message). Body
    /// discipline mirrors `fork` (additionalProperties:false upstream): EXACTLY one
    /// key.
    pub async fn revert(
        &self,
        id: &str,
        message_id: &str,
        route: &Route,
    ) -> Result<(), ServeError> {
        let path = with_route(
            &format!("/session/{}/revert", encode_path_segment(id)),
            route,
        );
        self.json_request(
            HttpMethod::Post,
            &path,
            Some(json!({ "messageID": message_id })),
            None,
        )
        .await?;
        Ok(())
    }

    /// `POST /session/:id/unrevert` — restores ALL reverted messages (opencode's
    /// all-or-nothing redo). No body.
    pub async fn unrevert(&self, id: &str, route: &Route) -> Result<(), ServeError> {
        let path = with_route(
            &format!("/session/{}/unrevert", encode_path_segment(id)),
            route,
        );
        self.json_request(HttpMethod::Post, &path, None, None)
            .await?;
        Ok(())
    }

    // ── SSE fan-out (serve-manager.ts:419-438) ──────────────────────────────────

    fn emitter_for(&self, session_id: &str) -> broadcast::Sender<SessionSignal> {
        let mut emitters = self
            .inner
            .session_emitters
            .lock()
            .expect("session emitters mutex");
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
            let mut map = self
                .inner
                .session_emitters
                .lock()
                .expect("session emitters mutex");
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
    pub async fn once_idle(
        &self,
        session_id: &str,
        timeout: Duration,
        route: Route,
    ) -> Result<(), ServeError> {
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
        let mut emitters = inner
            .session_emitters
            .lock()
            .expect("session emitters mutex");
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
        body.insert(
            "model".into(),
            serde_json::json!({ "providerID": m.provider_id, "modelID": m.model_id }),
        );
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
    lower.contains("serveerror")
        || lower.contains("failed to start server")
        || lower.contains("eaddrinuse")
}

/// `withRoute(requestPath, {cwd})` (`serve-manager.ts:72-78`): append `directory=<cwd>`
/// when a non-blank cwd is present, preserving any existing query string.
pub fn with_route(request_path: &str, route: &Route) -> String {
    let cwd = match route {
        Some(cwd) if !cwd.trim().is_empty() => cwd,
        _ => return request_path.to_string(),
    };
    let separator = if request_path.contains('?') { '&' } else { '?' };
    format!(
        "{request_path}{separator}directory={}",
        percent_encode_component(cwd)
    )
}

/// Minimal RFC-3986 percent-encoding for a query-component value (unreserved chars pass
/// through; everything else is `%XX`). opencode decodes the `directory` param either way;
/// this value is a normalized (masked) path field in the oracle, not byte-graded.
fn percent_encode_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
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
        assert!(is_fatal_serve_stderr(
            "listen EADDRINUSE: address already in use"
        ));
        assert!(is_fatal_serve_stderr("eaddrinuse"));
        assert!(!is_fatal_serve_stderr("info: serve listening"));
        assert!(!is_fatal_serve_stderr(""));
    }

    #[test]
    fn with_route_appends_directory_preserving_query() {
        assert_eq!(with_route("/session", &None), "/session");
        assert_eq!(with_route("/session", &Some("  ".to_string())), "/session");
        assert_eq!(
            with_route("/session", &Some("/home/u/p".to_string())),
            "/session?directory=%2Fhome%2Fu%2Fp"
        );
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
        assert!(
            msg.contains("did not become healthy within 20000ms"),
            "{msg}"
        );
    }

    #[test]
    fn idle_timeout_error_message_matches_reference() {
        let msg = ServeError::IdleTimeout {
            session_id: "ses_1".into(),
            timeout_ms: 600_000,
        }
        .to_string();
        assert!(
            msg.contains("Timed out after 600000ms waiting for OpenCode session ses_1 to go idle."),
            "{msg}"
        );
    }

    #[test]
    fn build_prompt_body_splits_model_and_sets_variant() {
        let body = build_prompt_body("hi", Some("provider/model"), Some("low"));
        assert_eq!(body["parts"][0]["text"], serde_json::json!("hi"));
        assert_eq!(body["model"]["providerID"], serde_json::json!("provider"));
        assert_eq!(body["model"]["modelID"], serde_json::json!("model"));
        assert_eq!(body["variant"], serde_json::json!("low"));
    }

    #[test]
    fn build_prompt_body_omits_unsplittable_model_and_empty_effort() {
        let body = build_prompt_body("hi", Some("noslash"), Some(""));
        assert!(body.get("model").is_none(), "unsplittable model omitted");
        assert!(body.get("variant").is_none(), "empty effort omitted");
    }

    // ── compact (POST /session/:id/summarize) + get_config (GET /config) ────────

    /// A `ServeHttp` fake that records every request (`METHOD url body?`) and scripts
    /// responses: healthy probes, summarize per `summarize_status`, fork per
    /// `fork_status`/`fork_body`, `/config` per `config_body`, everything else a
    /// benign 200 `{}`.
    struct RecordingHttp {
        requests: Mutex<Vec<(String, String, Option<String>)>>,
        summarize_status: u16,
        fork_status: u16,
        fork_body: Vec<u8>,
        config_body: Vec<u8>,
        revert_status: u16,
    }

    impl RecordingHttp {
        fn new() -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
                summarize_status: 200,
                fork_status: 200,
                fork_body: br#"{"id":"ses_child","directory":"/tmp/x"}"#.to_vec(),
                config_body: br#"{"model":null}"#.to_vec(),
                revert_status: 200,
            }
        }

        fn recorded(&self) -> Vec<(String, String, Option<String>)> {
            self.requests.lock().expect("requests mutex").clone()
        }
    }

    impl ServeHttp for RecordingHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> Pin<Box<dyn Future<Output = Result<ServeHttpResponse, ServeHttpError>> + Send + 'a>>
        {
            let method = format!("{:?}", req.method).to_uppercase();
            self.requests.lock().expect("requests mutex").push((
                method,
                req.url.clone(),
                req.body
                    .as_ref()
                    .map(|b| String::from_utf8_lossy(b).into_owned()),
            ));
            if req.url.contains("/global/health") {
                return Box::pin(async { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) });
            }
            if req.url.contains("/summarize") {
                let status = self.summarize_status;
                let body = if status == 200 {
                    // VALIDATED 1.18.18 contract: the summarize success body is a boolean.
                    b"true".to_vec()
                } else {
                    br#"{"error":"providerID is required"}"#.to_vec()
                };
                return Box::pin(async move { Ok(ServeHttpResponse::new(status, body)) });
            }
            if req.url.contains("/fork") {
                let status = self.fork_status;
                let body = self.fork_body.clone();
                return Box::pin(async move { Ok(ServeHttpResponse::new(status, body)) });
            }
            if req.url.contains("/revert") {
                let status = self.revert_status;
                let body = if status == 200 {
                    b"true".to_vec()
                } else {
                    br#"{"error":"unknown route"}"#.to_vec()
                };
                return Box::pin(async move { Ok(ServeHttpResponse::new(status, body)) });
            }
            if req.url.contains("/config") {
                let body = self.config_body.clone();
                return Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) });
            }
            Box::pin(async move { Ok(ServeHttpResponse::new(200, b"{}".to_vec())) })
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

    async fn started_recording_manager(http: Arc<RecordingHttp>) -> OpencodeServeManager {
        let deps = ServeDeps {
            spawner: Arc::new(FakeSpawner),
            http,
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let mgr = OpencodeServeManager::new(deps, ServeConfig::default());
        mgr.ensure_started()
            .await
            .expect("healthy fake serve starts");
        mgr
    }

    #[tokio::test]
    async fn compact_posts_the_exact_validated_summarize_body() {
        let http = Arc::new(RecordingHttp::new());
        let mgr = started_recording_manager(http.clone()).await;

        mgr.compact(
            "ses_9",
            "prov-a",
            "mdl-x",
            &Some("/work dir".to_string()),
            None,
        )
        .await
        .expect("200 summarize succeeds");

        let requests = http.recorded();
        let (_, url, body) = requests
            .iter()
            .find(|(method, url, _)| method == "POST" && url.contains("/summarize"))
            .expect("a summarize POST was recorded");
        assert!(
            url.contains("/session/ses_9/summarize"),
            "the summarize path carries the session id: {url}"
        );
        assert!(
            url.contains("directory=%2Fwork%20dir"),
            "the route is preserved: {url}"
        );
        let body: Value =
            serde_json::from_str(body.as_deref().expect("summarize carries a JSON body")).unwrap();
        let obj = body.as_object().unwrap();
        assert_eq!(
            obj.len(),
            2,
            "additionalProperties:false — EXACTLY the two required keys: {body}"
        );
        assert_eq!(body["providerID"], serde_json::json!("prov-a"));
        assert_eq!(body["modelID"], serde_json::json!("mdl-x"));
    }

    #[tokio::test]
    async fn compact_surfaces_a_validation_400_as_an_http_error() {
        let http = Arc::new(RecordingHttp {
            summarize_status: 400,
            ..RecordingHttp::new()
        });
        let mgr = started_recording_manager(http).await;

        match mgr.compact("ses_9", "prov-a", "mdl-x", &None, None).await {
            Err(ServeError::Http { method, status, .. }) => {
                assert_eq!(method, "POST");
                assert_eq!(status, 400);
            }
            other => panic!("expected a 400 Http error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn get_config_returns_the_raw_config_body() {
        let http = Arc::new(RecordingHttp {
            config_body: br#"{"model":"prov-a/mdl-x","theme":"dark"}"#.to_vec(),
            ..RecordingHttp::new()
        });
        let mgr = started_recording_manager(http.clone()).await;

        let config = mgr.get_config(&None).await.expect("config fetches");
        assert_eq!(config["model"], serde_json::json!("prov-a/mdl-x"));
        assert_eq!(config["theme"], serde_json::json!("dark"));

        let requests = http.recorded();
        let (_, _, body) = requests
            .iter()
            .find(|(method, url, _)| method == "GET" && url.contains("/config"))
            .expect("a /config GET was recorded");
        assert!(body.is_none(), "GET /config carries no body");
    }

    // ── fork (POST /session/:id/fork) ────────────────────────────────────────

    /// The recorded `POST /session/:id/fork` request, if any.
    fn fork_request(http: &RecordingHttp) -> Option<(String, String, Option<String>)> {
        http.recorded()
            .into_iter()
            .find(|(method, url, _)| method == "POST" && url.contains("/fork"))
    }

    #[tokio::test]
    async fn fork_without_a_message_id_posts_no_body_and_parses_the_child() {
        let http = Arc::new(RecordingHttp::new());
        let mgr = started_recording_manager(http.clone()).await;

        let child = mgr
            .fork("ses_9", &Some("/work dir".to_string()), None)
            .await
            .expect("200 fork succeeds");

        assert_eq!(child.id, "ses_child");
        assert_eq!(child.directory.as_deref(), Some("/tmp/x"));
        let (_, url, body) = fork_request(&http).expect("a fork POST was recorded");
        assert!(
            url.contains("/session/ses_9/fork"),
            "the fork path carries the session id: {url}"
        );
        assert!(
            url.contains("directory=%2Fwork%20dir"),
            "the route is preserved: {url}"
        );
        assert!(
            body.is_none(),
            "no message_id -> the legacy no-POST-body shape (strict additionalProperties:false schema): {body:?}"
        );
    }

    #[tokio::test]
    async fn fork_with_a_message_id_posts_exactly_the_message_id_key() {
        let http = Arc::new(RecordingHttp::new());
        let mgr = started_recording_manager(http.clone()).await;

        mgr.fork("ses_9", &None, Some("msg_abc"))
            .await
            .expect("200 fork succeeds");

        let (_, _, body) = fork_request(&http).expect("a fork POST was recorded");
        let body: Value =
            serde_json::from_str(body.as_deref().expect("a message id carries a JSON body"))
                .unwrap();
        let obj = body.as_object().unwrap();
        assert_eq!(
            obj.len(),
            1,
            "additionalProperties:false — EXACTLY the single optional key: {body}"
        );
        assert_eq!(body["messageID"], serde_json::json!("msg_abc"));
    }

    #[tokio::test]
    async fn fork_surfaces_a_validation_400_as_an_http_error() {
        let http = Arc::new(RecordingHttp {
            fork_status: 400,
            fork_body: br#"{"error":"expected string to match '^msg'"}"#.to_vec(),
            ..RecordingHttp::new()
        });
        let mgr = started_recording_manager(http).await;

        match mgr.fork("ses_9", &None, None).await {
            Err(ServeError::Http {
                method,
                status,
                body,
                ..
            }) => {
                assert_eq!(method, "POST");
                assert_eq!(status, 400);
                assert!(
                    body.contains("expected string to match '^msg'"),
                    "the serve error text crosses the surface: {body}"
                );
            }
            other => panic!("expected a 400 Http error, got {other:?}"),
        }
    }

    // ── revert/unrevert + snapshots-disabled launch (kata 1wxv Task 3) ────────

    /// The recorded revert-family POST requests, if any (`/revert` AND `/unrevert` —
    /// the latter never contains the former as a substring).
    fn revert_requests(http: &RecordingHttp) -> Vec<(String, String, Option<String>)> {
        http.recorded()
            .into_iter()
            .filter(|(method, url, _)| method == "POST" && url.contains("revert"))
            .collect()
    }

    #[tokio::test]
    async fn revert_posts_exactly_the_message_id_key() {
        let http = Arc::new(RecordingHttp::new());
        let mgr = started_recording_manager(http.clone()).await;

        mgr.revert("ses_9", "msg_u3", &Some("/work dir".to_string()))
            .await
            .expect("200 revert succeeds");

        let requests = revert_requests(&http);
        assert_eq!(requests.len(), 1, "exactly one revert POST");
        let (_, url, body) = requests.into_iter().next().expect("one revert POST");
        assert!(
            url.contains("/session/ses_9/revert"),
            "the revert path carries the session id: {url}"
        );
        assert!(
            url.contains("directory=%2Fwork%20dir"),
            "the route is preserved: {url}"
        );
        // additionalProperties:false upstream: EXACTLY the one key.
        let body: Value =
            serde_json::from_str(body.as_deref().expect("revert carries a JSON body")).unwrap();
        assert_eq!(body, serde_json::json!({ "messageID": "msg_u3" }), "{body}");
    }

    #[tokio::test]
    async fn unrevert_posts_no_body() {
        let http = Arc::new(RecordingHttp::new());
        let mgr = started_recording_manager(http.clone()).await;

        mgr.unrevert("ses_9", &None)
            .await
            .expect("200 unrevert succeeds");

        let requests = revert_requests(&http);
        assert_eq!(requests.len(), 1, "exactly one unrevert POST");
        let (_, url, body) = requests.into_iter().next().expect("one unrevert POST");
        assert!(
            url.contains("/session/ses_9/unrevert"),
            "the unrevert path carries the session id: {url}"
        );
        assert!(
            body.is_none(),
            "unrevert is the legacy no-POST-body shape: {body:?}"
        );
    }

    #[tokio::test]
    async fn revert_surfaces_a_404_as_an_http_error() {
        // A CLI predating the revert surface answers 404/unknown-route; the caller
        // maps it to UNSUPPORTED_CAPABILITY (never an uncontextualized INTERNAL_ERROR).
        let http = Arc::new(RecordingHttp {
            revert_status: 404,
            ..RecordingHttp::new()
        });
        let mgr = started_recording_manager(http).await;

        match mgr.revert("ses_9", "msg_u3", &None).await {
            Err(ServeError::Http { method, status, .. }) => {
                assert_eq!(method, "POST");
                assert_eq!(status, 404);
            }
            other => panic!("expected a 404 Http error, got {other:?}"),
        }
    }

    /// A spawner that CAPTURES its spawn requests (the launch-config assertion).
    struct CapturingSpawner {
        requests: Mutex<Vec<SpawnRequest>>,
    }
    impl ProcessSpawner for CapturingSpawner {
        fn spawn(&self, req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
            self.requests.lock().expect("spawns mutex").push(req);
            Ok(Box::new(NeverExitsProcess))
        }
    }

    /// kata 1wxv Task 3 (decision 1 — rollback NEVER touches files): native
    /// revert re-applies FILE state for patch-carrying turns when snapshots are
    /// enabled (probe-verified against the vendored 1.18.21 CLI), so the managed
    /// fresh-agent `opencode serve` sidecar ALWAYS launches with opencode
    /// snapshots DISABLED via `OPENCODE_CONFIG_CONTENT={"snapshot": false}`
    /// (the vendored CLI's verified config key; merged config, highest-precedence
    /// env lane). The Task 7 byte-identical-working-tree e2e is the behavioral
    /// arbiter; this pins the launch config itself.
    ///
    /// Env-hermetic (delta-r1 F3): the launch now MERGES an inherited value,
    /// so this default-path pin scrubs a possibly-hostile host var first.
    #[tokio::test]
    async fn the_managed_serve_launches_with_opencode_snapshots_disabled() {
        let _env_guard = config_env_lock().await;
        let scrubbed = scrub_config_env();

        let spawner = Arc::new(CapturingSpawner {
            requests: Mutex::new(Vec::new()),
        });
        let deps = ServeDeps {
            spawner: spawner.clone(),
            http: Arc::new(RecordingHttp::new()),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let mgr = OpencodeServeManager::new(deps, ServeConfig::default());
        mgr.ensure_started()
            .await
            .expect("healthy fake serve starts");

        let requests = spawner.requests.lock().expect("spawns mutex");
        assert_eq!(requests.len(), 1, "exactly one sidecar spawn");
        let entry = requests[0]
            .env
            .iter()
            .find(|(key, _)| key == OPENCODE_CONFIG_CONTENT_ENV)
            .expect("the managed serve carries OPENCODE_CONFIG_CONTENT");
        assert_eq!(
            entry.1, OPENCODE_SNAPSHOTS_DISABLED_CONFIG,
            "the managed config is exactly the snapshots-disabled document"
        );
        let parsed: Value =
            serde_json::from_str(&entry.1).expect("the managed config is valid JSON");
        assert_eq!(parsed, serde_json::json!({ "snapshot": false }));
        drop(scrubbed);
    }

    // ── delta-r1 F3: the managed config MERGE (never destroys inherited values) ──

    /// Serialize env mutation for the config-env probes (parallel tests share the
    /// process env; the scrubbers below mutate it). A TOKIO mutex: the guard is
    /// held across the spawn-level tests' `.await points.
    async fn config_env_lock() -> tokio::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
            .lock()
            .await
    }

    /// Remove the process-inherited `OPENCODE_CONFIG_CONTENT` for the duration of
    /// a default-path test; restore on drop.
    fn scrub_config_env() -> impl Drop {
        struct Restore(Option<String>);
        impl Drop for Restore {
            fn drop(&mut self) {
                match self.0.take() {
                    Some(v) => std::env::set_var(OPENCODE_CONFIG_CONTENT_ENV, v),
                    None => std::env::remove_var(OPENCODE_CONFIG_CONTENT_ENV),
                }
            }
        }
        let prior = std::env::var(OPENCODE_CONFIG_CONTENT_ENV).ok();
        std::env::remove_var(OPENCODE_CONFIG_CONTENT_ENV);
        Restore(prior)
    }

    #[test]
    fn merged_config_absent_writes_the_bare_pin_document() {
        assert_eq!(
            merged_opencode_config_content(None),
            OPENCODE_SNAPSHOTS_DISABLED_CONFIG
        );
        // An empty inherited value merges as absent, never a malformed warning.
        assert_eq!(
            merged_opencode_config_content(Some("")),
            OPENCODE_SNAPSHOTS_DISABLED_CONFIG
        );
    }

    #[test]
    fn merged_config_merges_into_an_inherited_object_and_forces_the_pin() {
        let user =
            r#"{"plugin":["file:///home/me/plugin.ts"],"model":"openai/gpt-5","theme":"dark"}"#;
        let parsed: Value = serde_json::from_str(&merged_opencode_config_content(Some(user)))
            .expect("merged is valid JSON");
        assert_eq!(
            parsed,
            serde_json::json!({
                "plugin": ["file:///home/me/plugin.ts"],
                "model": "openai/gpt-5",
                "theme": "dark",
                "snapshot": false,
            }),
            "sibling keys preserved; the snapshots pin is forced in"
        );
        // A user-supplied top-level `snapshot` NEVER wins — the rollback decision
        // pins it (that is the point of the managed lane).
        let overridden: Value = serde_json::from_str(&merged_opencode_config_content(Some(
            r#"{"snapshot":true,"autoupdate":false}"#,
        )))
        .expect("merged is valid JSON");
        assert_eq!(
            overridden,
            serde_json::json!({ "snapshot": false, "autoupdate": false })
        );
    }

    /// tracing capture facility (the freshell-freshagent DIAG-01 idiom):
    /// thread-local, for the synchronous warn inside the merge helper.
    mod config_capture {
        use std::collections::BTreeMap;
        use std::sync::{Arc, Mutex};
        use tracing::field::{Field, Visit};
        use tracing::{Event, Subscriber};
        use tracing_subscriber::layer::{Context, SubscriberExt};
        use tracing_subscriber::Layer;

        struct Visitor {
            fields: BTreeMap<String, String>,
        }
        impl Visit for Visitor {
            fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
                self.fields
                    .insert(field.name().to_string(), format!("{value:?}"));
            }
            fn record_str(&mut self, field: &Field, value: &str) {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }
        }

        /// The capture target: one `BTreeMap<field, value>` per traced event.
        type CapturedEvents = Arc<Mutex<Vec<BTreeMap<String, String>>>>;

        struct CaptureLayer {
            events: CapturedEvents,
        }
        impl<S: Subscriber> Layer<S> for CaptureLayer {
            fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
                let mut visitor = Visitor {
                    fields: BTreeMap::new(),
                };
                event.record(&mut visitor);
                self.events
                    .lock()
                    .expect("capture lock")
                    .push(visitor.fields);
            }
        }

        /// Thread-local capture (the helper under test emits synchronously on
        /// the calling thread — no spawned tasks cross here).
        pub fn capture() -> (CapturedEvents, tracing::subscriber::DefaultGuard) {
            let events = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer {
                events: Arc::clone(&events),
            };
            let subscriber = tracing_subscriber::registry().with(layer);
            (events, tracing::subscriber::set_default(subscriber))
        }
    }

    /// Focused-review ep1-r2 F5 (log hygiene): the malformed-inline-config
    /// warning must never copy user config into persistent logs — an inline
    /// OpenCode document can carry credential-shaped fields (API keys,
    /// authorization headers), and a truncated/malformed secret-bearing value
    /// would otherwise leak. The warn names ONLY the replaced value's byte
    /// length; NO substring of the content appears in any traced field.
    #[test]
    fn merged_config_malformed_is_replaced_with_a_content_free_length_only_warning() {
        let (events, _guard) = config_capture::capture();
        let malformed = "not-json-at-all{ this is longer than twenty four chars }";
        let replaced = merged_opencode_config_content(Some(malformed));
        assert_eq!(replaced, OPENCODE_SNAPSHOTS_DISABLED_CONFIG);
        let events = events.lock().expect("capture lock");
        let warn = events
            .iter()
            .find(|fields| {
                fields.get("message").map(String::as_str)
                    == Some("freshell_opencode.config_content.malformed_inline_config_replaced")
            })
            .expect("a malformed inline config warns loudly");
        assert_eq!(
            warn.get("replaced_value_bytes_len")
                .cloned()
                .unwrap_or_default(),
            malformed.len().to_string(),
            "the warning names ONLY the replaced value's byte length: {warn:?}"
        );
        for (field, value) in warn.iter() {
            for n in [8usize, 16, 24, malformed.len()] {
                let needle = &malformed[..n.min(malformed.len())];
                assert!(
                    !value.contains(needle),
                    "no content substring ({needle:?}) may appear in any traced field ({field}={value:?})"
                );
            }
        }
    }

    // ── focused ep1-r4 F1: OpenCode (v1.18.21) parses OPENCODE_CONFIG_CONTENT
    //    with a JSONC parser (// and /* */ comments, trailing commas) — the merge
    //    must accept the same dialect, never replace valid inline config ──────

    #[test]
    fn jsonc_normalization_strips_comments_string_literal_aware() {
        // Line comments end AT the newline; block comments end at the closer.
        assert_eq!(
            jsonc_to_strict_json("{\"a\":1}//note\n{\"b\":2}"),
            "{\"a\":1} \n{\"b\":2}"
        );
        assert_eq!(
            jsonc_to_strict_json("{/* head */\"a\": /* inline */ 1}"),
            "{ \"a\":   1}"
        );
        // A removed comment leaves ONE space — adjacent tokens are NEVER fused.
        assert_eq!(jsonc_to_strict_json("1/**/2"), "1 2");
        // An UNTERMINATED block comment keeps its tail VERBATIM (ep2-r4: the
        // parser OpenCode actually uses raises a lexical error there — stripping
        // to EOF could leave a VALID strict document ("{"a":1}/* dangling" →
        // "{"a":1} "), silently accepting malformed JSONC into the merge).
        let verbatim = jsonc_to_strict_json("{\"a\":1}/* dangling");
        assert_eq!(verbatim, "{\"a\":1} /* dangling");
        assert!(
            serde_json::from_str::<serde_json::Value>(&verbatim).is_err(),
            "the unterminated document stays INVALID for the strict parse: {verbatim:?}"
        );
        // Comment OPENERS INSIDE string literals survive verbatim (a URL's "//"
        // is data, never a comment).
        assert_eq!(
            jsonc_to_strict_json("{\"u\":\"https://x//y\",\"s\":\"/* not a comment */\"}"),
            "{\"u\":\"https://x//y\",\"s\":\"/* not a comment */\"}"
        );
        // An escaped quote does NOT close the string — the trailing // stays
        // string content.
        assert_eq!(
            jsonc_to_strict_json("{\"s\":\"a\\\"//b\"}"),
            "{\"s\":\"a\\\"//b\"}"
        );
    }

    #[test]
    fn jsonc_normalization_drops_trailing_commas_string_literal_aware() {
        assert_eq!(
            jsonc_to_strict_json("{\"a\":[1,2,],\"b\":2,}"),
            "{\"a\":[1,2],\"b\":2}"
        );
        // A comma separated from the closer by a (now-stripped) comment/ws drops.
        assert_eq!(jsonc_to_strict_json("{\"a\":1, /* x */ }"), "{\"a\":1   }");
        // ",}" / ",]" sequences INSIDE strings are data — never stripped.
        assert_eq!(
            jsonc_to_strict_json("{\"s\":\"a,}b,]c\",\"t\":1,}"),
            "{\"s\":\"a,}b,]c\",\"t\":1}"
        );
        // A REAL content comma is kept (only a comma directly before a closer drops).
        assert_eq!(
            jsonc_to_strict_json("{\"a\":1,\"b\":2}"),
            "{\"a\":1,\"b\":2}"
        );
    }

    #[test]
    fn merged_config_parses_jsonc_and_preserves_every_user_key_verbatim() {
        let user = r#"{
            // the provider pin — credential-shaped fields legitimately ride this lane
            "provider": {
                "dev": {
                    "models": { "m-x": { "name": "M X" } },
                    "options": {
                        "apiKey": "sk-test-only",
                        "headers": { "X-Api-Key": "hdr-test-only", "Authorization": "Bearer t" }
                    }
                }
            },
            "model": "dev/m-x",
            "plugin": [
                "https://plugins.example/p.js", // a quoted URL carries "//" — data, never a comment
            ],
            "log": "https://logs.example/tail", /* a block comment before the closer */
            "snapshot": true,
        }"#;
        let merged: Value = serde_json::from_str(&merged_opencode_config_content(Some(user)))
            .expect("the merged document is valid strict JSON");
        assert_eq!(
            merged,
            serde_json::json!({
                "provider": { "dev": {
                    "models": { "m-x": { "name": "M X" } },
                    "options": {
                        "apiKey": "sk-test-only",
                        "headers": { "X-Api-Key": "hdr-test-only", "Authorization": "Bearer t" }
                    },
                }},
                "model": "dev/m-x",
                "plugin": ["https://plugins.example/p.js"],
                "log": "https://logs.example/tail",
                "snapshot": false,
            }),
            "JSONC object ⇒ merged preserving ALL user keys verbatim (incl. models/apiKey/headers \
             and comment-containing strings); the snapshot:false pin still wins over the user key"
        );
    }

    /// Focused ep1-r4 F1: a VALID JSONC document never enters the malformed
    /// branch — the content-free warning fires ONLY for genuinely unparseable
    /// input (below).
    #[test]
    fn merged_config_valid_jsonc_never_emits_the_malformed_warning() {
        let (events, _guard) = config_capture::capture();
        let jsonc = "{\n  // line comment\n  \"share\": \"disabled\", /* block */\n  \"autoupdate\": false,\n}";
        let merged: Value = serde_json::from_str(&merged_opencode_config_content(Some(jsonc)))
            .expect("the merged document is valid strict JSON");
        assert_eq!(
            merged,
            serde_json::json!({ "share": "disabled", "autoupdate": false, "snapshot": false })
        );
        let events = events.lock().expect("capture lock");
        assert!(
            events.iter().all(|fields| {
                fields.get("message").map(String::as_str)
                    != Some("freshell_opencode.config_content.malformed_inline_config_replaced")
            }),
            "valid JSONC never warns: {events:?}"
        );
    }

    /// A document unparseable even AFTER comment/trailing-comma normalization
    /// keeps the existing content-free replace+warn behavior (F5 unchanged).
    #[test]
    fn merged_config_unparseable_after_jsonc_normalization_still_warns_content_free() {
        let (events, _guard) = config_capture::capture();
        let malformed = "{ \"model\": , // no value\n }";
        let replaced = merged_opencode_config_content(Some(malformed));
        assert_eq!(replaced, OPENCODE_SNAPSHOTS_DISABLED_CONFIG);
        let events = events.lock().expect("capture lock");
        let warn = events
            .iter()
            .find(|fields| {
                fields.get("message").map(String::as_str)
                    == Some("freshell_opencode.config_content.malformed_inline_config_replaced")
            })
            .expect("a genuinely unparseable document still warns loudly");
        assert_eq!(
            warn.get("replaced_value_bytes_len")
                .cloned()
                .unwrap_or_default(),
            malformed.len().to_string(),
            "length-only, content-free (F5): {warn:?}"
        );
        assert!(
            warn.values().all(|v| !v.contains("model")),
            "no content substring survives into the warning: {warn:?}"
        );
    }

    /// Focused ep2-r1 F3: `jsonc-parser` (the parser OpenCode's 1.18.21
    /// `ConfigParse.jsonc` actually uses) ends `//` line comments at LF **or
    /// bare CR** (microsoft/node-jsonc-parser scanner) — the normalizer must
    /// match, or a valid CR-only inline config loses everything after its
    /// first comment (→ strict-parse miss → content-free replace, silently
    /// dropping model/plugin/auth settings).
    #[test]
    fn jsonc_normalization_line_comments_end_at_lf_or_bare_cr() {
        // LF (baseline, already covered) and CR both terminate; the terminator
        // itself stays as document whitespace.
        assert_eq!(
            jsonc_to_strict_json("{\"a\":1}//x\n{\"b\":2}"),
            "{\"a\":1} \n{\"b\":2}"
        );
        assert_eq!(
            jsonc_to_strict_json("{\"a\":1}//x\r{\"b\":2}"),
            "{\"a\":1} \r{\"b\":2}"
        );
        // CRLF terminates at the CR (the \n that follows is plain whitespace).
        assert_eq!(
            jsonc_to_strict_json("{\"a\":1}//note\r\n{\"b\":2}"),
            "{\"a\":1} \r\n{\"b\":2}"
        );
        // The full valid document on bare-CR line endings merges — never the
        // malformed branch.
        let cr_only = "{\r  // provider pin\r  \"model\": \"dev/m-x\",\r}\r";
        let merged: Value = serde_json::from_str(&merged_opencode_config_content(Some(cr_only)))
            .expect("CR-only JSONC is valid after normalization");
        assert_eq!(
            merged,
            serde_json::json!({ "model": "dev/m-x", "snapshot": false })
        );
    }

    /// A non-object JSON value can't take a top-level pin either — same
    /// replace+warn, content-free (F5).
    #[test]
    fn merged_config_json_scalars_and_arrays_are_replaced_with_the_warning() {
        let (events, _guard) = config_capture::capture();
        let scalar = r#"["plugin-x"]"#;
        assert_eq!(
            merged_opencode_config_content(Some(scalar)),
            OPENCODE_SNAPSHOTS_DISABLED_CONFIG
        );
        let events = events.lock().expect("capture lock");
        assert_eq!(events.len(), 1, "one warn per replaced malformed value");
        assert_eq!(
            events[0]
                .get("replaced_value_bytes_len")
                .cloned()
                .unwrap_or_default(),
            scalar.len().to_string(),
        );
        assert!(
            events[0].values().all(|v| !v.contains("plugin-x")),
            "no content substring survives into the warning: {:?}",
            events[0]
        );
    }

    /// Spawn-level: a config-supplied inline document is MERGED into the launch
    /// (sibling keys survive, snapshot pinned), never replaced — and the spawn env
    /// carries EXACTLY ONE occurrence (the merged value).
    #[tokio::test]
    async fn the_managed_serve_merges_a_config_supplied_inline_document() {
        let _env_guard = config_env_lock().await;
        let scrubbed = scrub_config_env();
        let spawner = Arc::new(CapturingSpawner {
            requests: Mutex::new(Vec::new()),
        });
        let deps = ServeDeps {
            spawner: spawner.clone(),
            http: Arc::new(RecordingHttp::new()),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let config = ServeConfig {
            env: vec![(
                OPENCODE_CONFIG_CONTENT_ENV.to_string(),
                r#"{"plugin":["file:///p.ts"],"provider":{"x":{"models":{}}}}"#.to_string(),
            )],
            ..ServeConfig::default()
        };
        let mgr = OpencodeServeManager::new(deps, config);
        mgr.ensure_started()
            .await
            .expect("healthy fake serve starts");
        drop(scrubbed);

        let requests = spawner.requests.lock().expect("spawns mutex");
        assert_eq!(requests.len(), 1, "exactly one sidecar spawn");
        let occurrences: Vec<&String> = requests[0]
            .env
            .iter()
            .filter(|(key, _)| key == OPENCODE_CONFIG_CONTENT_ENV)
            .map(|(_, v)| v)
            .collect();
        assert_eq!(
            occurrences.len(),
            1,
            "exactly one OPENCODE_CONFIG_CONTENT entry — the MERGED value"
        );
        let parsed: Value = serde_json::from_str(occurrences[0]).expect("valid JSON");
        assert_eq!(
            parsed,
            serde_json::json!({
                "plugin": ["file:///p.ts"],
                "provider": { "x": { "models": {} } },
                "snapshot": false,
            })
        );
    }

    /// Spawn-level: the PROCESS-inherited value merges the same way (the launch
    /// environment is the lane the finding names — a freshell server running
    /// WITH OPENCODE_CONFIG_CONTENT exports it to the managed serve).
    #[tokio::test]
    async fn the_managed_serve_merges_the_process_inherited_inline_document() {
        let _env_guard = config_env_lock().await;
        std::env::set_var(OPENCODE_CONFIG_CONTENT_ENV, r#"{"share":"disabled"}"#);
        let _scrubbed = DeferUnset;
        struct DeferUnset;
        impl Drop for DeferUnset {
            fn drop(&mut self) {
                std::env::remove_var(OPENCODE_CONFIG_CONTENT_ENV);
            }
        }

        let spawner = Arc::new(CapturingSpawner {
            requests: Mutex::new(Vec::new()),
        });
        let deps = ServeDeps {
            spawner: spawner.clone(),
            http: Arc::new(RecordingHttp::new()),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        OpencodeServeManager::new(deps, ServeConfig::default())
            .ensure_started()
            .await
            .expect("healthy fake serve starts");

        let requests = spawner.requests.lock().expect("spawns mutex");
        let entry = requests[0]
            .env
            .iter()
            .find(|(key, _)| key == OPENCODE_CONFIG_CONTENT_ENV)
            .expect("the managed serve carries OPENCODE_CONFIG_CONTENT");
        let parsed: Value = serde_json::from_str(&entry.1).expect("valid JSON");
        assert_eq!(
            parsed,
            serde_json::json!({ "share": "disabled", "snapshot": false }),
            "the inherited document survives; the pin merges in"
        );
    }
}
