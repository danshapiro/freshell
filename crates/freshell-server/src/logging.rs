//! Structured JSONL logging (DIAG-01) with size-based rotation and
//! from-the-first-byte secret redaction (DIAG-03).
//!
//! ## Canonical line schema (the Tauri-ready contract)
//!
//! Every line written to `<home>/.freshell/logs/rust-server.jsonl` is one
//! self-describing JSON object. Fields every line ALWAYS carries:
//!
//!   - `ts`          RFC3339-millis `Z` UTC timestamp (tracing event time)
//!   - `level`       severity: `TRACE`/`DEBUG`/`INFO`/`WARN`/`ERROR`
//!   - `target`      component: the emitting crate's module path (e.g.
//!     `freshell_ws::terminal`, `freshell_terminal::registry`)
//!   - `msg`         human summary or dotted event name (`terminal.created`,
//!     `ws.connection.closed`, `server.started`); events that prefer prose in
//!     `msg` additionally carry an `event` field with the dotted
//!     machine-readable name
//!   - `app_version` the release that wrote the line (DIAG-01 "app version";
//!     resolved once at boot from `FRESHELL_APP_VERSION`/the build constant,
//!     so any arbitrary log tail is attributable)
//!   - `server_pid`  the server process that wrote the line (DIAG-01 process
//!     ownership of the WRITER; child processes an event spawns report their
//!     own `pid` field alongside)
//!
//! Context fields, flattened into the same object when applicable (span
//! fields merge root->leaf, then the event's own fields win collisions):
//!
//!   - HTTP requests: `request_id`, `route`, `method`, `status`,
//!     `duration_ms` (one `http_request` event per response; see
//!     [`request_logging_middleware`])
//!   - WS connections: `connection_id`, `origin_kind` -- carried on the
//!     `ws.connection.established`/`closed` lifecycle events, via the
//!     per-connection `ws_conn` span on every event emitted while serving
//!     that connection, AND as explicit event fields on the create-reply
//!     settle companions (`ws.terminal.create.settled` with
//!     `connection_id`/`request_id`/`terminal_id`/`path`). Ownership-
//!     envelope NOTE: span enrichment is active under bare level filters
//!     (any `RUST_LOG=error..trace`) and globally-anchored mixes
//!     (`info,freshell_terminal=debug`); tracing-subscriber disables span
//!     callsites under TARGET-DIRECTIVE-ONLY filters (even a matched
//!     `freshell_ws=info`), which is exactly why the settle companions
//!     carry the join as event fields -- event fields ride through any
//!     filter admitting the event. Under `freshell_ws=off` nothing in the
//!     ws crate logs at all (operator's express choice); a
//!     `terminal.created` line then joins only via `terminal_id`.
//!   - Terminals: `terminal_id` plus spawn-mode/cwd/pid on
//!     `terminal.created`, `exit_code` on `terminal.exited`, the kill actor
//!     (`by`: api/idle/shutdown) on `terminal.killed`
//!   - Fresh agents: `provider` + `session_id` on the session lifecycle
//!     events (`freshagent.session.created`, `...session.crash_detected`,
//!     `...sidecar.reaped`, crash-recovery events); `freshagent.sidecar.spawned`
//!     carries `provider` + the spawned process `pid` (no `session_id` --
//!     the spawn can precede session minting on the create path; the
//!     pid<->session join is the same session's adjacent created/reaped
//!     events). Prompt/turn CONTENT is never logged anywhere.
//!   - Server lifecycle: `server.started` (`bind`, `port`, `boot_id`,
//!     `instance_id`, `commit`, `dirty`) -> `server.stopping` (`signal`)
//!     -> `server.stopped` (plus the `shutdown_forensics` diagnostic record)
//!
//! A Tauri host-side producer (or any other Rust component of the desktop
//! app) emitting THIS EXACT SHAPE -- with its own `app_version` and its
//! process's pid -- produces a coherent, combinable diagnostic stream; the
//! schema is deliberately free of server-only assumptions so that producer
//! can be layered on without a contract change.
//!
//! ## Rotation + redaction (DIAG-03)
//!
//!   - **Size-based rotation**, bounded total: [`DEFAULT_MAX_BYTES`] per file
//!     (10 MiB) x [`DEFAULT_MAX_BACKUPS`] backups (2) = 3 files total,
//!     overridable via `FRESHELL_LOG_MAX_BYTES`/`FRESHELL_LOG_MAX_BACKUPS`.
//!     This is a deliberate deviation from the legacy Node server's
//!     `rotating-file-stream` defaults (`server/logger.ts`:
//!     `DEFAULT_DEBUG_LOG_SIZE = '10M'`, `maxFiles: 5`) -- same per-file size,
//!     a smaller total file count for this first slice. Documented, not a
//!     parity claim.
//!   - **Redaction from the first byte**: every line is scrubbed by
//!     [`scrub`] in [`RotatingWriter::write_line`] BEFORE it reaches disk --
//!     a writer-level guarantee, not call-site discipline. Covers the live
//!     `AUTH_TOKEN` value verbatim (wherever it appears: header, query
//!     string, JSON body, nested error text) plus any JSON field whose KEY
//!     contains "token" (case-insensitive -- covers `token`, `authToken`,
//!     `x-auth-token`, `AUTH_TOKEN`, ...) or is exactly "cookie", and a raw
//!     `Cookie:`/`Set-Cookie:` header fragment if one is ever logged as plain
//!     text (belt-and-braces; no current call site does this).
//!   - **Level control**: `RUST_LOG` (standard `tracing_subscriber::EnvFilter`
//!     syntax), default `info` -- mirrors the legacy server's `LOG_LEVEL`
//!     env-var convention (`server/logger.ts`), one canonical env var deep.
//!   - The pre-existing single stdout ("`freshell-server listening on
//!     ...`") line is left untouched for compat -- this module is additive.
//!
//! ## NOT in scope
//!
//!   - OTLP/telemetry export, remote log shipping.
//!   - Client-log ingestion (`DIAG-02`), live debug/perf toggles (`DIAG-04`).
//!
//! See `crates/freshell-server/tests/diag01_diag03_logging.rs` (rotation/
//! redaction) and `crates/freshell-server/tests/diag01_lifecycle_logging.rs`
//! (full-flow schema + correlation + restart) for the outer, black-box,
//! operator-experience proof of this contract.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use axum::extract::Request;
use axum::http::Uri;
use axum::middleware::Next;
use axum::response::Response;
#[cfg(test)]
use freshell_runtime_observability::scrub;
use freshell_runtime_observability::RotatingJsonlWriter as RotatingWriter;
use serde_json::{Map, Value};
use tracing::field::{Field, Visit};
use tracing::span::{Attributes, Id, Record};
use tracing::{Event, Instrument, Subscriber};
use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::Layer;

