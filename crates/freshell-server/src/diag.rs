//! DIAG-05: `GET /api/server-info`, `GET /api/debug`, `POST /api/perf` --
//! ported from `server/{server-info,debug,perf}-router.ts`. All three sit
//! behind the standard `/api/*` auth-token gate (`x-auth-token` header or the
//! `freshell-auth` cookie), reusing [`crate::boot::is_authed`] /
//! [`crate::boot::unauthorized`] -- the SAME reject every other authenticated
//! REST module in this crate shares (mirrors `server/auth.ts#httpAuthMiddleware`
//! mounted ahead of the perf/debug/server-info routers, `server/index.ts:173`).
//!
//! ## `/api/server-info`
//!
//! `version`/`uptime`/`platform`/`arch` carry no secrets (safe as-is, legacy
//! parity). `runtime: "rust"` REPLACES legacy's `nodeVersion` -- this is both
//! honest (there is no Node version to report) and the permanent node/rust
//! discriminator SPEC A (CFG-07/HARNESS-02) relies on, since `nodeVersion`'s
//! *presence* (legacy) vs `runtime`'s *presence* (Rust) can never converge the
//! way a regenerate-vs-persist `instanceId` gap could.
//!
//! ## `/api/debug`
//!
//! Same shape as legacy (`version`, `appVersion`, `wsConnections`,
//! `settings`, `sessionsProjects`, `tabsRegistry`, `terminals`, `time`), with
//! [`redact_settings`] applied to the `settings` snapshot BEFORE
//! serialization -- see that function's doc comment for the schema-based,
//! marker-aware redaction rule.
//!
//! ## `/api/perf`
//!
//! A live control: patches `settings.logging.debug` via the shared
//! [`crate::settings_store::SettingsStore`] and broadcasts `settings.updated`
//! so every connected client's Debug toggle stays in sync (legacy
//! `perf-router.ts`). DIAG-04 (not this spec) owns the deeper "detailed/perf
//! entries only during the enabled interval" proof -- this endpoint owns only
//! the request/response shape + the broadcast (D.9 fence).

use std::sync::Arc;
use std::time::Instant;

use axum::{
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::boot::{is_authed, unauthorized};
use crate::settings_store::SettingsStore;

/// Shared, cheaply-cloneable state for the three DIAG-05 routes.
#[derive(Clone)]
pub struct DiagState {
    pub auth_token: Arc<String>,
    /// The SAME resolved version string `GET /api/health`/`GET /api/version`
    /// report, so all three never disagree.
    pub app_version: Arc<String>,
    /// Captured once at boot (`Instant::now()`) -- used ONLY for `uptime`
    /// (monotonic, immune to wall-clock adjustments). Deliberately separate
    /// from the ISO-8601 `started_at` string `GET /api/health` reports.
    pub boot_instant: Instant,
    pub settings: SettingsStore,
    pub registry: freshell_terminal::TerminalRegistry,
    pub tabs: freshell_ws::tabs::TabsRegistry,
    pub session_index: Option<Arc<freshell_sessions::directory_index::SessionIndex>>,
    /// The shared server->client broadcast bus -- `POST /api/perf` pushes
    /// `settings.updated` here on every successful toggle.
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
}

/// The REST sub-router, pre-bound to its state (mergeable into the server app).
pub fn router(state: DiagState) -> Router {
    Router::new()
        .route("/api/server-info", get(server_info))
        .route("/api/debug", get(debug))
        .route("/api/perf", post(perf))
        .with_state(state)
}

// ---------------------------------------------------------------------
// GET /api/server-info
// ---------------------------------------------------------------------

async fn server_info(State(state): State<DiagState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(server_info_body(&state)).into_response()
}

/// Split out from the async handler so it is unit-testable without a runtime
/// (mirrors `freshell_api::health_body`'s split).
fn server_info_body(state: &DiagState) -> Value {
    json!({
        "version": &*state.app_version,
        "uptime": state.boot_instant.elapsed().as_secs(),
        "runtime": "rust",
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        // Provenance-hardening lane: additive fields only, never replacing
        // an existing one -- see `build.rs`'s module doc comment for the
        // `git rev-parse HEAD` / `git status --porcelain` compile-time
        // mechanism these two functions read back via `option_env!`.
        "commit": build_commit(),
        "buildDirty": build_dirty(),
    })
}

/// The git commit SHA this binary was built from, baked in at compile time
/// by `build.rs`. Falls back to the literal `"unknown"` when git was
/// unavailable at build time (e.g. a source tarball with no `.git`) -- this
/// never happens as a runtime failure, only ever a build-time fallback.
/// `pub(crate)` so `main.rs`'s boot line can print the SAME value
/// `GET /api/server-info`'s `commit` field reports -- one source of truth.
pub(crate) fn build_commit() -> &'static str {
    option_env!("FRESHELL_BUILD_COMMIT").unwrap_or("unknown")
}

