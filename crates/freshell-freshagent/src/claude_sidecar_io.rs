//! The claude sidecar's process I/O beside its stdout protocol (core-runtime
//! design §3.2, §5.9): [`spawn_stderr_logger`] turns the sidecar's stderr into
//! server log events (G14).
//!
//! The sidecar writes one JSON log record per stderr line
//! (`crates/freshell-claude-sidecar/log.mjs`: `{severity, component, event,
//! ...fields}`). Each record is re-emitted through `tracing` as
//! `freshagent.claude.sidecar_log` at the record's own severity, labelled with
//! the sidecar's ownership id, pid, session type and (once the sidecar has
//! named it) the session id. A line that is not a JSON record (a Node crash
//! trace, a stray print) is logged at warn with `raw = true`.
//!
//! Bounds, per sidecar: a line is read up to [`STDERR_LINE_MAX_BYTES`] (the
//! rest of a longer line is counted, not kept); a raw line's text is cut to
//! [`RAW_TEXT_MAX_BYTES`]; at most [`LINES_PER_WINDOW`] lines are logged per
//! [`RATE_WINDOW`], and the lines dropped beyond that are reported in one
//! `freshagent.claude.sidecar_log_dropped` warning when their window closes.
//! A hosted sidecar (the session host sets `FRESHELL_HOSTED_FRESH_AGENT`)
//! has its raw lines logged by byte count only; its records already carry
//! CLI output by size only (log.mjs).

use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;

use serde_json::{Map, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, BufReader};
use tokio::time::Instant;

const PROVIDER: &str = "claude";

/// Set by the hosted session host in a hosted sidecar's environment (to the
/// provider it hosts: `claude` or `kilroy`).
const HOSTED_ENV: &str = "FRESHELL_HOSTED_FRESH_AGENT";

/// The longest stderr line kept whole. Records are far shorter (log.mjs cuts
/// CLI output to 2 KiB); a longer line is cut here and counted.
const STDERR_LINE_MAX_BYTES: usize = 16 * 1024;
/// The most bytes of a raw (non-JSON) line's text kept in its log event.
const RAW_TEXT_MAX_BYTES: usize = 4 * 1024;
/// Lines logged per [`RATE_WINDOW`] per sidecar.
const LINES_PER_WINDOW: u32 = 50;
/// The rate-limit window.
const RATE_WINDOW: Duration = Duration::from_secs(1);

/// The bounds one stderr logger applies (tests shrink them).
#[derive(Clone, Copy, Debug)]
struct StderrLogLimits {
    line_max_bytes: usize,
    raw_text_max_bytes: usize,
    lines_per_window: u32,
    window: Duration,
}

impl Default for StderrLogLimits {
    fn default() -> Self {
        Self {
            line_max_bytes: STDERR_LINE_MAX_BYTES,
            raw_text_max_bytes: RAW_TEXT_MAX_BYTES,
            lines_per_window: LINES_PER_WINDOW,
            window: RATE_WINDOW,
        }
    }
}

/// Whether a sidecar spawned with `environment` (its complete environment, or
/// `None` to inherit this process's) runs hosted.
pub(crate) fn hosted_sidecar(environment: Option<&[(String, String)]>) -> bool {
    let value = match environment {
        Some(environment) => environment
            .iter()
            .rev()
            .find(|(key, _)| key == HOSTED_ENV)
            .map(|(_, value)| value.clone()),
        None => std::env::var(HOSTED_ENV).ok(),
    };
    value.is_some_and(|value| !value.is_empty())
}

/// A record's severity, as log.mjs writes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Severity {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

impl Severity {
    fn parse(text: &str) -> Option<Self> {
        match text.to_ascii_lowercase().as_str() {
            "trace" => Some(Self::Trace),
            "debug" => Some(Self::Debug),
            "info" => Some(Self::Info),
            "warn" | "warning" => Some(Self::Warn),
            "error" | "fatal" => Some(Self::Error),
            _ => None,
        }
    }
}

/// The identity a sidecar's log events carry. The session id is bound late:
/// the sidecar starts (and logs `sidecar.ready`) before it names its session.
#[derive(Clone)]
pub(crate) struct SidecarLogLabels {
    inner: Arc<LabelsInner>,
}

