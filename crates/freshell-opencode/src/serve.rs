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
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
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

/// Merge the snapshots pin into valid user JSONC. Refuse malformed input
/// before starting the shared serve; the error never includes source bytes.
pub fn merged_opencode_config_content(inherited: Option<&str>) -> Result<String, ServeError> {
    let Some(raw) = inherited.filter(|raw| !raw.is_empty()) else {
        return Ok(OPENCODE_SNAPSHOTS_DISABLED_CONFIG.to_string());
    };
    freshell_platform::opencode_config::merge_owned_entries(
        Some(raw),
        &freshell_platform::opencode_config::OpencodeConfigPlan {
            sources: Vec::new(),
            user_owns_freshell_mcp: false,
        },
        &freshell_platform::opencode_config::OwnedConfigEdits {
            disable_snapshots: true,
            ..Default::default()
        },
    )
    .map_err(|_| ServeError::InvalidConfig)
}

/// A boxed, `Send` future — the object-safe async return used by the injected IO
/// traits (keeps them `dyn`-compatible without an `async-trait` dependency).
pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

// ── injected IO seams (fetchFn / spawnFn / allocatePort / connectEventStream) ────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HttpMethod {
    Get,
    Post,
    /// Unified agent names (Task 3): `PATCH /session/:id` — the supported
    /// `update_session_title` route.
    Patch,
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
    /// Task 3 native names: a JSON PATCH request.
    pub fn patch_json(url: impl Into<String>, body: Vec<u8>) -> Self {
        Self {
            method: HttpMethod::Patch,
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

/// Render `err` plus every `source()` in its chain, `"; caused by: "`-joined.
///
/// A bare `to_string()` drops diagnostics that identify a transport failure's
/// root cause, so keep the complete error chain in logs and user-facing errors.
pub fn display_error_chain(err: &(dyn std::error::Error + 'static)) -> String {
    let mut rendered = err.to_string();
    let mut source = err.source();
    while let Some(cause) = source {
        rendered.push_str("; caused by: ");
        rendered.push_str(&cause.to_string());
        source = cause.source();
    }
    rendered
}

/// Whether a timed-out request over a captured base may discard the running
/// `opencode serve` sidecar. Read-only calls pass `No` so a slow GET never
/// kills the shared daemon.
mod discard_on_timeout {
    #[derive(Clone, Copy, PartialEq, Eq)]
    pub enum DiscardOnTimeout {
        Yes,
        No,
    }
}
use discard_on_timeout::DiscardOnTimeout;

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
    InvalidConfig,
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
            ServeError::InvalidConfig => write!(f, "OpenCode inline config contains malformed JSONC or is not an object"),
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
                | ServeError::InvalidConfig
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
    /// Per-request timeout for the compact/summarize POST — the ONLY serve call
    /// whose handler runs a full LLM summarization before answering. A real
    /// session's summarize routinely exceeds the generic 30 s bound (the
    /// 2026-09-11 compact incident + its 2026-09-14 recurrence both timed out
    /// there, surfacing as `OPENCODE_COMPACT_FAILED` "operation timed out"
    /// banners), so compact gets its own LLM-scale budget — aligned with the
    /// 600 s opencode turn budget that also bounds the compact's await-idle
    /// tail (`opencode_ws.rs`'s `DEFAULT_TURN_TIMEOUT`).
    pub compact_timeout: Duration,
    /// Daemon exit-watcher poll cadence (`Task 3`): how often the running
    /// daemon's `exited()` is consulted between request traffic.
    pub daemon_watch_interval: Duration,
    /// Re-warm backoff: the initial delay before the first respawn attempt
    /// after a daemon loss, doubling per failed attempt, capped at
    /// [`ServeConfig::re_warm_backoff_max_ms`].
    pub re_warm_backoff_initial_ms: u64,
    /// Re-warm backoff ceiling: the escalation stops here (a crash-looping
    /// daemon retries at this interval forever — it self-heals when e.g.
    /// disk frees).
    pub re_warm_backoff_max_ms: u64,
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
            compact_timeout: Duration::from_millis(600_000),
            daemon_watch_interval: Duration::from_millis(1_000),
            re_warm_backoff_initial_ms: 2_000,
            re_warm_backoff_max_ms: 60_000,
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

/// The daemon-level channel capacity for [`DaemonSignal`] broadcasts.
const DAEMON_CHANNEL_CAPACITY: usize = 16;

/// A daemon-lifecycle edge broadcast by the manager (the client-facing
/// runtime's Task-4 revival design consumes this): `Lost` when the shared
/// daemon is gone (a requested discard with its reason, or an unrequested
/// process exit), `Started` on every successful COLD start (not on the
/// fast-path return of an already-running daemon).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DaemonSignal {
    /// The running daemon is gone. `reason` is the loss class: `"process_exit"`
    /// for an unrequested exit, the discard's reason (e.g. `"request_timeout"`)
    /// for a requested kill.
    Lost { reason: &'static str },
    /// A previously-lost (or never-started) daemon completed a cold start and
    /// is healthy again.
    Started,
}

/// Which loss arm is running the shared exactly-once path
/// ([`OpencodeServeManager::lose_daemon`]).
enum LossArm<'a> {
    /// The exit watcher observed an unrequested process exit. `ownership_id`
    /// gates staleness (a watcher for a superseded daemon must not run the
    /// loss path on its successor); `base_url` rides the crash WARN.
    Watcher {
        base_url: &'a str,
        ownership_id: &'a str,
    },
    /// A requested discard (kill). `dispatched_base` is the base URL the
    /// timed-out request was actually sent to — the discard takes+kills
    /// ONLY the daemon at that base; a STALE timeout (its daemon already
    /// lost, a replacement owns the entry) no-ops with the same silence as
    /// a `None` take, never killing the innocent replacement. The watcher
    /// is aborted first (a requested kill never raises the crash event);
    /// `reason` names the discard cause and rides both the WARN and the
    /// `Lost` signal.
    Discard {
        reason: &'static str,
        dispatched_base: &'a str,
    },
}

struct RunningServe {
    base_url: String,
    /// The shared daemon handle. `Arc` (LB-06): the exit watcher keeps a clone
    /// that outlives this entry — the watcher polls ITS Arc, the entry keeps
    /// its own, nothing is moved out.
    process: Arc<dyn ServeProcess>,
    /// THIS daemon's spawn identity: the stale-watcher gate (a watcher for a
    /// superseded daemon must not run the loss path on its successor).
    ownership_id: String,
    _event_handle: Box<dyn EventStreamHandle>,
    /// The exit watcher's abort handle — aborted on the requested-loss paths
    /// (discard/shutdown) so a killed daemon never raises the crash event.
    _exit_watch: Option<tokio::task::AbortHandle>,
}

struct Inner {
    deps: ServeDeps,
    config: ServeConfig,
    shutdown: AtomicBool,
    running: tokio::sync::Mutex<Option<Arc<RunningServe>>>,
    session_emitters: Mutex<HashMap<String, broadcast::Sender<SessionSignal>>>,
    daemon_signals: broadcast::Sender<DaemonSignal>,
    /// The re-warm backoff's attempt counter: incremented per re-warm attempt
    /// and reset when a loss is a FRESH incident (see
    /// [`OpencodeServeManager::schedule_re_warm`]) — each new incident starts
    /// at the initial delay while a crash-looping daemon still escalates to
    /// and retries at the capped interval.
    re_warm_attempts: AtomicUsize,
    /// The DISPATCH ERA (ep2-r2 fresheyes Major — cross-generation event
    /// contamination; HARDENED ep2-r3 — the check-to-dispatch TOCTOU): a
    /// monotonic counter retired (incremented) by every running-entry TAKE
    /// under the `running` lock — the two `lose_daemon` arms and `shutdown`.
    /// Each daemon's dispatch sink captures the era at its connect (inside
    /// the cold-start critical section, so no take can interleave) and
    /// [`dispatch_event_on_era`] re-verifies it UNDER the `session_emitters`
    /// mutex, atomically with sender-selection + send: no event originating
    /// from a daemon whose loss has been taken can dispatch into the
    /// successor era, even when the sink's fast-path check passed before a
    /// preemption straddled the take.
    event_era: AtomicU64,
    /// ep2-r3 test seam (`cfg(test)`-only): when armed, the dispatch sink
    /// parks AFTER passing its era check and BEFORE dispatching — the exact
    /// preempted-callback window the ep2-r3 fresheyes Major pins (a check
    /// that is not atomic with dispatch can pass, be preempted, and then
    /// deliver into a successor era's registration). Never compiled into
    /// production builds. See
    /// [`OpencodeServeManager::arm_dispatch_park_for_tests`].
    #[cfg(test)]
    test_dispatch_park: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    /// When the running daemon completed its (healthy) cold start — the
    /// fresh-incident clock for the re-warm backoff.
    last_cold_start_at: Mutex<Option<Instant>>,
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
                daemon_signals: broadcast::Sender::new(DAEMON_CHANNEL_CAPACITY),
                re_warm_attempts: AtomicUsize::new(0),
                event_era: AtomicU64::new(0),
                #[cfg(test)]
                test_dispatch_park: Mutex::new(None),
                last_cold_start_at: Mutex::new(None),
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

    /// The CURRENT running daemon's spawn identity: the `ownership_id`
    /// minted at its cold start — unique per daemon GENERATION, stable
    /// across `ensure_started` fast paths, `None` while no daemon runs.
    /// The freshopencode runtime's daemon-generation fence (Task 4 delta
    /// round 2): a session bridge stamped with any other id was spawned
    /// against a SUPERSEDED daemon and is dead for revival purposes even
    /// while its task is still draining.
    pub async fn ownership_id(&self) -> Option<String> {
        self.inner
            .running
            .lock()
            .await
            .as_ref()
            .map(|r| r.ownership_id.clone())
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
            merged_opencode_config_content(inherited.as_deref())?,
        ));
        let process: Arc<dyn ServeProcess> = self
            .inner
            .deps
            .spawner
            .spawn(SpawnRequest {
                command: self.config().command.clone(),
                hostname: endpoint.hostname.clone(),
                port: endpoint.port,
                ownership_id: ownership_id.clone(),
                env,
                pure: false,
                cwd: None,
            })
            .map_err(ServeError::Spawn)?
            .into();

        if let Err(e) = self.wait_for_health(&base_url, process.as_ref()).await {
            process.kill();
            return Err(e);
        }

        // Arm the exit watcher BEFORE storing the entry — the spawn is
        // synchronous (the guard is never held across an await here) and the
        // watcher's first action is a sleep, so by the time it first consults
        // `exited()` the entry is stored; its loss path still re-verifies
        // ownership, so a store-visibility race can only no-op, never mis-fire.
        let watch =
            self.spawn_exit_watch(base_url.clone(), Arc::clone(&process), ownership_id.clone());
        let sink = self.make_dispatch_sink();
        let handle = self
            .inner
            .deps
            .events
            .connect(format!("{base_url}/global/event"), sink);

        *guard = Some(Arc::new(RunningServe {
            base_url: base_url.clone(),
            process,
            ownership_id,
            _event_handle: handle,
            _exit_watch: Some(watch),
        }));
        // The fresh-incident clock for the re-warm backoff: this daemon's
        // healthy-service lifetime starts now.
        *self
            .inner
            .last_cold_start_at
            .lock()
            .expect("cold-start clock mutex") = Some(Instant::now());
        // COLD-start edge only — the fast path above (already running) never
        // re-broadcasts this.
        let _ = self.inner.daemon_signals.send(DaemonSignal::Started);
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

    /// The per-connection dispatch sink, ERA-GATED (ep2-r2 fresheyes Major —
    /// cross-generation event contamination; HARDENED ep2-r3 — the
    /// check-to-dispatch TOCTOU): the sink captures the CURRENT
    /// [`Inner::event_era`] at its daemon's connect (called from
    /// `ensure_started` inside the cold-start `running` critical section,
    /// so no take can interleave with the capture) and hands it to
    /// [`dispatch_event_on_era`], which re-verifies the era UNDER the
    /// `session_emitters` mutex, atomically with selection+send. The
    /// load-compare here is only the CHEAP FAST PATH (the common
    /// already-retired case drops without touching the emitter map) — it
    /// is NOT the fence: an event that passes it can still be preempted
    /// before dispatch, and only the under-lock re-verification stops a
    /// stale event from reaching a successor-era registration after its
    /// era was retired, its emitters swept, and the successor registered a
    /// replacement sender. Every daemon removal is a TAKE under that same
    /// `running` lock (`lose_daemon`'s two arms, `shutdown`), each take
    /// retires the era via [`Self::retire_event_era`] BEFORE its sweep
    /// claims the emitter mutex — so by construction NO event originating
    /// from a daemon whose loss has been taken can dispatch into the
    /// successor era: a buffered/late `session.idle` from the lost
    /// generation can never satisfy the successor's `await_idle` (the
    /// false `freshAgent.turn.complete` the no-chime-on-loss contract
    /// forbids), and no other late event can contaminate a successor-era
    /// bridge. The authoritative gate lives at DISPATCH — under the
    /// emitter mutex — because dropping the [`EventStreamHandle`] only
    /// ABORTS the transport's reader task (`SseHandle`'s drop), and a
    /// check that is not atomic with dispatch can be preempted past both.
    fn make_dispatch_sink(&self) -> EventSink {
        let weak = Arc::downgrade(&self.inner);
        let era = self.inner.event_era.load(Ordering::Acquire);
        Arc::new(move |event: ParsedServeEvent| {
            let Some(inner) = weak.upgrade() else {
                return;
            };
            if inner.event_era.load(Ordering::Acquire) != era {
                // A superseded generation's late/buffered event: dropped at
                // the gate, never reaching the successor era's emitters.
                return;
            }
            // ep2-r3 test seam (`cfg(test)`-only): hold the callback in the
            // exact window the fresheyes finding names — the era check has
            // PASSED and the dispatch has not yet run — so a test can
            // retire the era and register a successor-era sender while this
            // callback is parked. See
            // [`Self::arm_dispatch_park_for_tests`].
            #[cfg(test)]
            if let Some(park) = inner
                .test_dispatch_park
                .lock()
                .expect("test dispatch park mutex")
                .clone()
            {
                park();
            }
            dispatch_event_on_era(&inner, event, Some(era));
        })
    }

    /// Arm or clear the `cfg(test)`-only dispatch park (ep2-r3): the armed
    /// closure is invoked by every dispatch sink AFTER passing its era
    /// check and BEFORE dispatching, so a test can hold an in-flight
    /// callback while it retires the era (a daemon loss take) and
    /// registers a successor-era sender — the preempted-callback
    /// interleaving the era verification's dispatch-time atomicity must
    /// survive. Production builds never see the seam.
    #[cfg(test)]
    pub(crate) fn arm_dispatch_park_for_tests(&self, park: Option<Arc<dyn Fn() + Send + Sync>>) {
        *self
            .inner
            .test_dispatch_park
            .lock()
            .expect("test dispatch park mutex") = park;
    }

    /// Retire the current dispatch era — the take-side half of the era gate
    /// ([`Self::make_dispatch_sink`]). Called ONLY while the `running` lock
    /// is held for a take (the two `lose_daemon` arms, `shutdown`): from
    /// this moment no event from the daemon being taken can dispatch into
    /// the session-emitter map, whatever its SSE connection still buffers —
    /// a successor era's emitters can never be contaminated by the lost
    /// generation, and a successor (which can only cold-start after the
    /// lock releases) always connects a strictly newer era.
    fn retire_event_era(&self) {
        self.inner.event_era.fetch_add(1, Ordering::Release);
    }

    /// Spawn the daemon exit watcher for one cold-started daemon (Task 3,
    /// the shared-daemon adaptation of the freshcodex onExit self-heal): poll
    /// the SHARED process Arc's `exited()` every `daemon_watch_interval`; on
    /// `Some` run the staleness-gated loss path and end. The manager clone is
    /// cheap (`Arc`-backed); the process Arc and ownership id move in with
    /// the task — the running entry keeps its own Arc (LB-06: share, never
    /// move the daemon out of the entry).
    fn spawn_exit_watch(
        &self,
        base_url: String,
        process: Arc<dyn ServeProcess>,
        ownership_id: String,
    ) -> tokio::task::AbortHandle {
        let manager = self.clone();
        let interval = self.config().daemon_watch_interval;
        let handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(interval).await;
                if process.exited().is_some() {
                    manager
                        .lose_daemon(LossArm::Watcher {
                            base_url: &base_url,
                            ownership_id: &ownership_id,
                        })
                        .await;
                    return;
                }
            }
        });
        handle.abort_handle()
    }

    /// The shared exactly-once daemon-loss path: a daemon that died on its own
    /// (the watcher arm) or was discarded (the requested-kill arm) must not
    /// leave a poisoned running entry (the 2026-09-20 incident's silent
    /// half). **Exactly-once (LB-07):** the running-entry take is the race
    /// arbiter — a `None` take means the other arm already handled this loss,
    /// and the whole path is a silent no-op: no log, no Lost, no re-warm. The
    /// arm selects the pre-take gate and the structured WARN (a requested kill
    /// never raises the crash event; a watcher's WARN names the dead daemon).
    ///
    /// **Sweep fencing (ep2-r1 fresheyes Major):** the session-emitter sweep
    /// is part of the SAME `running` critical section as the take, BEFORE the
    /// lock releases. A successor daemon cannot cold-start while this lock is
    /// held (`ensure_started` needs it), so every sender claimed by the sweep
    /// was necessarily registered against the daemon being lost (or against
    /// no daemon at all — an in-flight `once_idle` whose request was going to
    /// fail anyway); any registration that happens after the release belongs
    /// to a SUCCESSOR and is never swept by this loss. Pre-fix, the sweep ran
    /// after the lock release (kill/reap → `emit_lost_for_all`), so a fenced
    /// attach that cold-started daemon B in that window had B's fresh bridge
    /// sender wiped by A's late cleanup — B's bridge then drained its closed
    /// channel and exited with no recovery trigger left (B's `Started` pass
    /// had already seen a live B-stamped bridge, the `Lost` pass never
    /// revives, and A's re-warm takes B's fast path silently) — the exact
    /// dead-ended pane this recovery exists to heal.
    ///
    /// **Era retirement (ep2-r2 fresheyes Major):** the take also retires
    /// the lost daemon's DISPATCH ERA inside the same critical section
    /// ([`Self::retire_event_era`]) — the taken daemon's event sink drops
    /// every event from this moment on, so a buffered/late event from the
    /// lost generation can never dispatch into the successor era's
    /// emitters (the cross-generation `session.idle` that would falsely
    /// satisfy a successor's `await_idle` and produce a chime). See
    /// [`Self::make_dispatch_sink`].
    async fn lose_daemon(&self, arm: LossArm<'_>) {
        let (taken, lost_senders) = {
            let mut running = self.inner.running.lock().await;
            match arm {
                LossArm::Watcher {
                    base_url: _,
                    ownership_id,
                } => match running.as_ref() {
                    // Still OUR daemon: retire its dispatch era, take it
                    // (the loss is ours to handle) and sweep the shared
                    // session-emitter map while no successor can be
                    // starting.
                    Some(r) if r.ownership_id == ownership_id => {
                        self.retire_event_era();
                        let senders = self.take_session_emitters();
                        (running.take(), senders)
                    }
                    // Stale watcher — a newer daemon owns the entry: no-op.
                    _ => return,
                },
                LossArm::Discard {
                    reason: _,
                    dispatched_base,
                } => match running.as_ref() {
                    // The wedged request's OWN daemon: abort the watcher
                    // FIRST (inside the lock, before the take and the
                    // WARN/kill sequence) — the requested kill must never
                    // raise the crash event. After the take the watcher can
                    // never win its own take; if it already won, our take
                    // below is the silent no-op.
                    Some(r) if r.base_url == dispatched_base => {
                        if let Some(watch) = &r._exit_watch {
                            watch.abort();
                        }
                        // The take retires the taken daemon's dispatch era
                        // under the same lock (the era-gate invariant).
                        self.retire_event_era();
                        let senders = self.take_session_emitters();
                        (running.take(), senders)
                    }
                    // Stale timeout — the request's daemon is already gone
                    // and a replacement owns the entry: no-op (no kill, no
                    // log, no Lost, no re-warm), the same silence as a
                    // `None` take. The gate is the base URL captured at
                    // dispatch — the exact address the wedged request was
                    // sent to — so a mismatch means the entry is a
                    // different (re-warmed) daemon the request never used.
                    _ => return,
                },
            }
        };
        let Some(running) = taken else {
            return;
        };
        let reason = match arm {
            LossArm::Watcher { base_url, .. } => {
                tracing::warn!(
                    reason = "process_exit",
                    base_url = %base_url,
                    "freshagent.opencode.daemon_crash_detected"
                );
                "process_exit"
            }
            LossArm::Discard { reason, .. } => {
                tracing::warn!(reason = reason, "freshagent.opencode.daemon_discarded");
                reason
            }
        };
        // The watcher arm's kill is reaper parity only (the process already
        // exited); the discard arm's kill is the requested kill. Either way
        // kill() reaps the /proc-scoped ownership tree.
        running.process.kill();
        // The sweep already ran INSIDE the take critical section, so
        // `lost_senders` is exactly the set of THIS daemon's emitters it
        // claimed: the Lost edge goes only to the sessions the lost daemon
        // served, and a successor's post-release registration is not in it
        // and stays live.
        for sender in lost_senders {
            let _ = sender.send(SessionSignal::Lost);
        }
        let _ = self
            .inner
            .daemon_signals
            .send(DaemonSignal::Lost { reason });
        self.schedule_re_warm();
    }

    /// Schedule the backoff-guarded respawn after a daemon loss: a RETRY loop
    /// that sleeps `re_warm_backoff_initial_ms * 2^(attempts-1)` (capped at
    /// `re_warm_backoff_max_ms`), then calls `ensure_started`. A FAILED
    /// attempt logs and schedules the next (escalating) attempt — a transient
    /// spawn/health failure (e.g. disk pressure) must not strand the daemon
    /// permanently absent. A SUCCESSFUL attempt ends the loop; the fresh
    /// daemon's own exit watcher is armed by `ensure_started`. Never spawns
    /// (nor retries) once shutdown is set.
    ///
    /// **Fresh-incident gate** (the round-2 "no permanent 60 s first delay"
    /// finding, reconciled with the behavior list's crash-loop escalation):
    /// a daemon that OUTLIVED the whole backoff ladder makes this loss a NEW
    /// incident — the attempt counter resets so its re-warm starts at the
    /// initial delay. A daemon that died faster KEEPS the accumulated
    /// escalation: a daemon dying immediately after every successful start
    /// must climb the ladder (50→100→200→400 ms…), never respawn at the
    /// floor every cycle. The counter therefore persists across re-warm
    /// successes and resets only here, at the next loss, when the lost
    /// daemon's healthy lifetime reached the ladder's cap.
    fn schedule_re_warm(&self) {
        if self.inner.shutdown.load(Ordering::SeqCst) {
            return;
        }
        let fresh_incident = {
            let last_cold_start = *self
                .inner
                .last_cold_start_at
                .lock()
                .expect("cold-start clock mutex");
            last_cold_start
                .map(|started_at| {
                    started_at.elapsed()
                        >= Duration::from_millis(self.config().re_warm_backoff_max_ms)
                })
                .unwrap_or(true)
        };
        if fresh_incident {
            self.inner.re_warm_attempts.store(0, Ordering::SeqCst);
        }
        let manager = self.clone();
        tokio::spawn(async move {
            loop {
                let attempts = manager
                    .inner
                    .re_warm_attempts
                    .fetch_add(1, Ordering::SeqCst)
                    + 1;
                let delay_ms = (manager
                    .config()
                    .re_warm_backoff_initial_ms
                    .saturating_mul(1u64 << (attempts - 1).min(16)))
                .min(manager.config().re_warm_backoff_max_ms);
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                if manager.inner.shutdown.load(Ordering::SeqCst) {
                    return;
                }
                match manager.ensure_started().await {
                    Ok(_) => {
                        tracing::info!(attempt = attempts, "freshagent.opencode.daemon_re_warm");
                        return;
                    }
                    Err(err) => {
                        tracing::warn!(
                            attempt = attempts,
                            error = %err,
                            "freshagent.opencode.daemon_re_warm"
                        );
                    }
                }
            }
        });
    }

    async fn require_base(&self) -> Result<String, ServeError> {
        self.ensure_started().await
    }

    /// One JSON request/response through the transport, bounded by the config's
    /// `request_timeout`. On a timeout the sidecar the request was dispatched
    /// against is discarded (`discardRunning('request_timeout')`,
    /// `serve-manager.ts:320-324`) — never a re-warmed replacement.
    /// `not_found_value` mirrors `json`'s 404 handling.
    async fn json_request(
        &self,
        method: HttpMethod,
        path: &str,
        body: Option<Value>,
        not_found_value: Option<Value>,
    ) -> Result<Value, ServeError> {
        self.json_request_maybe_witnessed(method, path, body, not_found_value, &[], None)
            .await
    }

    /// One request with optional dispatch witnesses and a per-call timeout override.
    /// Witnesses arm at the actual HTTP-send boundary, after this call's own
    /// `require_base`; `compact` uses the dedicated LLM-scale timeout.
    async fn json_request_maybe_witnessed(
        &self,
        method: HttpMethod,
        path: &str,
        body: Option<Value>,
        not_found_value: Option<Value>,
        dispatch_witnesses: &[std::sync::Arc<std::sync::atomic::AtomicBool>],
        timeout_override: Option<Duration>,
    ) -> Result<Value, ServeError> {
        let base = self.require_base().await?;
        self.json_request_over_base(
            method,
            path,
            body,
            not_found_value,
            base,
            DiscardOnTimeout::Yes,
            dispatch_witnesses,
            timeout_override,
        )
        .await
    }

    /// One JSON request/response against a caller-captured base URL. This core
    /// never starts a sidecar and can be told not to discard it on timeout.
    #[allow(clippy::too_many_arguments)]
    async fn json_request_over_base(
        &self,
        method: HttpMethod,
        path: &str,
        body: Option<Value>,
        not_found_value: Option<Value>,
        base: String,
        discard_on_timeout: DiscardOnTimeout,
        dispatch_witnesses: &[std::sync::Arc<std::sync::atomic::AtomicBool>],
        timeout_override: Option<Duration>,
    ) -> Result<Value, ServeError> {
        let url = format!("{base}{path}");
        let timeout = timeout_override.unwrap_or_else(|| self.config().request_timeout);
        let method_str = format!("{method:?}").to_uppercase();
        let mut req = match (method, &body) {
            (HttpMethod::Get, _) => ServeHttpRequest::get(&url),
            (HttpMethod::Post, Some(value)) => {
                ServeHttpRequest::post_json(&url, serde_json::to_vec(value).unwrap_or_default())
            }
            (HttpMethod::Post, None) => ServeHttpRequest::post(&url),
            (HttpMethod::Patch, Some(value)) => {
                ServeHttpRequest::patch_json(&url, serde_json::to_vec(value).unwrap_or_default())
            }
            (HttpMethod::Patch, None) => {
                return Err(ServeError::Http {
                    method: method_str,
                    url,
                    status: 0,
                    body: "PATCH requires a JSON body".to_string(),
                })
            }
        };
        req = req.with_timeout(timeout);

        let resp = match {
            for witness in dispatch_witnesses {
                witness.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            tokio::time::timeout(timeout, self.inner.deps.http.request(req))
        }
        .await
        {
            Err(_) => {
                if discard_on_timeout == DiscardOnTimeout::Yes {
                    // Gate on the daemon THIS request was dispatched against:
                    // a stale timeout (its daemon already discarded, a
                    // re-warmed replacement installed) must never kill the
                    // replacement — the discard no-ops on a base mismatch.
                    self.discard_running("request_timeout", &base).await;
                }
                return Err(ServeError::RequestTimeout {
                    method: method_str,
                    url,
                    timeout_ms: timeout.as_millis() as u64,
                });
            }
            Ok(Err(transport)) => {
                return Err(match transport {
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

    /// Unified agent names (Task 3): `PATCH /session/:id` — the supported
    /// `update_session_title` metadata route (opencode's documented server
    /// API; SQLite stays read-only for native discovery — never a database
    /// write as an alternative). `route` is the session's own
    /// directory/endpoint (`?directory=<cwd>`); the caller verifies the
    /// effective-database context FIRST via
    /// [`Self::check_database_context`]. Transport failure classification
    /// (Undelivered vs ambiguous) is preserved by `json_request`.
    pub async fn update_session_title(
        &self,
        id: &str,
        title: &str,
        route: &Route,
    ) -> Result<Value, ServeError> {
        let path = with_route(&format!("/session/{}", encode_path_segment(id)), route);
        self.json_request(
            HttpMethod::Patch,
            &path,
            Some(json!({ "title": title })),
            None,
        )
        .await
    }

    /// `getSession` against a CALLER-CAPTURED base URL (b8ke focused FR2):
    /// the side-effect-free snapshot GET's transport. Never spawns (no
    /// `require_base` re-lookup mid-request) and never discards the running
    /// sidecar on a timeout — the caller degrades to its disk-state answer
    /// instead of killing the shared daemon.
    pub async fn get_session_at(
        &self,
        id: &str,
        route: &Route,
        base: &str,
    ) -> Result<Value, ServeError> {
        let path = with_route(&format!("/session/{}", encode_path_segment(id)), route);
        self.json_request_over_base(
            HttpMethod::Get,
            &path,
            None,
            None,
            base.to_string(),
            DiscardOnTimeout::No,
            &[],
            None,
        )
        .await
    }

    /// The OPENCODE_DB override evaluation (Task 3 native names): absolute
    /// overrides address that file; relative overrides resolve against
    /// `cwd` (the serve inherits the spawning process's working directory);
    /// `:memory:` is an in-memory route that can never address an indexed
    /// file database; absent overrides fall back to the ambient data home's
    /// `opencode.db` (the same resolution the session index uses). Never a
    /// store selector derived from the session's directory.
    pub fn effective_database(&self) -> EffectiveOpencodeDatabase {
        let override_value = self
            .config()
            .env
            .iter()
            .rev()
            .find(|(key, _)| key == "OPENCODE_DB")
            .map(|(_, value)| value.clone())
            .or_else(|| std::env::var("OPENCODE_DB").ok().filter(|v| !v.is_empty()));
        resolve_opencode_database(
            override_value.as_deref(),
            default_opencode_database(),
            &std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")),
        )
    }

    /// Task 3 native names: before dispatching a metadata write, verify the
    /// selected serve's effective database MATCHES the database the session
    /// was indexed at — a mismatched serve would write a title into the
    /// wrong store, and an in-memory route can never address it. Fails
    /// diagnostically (the caller surfaces it as an unsupported native
    /// route); never silently uses the directory as a store selector.
    pub fn check_database_context(
        &self,
        indexed_database: &std::path::Path,
    ) -> Result<(), ServeError> {
        match self.effective_database() {
            EffectiveOpencodeDatabase::Memory => Err(ServeError::Transport(
                "opencode serve runs an in-memory database (:memory:); it can never address an indexed file database"
                    .to_string(),
            )),
            EffectiveOpencodeDatabase::File(effective) => {
                let canon = |path: &std::path::Path| {
                    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
                };
                if canon(&effective) == canon(indexed_database) {
                    Ok(())
                } else {
                    Err(ServeError::Transport(format!(
                        "opencode serve database mismatch: the serve is pinned to {} but the session is indexed at {}",
                        effective.display(),
                        indexed_database.display()
                    )))
                }
            }
        }
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

    /// `listMessages` against a CALLER-CAPTURED base URL (b8ke focused
    /// FR2) — the same side-effect-free contract as
    /// [`Self::get_session_at`].
    pub async fn list_messages_at(
        &self,
        id: &str,
        route: &Route,
        base: &str,
    ) -> Result<Value, ServeError> {
        let path = with_route(
            &format!("/session/{}/message", encode_path_segment(id)),
            route,
        );
        self.json_request_over_base(
            HttpMethod::Get,
            &path,
            None,
            Some(Value::Array(Vec::new())),
            base.to_string(),
            DiscardOnTimeout::No,
            &[],
            None,
        )
        .await
    }

    /// `promptAsync(id, {parts, model?, variant?, agent?}, route)` — the send-turn call
    /// (`serve-manager.ts:355-365`). Returns once the serve accepts the prompt.
    ///
    /// `dispatch_witness` (b8ke focused round-2 review R2-4): flips at the
    /// TRUE dispatch boundary — right where the HTTP send is issued, after
    /// this call's own `require_base` — NOT when the response is processed.
    /// The POST-received→response-processed window (and any ambiguous
    /// response failure) must already count as accepted: the daemon may be
    /// executing the turn while the local await is still parked on the
    /// response, so a handoff landing in that window still sees the
    /// acceptance armed and issues the daemon-side abort.
    ///
    /// `dispatched_witness` (send-during-compact queue, Task 5): the FRESH
    /// per-drive guard-release witness the queued-send drain's drive block
    /// races its ownership op guard against — the additive second witness
    /// mirroring `compact`'s two-witness collection: both flip INSIDE the
    /// request leg at the true send point, so the guard releases exactly
    /// at the prompt POST's dispatch boundary (never earlier, and never
    /// held through the turn's read-only await-idle tail).
    pub async fn prompt_async(
        &self,
        id: &str,
        body: Value,
        route: &Route,
        dispatch_witness: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
        dispatched_witness: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) -> Result<(), ServeError> {
        let path = with_route(
            &format!("/session/{}/prompt_async", encode_path_segment(id)),
            route,
        );
        // Both witnesses flip INSIDE the request leg at the true send point —
        // the exact shape `compact` uses (both arrive at the dispatch boundary).
        let mut witnesses = Vec::with_capacity(
            dispatch_witness.is_some() as usize + dispatched_witness.is_some() as usize,
        );
        if let Some(w) = dispatch_witness {
            witnesses.push(w);
        }
        if let Some(w) = dispatched_witness {
            witnesses.push(w);
        }
        self.json_request_maybe_witnessed(
            HttpMethod::Post,
            &path,
            Some(body),
            None,
            &witnesses,
            None,
        )
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

    /// `abort` against a CALLER-CAPTURED base URL (b8ke focused FR1): the
    /// stop path's daemon-side turn abort. The stop path must never spawn a
    /// daemon (a `require_base` re-lookup could `ensure_started` one after
    /// the running entry disappeared) and never kills the shared daemon —
    /// the abort is issued at exactly the captured base, and a transport
    /// failure is surfaced to the caller's bounded retry loop.
    pub async fn abort_at(&self, id: &str, route: &Route, base: &str) -> Result<(), ServeError> {
        let path = with_route(
            &format!("/session/{}/abort", encode_path_segment(id)),
            route,
        );
        self.json_request_over_base(
            HttpMethod::Post,
            &path,
            None,
            None,
            base.to_string(),
            DiscardOnTimeout::No,
            &[],
            None,
        )
        .await?;
        Ok(())
    }

    /// `GET /config` — the serve's global config, returned verbatim. The fresh-agent
    /// compact path consumes only its `model` key (probed on 1.18.18: present,
    /// string-or-null) as the model-pair fallback when a session carries no splittable
    /// model of its own.
    ///
    /// A slow config read must never kill the shared daemon — the FR2 read rule
    /// (b8ke): capture the base once (spawn-on-demand is preserved), then
    /// transport over the captured base with `DiscardOnTimeout::No`.
    pub async fn get_config(&self, route: &Route) -> Result<Value, ServeError> {
        let base = self.require_base().await?;
        let path = with_route("/config", route);
        self.json_request_over_base(
            HttpMethod::Get,
            &path,
            None,
            None,
            base,
            DiscardOnTimeout::No,
            &[],
            None,
        )
        .await
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
    ///
    /// `accepted_witness` (b8ke focused round-2 review R2-5): the SAME
    /// dispatch-boundary arming for the session's accepted-daemon-operation
    /// flag — a summarize POST the daemon received (even before its response
    /// is processed) is daemon-side work a handoff must quiesce, exactly like
    /// an accepted prompt. Both flags flip at the SAME instant, inside the
    /// request leg at the true send point.
    #[allow(clippy::too_many_arguments)] // the compact field set (both witnesses ride the one dispatch)
    pub async fn compact(
        &self,
        id: &str,
        provider_id: &str,
        model_id: &str,
        route: &Route,
        dispatched_witness: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
        accepted_witness: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) -> Result<(), ServeError> {
        let path = with_route(
            &format!("/session/{}/summarize", encode_path_segment(id)),
            route,
        );
        // Both witnesses flip INSIDE the request leg at the true send point —
        // after its own `require_base` (the serve is running; aborts in the
        // cold-start leg are still provably no-side-effects) and right where
        // the HTTP call is issued (an abort inside the request leg's shared
        // lock waits doesn't falsely look dispatched — ep4-r6 F3).
        let mut witnesses = Vec::with_capacity(
            dispatched_witness.is_some() as usize + accepted_witness.is_some() as usize,
        );
        if let Some(w) = dispatched_witness {
            witnesses.push(w);
        }
        if let Some(w) = accepted_witness {
            witnesses.push(w);
        }
        // 2026-09-20 incident: the summarize POST used the discard-on-timeout
        // lane, so a 600 s budget exceeded on a healthy-but-busy daemon KILLED
        // the one shared daemon for every freshopencode session. Mirror the
        // FR2 captured-base transport (`get_session_at`): a timed-out compact
        // answers `RequestTimeout` and NEVER kills the shared daemon. The
        // redo-destroy classification is unchanged — `RequestTimeout` stays
        // outside `never_dispatched()` (a timed-out POST may have reached the
        // daemon).
        let base = self.require_base().await?;
        self.json_request_over_base(
            HttpMethod::Post,
            &path,
            Some(json!({ "providerID": provider_id, "modelID": model_id })),
            None,
            base,
            DiscardOnTimeout::No,
            &witnesses,
            // The summarize handler runs the whole LLM turn before answering;
            // use its dedicated timeout rather than the generic request bound.
            Some(self.config().compact_timeout),
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

    /// Subscribe to the daemon-level lifecycle stream ([`DaemonSignal`]).
    ///
    /// NOTE (LB-02a, source-verified at the locked tokio version): tokio
    /// broadcast does NOT replay history to late subscribers — a receiver
    /// created here starts at the channel's current TAIL and observes only
    /// signals sent AFTER this call. Consumers (Task 4's bridge revival) must
    /// therefore be LEVEL-TRIGGERED (query daemon state on receipt), never
    /// event-history-dependent.
    pub fn subscribe_daemon_signals(&self) -> broadcast::Receiver<DaemonSignal> {
        self.inner.daemon_signals.subscribe()
    }

    /// Feed one parsed SSE event into the per-session fan-out. This is the
    /// generation-less ingestion seam (`dispatchEvent`,
    /// `serve-manager.ts:429-432`) — test-facing in practice. It is
    /// deliberately UNGATED (no era): the era fence guards the REAL
    /// per-connection sinks (see [`Self::make_dispatch_sink`] and
    /// [`dispatch_event_on_era`]); a production caller must ingest through
    /// a sink, not this seam.
    pub fn dispatch_event(&self, event: ParsedServeEvent) {
        dispatch_event_on(&self.inner, event);
    }

    /// Collect every registered session-emitter sender and CLEAR the shared
    /// map — the sweep half of [`Self::emit_lost_for_all`], split out so the
    /// daemon-loss path can run it INSIDE the `running` critical section
    /// that removes the dead daemon (see [`Self::lose_daemon`]): while that
    /// lock is held no successor daemon can cold-start (`ensure_started`
    /// needs it), so every sender claimed here belongs to the daemon being
    /// lost, and anything registered later (a successor's bridge) is never
    /// swept by this loss.
    fn take_session_emitters(&self) -> Vec<broadcast::Sender<SessionSignal>> {
        let mut map = self
            .inner
            .session_emitters
            .lock()
            .expect("session emitters mutex");
        let senders = map.values().cloned().collect();
        map.clear();
        senders
    }

    /// Signal every subscriber that the sidecar was lost (`emitLostForAllSessions`,
    /// `serve-manager.ts:126-132`). Exposed for the sidecar-loss liveness path/tests
    /// and the shutdown teardown. The daemon-LOSS path does NOT use this method:
    /// it sweeps via [`Self::take_session_emitters`] inside its own `running`
    /// critical section (see [`Self::lose_daemon`]) so a successor daemon's
    /// fresh senders can never be wiped by a predecessor's late cleanup; this
    /// whole-map form is correct only where no successor remains to protect
    /// (final shutdown, liveness tests).
    pub fn emit_lost_for_all(&self) {
        for sender in self.take_session_emitters() {
            let _ = sender.send(SessionSignal::Lost);
        }
    }

    /// The requested-loss arm: discard the running daemon the timed-out
    /// request at `dispatched_base` was sent to (a Yes-lane request
    /// timeout, …), WARN the Task-2 structured event, then run the shared
    /// exactly-once loss path (Lost signal + backoff re-warm). A STALE
    /// timeout — one whose daemon was already replaced — no-ops silently.
    /// `reason` is `&'static` because it rides the [`DaemonSignal::Lost`]
    /// broadcast to daemon-signal subscribers.
    async fn discard_running(&self, reason: &'static str, dispatched_base: &str) {
        self.lose_daemon(LossArm::Discard {
            reason,
            dispatched_base,
        })
        .await;
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
    ///
    /// `accepted_witness` (b8ke focused FR1 + round-2 R2-4): flipped at the
    /// DISPATCH boundary — the moment the prompt POST is issued onto the
    /// transport, inside [`Self::prompt_async`] — NOT after it returns.
    /// Delivery and daemon acceptance happen before the response is
    /// processed; the POST-received→response-processed window (and any
    /// ambiguous response failure) must count as accepted, because from
    /// that moment the turn may execute INSIDE the shared serve while the
    /// local future can later fail (IdleTimeout) or be cancelled with the
    /// flag still falsely dark.
    ///
    /// `dispatched_witness` (send-during-compact queue, Task 5): the
    /// additive fresh per-drive guard-release witness, threaded through
    /// to [`Self::prompt_async`]'s request leg — the drain-driven send's
    /// op guard releases the moment it flips (the prompt POST's dispatch
    /// boundary), never before.
    #[allow(clippy::too_many_arguments)] // the turn field set (the compact precedent carries its witness the same way)
    pub async fn run_turn(
        &self,
        session_id: &str,
        text: &str,
        model: Option<&str>,
        effort: Option<&str>,
        timeout: Duration,
        route: Route,
        accepted_witness: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
        dispatched_witness: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>,
    ) -> Result<(), ServeError> {
        let rx = self.subscribe(session_id);
        let body = build_prompt_body(text, model, effort);
        self.prompt_async(
            session_id,
            body,
            &route,
            accepted_witness,
            dispatched_witness,
        )
        .await?;
        self.await_idle(session_id, rx, timeout, route).await
    }

    /// Shut down: stop future starts, discard the running sidecar (kill + stop SSE via
    /// the dropped handle), and signal all sessions lost (`shutdown`, `serve-manager.ts:573-591`).
    pub async fn shutdown(&self) {
        self.inner.shutdown.store(true, Ordering::SeqCst);
        let taken = {
            let mut running = self.inner.running.lock().await;
            // The take retires the dispatch era under the lock — the same
            // era-gate invariant as the loss path (a late event from the
            // daemon being taken must never dispatch past the take).
            self.retire_event_era();
            running.take()
        };
        if let Some(running) = taken {
            // The requested-loss discipline: abort the watcher so the shutdown
            // kill never raises the crash event. No `Lost` signal, no re-warm —
            // the shutdown flag set above blocks `schedule_re_warm`, and the
            // server is going down.
            if let Some(watch) = &running._exit_watch {
                watch.abort();
            }
            running.process.kill();
        }
        self.emit_lost_for_all();
    }
}

fn dispatch_event_on(inner: &Arc<Inner>, event: ParsedServeEvent) {
    dispatch_event_on_era(inner, event, None);
}

/// The era-verified dispatch (ep2-r3 fresheyes Major — the check-to-dispatch
/// TOCTOU): era verification is ATOMIC with dispatch. `Some(era)` (the sink
/// path, carrying the era its daemon connected under) is re-verified UNDER
/// the `session_emitters` mutex, and the mutex is held across the
/// check → sender-selection → send — the review's required invariant,
/// exactly: an event dispatches into a session's sender only if the event's
/// daemon era matches the CURRENT era, verified under the lock the sweep
/// itself must take. The take retires the era (an atomic increment) BEFORE
/// its sweep claims the emitters mutex, so a callback that re-verifies under
/// this lock either sees the retired era (the event is dropped BEFORE any
/// entry is selected or created — a retired-era event can never mint an
/// emitter entry) or holds the lock ahead of the sweep, in which case every
/// entry it selects was registered in its OWN era (the sweep clears the map
/// at every retirement). Either way no stale-era event can reach a
/// successor-era registration, whatever the OS scheduler does between a
/// sink's fast-path check and this dispatch.
///
/// `None` (the pub [`OpencodeServeManager::dispatch_event`] seam) is the
/// generation-less legacy lane, deliberately ungated — its callers are tests
/// and test helpers; if a production caller ever appears it must go through
/// a sink (or carry an era here).
fn dispatch_event_on_era(inner: &Arc<Inner>, event: ParsedServeEvent, era: Option<u64>) {
    let Some(session_id) = event.session_id.clone() else {
        return;
    };
    let mut emitters = inner
        .session_emitters
        .lock()
        .expect("session emitters mutex");
    if let Some(era) = era {
        if inner.event_era.load(Ordering::Acquire) != era {
            // The era this event originated from was retired while the
            // callback was in flight (after its sink passed the check,
            // before this lock): drop it under the lock — never dispatched,
            // never an entry.
            return;
        }
    }
    let sender = emitters
        .entry(session_id)
        .or_insert_with(|| broadcast::Sender::new(SESSION_CHANNEL_CAPACITY))
        .clone();
    // The send rides inside the same critical section: the selected sender
    // is the era-verified one, and `broadcast::Sender::send` is a
    // non-blocking enqueue (no re-entrancy into this mutex).
    let _ = sender.send(SessionSignal::Event(event));
}

/// Build the `prompt_async` body: `{ parts:[{type:'text',text}], model?, variant? }`
/// (`adapter.ts:363-367`). `model` is split into `{providerID, modelID}`; a
/// non-splittable model is omitted so the serve session default applies.
/// `pub` for the fresh-agent REST lane's gate-held drive (b8ke focused
/// round-4 R4-2: it composes subscribe + prompt_async + await_idle itself
/// so the prompt POST issues INSIDE its dispatch/condemn critical section).
pub fn build_prompt_body(text: &str, model: Option<&str>, effort: Option<&str>) -> Value {
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

// ── unified agent names (Task 3): the OPENCODE_DB context evaluation ─────────────

/// The effective database an `opencode serve` process uses, given its
/// `OPENCODE_DB` override. Never a store selector derived from a session's
/// directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EffectiveOpencodeDatabase {
    /// The resolved file database (an absolute override, a cwd-resolved
    /// relative override, or the ambient data-home default).
    File(std::path::PathBuf),
    /// `:memory:` — an in-memory route that can never address an indexed
    /// file database.
    Memory,
}

/// Evaluate the `OPENCODE_DB` override: absolute values address that file;
/// relative values resolve against the serve's working directory;
/// `:memory:` is in-memory; absent falls back to the ambient data home's
/// `opencode.db` (the same root the session index's default data home
/// resolves — mirrored here because this crate shares no dependency with
/// the index crate).
pub fn resolve_opencode_database(
    override_value: Option<&str>,
    default_database: std::path::PathBuf,
    cwd: &std::path::Path,
) -> EffectiveOpencodeDatabase {
    let Some(value) = override_value.map(str::trim).filter(|v| !v.is_empty()) else {
        return EffectiveOpencodeDatabase::File(default_database);
    };
    if value == ":memory:" {
        return EffectiveOpencodeDatabase::Memory;
    }
    let path = std::path::Path::new(value);
    if path.is_absolute() {
        return EffectiveOpencodeDatabase::File(path.to_path_buf());
    }
    EffectiveOpencodeDatabase::File(cwd.join(path))
}

/// The ambient opencode data home's `opencode.db` (XDG_DATA_HOME / the
/// Windows local-app-data path / `~/.local/share/opencode`), mirroring the
/// session index's default resolution.
pub fn default_opencode_database() -> std::path::PathBuf {
    fn data_home() -> std::path::PathBuf {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            if !xdg.is_empty() {
                return std::path::PathBuf::from(xdg).join("opencode");
            }
        }
        #[cfg(windows)]
        {
            if let Ok(local) = std::env::var("LOCALAPPDATA") {
                if !local.is_empty() {
                    return std::path::PathBuf::from(local).join("opencode");
                }
            }
        }
        let home = std::env::var("HOME")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| ".".to_string());
        std::path::PathBuf::from(home)
            .join(".local")
            .join("share")
            .join("opencode")
    }
    data_home().join("opencode.db")
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
    use freshell_platform::opencode_config::jsonc_to_strict_json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    // ── display_error_chain (transport diagnostics preservation) ─────────────

    /// A two-deep `source()` chain: top → mid → leaf.
    #[derive(Debug)]
    struct LeafError;

    impl std::fmt::Display for LeafError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "leaf cause")
        }
    }
    impl std::error::Error for LeafError {}

    #[derive(Debug)]
    struct MidError;

    impl std::fmt::Display for MidError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "mid cause")
        }
    }
    impl std::error::Error for MidError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&LeafError)
        }
    }

    #[derive(Debug)]
    struct TopError;

    impl std::fmt::Display for TopError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "top message")
        }
    }
    impl std::error::Error for TopError {
        fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
            Some(&MidError)
        }
    }

    /// A source-less error renders alone (no trailing separators).
    #[derive(Debug)]
    struct BareError;

    impl std::fmt::Display for BareError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "bare message")
        }
    }
    impl std::error::Error for BareError {}

    #[test]
    fn display_error_chain_appends_every_source_in_order() {
        assert_eq!(
            display_error_chain(&TopError),
            "top message; caused by: mid cause; caused by: leaf cause",
            "the whole source chain rides along, innermost last"
        );
    }

    #[test]
    fn display_error_chain_bare_error_renders_top_only() {
        assert_eq!(
            display_error_chain(&BareError),
            "bare message",
            "a source-less error renders exactly its own Display"
        );
    }

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
    /// responses: healthy probes, summarize per `summarize_status` (or a NEVER-resolving
    /// response when `summarize_pending` — the wedged shape from
    /// `tests/serve_health_bounded.rs`), fork per `fork_status`/`fork_body`, `/config`
    /// per `config_body` (or never-resolving when `config_pending`), `/prompt_async`
    /// never-resolving when `prompt_pending`, everything else a
    /// benign 200 `{}`. Per-request timeouts land in the index-aligned
    /// [`RecordingHttp::timeouts`] vec (`requests[i]`'s timeout is `timeouts[i]`).
    struct RecordingHttp {
        requests: Mutex<Vec<(String, String, Option<String>)>>,
        timeouts: Mutex<Vec<Option<Duration>>>,
        summarize_status: u16,
        summarize_pending: bool,
        fork_status: u16,
        fork_body: Vec<u8>,
        config_body: Vec<u8>,
        config_pending: bool,
        revert_status: u16,
        prompt_pending: bool,
    }

    impl RecordingHttp {
        fn new() -> Self {
            Self {
                requests: Mutex::new(Vec::new()),
                timeouts: Mutex::new(Vec::new()),
                summarize_status: 200,
                summarize_pending: false,
                fork_status: 200,
                fork_body: br#"{"id":"ses_child","directory":"/tmp/x"}"#.to_vec(),
                config_body: br#"{"model":null}"#.to_vec(),
                config_pending: false,
                revert_status: 200,
                prompt_pending: false,
            }
        }

        fn recorded(&self) -> Vec<(String, String, Option<String>)> {
            self.requests.lock().expect("requests mutex").clone()
        }

        /// The per-request timeout recorded for the request at `index` (index-aligned
        /// with `recorded()`; health probes carry their probe budget, not `None`).
        fn recorded_timeout(&self, index: usize) -> Option<Duration> {
            self.timeouts
                .lock()
                .expect("timeouts mutex")
                .get(index)
                .copied()
                .flatten()
        }
    }

    impl ServeHttp for RecordingHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> Pin<Box<dyn Future<Output = Result<ServeHttpResponse, ServeHttpError>> + Send + 'a>>
        {
            let method = format!("{:?}", req.method).to_uppercase();
            self.timeouts
                .lock()
                .expect("timeouts mutex")
                .push(req.timeout);
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
                if self.summarize_pending {
                    // A genuine wedge: the response NEVER resolves — only the
                    // caller's per-request bound can settle it.
                    return Box::pin(async {
                        std::future::pending::<()>().await;
                        unreachable!()
                    });
                }
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
                if self.config_pending {
                    // A genuine wedge: the response NEVER resolves — only the
                    // caller's per-request bound can settle it.
                    return Box::pin(async {
                        std::future::pending::<()>().await;
                        unreachable!()
                    });
                }
                let body = self.config_body.clone();
                return Box::pin(async move { Ok(ServeHttpResponse::new(200, body)) });
            }
            if req.url.contains("/prompt_async") && self.prompt_pending {
                // A genuine wedge: the response NEVER resolves — only the
                // caller's per-request bound can settle it.
                return Box::pin(async {
                    std::future::pending::<()>().await;
                    unreachable!()
                });
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

    /// A never-exiting serve process whose `kill()` calls are COUNTED — the
    /// discard-on-timeout assertion seam (the `tests/serve_health_bounded.rs`
    /// `NeverExitsProcess` pattern).
    struct KillCountingProcess {
        killed: Arc<AtomicUsize>,
    }
    impl ServeProcess for KillCountingProcess {
        fn exited(&self) -> Option<i32> {
            None
        }
        fn take_fatal_startup_error(&self) -> Option<String> {
            None
        }
        fn kill(&self) {
            self.killed.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct KillCountingSpawner {
        killed: Arc<AtomicUsize>,
    }
    impl ProcessSpawner for KillCountingSpawner {
        fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
            Ok(Box::new(KillCountingProcess {
                killed: self.killed.clone(),
            }))
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

    /// An [`EventSource`] that RECORDS every sink it is handed (one per cold
    /// start, in connect order) — the REAL per-connection dispatch closures
    /// the manager mints at each daemon's connect, so a test can call a
    /// daemon generation's sink directly, carrying that generation's
    /// identity (the `tests/serve_daemon_selfheal.rs`
    /// `RecordingEventSource` shape, unit-side).
    struct RecordingEventSource {
        sinks: Mutex<Vec<EventSink>>,
    }
    impl EventSource for RecordingEventSource {
        fn connect(&self, _url: String, sink: EventSink) -> Box<dyn EventStreamHandle> {
            self.sinks.lock().expect("recorded sinks mutex").push(sink);
            Box::new(NoopHandle)
        }
    }

    async fn started_recording_manager(http: Arc<RecordingHttp>) -> OpencodeServeManager {
        started_recording_manager_with_config(http, ServeConfig::default()).await
    }

    async fn started_recording_manager_with_config(
        http: Arc<RecordingHttp>,
        config: ServeConfig,
    ) -> OpencodeServeManager {
        let deps = ServeDeps {
            spawner: Arc::new(FakeSpawner),
            http,
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let mgr = OpencodeServeManager::new(deps, config);
        mgr.ensure_started()
            .await
            .expect("healthy fake serve starts");
        mgr
    }

    /// [`started_recording_manager_with_config`] with a kill-counting spawner,
    /// for the lanes that must NEVER kill the shared daemon.
    async fn started_recording_manager_counting_kills(
        http: Arc<RecordingHttp>,
        config: ServeConfig,
        killed: Arc<AtomicUsize>,
    ) -> OpencodeServeManager {
        let deps = ServeDeps {
            spawner: Arc::new(KillCountingSpawner { killed }),
            http,
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let mgr = OpencodeServeManager::new(deps, config);
        mgr.ensure_started()
            .await
            .expect("healthy fake serve starts");
        mgr
    }

    // ── b8ke focused round-2 review R2-4: the dispatch-boundary witness ─────────

    /// A `ServeHttp` fake whose `prompt_async` handler parks the response
    /// until the test releases it — the exact POST-received→response-
    /// processed window the accepted-turn witness must already cover.
    struct ParkedPromptHttp {
        dispatched: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
    }

    impl ParkedPromptHttp {
        fn new() -> Self {
            Self {
                dispatched: Arc::new(tokio::sync::Notify::new()),
                release: Arc::new(tokio::sync::Notify::new()),
            }
        }
    }

    impl ServeHttp for ParkedPromptHttp {
        fn request<'a>(
            &'a self,
            req: ServeHttpRequest,
        ) -> Pin<Box<dyn Future<Output = Result<ServeHttpResponse, ServeHttpError>> + Send + 'a>>
        {
            Box::pin(async move {
                if req.url.contains("/global/health") {
                    return Ok(ServeHttpResponse::new(200, b"{}".to_vec()));
                }
                if req.url.contains("/prompt_async") {
                    // The POST is on the wire — the daemon may already be
                    // running the turn — but its response is parked.
                    self.dispatched.notify_one();
                    self.release.notified().await;
                    return Ok(ServeHttpResponse::new(200, b"{}".to_vec()));
                }
                Ok(ServeHttpResponse::new(200, b"{}".to_vec()))
            })
        }
    }

    /// b8ke focused round-2 review R2-4: the accepted-turn witness must be
    /// armed at the DISPATCH boundary — the moment the prompt POST is
    /// issued onto the transport — NOT after `prompt_async` returns. In
    /// the POST-received→response-processed window the daemon may already
    /// be executing the turn while the local await is still parked on the
    /// response; a handoff landing there must see the acceptance armed
    /// and issue the daemon-side abort (pre-fix: the flag stayed dark
    /// until the response was processed, so the stop path skipped the
    /// abort and reported Reaped over a still-running daemon-side turn).
    #[tokio::test]
    async fn run_turn_arms_the_accepted_witness_at_the_dispatch_boundary() {
        let http = Arc::new(ParkedPromptHttp::new());
        let deps = ServeDeps {
            spawner: Arc::new(FakeSpawner),
            http: http.clone(),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let mgr = OpencodeServeManager::new(deps, ServeConfig::default());
        mgr.ensure_started()
            .await
            .expect("healthy fake serve starts");

        let witness = Arc::new(AtomicBool::new(false));
        let armed = Arc::clone(&witness);
        let turn = tokio::spawn(async move {
            mgr.run_turn(
                "ses_r24",
                "hold this daemon-side turn open",
                None,
                None,
                Duration::from_millis(50),
                None,
                Some(armed),
                None,
            )
            .await
        });

        // The POST reached the fake daemon; its response is parked. THE
        // assertion: the witness is ALREADY armed inside this window.
        http.dispatched.notified().await;
        assert!(
            witness.load(Ordering::SeqCst),
            "the accepted witness must be armed at the dispatch boundary — the POST is \
             on the wire and the daemon may already be running the turn while the \
             response is still parked"
        );

        // Release: the response completes; the local await then settles
        // (IdleTimeout here — the fake never emits an idle edge, matching
        // a turn still running daemon-side; the flag stays armed for the
        // stop path, exactly like the production IdleTimeout shape).
        http.release.notify_one();
        let settled = turn.await.expect("run_turn settled");
        assert!(matches!(settled, Err(ServeError::IdleTimeout { .. })));
        assert!(
            witness.load(Ordering::SeqCst),
            "an ambiguous local failure keeps the acceptance armed (fail closed)"
        );
    }

    /// Task 5 (send-during-compact queue): the ADDITIVE trailing
    /// `dispatched_witness` — the fresh per-drive guard-release witness
    /// the queued-send drain's drive block races its op guard against —
    /// flips at the prompt POST's DISPATCH boundary exactly like the
    /// accepted witness (both ride the one request leg), and NOT before:
    /// dark before the POST is issued, armed inside the
    /// POST-received→response-processed window (the same parked-POST rig
    /// as the accepted-witness test above).
    #[tokio::test]
    async fn run_turn_arms_the_dispatched_witness_at_the_dispatch_boundary() {
        let http = Arc::new(ParkedPromptHttp::new());
        let deps = ServeDeps {
            spawner: Arc::new(FakeSpawner),
            http: http.clone(),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let mgr = OpencodeServeManager::new(deps, ServeConfig::default());
        mgr.ensure_started()
            .await
            .expect("healthy fake serve starts");

        let accepted = Arc::new(AtomicBool::new(false));
        let dispatched = Arc::new(AtomicBool::new(false));
        let armed_accepted = Arc::clone(&accepted);
        let armed_dispatched = Arc::clone(&dispatched);

        // BEFORE: no prompt POST has been issued — both witnesses are dark.
        assert!(!accepted.load(Ordering::SeqCst));
        assert!(!dispatched.load(Ordering::SeqCst));

        let turn = tokio::spawn(async move {
            mgr.run_turn(
                "ses_t5",
                "hold this daemon-side turn open",
                None,
                None,
                Duration::from_millis(50),
                None,
                Some(armed_accepted),
                Some(armed_dispatched),
            )
            .await
        });

        // The POST reached the fake daemon; its response is parked. THE
        // assertion: the dispatched witness is ALREADY armed inside this
        // window — it flips at the true send point, inside the request
        // leg, NOT after the response is processed.
        http.dispatched.notified().await;
        assert!(
            accepted.load(Ordering::SeqCst),
            "the accepted witness stays armed at the dispatch boundary"
        );
        assert!(
            dispatched.load(Ordering::SeqCst),
            "the dispatched witness must flip at the prompt POST's dispatch \
             boundary — the POST is on the wire while the response is still \
             parked"
        );

        // Release: the response completes; the local await then settles
        // (IdleTimeout here — the fake never emits an idle edge). The
        // dispatched witness stays armed, exactly like the accepted one.
        http.release.notify_one();
        let settled = turn.await.expect("run_turn settled");
        assert!(matches!(settled, Err(ServeError::IdleTimeout { .. })));
        assert!(
            dispatched.load(Ordering::SeqCst),
            "the dispatched witness stays armed once flipped (one-way latch)"
        );
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

    /// The compact/summarize POST is the ONE serve call whose handler runs a
    /// full LLM summarization before answering, so it must carry the dedicated
    /// LLM-scale `compact_timeout` — NOT the generic 30 s request bound that
    /// every other call keeps. This pins the exact per-request timeout the
    /// manager hands the transport for the summarize POST (both the reqwest
    /// `.timeout()` and the tokio wrapper resolve from it), using a distinct
    /// compact budget so a regression back to the generic bound fails
    /// deterministically.
    #[tokio::test]
    async fn compact_uses_the_dedicated_compact_timeout_not_the_generic_request_bound() {
        let http = Arc::new(RecordingHttp::new());
        let config = ServeConfig {
            compact_timeout: Duration::from_millis(123_456),
            ..ServeConfig::default()
        };
        let mgr = started_recording_manager_with_config(http.clone(), config).await;

        mgr.compact("ses_9", "prov-a", "mdl-x", &None, None, None)
            .await
            .expect("200 summarize succeeds");
        // A non-compact call in the SAME manager keeps the generic bound.
        mgr.get_config(&None).await.expect("config fetches");

        let requests = http.recorded();
        let summarize_index = requests
            .iter()
            .position(|(method, url, _)| method == "POST" && url.contains("/summarize"))
            .expect("a summarize POST was recorded");
        assert_eq!(
            http.recorded_timeout(summarize_index),
            Some(Duration::from_millis(123_456)),
            "the summarize POST carries the dedicated compact timeout, not the generic 30 s bound"
        );
        let config_index = requests
            .iter()
            .position(|(method, url, _)| method == "GET" && url.contains("/config"))
            .expect("a /config GET was recorded");
        assert_eq!(
            http.recorded_timeout(config_index),
            Some(Duration::from_millis(30_000)),
            "non-compact calls keep the generic request timeout"
        );
    }

    #[tokio::test]
    async fn compact_surfaces_a_validation_400_as_an_http_error() {
        let http = Arc::new(RecordingHttp {
            summarize_status: 400,
            ..RecordingHttp::new()
        });
        let mgr = started_recording_manager(http).await;

        match mgr
            .compact("ses_9", "prov-a", "mdl-x", &None, None, None)
            .await
        {
            Err(ServeError::Http { method, status, .. }) => {
                assert_eq!(method, "POST");
                assert_eq!(status, 400);
            }
            other => panic!("expected a 400 Http error, got {other:?}"),
        }
    }

    // 2026-09-20 incident: a compact timeout (600 s budget) ran the
    // DiscardOnTimeout::Yes arm and KILLED the one shared `opencode serve`
    // daemon for every freshopencode session. The compact lane must degrade
    // like the FR2 snapshot lane: the POST times out, the daemon survives.
    #[tokio::test]
    async fn compact_timeout_does_not_kill_the_shared_daemon() {
        let killed = Arc::new(AtomicUsize::new(0));
        let http = Arc::new(RecordingHttp {
            summarize_pending: true,
            ..RecordingHttp::new()
        });
        let config = ServeConfig {
            compact_timeout: Duration::from_millis(50),
            ..ServeConfig::default()
        };
        let mgr =
            started_recording_manager_counting_kills(http.clone(), config, killed.clone()).await;

        let err = mgr
            .compact("ses_timeout", "prov-a", "mdl-x", &None, None, None)
            .await
            .expect_err("the summarize POST must time out");
        assert!(
            matches!(err, ServeError::RequestTimeout { .. }),
            "got {err:?}"
        );
        assert_eq!(
            killed.load(Ordering::SeqCst),
            0,
            "a compact timeout must NEVER kill the shared daemon"
        );
        assert!(
            mgr.base_url().await.is_some(),
            "the running entry must survive a compact timeout"
        );
        // The compact-timeout POST must still carry the dedicated budget.
        let requests = http.recorded();
        let summarize_index = requests
            .iter()
            .position(|(method, url, _)| method == "POST" && url.contains("/summarize"))
            .expect("a summarize POST was recorded");
        assert_eq!(
            http.recorded_timeout(summarize_index),
            Some(Duration::from_millis(50))
        );
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

    // The compact drive's pre-flight model-pair resolution reads /config; a slow
    // config GET is the same defect class (a read must never kill the daemon).
    #[tokio::test]
    async fn get_config_timeout_does_not_kill_the_shared_daemon() {
        let killed = Arc::new(AtomicUsize::new(0));
        let http = Arc::new(RecordingHttp {
            config_pending: true,
            ..RecordingHttp::new()
        });
        let config = ServeConfig {
            request_timeout: Duration::from_millis(50),
            ..ServeConfig::default()
        };
        let mgr = started_recording_manager_counting_kills(http, config, killed.clone()).await;

        let err = mgr
            .get_config(&None)
            .await
            .expect_err("config GET must time out");
        assert!(
            matches!(err, ServeError::RequestTimeout { .. }),
            "got {err:?}"
        );
        assert_eq!(
            killed.load(Ordering::SeqCst),
            0,
            "a config read timeout must NEVER kill the shared daemon"
        );
        assert!(
            mgr.base_url().await.is_some(),
            "the running entry must survive a config read timeout"
        );
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
            merged_opencode_config_content(None).unwrap(),
            OPENCODE_SNAPSHOTS_DISABLED_CONFIG
        );
        // An empty inherited value merges as absent, never a malformed warning.
        assert_eq!(
            merged_opencode_config_content(Some("")).unwrap(),
            OPENCODE_SNAPSHOTS_DISABLED_CONFIG
        );
    }

    #[test]
    fn launch_config_refuses_malformed_jsonc_without_exposing_source() {
        let malformed = "{\"provider\":{\"apiKey\":\"fixture-secret\"},";
        let error = merged_opencode_config_content(Some(malformed)).unwrap_err();
        assert_eq!(error, ServeError::InvalidConfig);
        assert!(!error.to_string().contains("fixture-secret"));
        let valid = merged_opencode_config_content(Some(
            "{ // user comment\n \"plugin\":[\"file:///user-plugin.ts\",], }",
        ))
        .unwrap();
        let value: Value = serde_json::from_str(&valid).unwrap();
        assert_eq!(
            value["plugin"],
            serde_json::json!(["file:///user-plugin.ts"])
        );
        assert_eq!(value["snapshot"], false);
    }

    #[test]
    fn merged_config_merges_into_an_inherited_object_and_forces_the_pin() {
        let user =
            r#"{"plugin":["file:///home/me/plugin.ts"],"model":"openai/gpt-5","theme":"dark"}"#;
        let parsed: Value =
            serde_json::from_str(&merged_opencode_config_content(Some(user)).unwrap())
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
        let overridden: Value = serde_json::from_str(
            &merged_opencode_config_content(Some(r#"{"snapshot":true,"autoupdate":false}"#))
                .unwrap(),
        )
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

    /// Malformed inline config is refused without exposing source content in
    /// errors or structured events.
    #[test]
    fn merged_config_malformed_is_refused_without_source_content() {
        let (events, _guard) = config_capture::capture();
        let malformed = "not-json-at-all{ this is longer than twenty four chars }";
        let error = merged_opencode_config_content(Some(malformed)).unwrap_err();
        assert_eq!(error, ServeError::InvalidConfig);
        assert!(!error.to_string().contains(malformed));
        let events = events.lock().expect("capture lock");
        assert!(events
            .iter()
            .all(|fields| fields.values().all(|value| !value.contains(malformed))));
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
        let merged: Value =
            serde_json::from_str(&merged_opencode_config_content(Some(user)).unwrap())
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
        let merged: Value =
            serde_json::from_str(&merged_opencode_config_content(Some(jsonc)).unwrap())
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

    /// A document unparseable after JSONC normalization is refused.
    #[test]
    fn merged_config_unparseable_after_jsonc_normalization_is_refused() {
        let (events, _guard) = config_capture::capture();
        let malformed = "{ \"model\": , // no value\n }";
        let error = merged_opencode_config_content(Some(malformed)).unwrap_err();
        assert_eq!(error, ServeError::InvalidConfig);
        let events = events.lock().expect("capture lock");
        assert!(events
            .iter()
            .all(|fields| fields.values().all(|value| !value.contains("model"))));
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
        let merged: Value =
            serde_json::from_str(&merged_opencode_config_content(Some(cr_only)).unwrap())
                .expect("CR-only JSONC is valid after normalization");
        assert_eq!(
            merged,
            serde_json::json!({ "model": "dev/m-x", "snapshot": false })
        );
    }

    /// A non-object JSON value cannot take the top-level pin.
    #[test]
    fn merged_config_json_scalars_and_arrays_are_refused() {
        let (events, _guard) = config_capture::capture();
        let scalar = r#"["plugin-x"]"#;
        assert_eq!(
            merged_opencode_config_content(Some(scalar)),
            Err(ServeError::InvalidConfig)
        );
        let events = events.lock().expect("capture lock");
        assert!(events
            .iter()
            .all(|fields| fields.values().all(|value| !value.contains("plugin-x"))));
    }

    /// 2026-09-20 incident: the daemon discard that killed the shared serve left
    /// ZERO log trace (its reason parameter went unused), so the shared-daemon
    /// death was undiagnosable from the structured JSONL log. The discard must
    /// be observable: a WARN `freshagent.opencode.daemon_discarded` naming its
    /// reason. Driven through `prompt_async` — a deliberate
    /// `DiscardOnTimeout::Yes` lane — so a pending prompt POST times out and
    /// takes the discard path.
    #[tokio::test]
    async fn discard_running_emits_a_structured_warn_with_its_reason() {
        let killed = Arc::new(AtomicUsize::new(0));
        let http = Arc::new(RecordingHttp {
            prompt_pending: true,
            ..RecordingHttp::new()
        });
        let config = ServeConfig {
            request_timeout: Duration::from_millis(50),
            ..ServeConfig::default()
        };
        let (events, _guard) = config_capture::capture();
        let mgr = started_recording_manager_counting_kills(http, config, killed.clone()).await;

        let err = mgr
            .prompt_async(
                "ses_discard",
                build_prompt_body("hi", None, None),
                &None,
                None,
                None,
            )
            .await
            .expect_err("the prompt POST must time out");
        assert!(
            matches!(err, ServeError::RequestTimeout { .. }),
            "got {err:?}"
        );
        // The discard itself ran: the Yes-lane timeout took the daemon down.
        assert_eq!(
            killed.load(Ordering::SeqCst),
            1,
            "the discard must actually kill the running daemon here"
        );
        let events = events.lock().expect("capture lock");
        let discard = events
            .iter()
            .find(|fields| {
                fields.get("message").map(String::as_str)
                    == Some("freshagent.opencode.daemon_discarded")
            })
            .expect("a daemon discard must emit freshagent.opencode.daemon_discarded");
        assert_eq!(
            discard.get("reason").map(String::as_str),
            Some("request_timeout"),
            "the discard warn carries its reason: {discard:?}"
        );
    }

    // ── Task 3: the daemon exit watcher's loss path (unit side) ──────────────

    /// A serve whose "exit" is test-controlled: `exited()` reports `Some(0)`
    /// once the shared flag is set (the `tests/serve_daemon_selfheal.rs`
    /// `FlagExitProcess` shape, unit-side).
    struct FlagExitProcess {
        exited: Arc<AtomicBool>,
        killed: Arc<AtomicUsize>,
    }
    impl ServeProcess for FlagExitProcess {
        fn exited(&self) -> Option<i32> {
            self.exited.load(Ordering::SeqCst).then_some(0)
        }
        fn take_fatal_startup_error(&self) -> Option<String> {
            None
        }
        fn kill(&self) {
            self.killed.fetch_add(1, Ordering::SeqCst);
        }
    }

    struct FlagExitSpawner {
        exited: Arc<AtomicBool>,
        killed: Arc<AtomicUsize>,
    }
    impl ProcessSpawner for FlagExitSpawner {
        fn spawn(&self, _req: SpawnRequest) -> Result<Box<dyn ServeProcess>, String> {
            Ok(Box::new(FlagExitProcess {
                exited: self.exited.clone(),
                killed: self.killed.clone(),
            }))
        }
    }

    /// The watcher's unrequested-exit arm must WARN
    /// `freshagent.opencode.daemon_crash_detected` with the loss reason and
    /// the dead daemon's base URL — the diagnosability complement of the
    /// Task-2 discard log (a silent shared-daemon death was the incident's
    /// undiagnosable half). The watcher task runs on this current-thread
    /// runtime, so the thread-local capture sees its WARN; awaiting the
    /// `DaemonSignal::Lost` edge first guarantees the loss path already ran.
    #[tokio::test]
    async fn unrequested_daemon_exit_warns_daemon_crash_detected_with_reason_and_base_url() {
        let exited = Arc::new(AtomicBool::new(false));
        let killed = Arc::new(AtomicUsize::new(0));
        let deps = ServeDeps {
            spawner: Arc::new(FlagExitSpawner {
                exited: exited.clone(),
                killed: killed.clone(),
            }),
            http: Arc::new(RecordingHttp::new()),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let config = ServeConfig {
            daemon_watch_interval: Duration::from_millis(5),
            re_warm_backoff_initial_ms: 5,
            re_warm_backoff_max_ms: 50,
            ..ServeConfig::default()
        };
        let mgr = OpencodeServeManager::new(deps, config);
        mgr.ensure_started()
            .await
            .expect("healthy fake serve starts");
        let mut signals = mgr.subscribe_daemon_signals();
        let (events, _guard) = config_capture::capture();

        exited.store(true, Ordering::SeqCst); // the daemon "exits"
        let signal = tokio::time::timeout(Duration::from_secs(2), signals.recv())
            .await
            .expect("loss signal within budget")
            .expect("channel alive");
        assert!(
            matches!(
                signal,
                DaemonSignal::Lost {
                    reason: "process_exit"
                }
            ),
            "got {signal:?}"
        );
        assert!(
            killed.load(Ordering::SeqCst) >= 1,
            "the already-exited daemon is still kill()ed for /proc-reaper parity"
        );

        let events = events.lock().expect("capture lock");
        let warn = events
            .iter()
            .find(|fields| {
                fields.get("message").map(String::as_str)
                    == Some("freshagent.opencode.daemon_crash_detected")
            })
            .expect("an unrequested daemon exit must WARN daemon_crash_detected");
        assert_eq!(
            warn.get("reason").map(String::as_str),
            Some("process_exit"),
            "the crash warn names the loss reason: {warn:?}"
        );
        assert_eq!(
            warn.get("base_url").map(String::as_str),
            Some("http://127.0.0.1:1"),
            "the crash warn names the dead daemon's base URL: {warn:?}"
        );
    }

    // ── ep2-r3 fresheyes Major: the check-to-dispatch TOCTOU ──────────────

    /// The era check is not atomic with dispatch into `session_emitters`
    /// (ep2-r3 fresheyes Major — the check-to-dispatch TOCTOU): a callback
    /// can pass the check, be preempted before `dispatch_event_on` acquires
    /// the emitter mutex, and resume only after its daemon's loss was
    /// TAKEN (the era retired, the emitters swept) and the successor
    /// registered a replacement sender — the stale event is then delivered
    /// into the successor's registration; a stale `session.idle` would
    /// falsely satisfy the successor's `await_idle` (the false
    /// `freshAgent.turn.complete` precursor).
    ///
    /// The interleaving, forced deterministically through the
    /// `cfg(test)` dispatch park: A's REAL sink passes the era check and
    /// PARKS; while held, A is lost through the REAL watcher arm (take +
    /// era retire + sweep) and the successor B re-warms (its own sink
    /// connected); a B-era `await_idle` is subscribed and IN FLIGHT for
    /// the durable session; only then is the parked callback released —
    /// its era check ALREADY PASSED, so only a re-verification atomic
    /// with dispatch can stop it. The stale A-era event must NOT satisfy
    /// B's await. A GENUINE B-era idle through B's own sink still must
    /// (the gate is an era fence, not a broken dispatch). Pre-fix, the
    /// released callback dispatched straight into B's fresh registration
    /// and the successor's await resolved Ok.
    #[tokio::test]
    async fn a_preempted_era_checked_event_never_reaches_the_successors_registration() {
        let exited = Arc::new(AtomicBool::new(false));
        let killed = Arc::new(AtomicUsize::new(0));
        let events = Arc::new(RecordingEventSource {
            sinks: Mutex::new(Vec::new()),
        });
        let deps = ServeDeps {
            spawner: Arc::new(FlagExitSpawner {
                exited: exited.clone(),
                killed: killed.clone(),
            }),
            http: Arc::new(RecordingHttp::new()),
            ports: Arc::new(FakeAllocator),
            events: events.clone(),
        };
        let config = ServeConfig {
            daemon_watch_interval: Duration::from_millis(5),
            re_warm_backoff_initial_ms: 5,
            re_warm_backoff_max_ms: 50,
            ..ServeConfig::default()
        };
        let mgr = OpencodeServeManager::new(deps, config);
        mgr.ensure_started()
            .await
            .expect("healthy fake serve starts");
        let mut signals = mgr.subscribe_daemon_signals();
        let sink_a = events
            .sinks
            .lock()
            .expect("recorded sinks mutex")
            .first()
            .expect("A's cold start connected its event stream")
            .clone();

        // The park: `entered` fires once the callback has passed A's era
        // check; dropping `release_tx` resumes it. The release receiver
        // rides a Mutex because the park closure must be `Sync` (an
        // `EventSink` requirement) and only the parked callback ever
        // touches it.
        let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
        let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        mgr.arm_dispatch_park_for_tests(Some(Arc::new(move || {
            let _ = entered_tx.send(());
            let _ = release_rx.lock().expect("release latch mutex").recv();
        })));

        // The preempted A-era callback, on its own OS thread: the sink is
        // synchronous, and the runtime must stay free to run the loss and
        // the re-warm while the callback is held.
        let done = Arc::new(AtomicBool::new(false));
        let done_thread = done.clone();
        let idle_event = || {
            crate::events::parse_serve_event(&serde_json::json!({
                "type": "session.idle",
                "properties": { "sessionID": "ses_race" }
            }))
            .expect("parseable serve event")
        };
        let sink_thread = std::thread::spawn(move || {
            sink_a(idle_event());
            done_thread.store(true, Ordering::SeqCst);
        });
        entered_rx
            .recv_timeout(std::time::Duration::from_secs(2))
            .expect("the sink parks after passing the era check, before dispatch");

        // While the callback is held: A dies through the REAL watcher arm —
        // the take retires the dispatch era and sweeps the emitters inside
        // the same running-lock critical section.
        exited.store(true, Ordering::SeqCst);
        let lost = tokio::time::timeout(Duration::from_secs(2), signals.recv())
            .await
            .expect("loss signal within budget")
            .expect("channel alive");
        assert!(
            matches!(
                lost,
                DaemonSignal::Lost {
                    reason: "process_exit"
                }
            ),
            "got {lost:?}"
        );
        // The successor B re-warms — a NEW generation with its own sink.
        exited.store(false, Ordering::SeqCst);
        let started = tokio::time::timeout(Duration::from_secs(2), signals.recv())
            .await
            .expect("re-warm within budget")
            .expect("channel alive");
        assert!(matches!(started, DaemonSignal::Started), "got {started:?}");
        let sink_b = events
            .sinks
            .lock()
            .expect("recorded sinks mutex")
            .get(1)
            .expect("B's cold start connected its event stream")
            .clone();

        // The B-era registration the stale event must not reach: an
        // in-flight `await_idle` for the durable session.
        let rx = mgr.subscribe("ses_race");
        let idle_manager = mgr.clone();
        let mut await_idle = tokio::spawn(async move {
            idle_manager
                .await_idle("ses_race", rx, Duration::from_secs(5), None)
                .await
        });
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Release the preempted callback: the era check already passed —
        // only an ATOMIC re-verification at dispatch can stop it now.
        drop(release_tx);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !done.load(Ordering::SeqCst) {
            assert!(
                Instant::now() < deadline,
                "the parked callback must complete after the release"
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }

        // THE assertion: the stale A-era event must NOT satisfy B's await —
        // the successor stays pending through the grace window.
        match tokio::time::timeout(Duration::from_millis(300), &mut await_idle).await {
            Err(_still_pending) => {}
            Ok(Ok(Ok(()))) => panic!(
                "the preempted A-era event — era-checked BEFORE the take, \
                 dispatched AFTER the successor registered — satisfied the \
                 successor's await_idle: the false freshAgent.turn.complete \
                 precursor (ep2-r3 check-to-dispatch TOCTOU)"
            ),
            other => panic!("await_idle settled unexpectedly: {other:?}"),
        }

        // Positive control: a GENUINE B-era idle through B's OWN sink still
        // satisfies it — the gate is an era fence, not a broken dispatch.
        mgr.arm_dispatch_park_for_tests(None);
        sink_b(idle_event());
        let outcome = tokio::time::timeout(Duration::from_secs(2), await_idle)
            .await
            .expect("the genuine B-era idle resolves within budget");
        assert!(
            matches!(outcome, Ok(Ok(()))),
            "the successor's own idle edge must satisfy await_idle, got {outcome:?}"
        );
        sink_thread.join().expect("the sink thread ends cleanly");
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