/// Fixed log file name under `<log_dir>/` -- deliberately NOT parameterized
/// per-mode/per-instance like the legacy server's debug log (that convention
/// exists to let multiple concurrent Node dev instances coexist; the Rust
/// server here is one binary, one file, kept simple per this slice's scope).
pub const LOG_FILE_NAME: &str = "rust-server.jsonl";

/// Default per-file size cap before rotating: 10 MiB, matching the legacy
/// server's `rotating-file-stream` size default (`server/logger.ts`
/// `DEFAULT_DEBUG_LOG_SIZE = '10M'`).
pub const DEFAULT_MAX_BYTES: u64 = 10 * 1024 * 1024;

/// Default number of rotated backups kept (`.1`, `.2`, ...), in addition to
/// the active file -- 3 files total. A documented, smaller-than-legacy
/// default for this slice (legacy keeps 5-10); see the module doc comment.
pub const DEFAULT_MAX_BACKUPS: u32 = 2;

/// Resolved configuration for [`init`].
pub struct LoggingConfig {
    pub log_dir: PathBuf,
    pub max_bytes: u64,
    pub max_backups: u32,
    /// The live secret (the process's `AUTH_TOKEN`) to scrub verbatim from
    /// every log line. Never logged itself, including here (this struct is
    /// never `Debug`-derived/printed).
    pub secret: String,
    /// The app version stamped onto EVERY line as `app_version` (DIAG-01's
    /// "app version" field): any arbitrary log tail is then attributable to
    /// the release that produced it without cross-referencing boot lines.
    /// Resolved by the caller (`main.rs`: `FRESHELL_APP_VERSION` env ->
    /// `APP_VERSION` const) so this module stays env-free about versioning
    /// and tests can inject a known value.
    pub app_version: String,
}