struct LabelsInner {
    ownership_id: String,
    session_type: String,
    pid: Option<u32>,
    /// The session's envelope id handle (the id clients address it by; an
    /// attach by durable id may change it), once the sidecar has named it.
    session: OnceLock<Arc<StdMutex<String>>>,
}

impl SidecarLogLabels {
    pub(crate) fn new(ownership_id: &str, session_type: &str, pid: Option<u32>) -> Self {
        Self {
            inner: Arc::new(LabelsInner {
                ownership_id: ownership_id.to_string(),
                session_type: session_type.to_string(),
                pid,
                session: OnceLock::new(),
            }),
        }
    }

    fn ownership_id(&self) -> &str {
        &self.inner.ownership_id
    }

    fn session_type(&self) -> &str {
        &self.inner.session_type
    }

    fn pid(&self) -> Option<u32> {
        self.inner.pid
    }

    /// Bind the session this sidecar serves, by its shared envelope id
    /// handle: every later event carries the handle's current value. Logged
    /// once, as the join between the sidecar's ownership id and its session.
    pub(crate) fn bind_session(&self, envelope: &Arc<StdMutex<String>>) {
        if self.inner.session.set(Arc::clone(envelope)).is_ok() {
            let session_id = self.session_id();
            tracing::info!(
                provider = PROVIDER,
                session_id = session_id.as_deref(),
                session_type = %self.inner.session_type,
                ownership_id = %self.inner.ownership_id,
                pid = self.inner.pid,
                "freshagent.claude.sidecar_bound"
            );
        }
    }

    /// The bound session's current envelope id.
    fn session_id(&self) -> Option<String> {
        self.inner.session.get().map(|envelope| {
            envelope
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone()
        })
    }
}

/// One stderr line as read: at most the line limit of its bytes (no
/// terminator), and its full length.
#[derive(Debug, PartialEq, Eq)]
struct StderrLine {
    bytes: Vec<u8>,
    total_bytes: usize,
}

impl StderrLine {
    fn truncated(&self) -> bool {
        self.total_bytes > self.bytes.len()
    }
}

/// One stderr line, classified.
#[derive(Debug, PartialEq, Eq)]
enum StderrRecord {
    /// A JSON log record. `fields` is the record's remaining keys as compact
    /// JSON. A missing or unknown severity is logged at warn (the unknown
    /// value stays in `fields`).
    Structured {
        severity: Severity,
        component: Option<String>,
        event: Option<String>,
        detail: Option<String>,
        fields: Option<String>,
    },
    /// A line that is not a JSON object. `text` is `None` for a hosted sidecar.
    Raw {
        text: Option<String>,
        bytes: usize,
        truncated: bool,
    },
}

/// Classify one line. A line cut by the reader is never parsed as a record.
fn classify_line(line: &StderrLine, hosted: bool, raw_text_max_bytes: usize) -> StderrRecord {
    if !line.truncated() {
        if let Ok(Value::Object(mut record)) = serde_json::from_slice::<Value>(&line.bytes) {
            let severity = record
                .get("severity")
                .and_then(Value::as_str)
                .and_then(Severity::parse);
            let component = string_field(&record, "component");
            let event = string_field(&record, "event");
            let detail = string_field(&record, "message");
            // The rest stays in the sidecar's order (`retain` keeps it).
            record.retain(|key, value| match key.as_str() {
                "severity" => severity.is_none(),
                "component" | "event" | "message" => !value.is_string(),
                _ => true,
            });
            let fields = (!record.is_empty()).then(|| Value::Object(record).to_string());
            return StderrRecord::Structured {
                severity: severity.unwrap_or(Severity::Warn),
                component,
                event,
                detail,
                fields,
            };
        }
    }
    let kept = line.bytes.len().min(raw_text_max_bytes);
    StderrRecord::Raw {
        text: (!hosted).then(|| utf8_prefix(&line.bytes, kept)),
        bytes: line.total_bytes,
        truncated: line.truncated() || kept < line.bytes.len(),
    }
}

fn string_field(record: &Map<String, Value>, key: &str) -> Option<String> {
    record.get(key).and_then(Value::as_str).map(str::to_string)
}

