//! Boot-time REST surface for the RETAINED React SPA (Phase 3.10).
//!
//! The original serves the built `dist/client` bundle and answers a handful of
//! HTTP endpoints the SPA fetches on first paint. This module ports the minimal
//! set the SPA needs to reach "connected" and create a first terminal against the
//! Rust server (the gateway to the oracle's T3 e2e/visual tier):
//!
//! * `GET /api/bootstrap` — shell-critical first-paint payload
//!   (`{ settings, platform, shell:{authenticated:true} }`), mirroring
//!   `server/shell-bootstrap-router.ts`. This is the SPA's primary boot fetch
//!   (`App.tsx` → `getBootstrap()`).
//! * `GET /api/platform` — `{ platform, availableClis, hostName, featureFlags }`
//!   (mirrors `server/platform-router.ts`), consumed by the PanePicker to decide
//!   which shell buttons to show.
//! * `GET /api/version` — `{ currentVersion, updateCheck:null }`.
//! * `GET /api/settings` — the full `ServerSettings` tree (mirrors
//!   `server/settings-router.ts` `router.get('/')`). Also the endpoint
//!   `auth.spec.ts` probes to assert unauthenticated requests are rejected 401.
//! * `GET /api/session-directory` — an empty read-model page for a clean isolated
//!   boot (`SessionDirectoryPageSchema`-shaped).
//! * `GET /api/network/status` — a minimal loopback status so `fetchNetworkStatus`
//!   resolves rather than erroring.
//!
//! ## Auth
//!
//! Every route here is gated exactly like `server/auth.ts#httpAuthMiddleware`:
//! the `x-auth-token` header (or the `freshell-auth` cookie, url-decoded) must
//! match `AUTH_TOKEN` under a constant-time compare, else `401 {error}`.
//! `/api/health` (in `freshell-api`) stays unauthenticated.
//!
//! Everything here is ADDITIVE and read-only against the retained client; no
//! `server/` or `shared/` source is touched.

use std::sync::Arc;