/// Resolve [`LoggingConfig`] from the environment, mirroring the legacy
/// server's `FRESHELL_LOG_DIR` override convention (`server/logger.ts`
/// `resolveDebugLogPath`) and adding two new, narrowly-scoped overrides
/// (`FRESHELL_LOG_MAX_BYTES`/`FRESHELL_LOG_MAX_BACKUPS`) so the rotation
/// bound is testable without waiting to actually accumulate 10 MiB.
pub fn resolve_config(home: Option<&Path>, secret: String, app_version: String) -> LoggingConfig {
    let log_dir = std::env::var("FRESHELL_LOG_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            home.map(|h| h.join(".freshell").join("logs"))
                .unwrap_or_else(|| PathBuf::from(".freshell").join("logs"))
        });
    let max_bytes = std::env::var("FRESHELL_LOG_MAX_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_BYTES);
    let max_backups = std::env::var("FRESHELL_LOG_MAX_BACKUPS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(DEFAULT_MAX_BACKUPS);
    LoggingConfig {
        log_dir,
        max_bytes,
        max_backups,
        secret,
        app_version,
    }
}

/// Install the global `tracing` subscriber: a `RUST_LOG`-controlled
/// (default `info`) [`EnvFilter`](tracing_subscriber::EnvFilter) wrapping the
/// custom [`JsonLayer`] over a redacting, size-rotating file writer.
///
/// Returns an error (never panics) if the log directory/file cannot be
/// created, or if a global subscriber is already installed -- either way the
/// server should keep booting with logging disabled rather than abort (the
/// pre-existing stderr "listening on" line still gets the operator to a
/// running server either way).
pub fn init(config: LoggingConfig) -> std::io::Result<()> {
    let path = config.log_dir.join(LOG_FILE_NAME);
    let writer = RotatingWriter::create(path, config.max_bytes, config.max_backups, config.secret)?;

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    let json_layer = JsonLayer {
        writer,
        app_version: config.app_version,
        server_pid: std::process::id() as u64,
    };
    let subscriber = tracing_subscriber::registry()
        .with(env_filter)
        .with(json_layer);

    tracing::subscriber::set_global_default(subscriber)
        .map_err(|err| std::io::Error::other(err.to_string()))
}

// ───────────────────────── redaction + rotation (DIAG-03) ─────────────────────────
//
// `scrub` and `RotatingJsonlWriter` live in the lower-level
// freshell-runtime-observability crate so supervisor incident reports and host
// diagnostics have the exact same from-first-byte redaction and size bounds.

// ───────────────────────── JSON event formatting (DIAG-01) ─────────────────────────

/// Collects a `tracing` span's or event's fields into a JSON map, splitting
/// out the implicit `message` field (renamed to `msg` at the call site) from
/// everything else (flattened into the top-level object).
#[derive(Default)]
struct JsonVisitor {
    message: Option<String>,
    fields: Map<String, Value>,
}

impl Visit for JsonVisitor {
    fn record_debug(&mut self, field: &Field, value: &dyn std::fmt::Debug) {
        let rendered = format!("{value:?}");
        if field.name() == "message" {
            self.message = Some(rendered);
        } else {
            self.fields
                .insert(field.name().to_string(), Value::String(rendered));
        }
    }

    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = Some(value.to_string());
        } else {
            self.fields
                .insert(field.name().to_string(), Value::String(value.to_string()));
        }
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields
            .insert(field.name().to_string(), Value::from(value));
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields
            .insert(field.name().to_string(), Value::from(value));
    }

    fn record_f64(&mut self, field: &Field, value: f64) {
        self.fields
            .insert(field.name().to_string(), Value::from(value));
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.fields
            .insert(field.name().to_string(), Value::from(value));
    }
}