/// The first `max` bytes as text, never ending inside a character (invalid
/// bytes become U+FFFD).
fn utf8_prefix(bytes: &[u8], max: usize) -> String {
    let mut end = max.min(bytes.len());
    if end < bytes.len() {
        // Back up over continuation bytes (10xxxxxx) to the cut character's start.
        while end > 0 && (bytes[end] & 0xc0) == 0x80 {
            end -= 1;
        }
    }
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

/// Reads lines of at most `max_bytes`, counting (not keeping) the rest of a
/// longer line. Everything consumed is held in `self` between awaits, and the
/// only await is `fill_buf`, so a `next_line` dropped mid-line (cancelled by
/// a `select!`) loses nothing.
struct LineReader {
    max_bytes: usize,
    pending: Vec<u8>,
    total: usize,
    started: bool,
}

impl LineReader {
    fn new(max_bytes: usize) -> Self {
        Self {
            max_bytes,
            pending: Vec::new(),
            total: 0,
            started: false,
        }
    }

    /// The next line without its terminator (`\n` or `\r\n`); `None` at the
    /// end of the stream.
    async fn next_line<R: AsyncBufRead + Unpin>(
        &mut self,
        reader: &mut R,
    ) -> std::io::Result<Option<StderrLine>> {
        loop {
            let (used, ended) = {
                let available = reader.fill_buf().await?;
                if available.is_empty() {
                    return Ok(self.started.then(|| self.finish()));
                }
                let newline = available.iter().position(|&byte| byte == b'\n');
                let chunk = &available[..newline.unwrap_or(available.len())];
                let room = self.max_bytes.saturating_sub(self.pending.len());
                self.pending
                    .extend_from_slice(&chunk[..chunk.len().min(room)]);
                self.total += chunk.len();
                self.started = true;
                (
                    chunk.len() + usize::from(newline.is_some()),
                    newline.is_some(),
                )
            };
            reader.consume(used);
            if ended {
                return Ok(Some(self.finish()));
            }
        }
    }

    fn finish(&mut self) -> StderrLine {
        let mut bytes = std::mem::take(&mut self.pending);
        let mut total_bytes = std::mem::replace(&mut self.total, 0);
        self.started = false;
        if total_bytes == bytes.len() && bytes.last() == Some(&b'\r') {
            bytes.pop();
            total_bytes -= 1;
        }
        StderrLine { bytes, total_bytes }
    }
}

/// Lines per window, with a count of the lines dropped beyond it.
struct LineRateLimiter {
    per_window: u32,
    window: Duration,
    window_start: Instant,
    admitted: u32,
    dropped: u64,
}

impl LineRateLimiter {
    fn new(per_window: u32, window: Duration, now: Instant) -> Self {
        Self {
            per_window,
            window,
            window_start: now,
            admitted: 0,
            dropped: 0,
        }
    }

    /// Whether a line read at `now` is logged. A line beyond the window's
    /// allowance is dropped and counted. Take a due summary first
    /// ([`Self::take_due_summary`]): a new window starts here.
    fn admit(&mut self, now: Instant) -> bool {
        if now >= self.window_start + self.window {
            self.window_start = now;
            self.admitted = 0;
        }
        if self.admitted < self.per_window {
            self.admitted += 1;
            true
        } else {
            self.dropped += 1;
            false
        }
    }

    /// When the summary of the dropped lines is due: the end of their window.
    fn summary_due(&self) -> Option<Instant> {
        (self.dropped > 0).then(|| self.window_start + self.window)
    }

    /// The number of dropped lines, once their window has ended.
    fn take_due_summary(&mut self, now: Instant) -> Option<u64> {
        if self.summary_due().is_some_and(|due| now >= due) {
            Some(std::mem::take(&mut self.dropped))
        } else {
            None
        }
    }

    /// The dropped lines not yet summarized (the stream ended).
    fn take_remaining(&mut self) -> Option<u64> {
        (self.dropped > 0).then(|| std::mem::take(&mut self.dropped))
    }
}

/// Re-emit a sidecar's stderr through `tracing` (see the module docs) on a task
/// that ends with the stream, when the sidecar exits.
pub(crate) fn spawn_stderr_logger<R>(stderr: R, labels: SidecarLogLabels, hosted: bool)
where
    R: AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(run_stderr_logger(
        stderr,
        labels,
        hosted,
        StderrLogLimits::default(),
    ));
}

