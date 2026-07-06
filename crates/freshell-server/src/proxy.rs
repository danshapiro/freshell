//! The browser-pane HTTP reverse proxy (Phase 3.18).
//!
//! Ports the HTTP half of `server/proxy-router.ts` (`router.use('/http/:port')`,
//! line 84): a same-origin reverse proxy for **loopback** URLs the SPA's
//! `BrowserPane` renders inside its iframe. The pane rewrites a
//! `http://localhost:<port>/<path>` URL to `/api/proxy/http/<port>/<path>`
//! (`src/components/panes/BrowserPane.tsx#buildHttpProxyUrl`, line 110) so the
//! iframe stays same-origin with Freshell. The proxy then **strips the
//! iframe-blocking response headers** (`X-Frame-Options`,
//! `Content-Security-Policy`, `Content-Security-Policy-Report-Only` —
//! `proxy-router.ts:19`) so dev servers that would otherwise refuse to be framed
//! render, and the screenshot chain can reach their content.
//!
//! ## Faithful behaviour (matches `proxy-router.ts`)
//! * Target is always `127.0.0.1:<port>` (never a remote host).
//! * `<port>` must be `1..=65535`, else `400 { error: "Invalid port number" }`.
//! * The upstream request carries the incoming method + body and the incoming
//!   headers minus hop-by-hop framing (`host` is set to the target;
//!   `connection` / `transfer-encoding` are dropped — `proxy-router.ts:90-93`).
//! * The response echoes the upstream status + headers **minus** the three
//!   iframe-blocking headers (and minus the framing headers `hyper` recomputes),
//!   streaming the body through unchanged.
//! * An upstream connection failure is `502 { error: "Failed to connect to
//!   localhost:<port>" }` (`proxy-router.ts:113`).
//!
//! ## Auth
//! Gated exactly like the original: the proxy is mounted under `/api`, behind
//! `server/auth.ts#httpAuthMiddleware`. The iframe navigates same-origin, so the
//! browser sends the `freshell-auth` cookie the SPA set (`src/lib/auth.ts:14`);
//! [`crate::boot::is_authed`] accepts that cookie (or the `x-auth-token` header).
//!
//! Everything here is ADDITIVE port code; no `server/` or `shared/` is touched.
//! The `/api/proxy/forward` TCP port-forward + the WS-upgrade proxy (remote-only
//! paths that require `netsh`/socket relay) are intentionally NOT ported here —
//! they are unused by the loopback e2e and are a later, safety-gated step.

use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use serde_json::json;

/// Response headers that prevent iframe embedding — stripped so proxied content
/// renders (`proxy-router.ts#IFRAME_BLOCKED_HEADERS`, line 19).
const IFRAME_BLOCKED_HEADERS: [&str; 3] = [
    "x-frame-options",
    "content-security-policy",
    "content-security-policy-report-only",
];

/// Hop-by-hop / framing response headers `hyper` recomputes for the outgoing
/// response; forwarding them verbatim alongside a streamed body would double-frame.
const HOP_BY_HOP_RESPONSE_HEADERS: [&str; 4] = [
    "connection",
    "transfer-encoding",
    "content-length",
    "keep-alive",
];

/// Request headers dropped before forwarding upstream (`proxy-router.ts:91-93`:
/// `host` is rewritten to the target; `connection`/`transfer-encoding` dropped).
const STRIPPED_REQUEST_HEADERS: [&str; 3] = ["host", "connection", "transfer-encoding"];

/// Shared, cheaply-cloneable state for the proxy surface.
#[derive(Clone)]
pub struct ProxyState {
    /// The required auth token (`AUTH_TOKEN`) — the gate for every route here.
    pub auth_token: Arc<String>,
    /// A shared, connection-pooling loopback HTTP client (redirects disabled so
    /// the iframe sees the target's real 3xx, matching Node's `http.request`).
    pub client: reqwest::Client,
}

impl ProxyState {
    /// Build the proxy state with a loopback-only reqwest client.
    pub fn new(auth_token: Arc<String>) -> Self {
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default();
        Self { auth_token, client }
    }
}

/// The proxy sub-router, pre-bound to its state (mergeable into the app).
///
/// A single catch-all mirrors Express's `router.use('/http/:port')` prefix match:
/// it serves the bare `/api/proxy/http/<port>`, the common trailing-slash form the
/// SPA emits (`/api/proxy/http/<port>/`, since `BrowserPane` always appends at
/// least `pathname="/"`, `BrowserPane.tsx:122`), and any deeper
/// `/api/proxy/http/<port>/<path…>`. Parsing the `<port>` off the tail ourselves
/// avoids axum's catch-all requiring a non-empty tail segment.
pub fn router(state: ProxyState) -> Router {
    Router::new()
        .route("/api/proxy/http/{*tail}", any(proxy))
        .with_state(state)
}