/// A `tracing_subscriber::Layer` that formats every event as one JSONL line
/// with exactly the fields DIAG-01 calls for (`ts`, `level`, `target`,
/// `msg`, plus flattened span/event key-values such as `request_id`,
/// `route`, `status`, `duration_ms`), and writes it through a
/// [`RotatingWriter`] (which redacts before any byte reaches disk).
///
/// Every line is additionally stamped with `app_version` (the release that
/// produced it) and `server_pid` (the process that wrote it) -- DIAG-01's
/// app-version and process-ownership requirements at per-line granularity,
/// so ANY arbitrary log tail is self-attributing (which build, which
/// process) without cross-referencing a boot line that may have rotated
/// away. Both are inserted into the base field map BEFORE span/event fields
/// merge, so an event that legitimately carries its own `pid` (e.g. a
/// spawned child's pid on `terminal.created`) keeps its own meaning --
/// `server_pid` never collides with it.
///
/// Hand-rolled rather than `tracing_subscriber::fmt`'s JSON formatter
/// because `fmt` hardcodes different field names (`timestamp`/`message`,
/// nested `fields`/`span` objects) with no rename hook -- reimplementing the
/// ~80 lines below is simpler than fighting that shape.
struct JsonLayer {
    writer: RotatingWriter,
    app_version: String,
    server_pid: u64,
}

/// Span-local storage for this layer: the JSON fields recorded when the
/// span was created (`request_id`, `route`, `method`, ...), merged into
/// every event logged while that span is the current context.
struct SpanFields(Map<String, Value>);