async fn run_stderr_logger<R>(
    stderr: R,
    labels: SidecarLogLabels,
    hosted: bool,
    limits: StderrLogLimits,
) where
    R: AsyncRead + Unpin,
{
    let mut reader = BufReader::new(stderr);
    let mut lines = LineReader::new(limits.line_max_bytes);
    let mut limiter = LineRateLimiter::new(limits.lines_per_window, limits.window, Instant::now());
    loop {
        let summary_due = limiter.summary_due();
        let read = tokio::select! {
            biased;
            read = lines.next_line(&mut reader) => read,
            () = sleep_until_due(summary_due) => {
                if let Some(dropped) = limiter.take_due_summary(Instant::now()) {
                    emit_dropped(&labels, dropped, limits.window);
                }
                continue;
            }
        };
        let line = match read {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(error) => {
                tracing::warn!(
                    provider = PROVIDER,
                    ownership_id = %labels.ownership_id(),
                    error = %error,
                    "freshagent.claude.sidecar_log_read_failed"
                );
                break;
            }
        };
        if !line.truncated() && line.bytes.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let now = Instant::now();
        if let Some(dropped) = limiter.take_due_summary(now) {
            emit_dropped(&labels, dropped, limits.window);
        }
        if limiter.admit(now) {
            emit_record(
                &labels,
                classify_line(&line, hosted, limits.raw_text_max_bytes),
            );
        }
    }
    if let Some(dropped) = limiter.take_remaining() {
        emit_dropped(&labels, dropped, limits.window);
    }
}

/// Resolves at `due`; never, when nothing is due.
async fn sleep_until_due(due: Option<Instant>) {
    match due {
        Some(due) => tokio::time::sleep_until(due).await,
        None => std::future::pending().await,
    }
}

/// Emit one `tracing` event at a [`Severity`] chosen at run time (the
/// `tracing` macros take the level as a constant).
macro_rules! event_at {
    ($severity:expr, $($rest:tt)+) => {
        match $severity {
            Severity::Trace => tracing::trace!($($rest)+),
            Severity::Debug => tracing::debug!($($rest)+),
            Severity::Info => tracing::info!($($rest)+),
            Severity::Warn => tracing::warn!($($rest)+),
            Severity::Error => tracing::error!($($rest)+),
        }
    };
}

fn emit_record(labels: &SidecarLogLabels, record: StderrRecord) {
    let session_id = labels.session_id();
    match record {
        StderrRecord::Structured {
            severity,
            component,
            event,
            detail,
            fields,
        } => event_at!(
            severity,
            provider = PROVIDER,
            session_id = session_id.as_deref(),
            session_type = %labels.session_type(),
            ownership_id = %labels.ownership_id(),
            pid = labels.pid(),
            component = component.as_deref(),
            sidecar_event = event.as_deref(),
            detail = detail.as_deref(),
            fields = fields.as_deref(),
            "freshagent.claude.sidecar_log"
        ),
        StderrRecord::Raw {
            text,
            bytes,
            truncated,
        } => tracing::warn!(
            provider = PROVIDER,
            session_id = session_id.as_deref(),
            session_type = %labels.session_type(),
            ownership_id = %labels.ownership_id(),
            pid = labels.pid(),
            raw = true,
            bytes,
            truncated,
            text = text.as_deref(),
            "freshagent.claude.sidecar_log"
        ),
    }
}

fn emit_dropped(labels: &SidecarLogLabels, dropped: u64, window: Duration) {
    let session_id = labels.session_id();
    tracing::warn!(
        provider = PROVIDER,
        session_id = session_id.as_deref(),
        session_type = %labels.session_type(),
        ownership_id = %labels.ownership_id(),
        pid = labels.pid(),
        dropped,
        window_ms = window.as_millis() as u64,
        "freshagent.claude.sidecar_log_dropped"
    );
}

/// A thread-local `tracing` capture for this crate's log tests (level,
/// message and fields of every event).
#[cfg(test)]
pub(crate) mod test_capture {
    use std::collections::BTreeMap;
    use std::sync::{Arc, Mutex as StdMutex};
    use tracing::field::{Field, Visit};
    use tracing::{Event, Level, Subscriber};
    use tracing_subscriber::layer::{Context, SubscriberExt};
    use tracing_subscriber::Layer;

    #[derive(Clone, Debug)]
    pub(crate) struct Captured {
        pub level: Level,
        pub message: String,
        pub fields: BTreeMap<String, String>,
    }

    impl Captured {
        pub(crate) fn field(&self, name: &str) -> Option<&str> {
            self.fields.get(name).map(String::as_str)
        }
    }