/// Whether `git status --porcelain` was non-empty (an uncommitted change
/// present) at build time. Fail-closed: an unknown build-time git state
/// (git unavailable) is reported as `true` (dirty) rather than `false` --
/// an unverifiable build must never be silently reported clean.
fn build_dirty() -> bool {
    !matches!(option_env!("FRESHELL_BUILD_DIRTY"), Some("false"))
}

// ---------------------------------------------------------------------
// GET /api/debug
// ---------------------------------------------------------------------

async fn debug(State(state): State<DiagState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(debug_body(&state).await).into_response()
}

async fn debug_body(state: &DiagState) -> Value {
    let settings = state.settings.get().await;
    let settings_value = serde_json::to_value(&settings).unwrap_or_else(|_| json!({}));
    let redacted_settings = redact_settings(&settings_value);

    let (record_count, device_count) = state.tabs.diagnostic_counts();

    let sessions_projects = match &state.session_index {
        Some(index) => distinct_project_paths(&index.snapshot().await),
        None => Vec::new(),
    };

    json!({
        "version": 1,
        "appVersion": &*state.app_version,
        "wsConnections": state.registry.connection_count(),
        "settings": redacted_settings,
        "sessionsProjects": sessions_projects,
        "tabsRegistry": {
            "recordCount": record_count,
            "deviceCount": device_count,
        },
        "terminals": state.registry.inventory(),
        "time": chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    })
}

/// Distinct, sorted project paths across the indexed session corpus (`GET
/// /api/debug`'s `sessionsProjects`, legacy `codingCliIndexer.getProjects()`).
fn distinct_project_paths(
    items: &[freshell_sessions::directory_index::IndexedSession],
) -> Vec<String> {
    let mut projects: Vec<String> = items.iter().map(|s| s.project_path.clone()).collect();
    projects.sort();
    projects.dedup();
    projects
}

/// Schema-based, marker-aware secret redaction (DIAG-05 D.4/D.6). Walks the
/// structured settings [`Value`] BEFORE serialization (never a post-serialize
/// string regex -- that's fragile against nested/partial matches, D.8) and
/// redacts a value to `"[redacted]"` when:
///
/// - its KEY name (case-insensitive substring match) is one of the known
///   secret vocabulary (`token`, `apikey`/`api_key`, `secret`, `password`,
///   `credential`, `cookie`, `authorization`, `auth-header`), OR
/// - the ENCLOSING object carries a `"secretMarked": true` marker -- every
///   OTHER field in that object is redacted regardless of its key name. This
///   is what catches the "unknown future secret-marked field" acceptance
///   case: a brand-new secret field can be added to settings later, with NO
///   code change here, and still gets redacted because it is marker-tagged.
///
/// Non-secret siblings (at any depth) survive verbatim. This is an additive
/// port of `logging.rs`'s key-based scrub approach (`token_field_re`) into a
/// dedicated, structural walker -- deliberately NOT reaching into that
/// module's internals (it is a concurrently-frozen slice; D.4).
pub fn redact_settings(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let secret_marked = matches!(map.get("secretMarked"), Some(Value::Bool(true)));
            let mut out = serde_json::Map::with_capacity(map.len());
            for (key, val) in map {
                if key == "secretMarked" {
                    out.insert(key.clone(), val.clone());
                    continue;
                }
                if secret_marked || is_secret_key(key) {
                    out.insert(key.clone(), json!("[redacted]"));
                } else {
                    out.insert(key.clone(), redact_settings(val));
                }
            }
            Value::Object(out)
        }
        Value::Array(items) => Value::Array(items.iter().map(redact_settings).collect()),
        other => other.clone(),
    }
}

/// Case-insensitive substring match against the known secret-key vocabulary
/// (D.6's decision table).
fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    const NEEDLES: &[&str] = &[
        "token",
        "apikey",
        "api_key",
        "secret",
        "password",
        "credential",
        "cookie",
        "authorization",
        "auth-header",
    ];
    NEEDLES.iter().any(|needle| lower.contains(needle))
}

// ---------------------------------------------------------------------
// POST /api/perf
// ---------------------------------------------------------------------

