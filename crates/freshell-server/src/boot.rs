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
//! * `GET /api/terminals` — the terminal directory (an empty array on a clean
//!   boot; the shape `TestHarness.killAllTerminals` + the directory listing read).
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
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use freshell_protocol::ServerSettings;
use serde_json::{json, Value};

/// Shared, cheaply-cloneable state for the boot REST surface.
#[derive(Clone)]
pub struct BootState {
    /// The required auth token (`AUTH_TOKEN`) — the gate for every route here.
    pub auth_token: Arc<String>,
    /// The server-settings tree returned by `GET /api/settings` and embedded in
    /// the `bootstrap` payload's `settings` field.
    pub settings: Arc<ServerSettings>,
    /// The precomputed platform payload
    /// (`{ platform, availableClis, hostName, featureFlags }`) shared by
    /// `GET /api/platform` and `bootstrap.platform`.
    pub platform: Arc<Value>,
    /// The app version string reported by `GET /api/version`.
    pub app_version: Arc<String>,
    /// The bound loopback port, echoed in `GET /api/network/status`.
    pub port: u16,
    /// The shared in-memory tabs registry — the `POST /api/tabs-sync/client-retire`
    /// beacon retires a client's snapshot here (the SAME registry the `/ws`
    /// `tabs.sync.*` path uses), so an unload without a live socket still drops the
    /// closing client's tabs from every other viewer.
    pub tabs: freshell_ws::tabs::TabsRegistry,
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
        .route("/api/settings", get(get_settings))
        .route("/api/session-directory", get(session_directory))
        .route("/api/terminals", get(terminals))
        .route("/api/network/status", get(network_status))
        .route("/api/extensions", get(extensions))
        .route("/api/logs/client", post(logs_client))
        .route("/api/tabs-sync/client-retire", post(tabs_sync_client_retire))
        .with_state(state)
}

// ── Handlers ────────────────────────────────────────────────────────────────

/// `GET /api/bootstrap` → the shell-critical first-paint payload.
async fn bootstrap(State(state): State<BootState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(json!({
        "settings": &*state.settings,
        "platform": &*state.platform,
        "shell": { "authenticated": true },
    }))
    .into_response()
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
    Json(json!({ "currentVersion": &*state.app_version, "updateCheck": null })).into_response()
}

/// `GET /api/settings` → the full `ServerSettings` tree (`configStore.getSettings()`).
async fn get_settings(State(state): State<BootState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(&*state.settings).into_response()
}

/// `GET /api/session-directory` → an empty read-model page (clean isolated boot).
async fn session_directory(State(state): State<BootState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(json!({ "items": [], "nextCursor": null, "revision": 0 })).into_response()
}

/// `GET /api/terminals` → the terminal directory. Empty array on a clean boot
/// (the no-read-model-query shape `terminalViewService.listTerminalDirectory()`
/// returns, which `TestHarness.killAllTerminals` consumes as an array).
async fn terminals(State(state): State<BootState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(json!([])).into_response()
}

/// `GET /api/network/status` → a minimal loopback status so `fetchNetworkStatus`
/// resolves. Remote access is off on a clean isolated boot. This is intentionally
/// minimal — the full network surface (firewall/LAN/port-forward) is a later step.
async fn network_status(State(state): State<BootState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(json!({
        "configured": true,
        "host": "127.0.0.1",
        "remoteAccessEnabled": false,
        "remoteAccessRequested": false,
        "remoteAccessNeedsRepair": false,
        "port": state.port,
        "firewall": { "platform": "none", "active": false, "commands": [] },
        "accessUrl": format!("http://localhost:{}/", state.port),
    }))
    .into_response()
}

/// `GET /api/extensions` → the client extensions registry. Empty on a clean boot
/// (no `extensions/` dir in the isolated runtime root). The SPA's
/// `useEnsureExtensionsRegistry` normalizes a non-array to `[]`; returning `[]`
/// settles its load (a 404 makes it retry-storm), keeping the console clean and
/// the terminal write pipeline un-starved.
async fn extensions(State(state): State<BootState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(json!([])).into_response()
}

/// `POST /api/logs/client` → the client-log sink. Accept-and-ack (the SPA ignores
/// the body); returning 200 stops the boot-time 404.
async fn logs_client(State(state): State<BootState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    Json(json!({ "ok": true })).into_response()
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
pub(crate) fn is_authed(headers: &HeaderMap, token: &str) -> bool {
    if let Some(header_token) = headers
        .get("x-auth-token")
        .and_then(|value| value.to_str().ok())
    {
        if freshell_api::constant_time_eq(header_token.as_bytes(), token.as_bytes()) {
            return true;
        }
    }
    if let Some(cookie_header) = headers.get(header::COOKIE).and_then(|value| value.to_str().ok()) {
        if let Some(raw) = cookie_value(cookie_header, "freshell-auth") {
            let decoded = percent_decode(&raw);
            if freshell_api::constant_time_eq(decoded.as_bytes(), token.as_bytes()) {
                return true;
            }
        }
    }
    false
}

/// `401 { "error": "Unauthorized" }` — byte-shape-equal to the original's reject.
fn unauthorized() -> Response {
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
        assert!(!is_authed(&headers_with("x-auth-token", "nope"), "s3cr3t-token-abcdef"));
        assert!(!is_authed(&HeaderMap::new(), "s3cr3t-token-abcdef"));
    }

    #[test]
    fn cookie_token_authorizes_url_decoded() {
        // encodeURIComponent('a b/c') === 'a%20b%2Fc'
        let h = headers_with("cookie", "other=1; freshell-auth=a%20b%2Fc; z=2");
        assert!(is_authed(&h, "a b/c"));
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