    #[derive(Default)]
    struct Visitor {
        message: String,
        fields: BTreeMap<String, String>,
    }

    impl Visit for Visitor {
        fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
            let rendered = format!("{value:?}");
            if field.name() == "message" {
                self.message = rendered;
            } else {
                self.fields.insert(field.name().to_string(), rendered);
            }
        }
        fn record_str(&mut self, field: &Field, value: &str) {
            if field.name() == "message" {
                self.message = value.to_string();
            } else {
                self.fields
                    .insert(field.name().to_string(), value.to_string());
            }
        }
    }

    struct CaptureLayer(Arc<StdMutex<Vec<Captured>>>);

    impl<S: Subscriber> Layer<S> for CaptureLayer {
        fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
            let mut visitor = Visitor::default();
            event.record(&mut visitor);
            self.0.lock().expect("capture lock").push(Captured {
                level: *event.metadata().level(),
                message: visitor.message,
                fields: visitor.fields,
            });
        }
    }

    /// Capture this thread's events until the guard drops. On a current-thread
    /// runtime every task a test spawns emits on this thread.
    pub(crate) fn capture() -> (
        Arc<StdMutex<Vec<Captured>>>,
        tracing::subscriber::DefaultGuard,
    ) {
        let events = Arc::new(StdMutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry().with(CaptureLayer(Arc::clone(&events)));
        (events, tracing::subscriber::set_default(subscriber))
    }

    /// The captured events with this message.
    pub(crate) fn with_message(
        events: &Arc<StdMutex<Vec<Captured>>>,
        message: &str,
    ) -> Vec<Captured> {
        events
            .lock()
            .expect("capture lock")
            .iter()
            .filter(|event| event.message == message)
            .cloned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::test_capture::{capture, with_message, Captured};
    use super::*;
    use tokio::io::AsyncWriteExt;
    use tracing::Level;

    fn sidecar_logs(events: &Arc<StdMutex<Vec<Captured>>>) -> Vec<Captured> {
        with_message(events, "freshagent.claude.sidecar_log")
    }

    fn dropped_summaries(events: &Arc<StdMutex<Vec<Captured>>>) -> Vec<Captured> {
        with_message(events, "freshagent.claude.sidecar_log_dropped")
    }

    fn labels() -> SidecarLogLabels {
        SidecarLogLabels::new("claude-sidecar-test-owner", "kilroy", Some(4242))
    }

    /// Run the logger over `input` (then end of stream) to completion.
    async fn log_stderr(
        input: &[u8],
        labels: SidecarLogLabels,
        hosted: bool,
        limits: StderrLogLimits,
    ) {
        let (mut writer, reader) = tokio::io::duplex(input.len() + 1);
        writer.write_all(input).await.expect("write stderr");
        drop(writer);
        run_stderr_logger(reader, labels, hosted, limits).await;
    }

    #[test]
    fn severities_parse_as_log_mjs_writes_them() {
        assert_eq!(Severity::parse("debug"), Some(Severity::Debug));
        assert_eq!(Severity::parse("info"), Some(Severity::Info));
        assert_eq!(Severity::parse("warn"), Some(Severity::Warn));
        assert_eq!(Severity::parse("error"), Some(Severity::Error));
        assert_eq!(Severity::parse("WARNING"), Some(Severity::Warn));
        assert_eq!(Severity::parse("fatal"), Some(Severity::Error));
        assert_eq!(Severity::parse("trace"), Some(Severity::Trace));
        assert_eq!(Severity::parse("loud"), None);
    }

    #[test]
    fn a_hosted_sidecar_is_one_whose_environment_names_a_hosted_agent() {
        let env = |value: &str| vec![(HOSTED_ENV.to_string(), value.to_string())];
        assert!(hosted_sidecar(Some(&env("claude"))));
        assert!(hosted_sidecar(Some(&env("kilroy"))));
        assert!(!hosted_sidecar(Some(&env(""))));
        assert!(!hosted_sidecar(Some(&[(
            "HOME".to_string(),
            "/h".to_string()
        )])));
    }

    #[test]
    fn labels_carry_the_bound_session_and_follow_its_envelope() {
        let labels = labels();
        assert_eq!(
            labels.session_id(),
            None,
            "unbound until the sidecar names its session"
        );
        let envelope = Arc::new(StdMutex::new("placeholder-id".to_string()));
        labels.bind_session(&envelope);
        assert_eq!(labels.session_id().as_deref(), Some("placeholder-id"));
        *envelope.lock().unwrap() = "durable-id".to_string();
        assert_eq!(labels.session_id().as_deref(), Some("durable-id"));
        // A second bind changes nothing: one sidecar serves one session.
        labels.bind_session(&Arc::new(StdMutex::new("other".to_string())));
        assert_eq!(labels.session_id().as_deref(), Some("durable-id"));
    }

    #[test]
    fn binding_logs_the_join_between_ownership_and_session_once() {
        let (events, _guard) = capture();
        let labels = labels();
        let envelope = Arc::new(StdMutex::new("session-a".to_string()));
        labels.bind_session(&envelope);
        labels.bind_session(&envelope);
        let bound = with_message(&events, "freshagent.claude.sidecar_bound");
        assert_eq!(bound.len(), 1, "{bound:?}");
        assert_eq!(bound[0].level, Level::INFO);
        assert_eq!(bound[0].field("session_id"), Some("session-a"));
        assert_eq!(
            bound[0].field("ownership_id"),
            Some("claude-sidecar-test-owner")
        );
        assert_eq!(bound[0].field("session_type"), Some("kilroy"));
        assert_eq!(bound[0].field("pid"), Some("4242"));
    }

    #[test]
    fn the_limiter_admits_a_window_of_lines_and_summarizes_the_rest_when_it_closes() {
        let start = Instant::now();
        let window = Duration::from_millis(100);
        let mut limiter = LineRateLimiter::new(2, window, start);
        assert!(limiter.admit(start));
        assert!(limiter.admit(start + Duration::from_millis(10)));
        assert!(!limiter.admit(start + Duration::from_millis(20)));
        assert!(!limiter.admit(start + Duration::from_millis(30)));
        assert_eq!(limiter.summary_due(), Some(start + window));
        assert_eq!(
            limiter.take_due_summary(start + Duration::from_millis(99)),
            None
        );
        assert_eq!(limiter.take_due_summary(start + window), Some(2));
        assert_eq!(limiter.summary_due(), None);
        // The next window starts with a fresh allowance.
        assert!(limiter.admit(start + Duration::from_millis(150)));
        assert!(limiter.admit(start + Duration::from_millis(160)));
        assert!(!limiter.admit(start + Duration::from_millis(170)));
        assert_eq!(limiter.take_remaining(), Some(1));
        assert_eq!(limiter.take_remaining(), None);
    }

    #[tokio::test]
    async fn records_are_reemitted_at_their_own_severity_with_the_sidecar_labels() {
        let (events, _guard) = capture();
        let input = [
            r#"{"severity":"info","component":"claude-sidecar","event":"sidecar.ready","pid":4242}"#,
            r#"{"severity":"debug","component":"claude-sidecar","event":"x.debugged"}"#,
            r#"{"severity":"warn","component":"claude-sidecar","event":"interrupt.failed","sessionId":"s-1","error":"no"}"#,
            r#"{"severity":"error","component":"claude-cli-sim","event":"simulator_failure","message":"boom"}"#,
            r#"{"severity":"loud","component":"claude-sidecar","event":"x.odd"}"#,
            r#"{"component":"claude-sidecar","event":"x.unlabelled"}"#,
        ]
        .map(|line| format!("{line}\n"))
        .concat();
        log_stderr(
            input.as_bytes(),
            labels(),
            false,
            StderrLogLimits::default(),
        )
        .await;

        let logs = sidecar_logs(&events);
        let summary: Vec<(Level, Option<&str>)> = logs
            .iter()
            .map(|event| (event.level, event.field("sidecar_event")))
            .collect();
        assert_eq!(
            summary,
            vec![
                (Level::INFO, Some("sidecar.ready")),
                (Level::DEBUG, Some("x.debugged")),
                (Level::WARN, Some("interrupt.failed")),
                (Level::ERROR, Some("simulator_failure")),
                (Level::WARN, Some("x.odd")),
                (Level::WARN, Some("x.unlabelled")),
            ]
        );
        for event in &logs {
            assert_eq!(event.field("provider"), Some("claude"));
            assert_eq!(
                event.field("ownership_id"),
                Some("claude-sidecar-test-owner")
            );
            assert_eq!(event.field("session_type"), Some("kilroy"));
            assert_eq!(event.field("pid"), Some("4242"));
            assert_eq!(event.field("session_id"), None, "no session bound yet");
        }
        assert_eq!(logs[0].field("component"), Some("claude-sidecar"));
        assert_eq!(logs[0].field("fields"), Some(r#"{"pid":4242}"#));
        assert_eq!(
            logs[2].field("fields"),
            Some(r#"{"sessionId":"s-1","error":"no"}"#)
        );
        assert_eq!(logs[3].field("component"), Some("claude-cli-sim"));
        assert_eq!(logs[3].field("detail"), Some("boom"));
        assert_eq!(
            logs[4].field("fields"),
            Some(r#"{"severity":"loud"}"#),
            "an unknown severity stays visible"
        );
        assert_eq!(logs[1].field("fields"), None);
    }

    #[tokio::test]
    async fn records_after_the_session_is_bound_carry_its_id() {
        let (events, _guard) = capture();
        let labels = labels();
        let (mut writer, reader) = tokio::io::duplex(4096);
        let logger = tokio::spawn(run_stderr_logger(
            reader,
            labels.clone(),
            false,
            StderrLogLimits::default(),
        ));
        writer
            .write_all(b"{\"severity\":\"info\",\"event\":\"sidecar.ready\"}\n")
            .await
            .unwrap();
        wait_until(|| !sidecar_logs(&events).is_empty()).await;
        labels.bind_session(&Arc::new(StdMutex::new("session-b".to_string())));
        writer
            .write_all(b"{\"severity\":\"warn\",\"event\":\"configure.failed\"}\n")
            .await
            .unwrap();
        drop(writer);
        logger.await.unwrap();
        let logs = sidecar_logs(&events);
        assert_eq!(logs.len(), 2, "{logs:?}");
        assert_eq!(logs[0].field("session_id"), None);
        assert_eq!(logs[1].field("session_id"), Some("session-b"));
        assert_eq!(logs[1].level, Level::WARN);
    }

    #[tokio::test]
    async fn a_line_that_is_not_a_record_is_a_raw_warning_cut_to_4_kib() {
        let (events, _guard) = capture();
        let long = "x".repeat(10 * 1024);
        let input = format!("Error: node crashed\r\n{long}\n\"a json string\"\n42\n");
        log_stderr(
            input.as_bytes(),
            labels(),
            false,
            StderrLogLimits::default(),
        )
        .await;
        let logs = sidecar_logs(&events);
        assert_eq!(logs.len(), 4, "{logs:?}");
        for event in &logs {
            assert_eq!(event.level, Level::WARN);
            assert_eq!(event.field("raw"), Some("true"));
            assert_eq!(
                event.field("ownership_id"),
                Some("claude-sidecar-test-owner")
            );
        }
        assert_eq!(logs[0].field("text"), Some("Error: node crashed"));
        assert_eq!(logs[0].field("bytes"), Some("19"));
        assert_eq!(logs[0].field("truncated"), Some("false"));
        assert_eq!(
            logs[1].field("text").map(str::len),
            Some(RAW_TEXT_MAX_BYTES)
        );
        assert_eq!(logs[1].field("bytes"), Some("10240"));
        assert_eq!(logs[1].field("truncated"), Some("true"));
        assert_eq!(logs[2].field("text"), Some("\"a json string\""));
        assert_eq!(logs[3].field("text"), Some("42"));
    }

    #[tokio::test]
    async fn a_hosted_sidecar_raw_line_is_logged_by_size_only() {
        let (events, _guard) = capture();
        let input = "secret provider output\n{\"severity\":\"info\",\"event\":\"cli.stderr\",\"bytes\":9}\n";
        log_stderr(input.as_bytes(), labels(), true, StderrLogLimits::default()).await;
        let logs = sidecar_logs(&events);
        assert_eq!(logs.len(), 2, "{logs:?}");
        assert_eq!(logs[0].field("raw"), Some("true"));
        assert_eq!(logs[0].field("bytes"), Some("22"));
        assert_eq!(
            logs[0].field("text"),
            None,
            "a hosted raw line keeps no text"
        );
        assert!(
            !format!("{logs:?}").contains("secret provider output"),
            "{logs:?}"
        );
        assert_eq!(logs[1].level, Level::INFO);
        assert_eq!(logs[1].field("sidecar_event"), Some("cli.stderr"));
    }

    #[tokio::test]
    async fn an_overlong_line_is_cut_and_counted_and_the_next_line_still_parses() {
        let (events, _guard) = capture();
        let overlong = format!(
            "{{\"severity\":\"info\",\"event\":\"x\",\"pad\":\"{}\"}}",
            "y".repeat(40 * 1024)
        );
        let input = format!("{overlong}\n{{\"severity\":\"error\",\"event\":\"after\"}}\n");
        log_stderr(
            input.as_bytes(),
            labels(),
            false,
            StderrLogLimits::default(),
        )
        .await;
        let logs = sidecar_logs(&events);
        assert_eq!(logs.len(), 2, "{logs:?}");
        assert_eq!(
            logs[0].level,
            Level::WARN,
            "a cut line is raw, not a record"
        );
        assert_eq!(logs[0].field("raw"), Some("true"));
        assert_eq!(
            logs[0].field("bytes"),
            Some(overlong.len().to_string().as_str())
        );
        assert_eq!(logs[0].field("truncated"), Some("true"));
        assert_eq!(
            logs[0].field("text").map(str::len),
            Some(RAW_TEXT_MAX_BYTES)
        );
        assert_eq!(logs[1].level, Level::ERROR);
        assert_eq!(logs[1].field("sidecar_event"), Some("after"));
    }

    #[tokio::test]
    async fn a_flood_is_limited_to_50_lines_a_second_with_a_dropped_lines_summary() {
        let (events, _guard) = capture();
        let input: String = (0..60)
            .map(|n| format!("{{\"severity\":\"info\",\"event\":\"line.{n}\"}}\n"))
            .collect();
        log_stderr(
            input.as_bytes(),
            labels(),
            false,
            StderrLogLimits::default(),
        )
        .await;
        let logs = sidecar_logs(&events);
        assert_eq!(logs.len(), 50);
        assert_eq!(logs[49].field("sidecar_event"), Some("line.49"));
        let dropped = dropped_summaries(&events);
        assert_eq!(dropped.len(), 1, "{dropped:?}");
        assert_eq!(dropped[0].level, Level::WARN);
        assert_eq!(dropped[0].field("dropped"), Some("10"));
        assert_eq!(
            dropped[0].field("ownership_id"),
            Some("claude-sidecar-test-owner")
        );
        assert_eq!(dropped[0].field("window_ms"), Some("1000"));
    }

    #[tokio::test]
    async fn the_dropped_lines_summary_is_logged_when_its_window_closes() {
        let (events, _guard) = capture();
        let limits = StderrLogLimits {
            lines_per_window: 2,
            window: Duration::from_millis(100),
            ..StderrLogLimits::default()
        };
        let (mut writer, reader) = tokio::io::duplex(4096);
        let logger = tokio::spawn(run_stderr_logger(reader, labels(), false, limits));
        for n in 0..5 {
            writer
                .write_all(format!("{{\"severity\":\"info\",\"event\":\"line.{n}\"}}\n").as_bytes())
                .await
                .unwrap();
        }
        // The stream stays open: the summary comes from the window closing.
        wait_until(|| !dropped_summaries(&events).is_empty()).await;
        let dropped = dropped_summaries(&events);
        assert_eq!(dropped[0].field("dropped"), Some("3"));
        assert_eq!(dropped[0].field("window_ms"), Some("100"));
        assert_eq!(sidecar_logs(&events).len(), 2);
        // A later line in a new window is logged again.
        writer
            .write_all(b"{\"severity\":\"info\",\"event\":\"line.later\"}\n")
            .await
            .unwrap();
        drop(writer);
        logger.await.unwrap();
        let logs = sidecar_logs(&events);
        assert_eq!(logs.len(), 3, "{logs:?}");
        assert_eq!(logs[2].field("sidecar_event"), Some("line.later"));
        assert_eq!(dropped_summaries(&events).len(), 1);
    }

    #[tokio::test]
    async fn blank_lines_and_a_final_unterminated_line_are_handled() {
        let (events, _guard) = capture();
        log_stderr(
            b"\n   \n{\"severity\":\"info\",\"event\":\"last\"}",
            labels(),
            false,
            StderrLogLimits::default(),
        )
        .await;
        let logs = sidecar_logs(&events);
        assert_eq!(logs.len(), 1, "{logs:?}");
        assert_eq!(logs[0].field("sidecar_event"), Some("last"));
    }

    async fn wait_until(mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "timed out");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
}