use axum::{
    extract::{Path as AxumPath, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::settings_store::SettingsStore;

/// Shared, cheaply-cloneable state for the boot REST surface.
#[derive(Clone)]
pub struct BootState {
    /// The required auth token (`AUTH_TOKEN`) — the gate for every route here.
    pub auth_token: Arc<String>,
    /// The LIVE server-settings store (R2): embedded in the `bootstrap` payload's
    /// `settings` field. `GET /api/settings` itself now lives in
    /// `settings_store::router` (merged separately in `main.rs`), so the settings
    /// state here is read-only from this module's point of view.
    pub settings: SettingsStore,
    /// The precomputed platform payload
    /// (`{ platform, availableClis, hostName, featureFlags }`) shared by
    /// `GET /api/platform` and `bootstrap.platform`.
    pub platform: Arc<Value>,
    /// The app version string reported by `GET /api/version`.
    pub app_version: Arc<String>,
    /// The shared in-memory tabs registry — the `POST /api/tabs-sync/client-retire`
    /// beacon retires a client's snapshot here (the SAME registry the `/ws`
    /// `tabs.sync.*` path uses), so an unload without a live socket still drops the
    /// closing client's tabs from every other viewer.
    pub tabs: freshell_ws::tabs::TabsRegistry,
    /// The client extensions registry (`toClientRegistry()`), returned by
    /// `GET /api/extensions` (Follow-up 3.19) so the SPA's picker knows the real
    /// CLI agents. Precomputed at boot (immutable for the process life).
    pub extensions: std::sync::Arc<Vec<Value>>,
    /// R5: the live GitHub-release update checker backing `GET /api/version`'s
    /// `updateCheck` field (`crate::updater`). Cloneable (an `Arc`-backed cache
    /// inside), shared across every request.
    pub update_checker: crate::updater::UpdateChecker,
}

/// The boot REST sub-router, pre-bound to its state (mergeable into the app).
///
/// `GET /api/settings` merges with the freshcodex crate's `PATCH /api/settings`
/// (axum combines the two method routers on the same path).
pub fn router(state: BootState) -> Router {
    Router::new()
        .route("/api/bootstrap", get(bootstrap))
        .route("/api/platform", get(platform))
        .route("/api/version", get(version))
        .route("/api/extensions", get(extensions))
        .route("/api/extensions/{name}", get(extension_by_name))
        .route("/api/logs/client", post(logs_client))
        .route(
            "/api/tabs-sync/client-retire",
            post(tabs_sync_client_retire),
        )
        .with_state(state)
}

// ── Handlers ────────────────────────────────────────────────────────────────

/// `GET /api/bootstrap` → the shell-critical first-paint payload.
async fn bootstrap(State(state): State<BootState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let settings = state.settings.get().await;
    // `shell`: `server/index.ts:191` wires `getShellTaskStatus` to
    // `startupState.snapshot().tasks`; the original registers exactly two
    // startup tasks (`sessionRepairService` @ index.ts:886, `codingCliIndexer`
    // @ index.ts:901 — key order as observed live) and `ready` is
    // `Object.values(tasks).every(Boolean)`. The port performs its equivalent
    // init before binding the listener, so the steady-state snapshot (all
    // true) is the faithful response for every observable request.
    // `perf`: `getPerfLogging` (`index.ts:192`) → `{ logging: perfConfig.enabled }`,
    // where enabled = parseBoolean(PERF_LOGGING) || parseBoolean(PERF_DEBUG)
    // (`server/perf-logger.ts:33-35`).
    Json(json!({
        "settings": settings,
        "platform": &*state.platform,
        "shell": {
            "authenticated": true,
            "ready": true,
            "tasks": { "sessionRepairService": true, "codingCliIndexer": true },
        },
        "perf": { "logging": perf_logging_enabled() },
    }))
    .into_response()
}

/// `parseBoolean(env.PERF_LOGGING) || parseBoolean(env.PERF_DEBUG)`
/// (`server/perf-logger.ts:20-24,35`): trimmed, lowercased ∈ {1,true,yes,on}.
fn perf_logging_enabled() -> bool {
    fn parse(k: &str) -> bool {
        std::env::var(k)
            .map(|v| {
                let n = v.trim().to_lowercase();
                n == "1" || n == "true" || n == "yes" || n == "on"
            })
            .unwrap_or(false)
    }
    parse("PERF_LOGGING") || parse("PERF_DEBUG")
}

/// `GET /api/extensions/:name` \u2192 the single `ClientExtensionEntry` (R6). A
/// missing extension is `404 {"error":"Extension not found: '<name>'"}`, byte-
/// matching `extension-routes.ts:20-24`.
async fn extension_by_name(
    State(state): State<BootState>,
    headers: HeaderMap,
    AxumPath(name): AxumPath<String>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    match state
        .extensions
        .iter()
        .find(|e| e.get("name").and_then(Value::as_str) == Some(name.as_str()))
    {
        Some(entry) => Json(entry.clone()).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": format!("Extension not found: '{name}'") })),
        )
            .into_response(),
    }
}

/// `GET /api/platform` → `{ platform, availableClis, hostName, featureFlags }`.
async fn platform(State(state): State<BootState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json((*state.platform).clone()).into_response()
}

/// `GET /api/version` → `{ currentVersion, updateCheck:null }`.
async fn version(State(state): State<BootState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // R5: a LIVE GitHub update check (`crate::updater`), not a static `null` \u2014
    // verified against the ORIGINAL in this environment (real internet egress).
    let update_check = state.update_checker.check(&state.app_version).await;
    Json(json!({ "currentVersion": &*state.app_version, "updateCheck": update_check }))
        .into_response()
}

/// `GET /api/extensions` → the client extensions registry (`toClientRegistry()`,
/// `server/extension-routes.ts:15-17`). Follow-up 3.19: this now returns the real
/// discovered CLI extensions (claude/codex/opencode/…) so the SPA's PanePicker can
/// surface the coding-CLI agents, instead of the earlier empty `[]`. The SPA's
/// `useEnsureExtensionsRegistry` consumes this as the `ClientExtensionEntry[]`
/// array.
async fn extensions(State(state): State<BootState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(&*state.extensions).into_response()
}

/// `POST /api/logs/client` → the client-log sink (`server/client-logs.ts`).
/// The original validates the body against the strict zod
/// `ClientLogsPayloadSchema` (`{ client?, entries: ClientLogEntry[1..200] }`),
/// answering `400 { error: "Invalid request", details: issues }` on failure and
/// **204 No Content** on success (the entries are only logged server-side).
/// Issue objects below are ground-truthed against the LIVE original (zod v4).
async fn logs_client(
    State(state): State<BootState>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // express.json() strict mode: empty body → `{}` (then fails zod on the
    // missing `entries`); malformed / non-object-or-array top-level JSON →
    // express's own 400 HTML error page BEFORE the route runs.
    let parsed: Value = if body.is_empty() {
        Value::Object(serde_json::Map::new())
    } else {
        match serde_json::from_slice::<Value>(&body) {
            Ok(v @ (Value::Object(_) | Value::Array(_))) => v,
            Ok(_) | Err(_) => return crate::terminals::express_bad_request(),
        }
    };
    let issues = client_logs_issues(&parsed);
    if issues.is_empty() {
        // Confirmed production bug (see this fn's doc comment): validation
        // passing used to be a dead end -- the entries were never emitted
        // anywhere, so every browser-reported error/warning vanished. Emit
        // each one now, giving parity with the original's `logClientEntry`
        // (`server/client-logs.ts:33-53`).
        let entries = parsed
            .get("entries")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let client = parsed.get("client").cloned();
        emit_client_log_entries(client.as_ref(), &entries);
        StatusCode::NO_CONTENT.into_response()
    } else {
        (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid request", "details": issues })),
        )
            .into_response()
    }
}

/// Emit one `tracing` event per validated client-log entry, so browser-
/// reported log lines land in `rust-server.jsonl` (target
/// `freshell_server::client_logs`) exactly like every other structured
/// server event, instead of being silently discarded.
///
/// Parity with the original (`server/client-logs.ts:33-53`): each entry is
/// emitted at ITS OWN severity (`log[level](...)`, never coerced to a single
/// fixed level), with `message = entry.message || entry.event || 'Client
/// log'`. This handler runs inside the request's `http_request` span
/// ([`crate::logging::request_logging_middleware`]), so `request_id` /
/// `route` / `method` are already merged onto every event here by
/// `JsonLayer` -- no extra plumbing needed to correlate a client-reported
/// error back to the request that carried it.
///
/// Field names below are snake_case (`client_id`, `client_event`, ...),
/// matching this crate's existing JSONL convention (`request_id`,
/// `duration_ms`) rather than legacy's camelCase (`clientId`, `clientEvent`)
/// -- a deliberate, documented naming divergence. The parity contract is
/// "every entry lands, at its own severity, with its message and context" --
/// not the exact key spelling. `ip`/raw `userAgent` (legacy attaches these
/// per-entry from `req.ip`/`req.headers['user-agent']`) are not currently
/// captured as span fields anywhere in this port and are out of scope here.
///
/// No separate cap is applied here: `entries` is already bounded to `1..=200`
/// by [`client_logs_issues`]'s zod-parity check before this ever runs, so a
/// single request can never emit an unbounded number of lines.
/// Pre-emission redaction for client-supplied strings (review follow-up on
/// the `emit_client_log_entries` fix, commit ad77b571): the writer-level
/// [`scrub`](crate::logging) regexes match `"token":"…"` / `"cookie":"…"`
/// fields with PLAIN quotes on the final disk line -- but client-supplied
/// `message`/`args`/`context` strings are re-serialized JSON that the JSONL
/// writer JSON-encodes AGAIN, so any secret-bearing field inside them
/// reaches the disk line with ESCAPED quotes (`\"token\":…`, `\\\"token\\\":…`)
/// that defeat those patterns.
///
/// This scrub therefore runs over the RAW string forms here, BEFORE
/// emission, and matches BOTH quote forms:
///   * plain `"key":"value"` (a client that put JSON text straight into
///     `message` -- depth 0 in the raw string, escaped once on disk);
///   * escaped `\"key\":\"value\"` at any backslash depth (`\\+"`) -- the
///     reported leak: a client logging an object something upstream had
///     already serialized, so the `args`/`context` element is a STRING of
///     JSON text (depth 1+ in the raw string after this module's own
///     `ToString` re-serialization).
///
/// The plain-quote patterns are kept byte-identical to `logging.rs`'s
/// writer-level ones (which remain in place as the belt-and-braces layer;
/// the exact-`AUTH_TOKEN` replacement there already catches the live secret
/// at any depth since it is a quote-free literal match). Known, accepted
/// residual of the escaped variant: the value matcher is lazy, so a token
/// value that ITSELF contains a deeper-escaped quote (depth >= 2 nesting
/// inside the value) terminates the redaction span at that inner quote --
/// the token-named KEY at every depth still matches directly, and the
/// replacement always removes the value bytes up to the first quote, so the
/// failure direction is over-truncated redaction, never a longer leak than
/// today's.
fn scrub_client_supplied(raw: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;

    // Plain-quote token/cookie fields (byte-identical to logging.rs).
    static PLAIN_TOKEN_RE: OnceLock<Regex> = OnceLock::new();
    let plain_token = PLAIN_TOKEN_RE.get_or_init(|| {
        Regex::new(r#"(?i)"([a-z0-9_-]*token[a-z0-9_-]*)"\s*:\s*"((?:\\.|[^"\\])*)""#)
            .expect("valid plain token-field redaction regex")
    });
    static PLAIN_COOKIE_RE: OnceLock<Regex> = OnceLock::new();
    let plain_cookie = PLAIN_COOKIE_RE.get_or_init(|| {
        Regex::new(r#"(?i)"(cookie)"\s*:\s*"((?:\\.|[^"\\])*)""#)
            .expect("valid plain cookie-field redaction regex")
    });

    // Escaped-quote variants: a quote at JSON-encode depth n appears as
    // (2^n - 1) backslashes + `"`, so `\\+"` covers every depth >= 1.
    static ESCAPED_TOKEN_RE: OnceLock<Regex> = OnceLock::new();
    let escaped_token = ESCAPED_TOKEN_RE.get_or_init(|| {
        Regex::new(r#"(?i)\\+"([a-z0-9_-]*token[a-z0-9_-]*)\\+"\s*:\s*\\+"(?:\\.|[^"\\])*?\\+""#)
            .expect("valid escaped token-field redaction regex")
    });
    static ESCAPED_COOKIE_RE: OnceLock<Regex> = OnceLock::new();
    let escaped_cookie = ESCAPED_COOKIE_RE.get_or_init(|| {
        Regex::new(r#"(?i)\\+"(cookie)\\+"\s*:\s*\\+"(?:\\.|[^"\\])*?\\+""#)
            .expect("valid escaped cookie-field redaction regex")
    });

    // Raw `Cookie:`/`Set-Cookie:` header fragments (quote-free value, so the
    // one pattern already works at any escape depth).
    static COOKIE_HEADER_RE: OnceLock<Regex> = OnceLock::new();
    let cookie_header = COOKIE_HEADER_RE.get_or_init(|| {
        Regex::new(r"(?i)\b(cookie|set-cookie)\s*:\s*[^\r\n\x22]+")
            .expect("valid cookie-header redaction regex")
    });

    let out = plain_token.replace_all(raw, |caps: &regex::Captures| {
        format!("\"{}\":\"***REDACTED***\"", &caps[1])
    });
    let out = plain_cookie.replace_all(&out, |caps: &regex::Captures| {
        format!("\"{}\":\"***REDACTED***\"", &caps[1])
    });
    // Replacements below re-emit the canonical single-escape (`\"`) form:
    // the secret bytes are gone either way, and a depth-1 payload (the
    // reported case) stays parseable as the nested JSON it was.
    let out = escaped_token.replace_all(&out, |caps: &regex::Captures| {
        format!("\\\"{}\\\":\\\"***REDACTED***\\\"", &caps[1])
    });
    let out = escaped_cookie.replace_all(&out, |caps: &regex::Captures| {
        format!("\\\"{}\\\":\\\"***REDACTED***\\\"", &caps[1])
    });
    let out = cookie_header.replace_all(&out, |caps: &regex::Captures| {
        format!("{}: ***REDACTED***", &caps[1])
    });
    out.into_owned()
}

fn emit_client_log_entries(client: Option<&Value>, entries: &[Value]) {
    let client_json = client
        .map(ToString::to_string)
        .unwrap_or_else(|| "null".to_string());
    let client_id = client
        .and_then(|c| c.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default();

    for entry in entries {
        let Value::Object(e) = entry else { continue };
        let severity = e.get("severity").and_then(Value::as_str).unwrap_or("info");
        let client_event = e.get("event").and_then(Value::as_str).unwrap_or_default();
        let message = e
            .get("message")
            .and_then(Value::as_str)
            .filter(|m| !m.is_empty())
            .or({
                if client_event.is_empty() {
                    None
                } else {
                    Some(client_event)
                }
            })
            .unwrap_or("Client log")
            .to_string();
        // Client-supplied free-form strings get the pre-emission scrub (see
        // `scrub_client_supplied`): the writer-level scrub cannot see secrets
        // once these are JSON-encoded onto the disk line.
        let message = scrub_client_supplied(&message);
        let console_method = e
            .get("consoleMethod")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let stack = e.get("stack").and_then(Value::as_str).unwrap_or_default();
        let client_timestamp = e
            .get("timestamp")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let args = e
            .get("args")
            .map(|v| scrub_client_supplied(&v.to_string()))
            .unwrap_or_else(|| "null".to_string());
        let context = e
            .get("context")
            .map(|v| scrub_client_supplied(&v.to_string()))
            .unwrap_or_else(|| "null".to_string());

        // A tiny local macro to avoid quadruplicating this field list once
        // per severity arm below -- `tracing`'s macros must be invoked by
        // name (the level cannot be a runtime variable), so *which* macro
        // runs is the only thing that varies per arm.
        macro_rules! emit_client_log {
            ($level_macro:ident) => {
                tracing::$level_macro!(
                    target: "freshell_server::client_logs",
                    event = "client_log",
                    client_id,
                    client = %client_json,
                    client_timestamp,
                    client_event,
                    console_method,
                    args = %args,
                    context = %context,
                    stack,
                    "{}",
                    message
                )
            };
        }

        match severity {
            "error" => emit_client_log!(error),
            "warn" => emit_client_log!(warn),
            "debug" => emit_client_log!(debug),
            // `info` and any other (unreachable post-validation, but kept
            // total rather than partial) value: default to `info`, mirroring
            // the original's implicit "unknown severities never occur past
            // the schema gate" invariant without a silent panic if one ever
            // does.
            _ => emit_client_log!(info),
        }
    }
}

/// zod-v4 issue list for `ClientLogsPayloadSchema.safeParse(body)`
/// (`server/client-logs.ts:6-29`). Field order follows schema declaration
/// (`client`, then `entries`, per-entry: timestamp, severity, message, event,
/// consoleMethod, args, stack, context); strict-object `unrecognized_keys` is
/// appended last — all as observed live.
fn client_logs_issues(body: &Value) -> Vec<Value> {
    use crate::terminals::zod_received;
    let mut issues: Vec<Value> = Vec::new();
    let obj = match body {
        Value::Object(m) => m,
        other => {
            issues.push(json!({
                "expected": "object", "code": "invalid_type", "path": [],
                "message": format!("Invalid input: expected object, received {}", zod_received(other))
            }));
            return issues;
        }
    };

    // `client: ClientInfoSchema.optional()` — absent is fine; present must be
    // a plain object of optional strings (id, userAgent, url, path, language,
    // platform — declaration order).
    if let Some(client) = obj.get("client") {
        match client {
            Value::Object(c) => {
                for key in ["id", "userAgent", "url", "path", "language", "platform"] {
                    if let Some(v) = c.get(key) {
                        if !v.is_string() {
                            issues.push(json!({
                                "expected": "string", "code": "invalid_type", "path": ["client", key],
                                "message": format!("Invalid input: expected string, received {}", zod_received(v))
                            }));
                        }
                    }
                }
            }
            other => issues.push(json!({
                "expected": "object", "code": "invalid_type", "path": ["client"],
                "message": format!("Invalid input: expected object, received {}", zod_received(other))
            })),
        }
    }

    // `entries: z.array(ClientLogEntrySchema).min(1).max(200)` (required).
    match obj.get("entries") {
        None => issues.push(json!({
            "expected": "array", "code": "invalid_type", "path": ["entries"],
            "message": "Invalid input: expected array, received undefined"
        })),
        Some(Value::Array(arr)) => {
            if arr.is_empty() {
                issues.push(json!({
                    "origin": "array", "code": "too_small", "minimum": 1, "inclusive": true,
                    "path": ["entries"],
                    "message": "Too small: expected array to have >=1 items"
                }));
            } else if arr.len() > 200 {
                issues.push(json!({
                    "origin": "array", "code": "too_big", "maximum": 200, "inclusive": true,
                    "path": ["entries"],
                    "message": "Too big: expected array to have <=200 items"
                }));
            } else {
                for (i, entry) in arr.iter().enumerate() {
                    entry_issues(entry, i, &mut issues);
                }
            }
        }
        Some(other) => issues.push(json!({
            "expected": "array", "code": "invalid_type", "path": ["entries"],
            "message": format!("Invalid input: expected array, received {}", zod_received(other))
        })),
    }

    // `.strict()` on the top-level object only (entry objects strip silently).
    let unknown: Vec<&str> = obj
        .keys()
        .filter(|k| k.as_str() != "client" && k.as_str() != "entries")
        .map(String::as_str)
        .collect();
    if !unknown.is_empty() {
        let quoted: Vec<String> = unknown.iter().map(|k| format!("\"{k}\"")).collect();
        let message = if unknown.len() == 1 {
            format!("Unrecognized key: {}", quoted[0])
        } else {
            format!("Unrecognized keys: {}", quoted.join(", "))
        };
        issues.push(json!({
            "code": "unrecognized_keys", "keys": unknown, "path": [], "message": message
        }));
    }
    issues
}

/// Per-entry issues for `ClientLogEntrySchema` (non-strict object: unknown
/// entry keys are stripped without error — verified live).
fn entry_issues(entry: &Value, index: usize, issues: &mut Vec<Value>) {
    use crate::terminals::zod_received;
    let e = match entry {
        Value::Object(m) => m,
        other => {
            issues.push(json!({
                "expected": "object", "code": "invalid_type", "path": ["entries", index],
                "message": format!("Invalid input: expected object, received {}", zod_received(other))
            }));
            return;
        }
    };
    // timestamp: z.string() (required)
    match e.get("timestamp") {
        Some(v) if v.is_string() => {}
        Some(v) => issues.push(json!({
            "expected": "string", "code": "invalid_type", "path": ["entries", index, "timestamp"],
            "message": format!("Invalid input: expected string, received {}", zod_received(v))
        })),
        None => issues.push(json!({
            "expected": "string", "code": "invalid_type", "path": ["entries", index, "timestamp"],
            "message": "Invalid input: expected string, received undefined"
        })),
    }
    // severity: z.enum(['debug','info','warn','error']) (required) — any
    // missing/invalid value yields `invalid_value` (verified live).
    let severity_ok = matches!(
        e.get("severity").and_then(Value::as_str),
        Some("debug" | "info" | "warn" | "error")
    );
    if !severity_ok {
        issues.push(json!({
            "code": "invalid_value", "values": ["debug", "info", "warn", "error"],
            "path": ["entries", index, "severity"],
            "message": "Invalid option: expected one of \"debug\"|\"info\"|\"warn\"|\"error\""
        }));
    }
    // optional string fields, declaration order
    for key in ["message", "event", "consoleMethod"] {
        if let Some(v) = e.get(key) {
            if !v.is_string() {
                issues.push(json!({
                    "expected": "string", "code": "invalid_type", "path": ["entries", index, key],
                    "message": format!("Invalid input: expected string, received {}", zod_received(v))
                }));
            }
        }
    }
    // args: z.array(z.unknown()).optional()
    if let Some(v) = e.get("args") {
        if !v.is_array() {
            issues.push(json!({
                "expected": "array", "code": "invalid_type", "path": ["entries", index, "args"],
                "message": format!("Invalid input: expected array, received {}", zod_received(v))
            }));
        }
    }
    // stack: z.string().optional()
    if let Some(v) = e.get("stack") {
        if !v.is_string() {
            issues.push(json!({
                "expected": "string", "code": "invalid_type", "path": ["entries", index, "stack"],
                "message": format!("Invalid input: expected string, received {}", zod_received(v))
            }));
        }
    }
    // context: z.record(z.string(), z.unknown()).optional()
    if let Some(v) = e.get("context") {
        if !v.is_object() {
            issues.push(json!({
                "expected": "record", "code": "invalid_type", "path": ["entries", index, "context"],
                "message": format!("Invalid input: expected record, received {}", zod_received(v))
            }));
        }
    }
}

/// `POST /api/tabs-sync/client-retire` → retire a client's tab snapshot from the
/// shared registry (`server/tabs-registry/client-retire-router.ts`). This is the
/// unload path: the SPA `sendBeacon`s `{ deviceId, clientInstanceId, snapshotRevision }`
/// when the socket is already gone, so a closed device's tabs still disappear from
/// every other viewer. Returns `{ ok, accepted }` (the beacon body is authed by the
/// `freshell-auth` cookie, since `sendBeacon` cannot set the `x-auth-token` header).
async fn tabs_sync_client_retire(
    State(state): State<BootState>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(Json(body)) = body else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid tabs registry retire payload" })),
        )
            .into_response();
    };
    let device_id = body.get("deviceId").and_then(Value::as_str).unwrap_or("");
    let client_instance_id = body
        .get("clientInstanceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let snapshot_revision = body
        .get("snapshotRevision")
        .and_then(Value::as_i64)
        .unwrap_or(-1);
    if device_id.is_empty() || client_instance_id.is_empty() || snapshot_revision < 0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid tabs registry retire payload" })),
        )
            .into_response();
    }
    let accepted =
        state
            .tabs
            .retire_client_snapshot(device_id, client_instance_id, snapshot_revision);
    Json(json!({ "ok": true, "accepted": accepted })).into_response()
}

// ── Auth gate (ports server/auth.ts#httpAuthMiddleware) ──────────────────────

/// A request is authorized iff it presents the exact `AUTH_TOKEN` via the
/// `x-auth-token` header or the `freshell-auth` cookie (url-decoded), under a
/// constant-time compare. Absent/wrong credentials are rejected.
///
/// `pub(crate)` so the additive `files` REST surface shares the identical gate
/// (mirrors the single `server/auth.ts#httpAuthMiddleware` in the original).
///
/// SAFE-01 precedence fix: the original resolves the credential with
/// `provided = headerToken || cookieToken` (`server/auth.ts:41`) — a JS `||`,
/// which is a VALUE fallback, not an "accept either" gate. A present,
/// non-empty header wins UNCONDITIONALLY: if it's wrong, the request is
/// rejected even when a correct cookie is also attached (the cookie is never
/// even read in that case). Only an absent/empty header falls through to the
/// cookie. The previous port instead tried the header, and on failure tried
/// the cookie too — an "either succeeds" OR-gate that accepts a
/// wrong-header/right-cookie combination the original would reject. That
/// divergence matters once request paths compose the two on purpose (e.g. a
/// stale cached header alongside a live cookie); mirroring the original's
/// deterministic precedence removes the ambiguity.
pub(crate) fn is_authed(headers: &HeaderMap, token: &str) -> bool {
    let header_token = headers
        .get("x-auth-token")
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.is_empty());

    let cookie_token = headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookie_header| cookie_value(cookie_header, "freshell-auth"))
        .map(|raw| percent_decode(&raw))
        .filter(|value| !value.is_empty());

    let provided = match header_token {
        Some(header_token) => Some(header_token.to_string()),
        None => cookie_token,
    };

    match provided {
        Some(provided) => freshell_api::constant_time_eq(provided.as_bytes(), token.as_bytes()),
        None => false,
    }
}

/// `401 { "error": "Unauthorized" }` — byte-shape-equal to the original's reject.
///
/// `pub(crate)` so the additive `network` REST surface shares the identical reject.
pub(crate) fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

/// Extract a single cookie value by name from a `Cookie:` header line.
fn cookie_value(cookie_header: &str, name: &str) -> Option<String> {
    for part in cookie_header.split(';') {
        let part = part.trim();
        if let Some(eq) = part.find('=') {
            if &part[..eq] == name {
                return Some(part[eq + 1..].to_string());
            }
        }
    }
    None
}

/// Minimal `%XX` percent-decoder (the client cookie is `encodeURIComponent`-ed).
/// Bytes that are not a valid `%XX` escape pass through unchanged.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    fn headers_with(name: &'static str, value: &str) -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(name, HeaderValue::from_str(value).unwrap());
        h
    }

    #[test]
    fn header_token_authorizes() {
        let h = headers_with("x-auth-token", "s3cr3t-token-abcdef");
        assert!(is_authed(&h, "s3cr3t-token-abcdef"));
    }

    #[test]
    fn wrong_and_absent_token_rejected() {
        assert!(!is_authed(
            &headers_with("x-auth-token", "nope"),
            "s3cr3t-token-abcdef"
        ));
        assert!(!is_authed(&HeaderMap::new(), "s3cr3t-token-abcdef"));
    }

    #[test]
    fn cookie_token_authorizes_url_decoded() {
        // encodeURIComponent('a b/c') === 'a%20b%2Fc'
        let h = headers_with("cookie", "other=1; freshell-auth=a%20b%2Fc; z=2");
        assert!(is_authed(&h, "a b/c"));
    }

    // SAFE-01: conflicting-source precedence. `server/auth.ts:41` resolves
    // `provided = headerToken || cookieToken` -- a JS value-fallback, not an
    // "accept either" gate. A present, non-empty header wins UNCONDITIONALLY:
    // wrong header + correct cookie must still be REJECTED (the cookie is
    // never even consulted once a header is present).
    #[test]
    fn wrong_header_rejects_even_with_correct_cookie_present() {
        let mut h = headers_with("x-auth-token", "WRONG");
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("freshell-auth=s3cr3t-token-abcdef"),
        );
        assert!(!is_authed(&h, "s3cr3t-token-abcdef"));
    }

    #[test]
    fn falls_back_to_cookie_only_when_header_absent() {
        let h = headers_with("cookie", "freshell-auth=s3cr3t-token-abcdef");
        assert!(is_authed(&h, "s3cr3t-token-abcdef"));
    }

    #[test]
    fn empty_header_value_falls_back_to_cookie() {
        // Legacy: `('' as string|undefined) || undefined` treats an empty
        // header value as ABSENT, so the cookie is still consulted.
        let mut h = headers_with("x-auth-token", "");
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("freshell-auth=s3cr3t-token-abcdef"),
        );
        assert!(is_authed(&h, "s3cr3t-token-abcdef"));
    }

    #[test]
    fn scrub_client_supplied_redacts_nested_json_token_field() {
        // The reported leak shape: an args element that is a STRING of JSON
        // text -- after this module's ToString re-serialization the field's
        // quotes are escaped, defeating plain-quote patterns.
        let raw = r#"["{\"authToken\":\"nested-secret-123\"}","harmless"]"#;
        let out = scrub_client_supplied(raw);
        assert!(!out.contains("nested-secret-123"), "leaked: {out}");
        assert!(
            out.contains("harmless"),
            "non-secret content dropped: {out}"
        );
    }

    #[test]
    fn scrub_client_supplied_redacts_nested_json_cookie_field() {
        let raw = r#"["{\"cookie\":\"freshell-auth=abcdef123456\"}"]"#;
        let out = scrub_client_supplied(raw);
        assert!(!out.contains("abcdef123456"), "leaked: {out}");
    }

    #[test]
    fn scrub_client_supplied_redacts_plain_json_token_field() {
        // Depth-0: JSON text pasted straight into a message string.
        let raw = r#"request failed {"apiToken":"plain-secret-456"} retrying"#;
        let out = scrub_client_supplied(raw);
        assert!(!out.contains("plain-secret-456"), "leaked: {out}");
        assert!(out.contains("request failed"));
        assert!(out.contains("retrying"));
    }

    #[test]
    fn scrub_client_supplied_preserves_non_secret_content() {
        let raw = r#"{"route":"/api/health","status":200,"note":"all good"}"#;
        assert_eq!(scrub_client_supplied(raw), raw);
    }

    #[test]
    fn cookie_value_parses_named_pair() {
        assert_eq!(
            cookie_value("a=1; freshell-auth=xyz; b=2", "freshell-auth"),
            Some("xyz".to_string())
        );
        assert_eq!(cookie_value("a=1", "freshell-auth"), None);
    }

    #[test]
    fn percent_decode_handles_escapes_and_passthrough() {
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("plain-token_123"), "plain-token_123");
        assert_eq!(percent_decode("50%"), "50%"); // trailing % is not a valid escape
    }

    /// The merge invariant the app relies on: a boot router with `GET /api/settings`
    /// and a second router with `PATCH /api/settings` combine without panicking
    /// (axum merges the two method routers on the same path).
    #[test]
    fn get_and_patch_settings_merge_without_panic() {
        use axum::routing::patch;
        let boot = Router::new().route("/api/settings", get(|| async { "get" }));
        let other = Router::new().route("/api/settings", patch(|| async { "patch" }));
        // Would panic on an overlapping-method conflict; GET+PATCH is allowed.
        let _merged: Router = boot.merge(other);
    }
}