impl<S> Layer<S> for JsonLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_new_span(&self, attrs: &Attributes<'_>, id: &Id, ctx: Context<'_, S>) {
        let mut visitor = JsonVisitor::default();
        attrs.record(&mut visitor);
        if let Some(span) = ctx.span(id) {
            span.extensions_mut().insert(SpanFields(visitor.fields));
        }
    }

    fn on_record(&self, id: &Id, values: &Record<'_>, ctx: Context<'_, S>) {
        let mut visitor = JsonVisitor::default();
        values.record(&mut visitor);
        if let Some(span) = ctx.span(id) {
            let mut extensions = span.extensions_mut();
            if let Some(existing) = extensions.get_mut::<SpanFields>() {
                existing.0.extend(visitor.fields);
            } else {
                extensions.insert(SpanFields(visitor.fields));
            }
        }
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        let mut visitor = JsonVisitor::default();
        event.record(&mut visitor);

        let mut map = Map::new();
        map.insert("ts".to_string(), Value::String(now_rfc3339_millis()));
        map.insert(
            "level".to_string(),
            Value::String(event.metadata().level().to_string()),
        );
        map.insert(
            "target".to_string(),
            Value::String(event.metadata().target().to_string()),
        );
        // DIAG-01 per-line identity: the emitting build + process, before
        // any span/event fields merge (event-level fields would win a
        // collision; no call site uses either name -- verified by rg across
        // all server-side crates when this was added).
        map.insert(
            "app_version".to_string(),
            Value::String(self.app_version.clone()),
        );
        map.insert("server_pid".to_string(), Value::from(self.server_pid));

        // Merge span-chain fields root -> leaf, so the innermost span's
        // fields win on any (unexpected) key collision.
        if let Some(scope) = ctx.event_scope(event) {
            for span in scope.from_root() {
                let extensions = span.extensions();
                if let Some(SpanFields(fields)) = extensions.get::<SpanFields>() {
                    for (k, v) in fields {
                        map.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        // The event's own fields override span fields on collision.
        for (k, v) in visitor.fields {
            map.insert(k, v);
        }
        map.insert(
            "msg".to_string(),
            Value::String(visitor.message.unwrap_or_default()),
        );

        if let Ok(line) = serde_json::to_string(&Value::Object(map)) {
            let _ = self.writer.write_line(&line);
        }
    }
}

/// Millisecond-precision RFC3339 UTC timestamp, matching the legacy
/// server's `pino.stdTimeFunctions.isoTime` convention (`server/logger.ts`)
/// and the same format `main.rs` already uses for `started_at`.
fn now_rfc3339_millis() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

// ───────────────────────── HTTP request correlation (DIAG-01) ─────────────────────────

static REQUEST_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Strip the `token` query parameter from a request path before logging it,
/// mirroring the legacy server's `sanitizeUrl` (`server/request-logger.ts`) --
/// belt-and-braces alongside the writer-level [`scrub`], since a token
/// passed as a query parameter (e.g. a WS connect URL) should never even
/// reach the formatter as raw text.
fn sanitize_route(uri: &Uri) -> String {
    let path = uri.path();
    let Some(query) = uri.query() else {
        return path.to_string();
    };
    let filtered: Vec<&str> = query
        .split('&')
        .filter(|kv| {
            !kv.split('=')
                .next()
                .map(|k| k.eq_ignore_ascii_case("token"))
                .unwrap_or(false)
        })
        .collect();
    if filtered.is_empty() {
        path.to_string()
    } else {
        format!("{path}?{}", filtered.join("&"))
    }
}

/// Global axum middleware: assigns a `req-<uuid>` correlation id to every
/// request, logs one `http_request` event per response (level chosen by
/// status: `error` for 5xx, `warn` for 4xx, `info` otherwise) carrying
/// `request_id`, `route`, `method`, `status`, `duration_ms`, and echoes the
/// id back as the `x-request-id` response header (legacy parity,
/// `server/request-logger.ts`).
///
/// This is the mechanism behind DIAG-01's "request errors (4xx/5xx with
/// route)" and the general per-request correlation id requirement; see the
/// module doc comment for what is deliberately NOT covered by this one
/// layer (WS post-upgrade lifecycle, terminal/fresh-agent internals).
pub async fn request_logging_middleware(req: Request, next: Next) -> Response {
    let request_id = format!(
        "req-{}-{}",
        std::process::id(),
        REQUEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let method = req.method().as_str().to_string();
    let route = sanitize_route(req.uri());
    let start = std::time::Instant::now();
    let span = tracing::info_span!(
        "http_request",
        request_id = %request_id,
        route = %route,
        method = %method,
    );

    async move {
        let mut response = next.run(req).await;
        let status = response.status().as_u16();
        let duration_ms = start.elapsed().as_millis() as u64;
        match status {
            500..=599 => tracing::error!(status, duration_ms, "http_request"),
            400..=499 => tracing::warn!(status, duration_ms, "http_request"),
            _ => tracing::info!(status, duration_ms, "http_request"),
        }
        if let Ok(value) = axum::http::HeaderValue::from_str(&request_id) {
            response.headers_mut().insert("x-request-id", value);
        }
        response
    }
    .instrument(span)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_line_stamps_app_version_and_server_pid() {
        let dir = std::env::temp_dir().join(format!(
            "freshell-logging-stamp-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rust-server.jsonl");
        let writer = RotatingWriter::create(path.clone(), 1 << 20, 1, String::new()).unwrap();
        let layer = JsonLayer {
            writer,
            app_version: "9.9.9-test".to_string(),
            server_pid: 424242,
        };
        let subscriber = tracing_subscriber::registry().with(layer);
        tracing::subscriber::with_default(subscriber, || {
            tracing::info!(route = "/api/health", "http_request");
        });
        let content = std::fs::read_to_string(&path).unwrap();
        let line: serde_json::Value =
            serde_json::from_str(content.lines().next().unwrap()).unwrap();
        assert_eq!(line["app_version"], serde_json::json!("9.9.9-test"));
        assert_eq!(line["server_pid"], serde_json::json!(424242u64));
        // The pre-existing envelope fields must still be there.
        assert!(line["ts"].as_str().unwrap().ends_with('Z'));
        assert_eq!(line["level"], serde_json::json!("INFO"));
        assert_eq!(line["msg"], serde_json::json!("http_request"));
        assert_eq!(line["route"], serde_json::json!("/api/health"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn scrub_redacts_the_exact_secret_value_wherever_it_appears() {
        let secret = "s3cr3t-abc123";
        let line = format!(
            r#"{{"ts":"now","msg":"auth","raw_query":"?token={secret}","nested":{{"deep":"has {secret} inside"}}}}"#
        );
        let out = scrub(&line, secret);
        assert!(!out.contains(secret), "secret leaked: {out}");
        assert!(out.contains("***REDACTED***"));
    }

    #[test]
    fn scrub_redacts_any_token_named_json_field_even_without_the_known_secret() {
        let line = r#"{"ts":"now","authToken":"whatever-value","x-auth-token":"another","AUTH_TOKEN":"third"}"#;
        let out = scrub(line, "");
        assert!(!out.contains("whatever-value"));
        assert!(!out.contains("\"another\""));
        assert!(!out.contains("\"third\""));
        assert!(out.contains("\"authToken\":\"***REDACTED***\""));
    }

    #[test]
    fn scrub_redacts_cookie_json_field() {
        let line = r#"{"ts":"now","cookie":"freshell-auth=abcdef123456"}"#;
        let out = scrub(line, "");
        assert!(!out.contains("freshell-auth=abcdef123456"));
        assert!(out.contains("\"cookie\":\"***REDACTED***\""));
    }

    #[test]
    fn scrub_redacts_raw_cookie_header_fragment() {
        let line = r#"{"ts":"now","msg":"Cookie: freshell-auth=abcdef123456; other=1"}"#;
        let out = scrub(line, "");
        assert!(!out.contains("freshell-auth=abcdef123456"));
    }

    #[test]
    fn scrub_preserves_non_secret_content() {
        let line = r#"{"ts":"now","level":"INFO","target":"freshell_server","msg":"hello","route":"/api/health","status":200}"#;
        let out = scrub(line, "unrelated-secret");
        assert_eq!(out, line, "scrub must not alter lines without secrets");
    }

    #[test]
    fn rotation_bounds_total_files_and_active_size() {
        let dir = std::env::temp_dir().join(format!(
            "freshell-logging-rotation-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("rust-server.jsonl");
        let writer = RotatingWriter::create(path.clone(), 200, 2, String::new()).unwrap();

        for i in 0..200 {
            let _ = writer.write_line(&format!(
                r#"{{"ts":"now","level":"INFO","target":"t","msg":"line {i} padding padding"}}"#
            ));
        }

        let active_len = std::fs::metadata(&path).unwrap().len();
        assert!(
            active_len <= 200 * 2,
            "active file should stay bounded near the 200-byte cap, got {active_len}"
        );

        let mut backup1 = path.as_os_str().to_os_string();
        backup1.push(".1");
        let backup1 = PathBuf::from(backup1);
        assert!(backup1.exists(), "expected at least one rotated backup");

        let mut total_files = 1;
        for n in 1..=3u32 {
            let mut s = path.as_os_str().to_os_string();
            s.push(format!(".{n}"));
            if PathBuf::from(s).exists() {
                total_files += 1;
            }
        }
        assert!(
            total_files <= 3,
            "expected at most 3 total files (active + 2 backups), found {total_files}"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_route_strips_only_the_token_query_param() {
        let uri: Uri = "/ws?token=abc123&other=1".parse().unwrap();
        assert_eq!(sanitize_route(&uri), "/ws?other=1");

        let uri: Uri = "/api/health".parse().unwrap();
        assert_eq!(sanitize_route(&uri), "/api/health");
    }
}