async fn perf(State(state): State<DiagState>, headers: HeaderMap, raw_body: String) -> Response {
    // Auth is checked BEFORE any body parsing (`raw_body: String` never fails
    // extraction the way `Json<Value>` would on a missing/malformed
    // Content-Type) -- so an unauthenticated request is rejected with 401
    // regardless of what it sent as a body, matching legacy's
    // `httpAuthMiddleware` running strictly ahead of the route handler
    // (`server/index.ts:173`).
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let body: Value = serde_json::from_str(&raw_body).unwrap_or_else(|_| json!({}));
    // `enabled = req.body?.enabled === true` (`perf-router.ts:10`) -- anything
    // other than a literal JSON `true` (missing field, `"true"` string,
    // `1`, ...) is falsy, matching JS's strict `===` comparison.
    let enabled = matches!(body.get("enabled"), Some(Value::Bool(true)));

    match state
        .settings
        .patch(&json!({ "logging": { "debug": enabled } }))
        .await
    {
        Ok(merged) => {
            if let Ok(frame) =
                serde_json::to_string(&json!({ "type": "settings.updated", "settings": &merged }))
            {
                let _ = state.broadcast_tx.send(frame);
            }
            Json(json!({ "ok": true, "enabled": enabled })).into_response()
        }
        Err((status, err_body)) => (status, Json(err_body)).into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "freshell-diag05-{label}-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ))
    }

    fn sample_state(dir: &Path) -> DiagState {
        let auth_token = Arc::new("s3cr3t-token-abcdef".to_string());
        let (broadcast_tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
        DiagState {
            auth_token: Arc::clone(&auth_token),
            app_version: Arc::new("0.7.0".to_string()),
            boot_instant: Instant::now(),
            settings: SettingsStore::load(Some(dir), vec!["claude".into()]),
            registry: freshell_terminal::TerminalRegistry::new(),
            tabs: freshell_ws::tabs::TabsRegistry::new(),
            session_index: None,
            broadcast_tx: Arc::new(broadcast_tx),
        }
    }

    // ---- redact_settings ----

    #[test]
    fn redacts_known_secret_keys_at_any_depth() {
        let input = json!({
            "ai": { "geminiApiKey": "sk-super-secret" },
            "providers": {
                "codex": { "credential": "cred-xyz" }
            },
            "authorization": "Bearer abc123",
            "fontSize": 14,
            "enabledProviders": ["claude", "codex"],
        });

        let redacted = redact_settings(&input);

        assert_eq!(redacted["ai"]["geminiApiKey"], json!("[redacted]"));
        assert_eq!(
            redacted["providers"]["codex"]["credential"],
            json!("[redacted]")
        );
        assert_eq!(redacted["authorization"], json!("[redacted]"));
        // Non-secret siblings survive verbatim.
        assert_eq!(redacted["fontSize"], json!(14));
        assert_eq!(redacted["enabledProviders"], json!(["claude", "codex"]));
    }

    #[test]
    fn redacts_unknown_future_secret_marked_field_by_marker_not_name() {
        // The DIAG-05 acceptance's explicit case: a field with NO recognized
        // secret-key name, marked via a `secretMarked: true` sibling.
        let input = json!({
            "totallyNewField": { "secretMarked": true, "value": "x" },
        });

        let redacted = redact_settings(&input);

        assert_eq!(redacted["totallyNewField"]["value"], json!("[redacted]"));
        // The marker itself is preserved (not redacted) so downstream tooling
        // can still see the field WAS marker-redacted, not merely absent.
        assert_eq!(redacted["totallyNewField"]["secretMarked"], json!(true));
    }

    #[test]
    fn redaction_is_case_insensitive_and_substring_based() {
        let input = json!({ "AI_API_KEY": "sk-x", "SavedToken": "t-1", "Cookie": "c" });
        let redacted = redact_settings(&input);
        assert_eq!(redacted["AI_API_KEY"], json!("[redacted]"));
        assert_eq!(redacted["SavedToken"], json!("[redacted]"));
        assert_eq!(redacted["Cookie"], json!("[redacted]"));
    }

    #[test]
    fn non_secret_values_survive_untouched() {
        let input = json!({ "cwd": "/home/user/project", "terminal": { "scrollback": 5000 } });
        let redacted = redact_settings(&input);
        assert_eq!(redacted, input);
    }

    // ---- /api/server-info ----

    #[test]
    fn server_info_body_emits_runtime_rust_and_no_node_version() {
        let dir = unique_temp_dir("server-info");
        let state = sample_state(&dir);
        let body = server_info_body(&state);

        assert_eq!(body["runtime"], json!("rust"));
        assert!(
            body.get("nodeVersion").is_none(),
            "the Rust server-info must never emit nodeVersion (SPEC A's HARNESS-02 discriminator)"
        );
        assert_eq!(body["version"], json!("0.7.0"));
        assert_eq!(body["platform"], json!(std::env::consts::OS));
        assert_eq!(body["arch"], json!(std::env::consts::ARCH));
        assert!(
            body["uptime"].as_u64().is_some(),
            "uptime must be a non-negative integer"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn server_info_body_includes_build_commit_and_dirty_provenance_fields() {
        // Provenance-hardening lane: the running binary's source commit must
        // be recoverable from a live server without cross-referencing
        // deploy logs -- the incident this prevents was a mid-WIP binary
        // whose source commit was unknowable during a production
        // investigation. `commit` is baked in at compile time by
        // `build.rs` (a real git SHA, or the literal fallback `"unknown"`
        // when git is unavailable at build time); `buildDirty` records
        // whether `git status --porcelain` was non-empty at that same
        // build time. Additive fields only -- every existing field
        // asserted by `server_info_body_emits_runtime_rust_and_no_node_version`
        // above must be untouched by this.
        let dir = unique_temp_dir("server-info-provenance");
        let state = sample_state(&dir);
        let body = server_info_body(&state);

        let commit = body["commit"]
            .as_str()
            .expect("commit must be a string field");
        assert!(!commit.is_empty(), "commit must never be an empty string");

        assert!(
            body["buildDirty"].as_bool().is_some(),
            "buildDirty must be a boolean field, got: {:?}",
            body["buildDirty"]
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn server_info_uptime_is_monotonic_non_decreasing() {
        let dir = unique_temp_dir("server-info-uptime");
        let state = sample_state(&dir);
        let first = server_info_body(&state)["uptime"].as_u64().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(1100));
        let second = server_info_body(&state)["uptime"].as_u64().unwrap();
        assert!(
            second >= first,
            "uptime must never decrease (first={first}, second={second})"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- /api/debug ----

    #[tokio::test]
    async fn debug_body_has_the_legacy_field_set_with_redacted_settings() {
        let dir = unique_temp_dir("debug-body");
        let state = sample_state(&dir);
        // Seed a secret into the live settings tree so the end-to-end body
        // (not just the standalone redactor) proves the secret never leaks.
        state
            .settings
            .patch(&json!({ "ai": { "geminiApiKey": "sk-should-never-leak" } }))
            .await
            .ok();

        let body = debug_body(&state).await;

        assert_eq!(body["version"], json!(1));
        assert_eq!(body["appVersion"], json!("0.7.0"));
        assert_eq!(body["wsConnections"], json!(0));
        assert_eq!(body["tabsRegistry"]["recordCount"], json!(0));
        assert_eq!(body["tabsRegistry"]["deviceCount"], json!(0));
        assert_eq!(body["terminals"], json!([]));
        assert_eq!(body["sessionsProjects"], json!([]));
        assert!(body["time"].as_str().is_some());

        let serialized = serde_json::to_string(&body).unwrap();
        assert!(
            !serialized.contains("sk-should-never-leak"),
            "a seeded secret must never appear anywhere in the serialized /api/debug body"
        );
        assert_eq!(
            body["settings"]["ai"]["geminiApiKey"],
            json!("[redacted]"),
            "the redacted field must be present as the sentinel, not merely absent"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn debug_body_tabs_registry_recordcount_and_devicecount_reflect_raw_legacy_semantics() {
        // DEFECT 1 + DEFECT 2 route-level regression: two devices each push
        // an open snapshot containing the SAME tabKey (the ordinary
        // "same tab open on two devices" case). Legacy's `recordCount`
        // (`tabsRegistryStore.count()`, server/tabs-registry/store.ts:1306-1309)
        // is the RAW undeduplicated sum across client snapshots, so it must
        // be 2 here -- NOT 1, which is what a winner-per-tabKey dedup (the
        // OLD, defective `tabs_registry_counts` built on `query()`) would
        // report. Both devices are freshly pushed (well within the 7-day
        // display TTL, server/tabs-registry/store.ts:1298-1304), so
        // `deviceCount` must be 2.
        let dir = unique_temp_dir("debug-tabsregistry");
        let state = sample_state(&dir);

        state
            .tabs
            .replace_client_snapshot(
                "srv-1",
                "device-a",
                "Device A",
                "client-a1",
                1,
                vec![json!({
                    "tabKey": "shared-tab",
                    "tabId": "shared-tab",
                    "tabName": "from A",
                    "status": "open",
                    "revision": 1,
                    "updatedAt": 100,
                    "createdAt": 100,
                    "paneCount": 1,
                    "titleSetByUser": true,
                    "panes": [],
                })],
            )
            .expect("push accepted");
        state
            .tabs
            .replace_client_snapshot(
                "srv-1",
                "device-b",
                "Device B",
                "client-b1",
                1,
                vec![json!({
                    "tabKey": "shared-tab",
                    "tabId": "shared-tab",
                    "tabName": "from B",
                    "status": "open",
                    "revision": 1,
                    "updatedAt": 200,
                    "createdAt": 200,
                    "paneCount": 1,
                    "titleSetByUser": true,
                    "panes": [],
                })],
            )
            .expect("push accepted");

        let body = debug_body(&state).await;

        assert_eq!(
            body["tabsRegistry"]["recordCount"],
            json!(2),
            "recordCount must be the raw sum across both clients' snapshots (1 + 1), \
             not the deduped winner-per-tabKey count of 1"
        );
        assert_eq!(
            body["tabsRegistry"]["deviceCount"],
            json!(2),
            "both freshly-pushed devices are within the display TTL"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn debug_body_ws_connections_reflects_live_registry_count() {
        let dir = unique_temp_dir("debug-wsconn");
        let state = sample_state(&dir);
        let a = state.registry.new_connection_id();
        let _b = state.registry.new_connection_id();

        let body = debug_body(&state).await;
        assert_eq!(body["wsConnections"], json!(2));

        state.registry.remove_connection(a);
        let body_after = debug_body(&state).await;
        assert_eq!(body_after["wsConnections"], json!(1));

        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- /api/perf ----

    #[tokio::test]
    async fn perf_handler_toggles_debug_setting_and_broadcasts() {
        let dir = unique_temp_dir("perf");
        let state = sample_state(&dir);
        let mut rx = state.broadcast_tx.subscribe();

        let mut headers = HeaderMap::new();
        headers.insert(
            "x-auth-token",
            state.auth_token.to_string().parse().unwrap(),
        );
        let response = perf(
            State(state.clone()),
            headers,
            "{\"enabled\":true}".to_string(),
        )
        .await;
        // Route logic itself (not the auth gate) is exercised directly here;
        // the auth gate is proven separately below via the real router.
        let _ = response;

        let updated = state.settings.get().await;
        assert!(
            updated.logging.debug,
            "settings.logging.debug must now be true"
        );

        let frame = rx
            .try_recv()
            .expect("a settings.updated frame must have been broadcast");
        assert!(frame.contains("settings.updated"));

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn perf_only_a_literal_true_enables_matching_js_strict_equality() {
        let dir = unique_temp_dir("perf-strict");
        let state = sample_state(&dir);

        let mut headers = HeaderMap::new();
        headers.insert(
            "x-auth-token",
            state.auth_token.to_string().parse().unwrap(),
        );
        let _ = perf(
            State(state.clone()),
            headers,
            "{\"enabled\":\"true\"}".to_string(), // a STRING, not a bool
        )
        .await;

        let updated = state.settings.get().await;
        assert!(
            !updated.logging.debug,
            "a non-boolean-true `enabled` must be treated as false, matching `=== true`"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    // ---- auth gate (through the real router) ----

    #[tokio::test]
    async fn all_three_routes_reject_unauthenticated_requests() {
        use tower::ServiceExt;

        let dir = unique_temp_dir("auth-gate");
        let state = sample_state(&dir);
        let app = router(state);

        for (method, path) in [
            ("GET", "/api/server-info"),
            ("GET", "/api/debug"),
            ("POST", "/api/perf"),
        ] {
            let request = axum::http::Request::builder()
                .method(method)
                .uri(path)
                .body(axum::body::Body::empty())
                .unwrap();
            let response = app.clone().oneshot(request).await.unwrap();
            assert_eq!(
                response.status(),
                axum::http::StatusCode::UNAUTHORIZED,
                "{method} {path} must reject an unauthenticated request"
            );
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn server_info_accepts_the_correct_token() {
        use tower::ServiceExt;

        let dir = unique_temp_dir("auth-ok");
        let state = sample_state(&dir);
        let token = state.auth_token.to_string();
        let app = router(state);

        let request = axum::http::Request::builder()
            .method("GET")
            .uri("/api/server-info")
            .header("x-auth-token", token)
            .body(axum::body::Body::empty())
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);

        std::fs::remove_dir_all(&dir).ok();
    }
}