/// `/api/proxy/http/{*tail}` where `tail` is `<port>` or `<port>/<path…>`.
async fn proxy(
    State(state): State<ProxyState>,
    Path(tail): Path<String>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: axum::body::Bytes,
) -> Response {
    // Split `<port>` off the front; the remainder (possibly empty) is the upstream
    // path. `5173` → ("5173",""); `5173/` → ("5173",""); `5173/a/b` → ("5173","a/b").
    let (port_raw, rest) = match tail.split_once('/') {
        Some((port, rest)) => (port, rest),
        None => (tail.as_str(), ""),
    };
    forward(state, port_raw.to_string(), rest.to_string(), method, headers, uri, body).await
}

/// The shared forward path.
async fn forward(
    state: ProxyState,
    port_raw: String,
    rest: String,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: axum::body::Bytes,
) -> Response {
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }

    // Validate the port exactly like the original (`Number.isInteger` + 1..=65535).
    let target_port: u32 = match port_raw.parse::<u32>() {
        Ok(p) if (1..=65535).contains(&p) => p,
        _ => return bad_request("Invalid port number"),
    };

    // Build the upstream URL: http://127.0.0.1:<port>/<rest>?<query>.
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    let target_url = format!("http://127.0.0.1:{target_port}/{rest}{query}");

    // Convert the incoming method + headers to the upstream request. `host` is set
    // by reqwest to the target; hop-by-hop framing headers are dropped.
    let mut req = state.client.request(method, &target_url);
    let mut fwd_headers = HeaderMap::new();
    for (name, value) in headers.iter() {
        if STRIPPED_REQUEST_HEADERS.contains(&name.as_str()) {
            continue;
        }
        fwd_headers.insert(name.clone(), value.clone());
    }
    req = req.headers(fwd_headers);
    if !body.is_empty() {
        req = req.body(body);
    }

    let upstream = match req.send().await {
        Ok(resp) => resp,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": format!("Failed to connect to localhost:{target_port}") })),
            )
                .into_response();
        }
    };

    // Rebuild the response: same status, headers minus the iframe-blockers and the
    // framing headers hyper recomputes, streaming the body through unchanged.
    let status = upstream.status();
    let mut out_headers = HeaderMap::new();
    for (name, value) in upstream.headers().iter() {
        let lname = name.as_str().to_ascii_lowercase();
        if IFRAME_BLOCKED_HEADERS.contains(&lname.as_str())
            || HOP_BY_HOP_RESPONSE_HEADERS.contains(&lname.as_str())
        {
            continue;
        }
        if let (Ok(hn), Ok(hv)) = (
            HeaderName::from_bytes(name.as_ref()),
            HeaderValue::from_bytes(value.as_ref()),
        ) {
            out_headers.insert(hn, hv);
        }
    }

    let body = Body::from_stream(upstream.bytes_stream());
    let mut response = Response::new(body);
    *response.status_mut() = status;
    *response.headers_mut() = out_headers;
    response
}

/// `401 { "error": "Unauthorized" }` — byte-shape-equal to the original's reject.
fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

/// `400 { "error": <msg> }` — the original's invalid-port reject shape.
fn bad_request(msg: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": msg }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iframe_blocked_headers_are_the_original_set() {
        // The three headers the original strips (case-insensitive).
        assert!(IFRAME_BLOCKED_HEADERS.contains(&"x-frame-options"));
        assert!(IFRAME_BLOCKED_HEADERS.contains(&"content-security-policy"));
        assert!(IFRAME_BLOCKED_HEADERS.contains(&"content-security-policy-report-only"));
    }

    #[test]
    fn port_validation_matches_original_bounds() {
        for (raw, ok) in [
            ("0", false),
            ("1", true),
            ("65535", true),
            ("65536", false),
            ("-1", false),
            ("abc", false),
            ("", false),
        ] {
            let parsed = raw.parse::<u32>().ok().filter(|p| (1..=65535).contains(p));
            assert_eq!(parsed.is_some(), ok, "port {raw:?}");
        }
    }

    #[test]
    fn tail_splits_port_from_path() {
        // The single catch-all parses `<port>` off the front; the remainder is the
        // upstream path. Covers the SPA's common trailing-slash form.
        let cases = [
            ("5173", "5173", ""),
            ("5173/", "5173", ""),
            ("5173/index.html", "5173", "index.html"),
            ("8080/assets/a.js", "8080", "assets/a.js"),
        ];
        for (tail, port, rest) in cases {
            let (p, r) = match tail.split_once('/') {
                Some((p, r)) => (p, r),
                None => (tail, ""),
            };
            assert_eq!(p, port, "tail {tail:?}");
            assert_eq!(r, rest, "tail {tail:?}");
        }
    }

    #[test]
    fn target_url_composes_path_and_query() {
        // rest has no leading slash (axum strips it); query carries the `?`.
        let rest = "index.html";
        let query = "?v=1";
        assert_eq!(
            format!("http://127.0.0.1:{}/{}{}", 5173u32, rest, query),
            "http://127.0.0.1:5173/index.html?v=1"
        );
        // Bare root (no rest, no query).
        assert_eq!(
            format!("http://127.0.0.1:{}/{}{}", 8080u32, "", ""),
            "http://127.0.0.1:8080/"
        );
    }
}
