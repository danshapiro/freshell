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
//! * The upstream PATH+QUERY is the client's raw bytes, never percent-decoded
//!   or re-encoded (legacy forwards `req.url` verbatim — `proxy-router.ts:99`;
//!   `Path<String>` extraction would decode `%2F`→`/` and corrupt routes).
//! * The upstream request carries the incoming method + body and the incoming
//!   headers minus hop-by-hop framing (`host` is set to the target;
//!   `connection` / `transfer-encoding` are dropped — `proxy-router.ts:90-93`).
//!   Repeated headers keep all values in wire order, both directions.
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
    extract::State,
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

/// Hop-by-hop response headers `hyper` recomputes for the outgoing response;
/// forwarding `transfer-encoding`/`connection` verbatim alongside a re-framed
/// body would double-frame (or lie about) the wire. `content-length` is NOT in
/// this set: reqwest runs with zero compression features, so response bytes
/// are bit-exact (probe L4) and the upstream's declared length stays truthful
/// — and legacy forwards it (`proxy-router.ts:35` strips ONLY the three
/// iframe-blockers).
const HOP_BY_HOP_RESPONSE_HEADERS: [&str; 3] = ["connection", "transfer-encoding", "keep-alive"];

/// Request headers dropped before forwarding upstream (`proxy-router.ts:91-93`:
/// `host` is rewritten to the target; `connection`/`transfer-encoding` dropped).
///
/// SECURITY (wrap-review r3, deliberate hardening BEYOND the original legacy
/// design; the same strip was applied to `server/proxy-router.ts` so both
/// servers behave identically): `x-auth-token` is Freshell's own gate
/// credential — the original forwarded it (and the `freshell-auth` cookie,
/// filtered pair-wise in [`forward`]) to ANY proxied loopback app, handing a
/// hostile local dev server a bearer token that drives every authenticated
/// API/WS surface. A proxied app's OWN cookies/authorization still pass
/// through (its session/login flows keep working); only our credentials are
/// withheld.
const STRIPPED_REQUEST_HEADERS: [&str; 4] =
    ["host", "connection", "transfer-encoding", "x-auth-token"];

/// The cookie NAME of Freshell's own gate credential ([`crate::boot::is_authed`]
/// reads exactly this pair). Filtered out of forwarded `Cookie` values —
/// upstream apps never learn the token, while their own cookies survive.
const AUTH_COOKIE_NAME: &str = "freshell-auth";

/// Rebuild a `Cookie` header value with every `freshell-auth` pair removed
/// (name-compared exactly like [`crate::boot::cookie_value`]). `None` when
/// nothing remains — the header is then dropped entirely.
fn filter_auth_cookie(raw: &str) -> Option<String> {
    let kept: Vec<&str> = raw
        .split(';')
        .map(str::trim)
        .filter(|pair| !pair.is_empty())
        .filter(|pair| {
            pair.split_once('=')
                .map(|(name, _)| name.trim() != AUTH_COOKIE_NAME)
                .unwrap_or(true)
        })
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join("; "))
    }
}

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
            // The upstream target is ALWAYS 127.0.0.1, and legacy's raw
            // `http.request` never consults proxy env vars — but reqwest's
            // builder defaults to auto-detecting `HTTP_PROXY`/`HTTPS_PROXY`
            // ("system proxy"), which on some hosts would shunt the loopback
            // request through a corporate/MITM proxy. Pin no-proxy so the
            // loopback guarantee holds under any environment.
            .no_proxy()
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
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: axum::body::Body,
) -> Response {
    // Split `<port>` off the front of the RAW, never-percent-decoded path
    // (`uri.path()` — proven raw by `lb_probes::l1_...`). Extracting the
    // catch-all as `Path<String>` would percent-DECODE it (`%2F`→`/`,
    // `%25`→`%`), corrupting routes that dev servers actually serve
    // (Vite `/@fs/%2F…`, file names with `%20`). Legacy forwards Node's raw
    // `req.url` untouched (`proxy-router.ts:99`); so do we.
    // `5173` → ("5173",""); `5173/` → ("5173",""); `5173/a/b` → ("5173","a/b").
    let raw_path = uri.path();
    let tail = raw_path.strip_prefix("/api/proxy/http/").unwrap_or("");
    let (port_raw, rest) = match tail.split_once('/') {
        Some((port, rest)) => (port, rest),
        None => (tail, ""),
    };
    forward(
        state,
        port_raw.to_string(),
        rest.to_string(),
        method,
        headers,
        uri,
        body,
    )
    .await
}

/// The shared forward path.
async fn forward(
    state: ProxyState,
    port_raw: String,
    rest: String,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: axum::body::Body,
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
    // by reqwest to the target; hop-by-hop framing headers are dropped. Repeated
    // headers APPEND (a repeated client header must reach upstream N times, in
    // wire order — `proxy-router.ts` passes Node's header arrays through
    // untouched); `insert` would collapse them to last-wins.
    let mut req = state.client.request(method, &target_url);
    let mut fwd_headers = HeaderMap::new();
    for (name, value) in headers.iter() {
        if STRIPPED_REQUEST_HEADERS.contains(&name.as_str()) {
            continue;
        }
        if name == axum::http::header::COOKIE {
            // Cookie values need PAIR-level filtering, not a whole-header
            // drop: upstream apps keep their own cookies, only our
            // `freshell-auth` credential pair is withheld. Unparseable
            // values are dropped (fail closed for this header class).
            let filtered = value.to_str().ok().and_then(filter_auth_cookie);
            match filtered {
                Some(joined) => match HeaderValue::from_str(&joined) {
                    Ok(v) => {
                        fwd_headers.append(name.clone(), v);
                    }
                    Err(_) => continue,
                },
                None => continue,
            }
            continue;
        }
        fwd_headers.append(name.clone(), value.clone());
    }
    req = req.headers(fwd_headers);
    // Stream the request body (never buffer it): the incoming hyper body
    // becomes the outgoing reqwest body chunk-for-chunk, so multi-MiB uploads
    // pass through (no `Bytes` extraction → no 2 MiB `DefaultBodyLimit` 413)
    // and chunked uploads are observable upstream incrementally — legacy's
    // `req.pipe(proxyReq)` (`proxy-router.ts:119-120`). A body is attached
    // only when the client DECLARED one (the only two HTTP/1.1 framings);
    // attaching an empty streamed body to a plain GET would spontaneously
    // re-frame it as `transfer-encoding: chunked`.
    // The client's original `content-length` is among the forwarded headers
    // (it is NOT in `STRIPPED_REQUEST_HEADERS`), and reqwest honors an
    // explicit content-length alongside a streamed body (probe L5), so
    // length-declared uploads keep their exact framing — legacy's header
    // passthrough + piped bytes.
    let declared_body = headers.contains_key(axum::http::header::CONTENT_LENGTH)
        || headers.contains_key(axum::http::header::TRANSFER_ENCODING);
    if declared_body {
        req = req.body(reqwest::Body::wrap_stream(body.into_data_stream()));
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
    // Repeated headers APPEND so multi-`Set-Cookie` survives in wire order
    // (`proxy-router.ts:35` hands `res.writeHead` the header array verbatim —
    // collapsing it would silently kill proxied apps' session/login flows).
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
            out_headers.append(hn, hv);
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

// ── Load-bearing probes (BROWSER-01, `docs/plans/df1/BROWSER-01.md`) ─────────
//
// One-shot EMPIRICAL validations of the assumptions the BROWSER-01 design
// rests on (plan §L1..L5). They deliberately probe framework behavior
// (axum routing/extraction, `http::HeaderMap`, reqwest body handling) rather
// than proxy correctness — the durable contract tests live in
// `mod socket_contract`. Raw sockets everywhere: no framework client/server
// on either side of the wire, so nothing normalizes the bytes being proven.
// ── Raw-wire test support (BROWSER-01) ─────────────────────────────────
//
// Shared raw-TCP fixtures used by the load-bearing probes and the
// socket-level contract tests: a verbatim upstream capture fixture, a raw
// client with wire-order duplicate-preserving header parsing, and
// ephemeral-loopback spawns for both the REAL proxy router and arbitrary
// standalone axum routers. No framework client/server on either side of
// the wire, so nothing normalizes the bytes being proven.
#[cfg(test)]
pub(crate) mod wire_support {
    use super::*;

    pub(crate) const TEST_TOKEN: &str = "lb-probe-token-0123456789abcdef";

    // ── Raw-wire helpers ────────────────────────────────────────────────────

    /// One side of a raw TCP conversation plus a read-ahead buffer, so a
    /// single `read()` that straddles the head/body boundary loses nothing.
    pub(crate) struct Wire {
        stream: tokio::net::TcpStream,
        buf: Vec<u8>,
    }

    pub(crate) fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
        if needle.is_empty() || hay.len() < needle.len() {
            return None;
        }
        hay.windows(needle.len()).position(|w| w == needle)
    }

    /// Parse `\r\n`-terminated head bytes into (first line, ordered headers).
    /// Duplicate headers are preserved in wire order.
    pub(crate) fn parse_head(raw: &[u8]) -> (String, Vec<(String, String)>) {
        let text = String::from_utf8_lossy(raw);
        let mut lines = text.split("\r\n");
        let first = lines.next().unwrap_or("").to_string();
        let headers = lines
            .take_while(|l| !l.is_empty())
            .filter_map(|l| {
                l.split_once(':')
                    .map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))
            })
            .collect();
        (first, headers)
    }

    pub(crate) fn header_values<'a>(
        headers: &'a [(String, String)],
        name: &'a str,
    ) -> impl Iterator<Item = &'a str> {
        headers
            .iter()
            .filter(move |(n, _)| n.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    impl Wire {
        pub(crate) fn new(stream: tokio::net::TcpStream) -> Self {
            Self {
                stream,
                buf: Vec::new(),
            }
        }

        pub(crate) async fn write_all(&mut self, bytes: &[u8]) {
            self.try_write_all(bytes).await.unwrap();
        }

        pub(crate) async fn try_write_all(&mut self, bytes: &[u8]) -> std::io::Result<()> {
            use tokio::io::AsyncWriteExt;
            self.stream.write_all(bytes).await
        }

        /// Read until `needle` (inclusive) and return it, retaining any
        /// over-read bytes in the buffer.
        pub(crate) async fn read_until(&mut self, needle: &[u8]) -> Vec<u8> {
            use tokio::io::AsyncReadExt;
            loop {
                if let Some(pos) = find_subslice(&self.buf, needle) {
                    let end = pos + needle.len();
                    return self.buf.drain(..end).collect();
                }
                let mut tmp = [0u8; 8192];
                let n = self.stream.read(&mut tmp).await.unwrap();
                if n == 0 {
                    return std::mem::take(&mut self.buf);
                }
                self.buf.extend_from_slice(&tmp[..n]);
            }
        }

        pub(crate) async fn read_n(&mut self, n: usize) -> Vec<u8> {
            use tokio::io::AsyncReadExt;
            while self.buf.len() < n {
                let mut tmp = [0u8; 8192];
                let r = self.stream.read(&mut tmp).await.unwrap();
                if r == 0 {
                    break;
                }
                self.buf.extend_from_slice(&tmp[..r]);
            }
            let take = self.buf.len().min(n);
            self.buf.drain(..take).collect()
        }

        pub(crate) async fn read_to_eof(&mut self) -> Vec<u8> {
            use tokio::io::AsyncReadExt;
            let mut tmp = [0u8; 8192];
            loop {
                match self.stream.read(&mut tmp).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
                }
            }
            std::mem::take(&mut self.buf)
        }

        /// Read one RFC 7230 chunked body (with optional trailer lines) and
        /// return the reassembled payload.
        pub(crate) async fn read_chunked(&mut self) -> Vec<u8> {
            let mut body = Vec::new();
            loop {
                let size_line = self.read_until(b"\r\n").await;
                let size_text = String::from_utf8_lossy(&size_line);
                let size_text = size_text.trim();
                let size =
                    usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
                        .unwrap_or_else(|_| panic!("bad chunk size line {size_text:?}"));
                if size == 0 {
                    // Trailer lines until a bare CRLF (common case: none).
                    loop {
                        let line = self.read_until(b"\r\n").await;
                        if line == b"\r\n" {
                            break;
                        }
                    }
                    break;
                }
                body.extend_from_slice(&self.read_n(size).await);
                let crlf = self.read_n(2).await;
                assert_eq!(crlf, b"\r\n", "chunk terminator");
            }
            body
        }
    }

    /// A request as captured verbatim by the raw upstream fixture.
    #[derive(Debug, Default)]
    pub(crate) struct CapturedRequest {
        pub(crate) request_line: String,
        pub(crate) headers: Vec<(String, String)>,
        pub(crate) body: Vec<u8>,
    }

    impl CapturedRequest {
        pub(crate) fn raw_target(&self) -> &str {
            self.request_line.split(' ').nth(1).unwrap_or("")
        }
        pub(crate) fn header_values<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> {
            header_values(&self.headers, name)
        }
    }

    /// Read one full request (head + framed body) from a wire.
    pub(crate) async fn read_request(wire: &mut Wire) -> CapturedRequest {
        let head = wire.read_until(b"\r\n\r\n").await;
        let (request_line, headers) = parse_head(&head);
        let body = if header_values(&headers, "transfer-encoding").any(|v| v.contains("chunked")) {
            wire.read_chunked().await
        } else if let Some(cl) = header_values(&headers, "content-length").next() {
            wire.read_n(cl.parse().expect("content-length integer"))
                .await
        } else {
            Vec::new()
        };
        CapturedRequest {
            request_line,
            headers,
            body,
        }
    }

    /// A full response as captured on the client side.
    #[derive(Debug)]
    pub(crate) struct RawResponse {
        pub(crate) status_line: String,
        pub(crate) headers: Vec<(String, String)>,
        pub(crate) body: Vec<u8>,
    }

    impl RawResponse {
        pub(crate) fn status_code(&self) -> u16 {
            self.status_line
                .split(' ')
                .nth(1)
                .and_then(|c| c.parse().ok())
                .expect("status code")
        }
        pub(crate) fn header_values<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> {
            header_values(&self.headers, name)
        }
    }

    /// Send verbatim request bytes and read the full framed response.
    pub(crate) async fn raw_exchange(port: u16, request: &[u8]) -> RawResponse {
        raw_exchange_inner(port, request, false).await
    }

    /// Send a request whose server may reject the body before the upload
    /// finishes, then read and validate that response. A peer-close error is
    /// expected only for this early-rejection probe; all other write errors
    /// remain failures.
    pub(crate) async fn raw_exchange_may_close_request_early(
        port: u16,
        request: &[u8],
    ) -> RawResponse {
        raw_exchange_inner(port, request, true).await
    }

    async fn raw_exchange_inner(
        port: u16,
        request: &[u8],
        may_close_request_early: bool,
    ) -> RawResponse {
        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
                .await
                .unwrap();
            let mut wire = Wire::new(stream);
            if let Err(error) = wire.try_write_all(request).await {
                let peer_closed = matches!(
                    error.kind(),
                    std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::ConnectionAborted
                );
                assert!(
                    may_close_request_early && peer_closed,
                    "writing raw HTTP request failed: {error}"
                );
            }
            let head = wire.read_until(b"\r\n\r\n").await;
            let (status_line, headers) = parse_head(&head);
            let body =
                if header_values(&headers, "transfer-encoding").any(|v| v.contains("chunked")) {
                    wire.read_chunked().await
                } else if let Some(cl) = header_values(&headers, "content-length").next() {
                    wire.read_n(cl.parse().expect("content-length integer"))
                        .await
                } else {
                    wire.read_to_eof().await
                };
            RawResponse {
                status_line,
                headers,
                body,
            }
        })
        .await
        .expect("exchange timed out")
    }

    /// Bind `127.0.0.1:0` synchronously (usable before the runtime schedules
    /// the accept loop) and spawn one task per accepted connection.
    pub(crate) fn spawn_raw_listener<F, Fut>(handler: F) -> u16
    where
        F: Fn(Wire) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let h = Arc::clone(&handler);
                tokio::spawn(async move { h(Wire::new(stream)).await });
            }
        });
        port
    }

    /// Spawn the REAL proxy router (production state constructor) on an
    /// ephemeral loopback port, gated by `token`.
    pub(crate) async fn spawn_proxy(token: &str) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let app = router(ProxyState::new(Arc::new(token.to_string())));
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });
        port
    }

    /// Spawn an arbitrary standalone axum router on an ephemeral port.
    pub(crate) async fn spawn_app(app: Router) -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).unwrap();
            axum::serve(listener, app.into_make_service())
                .await
                .unwrap();
        });
        port
    }

    /// Static client→proxy head for `path_and_query`. `connection: close`
    /// gives the response a deterministic EOF. Ends with the blank line that
    /// terminates the head. Callers append body bytes for body-bearing
    /// requests (with a matching `content-length` or chunked framing added to
    /// the head) and pass extra request header lines (`"name: value"`).
    pub(crate) fn proxy_head(
        port: u16,
        token: &str,
        method: &str,
        upstream_port: u16,
        path_and_query: &str,
        extra_headers: &[&str],
    ) -> Vec<u8> {
        let extras: String = extra_headers.iter().map(|h| format!("{h}\r\n")).collect();
        format!(
            "{method} /api/proxy/http/{upstream_port}{path_and_query} HTTP/1.1\r\n\
             host: 127.0.0.1:{port}\r\n\
             x-auth-token: {token}\r\n\
             {extras}\
             connection: close\r\n\r\n",
        )
        .into_bytes()
    }

    /// Spawn a capture-all upstream plus the proxy, returning
    /// (proxy_port, upstream_port, captured).
    pub(crate) async fn spawn_proxy_and_capture(
        token: &str,
    ) -> (u16, u16, Arc<tokio::sync::Mutex<Vec<CapturedRequest>>>) {
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cap = Arc::clone(&captured);
        let upstream_port = spawn_raw_listener(move |mut wire| {
            let cap = Arc::clone(&cap);
            async move {
                let req = read_request(&mut wire).await;
                cap.lock().await.push(req);
                wire.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                    .await;
            }
        });
        let proxy_port = spawn_proxy(token).await;
        (proxy_port, upstream_port, captured)
    }
}

#[cfg(test)]
mod lb_probes {
    use super::wire_support::*;
    use super::*;

    // ── L0 sanity: a plain GET passes through the proxy at all ────────────
    #[tokio::test]
    async fn l0_sanity_plain_get_through_proxy() {
        let upstream_port = spawn_raw_listener(move |mut wire| async move {
            let _req = read_request(&mut wire).await;
            wire.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\nhello")
                .await;
        });
        let proxy_port = spawn_proxy(TEST_TOKEN).await;
        let resp = raw_exchange(
            proxy_port,
            &proxy_head(proxy_port, TEST_TOKEN, "GET", upstream_port, "/", &[]),
        )
        .await;
        assert_eq!(resp.status_code(), 200);
        assert_eq!(resp.body, b"hello");
    }

    // ── L1: axum matches percent-ENCODED paths and `uri.path()` is raw ─────
    //
    // The G1 fix parses `<port>`/`<rest>` off the raw URI instead of the
    // decoded `Path<String>` catch-all. Load-bearing: if axum rejected encoded
    // paths at routing time or handed the handler a decoded URI, the fix would
    // have to move elsewhere entirely.
    #[tokio::test]
    async fn l1_route_matches_encoded_path_and_uri_path_is_raw() {
        let app = Router::new().route(
            "/api/proxy/http/{*tail}",
            any(|uri: Uri| async move { uri.path().to_string() }),
        );
        let port = spawn_app(app).await;
        let resp = raw_exchange(
            port,
            b"GET /api/proxy/http/5173/a%2Fb/c%20d?q=%2F HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n",
        )
        .await;
        assert_eq!(resp.status_code(), 200, "route must match an encoded path");
        assert_eq!(
            String::from_utf8(resp.body).unwrap(),
            "/api/proxy/http/5173/a%2Fb/c%20d",
            "uri.path() must be the RAW, undecoded path"
        );
    }

    // ── L2: `HeaderMap::insert` collapses; `append` preserves ──────────────
    //
    // Confirms G2's mechanism: the current proxy copies headers with
    // `insert`, which REPLACES all existing values (multi `Set-Cookie` dies).
    #[test]
    fn l2_headermap_insert_collapses_append_preserves() {
        let mut collapsed = HeaderMap::new();
        collapsed.insert(
            HeaderName::from_static("x-dupe"),
            HeaderValue::from_static("one"),
        );
        collapsed.insert(
            HeaderName::from_static("x-dupe"),
            HeaderValue::from_static("two"),
        );
        assert_eq!(
            collapsed.get_all("x-dupe").iter().count(),
            1,
            "insert REPLACES every existing value for the name"
        );

        let mut preserved = HeaderMap::new();
        preserved.append(
            HeaderName::from_static("x-dupe"),
            HeaderValue::from_static("one"),
        );
        preserved.append(
            HeaderName::from_static("x-dupe"),
            HeaderValue::from_static("two"),
        );
        let values: Vec<_> = preserved
            .get_all("x-dupe")
            .iter()
            .map(|v| v.to_str().unwrap())
            .collect();
        assert_eq!(values, ["one", "two"], "append preserves order + values");
    }

    // ── L3: `Bytes` extraction is DefaultBodyLimit-capped; `Body` is not ────
    //
    // The G3 fix streams `axum::body::Body` instead of buffering `Bytes`.
    // Load-bearing: confirms the observed 413 mechanism and that extracting
    // `Body` directly really sidesteps the limit (no extra layer needed).
    #[tokio::test]
    async fn l3_bytes_extractor_hits_default_body_limit_body_extractor_does_not() {
        let big = vec![b'x'; 3 * 1024 * 1024];

        let bytes_app = Router::new().route(
            "/t",
            any(|body: axum::body::Bytes| async move { body.len().to_string() }),
        );
        let port = spawn_app(bytes_app).await;
        let mut req = format!(
            "POST /t HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
            big.len()
        )
        .into_bytes();
        req.extend_from_slice(&big);
        let resp = raw_exchange_may_close_request_early(port, &req).await;
        assert_eq!(
            resp.status_code(),
            413,
            "Bytes extraction must hit axum's 2 MiB DefaultBodyLimit"
        );

        let body_app = Router::new().route(
            "/t",
            any(|body: Body| async move {
                let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
                bytes.len().to_string()
            }),
        );
        let port = spawn_app(body_app).await;
        let resp = raw_exchange(port, &req).await;
        assert_eq!(resp.status_code(), 200, "Body extraction is uncapped");
        assert_eq!(String::from_utf8(resp.body).unwrap(), big.len().to_string());
    }

    // ── L4: reqwest injects NO accept-encoding and performs NO decompression ─
    //
    // The proxy forwards whatever the client sent (gzip included) byte-exact.
    // Load-bearing: if reqwest auto-added `Accept-Encoding` or transparently
    // decompressed, forwarded `content-encoding` + body bytes would disagree.
    // (Cargo already shows `default-features=false` without compression
    // features; this probe proves the runtime behavior, not the manifest.)
    #[tokio::test]
    async fn l4_reqwest_no_accept_encoding_injection_and_no_decompression() {
        // Real gzip bytes of "proxied-gzip-payload-0123456789" (gzip -n).
        const GZIP: [u8; 51] = [
            0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x03, 0x2b, 0x28, 0xca, 0xaf,
            0xc8, 0x4c, 0x4d, 0xd1, 0x4d, 0xaf, 0xca, 0x2c, 0xd0, 0x2d, 0x48, 0xac, 0xcc, 0xc9,
            0x4f, 0x4c, 0xd1, 0x35, 0x30, 0x34, 0x32, 0x36, 0x31, 0x35, 0x33, 0xb7, 0xb0, 0x04,
            0x00, 0x0d, 0xae, 0xc4, 0xd7, 0x1f, 0x00, 0x00, 0x00,
        ];
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cap = Arc::clone(&captured);
        let upstream_port = spawn_raw_listener(move |mut wire| {
            let cap = Arc::clone(&cap);
            async move {
                let req = read_request(&mut wire).await;
                cap.lock().await.push(req);
                let mut resp =
                    b"HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: 51\r\n\r\n"
                        .to_vec();
                resp.extend_from_slice(&GZIP);
                wire.write_all(&resp).await;
            }
        });
        let proxy_port = spawn_proxy(TEST_TOKEN).await;
        // NOTE: the client deliberately sends NO accept-encoding.
        let resp = raw_exchange(
            proxy_port,
            &proxy_head(proxy_port, TEST_TOKEN, "GET", upstream_port, "/", &[]),
        )
        .await;
        assert_eq!(resp.status_code(), 200);
        let got = captured.lock().await;
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].header_values("accept-encoding").count(),
            0,
            "reqwest must NOT inject accept-encoding; got {:?}",
            got[0].headers
        );
        assert_eq!(
            resp.header_values("content-encoding").collect::<Vec<_>>(),
            vec!["gzip"],
            "content-encoding header must survive"
        );
        assert_eq!(
            resp.body, GZIP,
            "gzip body bytes must pass through untouched (no decompression)"
        );
    }

    // ── L5: reqwest honors an explicit content-length with a streamed body ──
    //
    // The G3 fix streams the incoming body via `Body::wrap_stream` while
    // forwarding the client's original `content-length` (legacy parity). If
    // reqwest overrode or ignored the explicit header, swe would fall back to
    // chunked (still spec-legal, but a parity wobble worth knowing upfront).
    #[tokio::test]
    async fn l5_wrap_stream_honors_explicit_content_length() {
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cap = Arc::clone(&captured);
        let upstream_port = spawn_raw_listener(move |mut wire| {
            let cap = Arc::clone(&cap);
            async move {
                let req = read_request(&mut wire).await;
                cap.lock().await.push(req);
                wire.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                    .await;
            }
        });

        let stream = futures_util::stream::iter(vec![Ok::<_, std::io::Error>(
            axum::body::Bytes::from_static(b"hello world"),
        )]);
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("http://127.0.0.1:{upstream_port}/x"))
            .header("content-length", "11")
            .body(reqwest::Body::wrap_stream(stream))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let got = captured.lock().await;
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].header_values("content-length").collect::<Vec<_>>(),
            vec!["11"],
            "explicit content-length must reach the wire; got {:?}",
            got[0].headers
        );
        assert_eq!(
            got[0].header_values("transfer-encoding").count(),
            0,
            "no chunked framing when content-length is known"
        );
        assert_eq!(got[0].body, b"hello world");
    }
}

// ── Socket-level contract tests (BROWSER-01) ───────────────────────────────
//
// The durable parity contract of `proxy-router.ts`'s HTTP half, driven end
// to end through the REAL proxy router on real loopback sockets
// (`wire_support`). Each test name states the legacy behavior being pinned.
#[cfg(test)]
mod socket_contract {
    use super::wire_support::*;
    use super::*;

    const CONTRACT_TOKEN: &str = "contract-token-0123456789abcdef";

    /// G2 response direction: multi-`Set-Cookie` (and any other repeated
    /// header) must survive the proxy in wire order — the header copy must
    /// APPEND, never collapse. Legacy: Node forwards header arrays verbatim
    /// (`proxy-router.ts:35` + `res.writeHead` with a `set-cookie: string[]`).
    /// This is what keeps proxied apps' session/login flows alive.
    #[tokio::test]
    async fn response_preserves_duplicate_set_cookie_headers_in_order() {
        let upstream_port = spawn_raw_listener(move |mut wire| async move {
            let _req = read_request(&mut wire).await;
            wire.write_all(
                b"HTTP/1.1 200 OK\r\n\
                  content-length: 2\r\n\
                  set-cookie: session=abc; Path=/; HttpOnly\r\n\
                  set-cookie: prefs=dark; Path=/\r\n\
                  x-dupe-marker: first\r\n\
                  x-dupe-marker: second\r\n\r\n\
                  ok",
            )
            .await;
        });
        let proxy_port = spawn_proxy(CONTRACT_TOKEN).await;
        let resp = raw_exchange(
            proxy_port,
            &proxy_head(proxy_port, CONTRACT_TOKEN, "GET", upstream_port, "/", &[]),
        )
        .await;
        assert_eq!(resp.status_code(), 200);
        let cookies: Vec<_> = resp.header_values("set-cookie").collect();
        assert_eq!(
            cookies,
            vec!["session=abc; Path=/; HttpOnly", "prefs=dark; Path=/"],
            "BOTH set-cookie headers must survive in wire order (legacy forwards arrays)"
        );
        let dupes: Vec<_> = resp.header_values("x-dupe-marker").collect();
        assert_eq!(dupes, vec!["first", "second"]);
    }

    /// G2 request direction: a repeated client header must reach upstream
    /// as two headers, in wire order. Legacy passes `req.headers` arrays
    /// through to `http.request` untouched.
    #[tokio::test]
    async fn request_forwards_duplicate_headers_in_order() {
        let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let cap = Arc::clone(&captured);
        let upstream_port = spawn_raw_listener(move |mut wire| {
            let cap = Arc::clone(&cap);
            async move {
                let req = read_request(&mut wire).await;
                cap.lock().await.push(req);
                wire.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                    .await;
            }
        });
        let proxy_port = spawn_proxy(CONTRACT_TOKEN).await;
        let resp = raw_exchange(
            proxy_port,
            format!(
                "GET /api/proxy/http/{upstream_port}/ HTTP/1.1\r\n\
                 host: 127.0.0.1:{proxy_port}\r\n\
                 x-auth-token: {CONTRACT_TOKEN}\r\n\
                 x-dupe-request: alpha\r\n\
                 x-dupe-request: beta\r\n\
                 connection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await;
        assert_eq!(resp.status_code(), 200);
        let got = captured.lock().await;
        assert_eq!(got.len(), 1);
        let dupes: Vec<_> = got[0].header_values("x-dupe-request").collect();
        assert_eq!(
            dupes,
            vec!["alpha", "beta"],
            "a repeated client header must reach upstream twice, in wire order"
        );
    }
}

#[cfg(test)]
mod socket_contract_g1 {
    use super::wire_support::*;

    const TOKEN: &str = "contract-token-0123456789abcdef";

    /// G1: the upstream request-target must be `[<rest>] [? <query>]` with
    /// EVERY byte the client sent — legacy forwards Node's RAW `req.url`
    /// (`proxy-router.ts:99`), which is never percent-decoded. A dev server
    /// routing on encoded segments (Vite's `/@fs/%2F...`, file names with
    /// `%20`/`%25`) MUST see its real route, not a decoded-and-re-encoded
    /// mutation.
    #[tokio::test]
    async fn path_and_query_reach_upstream_byte_exact_never_decoded() {
        let cases: &[&str] = &[
            // Percent-encoded slash must NOT become a path separator.
            "/a%2Fb/c",
            // Encoded space round-trips as %20, not a literal space.
            "/hello%20world.txt",
            // Encoded percent must not collapse.
            "/100%25-certain",
            // UTF-8 encoded bytes stay encoded exactly as sent.
            "/caf%C3%A9/na%C3%AFve",
            // Encoded '?' stays data, not a query boundary.
            "/x%3Fy/z",
            // Encoded query values pass through untranslated.
            "/search?q=a%2Fb&r=%20&n=1%2B1",
            // '?' + raw '+' in query: no form-decoding games.
            "/plus?a=1+2&b=x+y",
            // Repeated and empty query keys, order preserved.
            "/multi?a=1&a=2&empty=&b=3",
            // Deep path with trailing slash.
            "/assets/vendor/%40scope/pkg/dist/",
            // Bare root forms.
            "/",
            "",
        ];
        for path_and_query in cases {
            let (proxy_port, upstream_port, captured) = spawn_proxy_and_capture(TOKEN).await;
            let resp = raw_exchange(
                proxy_port,
                format!(
                    "GET /api/proxy/http/{upstream_port}{path_and_query} HTTP/1.1\r\n\
                     host: 127.0.0.1:{proxy_port}\r\n\
                     x-auth-token: {TOKEN}\r\n\
                     connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await;
            assert_eq!(resp.status_code(), 200, "case {path_and_query:?}");
            let got = captured.lock().await;
            assert_eq!(got.len(), 1, "case {path_and_query:?}");
            let expected = if path_and_query.is_empty() {
                "/"
            } else {
                *path_and_query
            };
            assert_eq!(
                got[0].raw_target(),
                expected,
                "upstream must receive the byte-exact raw path+query (legacy: raw req.url)"
            );
        }
    }
}

#[cfg(test)]
mod socket_contract_g3 {
    use super::wire_support::*;
    use std::sync::Arc;

    const TOKEN: &str = "contract-token-0123456789abcdef";

    /// G3 (capacity + framing): a multi-MiB body must stream through — legacy
    /// pipes the raw request stream with NO size ceiling (`req.pipe(proxyReq)`,
    /// `proxy-router.ts:119-120`; only the pre-proxy `express.json` 1MB cap
    /// touches JSON). The original `content-length` rides along (legacy strips
    /// only host/connection/transfer-encoding), so upstream never sees a
    /// re-framed chunked upload when the client declared a length.
    #[tokio::test]
    async fn large_body_streams_through_with_original_content_length() {
        let (proxy_port, upstream_port, captured) = spawn_proxy_and_capture(TOKEN).await;
        let big: Vec<u8> = (0..(3 * 1024 * 1024u32)).map(|i| (i % 251) as u8).collect();
        let mut request = format!(
            "POST /api/proxy/http/{upstream_port}/upload HTTP/1.1\r\n\
             host: 127.0.0.1:{proxy_port}\r\n\
             x-auth-token: {TOKEN}\r\n\
             content-type: application/octet-stream\r\n\
             content-length: {}\r\n\
             connection: close\r\n\r\n",
            big.len()
        )
        .into_bytes();
        request.extend_from_slice(&big);
        let resp = raw_exchange(proxy_port, &request).await;
        assert_eq!(resp.status_code(), 200, "3 MiB upload must not 413");
        let got = captured.lock().await;
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].header_values("content-length").collect::<Vec<_>>(),
            vec![big.len().to_string()],
            "upstream must see the ORIGINAL content-length, not a re-framed body"
        );
        assert_eq!(
            got[0].header_values("transfer-encoding").count(),
            0,
            "no chunked re-framing when the client declared a length"
        );
        assert_eq!(got[0].body.len(), big.len(), "byte count preserved");
        assert!(got[0].body == big, "every byte preserved");
    }

    /// G3 (incrementality): the first body chunk must be observable UPSTREAM
    /// before the client has sent the last chunk — i.e. the proxy streams the
    /// request body instead of fully buffering it. Signal-gated both ways:
    /// zero wall-clock sleeps; pre-fix this deadlocks into the read deadline
    /// (the buffered extractor waits for a complete body the client is
    /// holding back), post-fix it flows.
    #[tokio::test]
    async fn request_body_chunks_arrive_upstream_incrementally() {
        let (seen_tx, seen_rx) = tokio::sync::oneshot::channel::<Vec<u8>>();
        let seen_tx = Arc::new(tokio::sync::Mutex::new(Some(seen_tx)));
        let full_body = Arc::new(tokio::sync::Mutex::new(Vec::new()));
        let fb = Arc::clone(&full_body);
        let upstream_port = spawn_raw_listener(move |mut wire| {
            let seen_tx = Arc::clone(&seen_tx);
            let fb = Arc::clone(&fb);
            async move {
                let _head = wire.read_until(b"\r\n\r\n").await;
                // First chunk only (frame: "5\r\nhello\r\n").
                let size_line = wire.read_until(b"\r\n").await;
                assert_eq!(String::from_utf8_lossy(&size_line).trim(), "5");
                let first = wire.read_n(5).await;
                let crlf = wire.read_n(2).await;
                assert_eq!(crlf, b"\r\n");
                // Prove arrival BEFORE the client's final chunk leaves.
                if let Some(tx) = seen_tx.lock().await.take() {
                    let _ = tx.send(first.clone());
                }
                let mut body = first;
                // Remaining chunks through the terminator.
                body.extend_from_slice(&wire.read_chunked().await);
                fb.lock().await.extend_from_slice(&body);
                wire.write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok")
                    .await;
            }
        });
        let proxy_port = spawn_proxy(TOKEN).await;

        tokio::time::timeout(std::time::Duration::from_secs(10), async move {
            let stream = tokio::net::TcpStream::connect(("127.0.0.1", proxy_port))
                .await
                .unwrap();
            let mut wire = Wire::new(stream);
            let head = format!(
                "POST /api/proxy/http/{upstream_port}/stream-upload HTTP/1.1\r\n\
                 host: 127.0.0.1:{proxy_port}\r\n\
                 x-auth-token: {TOKEN}\r\n\
                 content-type: text/plain\r\n\
                 transfer-encoding: chunked\r\n\
                 connection: close\r\n\r\n"
            );
            wire.write_all(head.as_bytes()).await;
            wire.write_all(b"5\r\nhello\r\n").await;

            // The upstream MUST observe the first chunk while the client is
            // still holding the second one back.
            let first = seen_rx.await.expect("upstream must see the first chunk");
            assert_eq!(first, b"hello");

            wire.write_all(b"5\r\nworld\r\n0\r\n\r\n").await;

            let resp_head = wire.read_until(b"\r\n\r\n").await;
            let (status_line, headers) = parse_head(&resp_head);
            assert_eq!(status_line, "HTTP/1.1 200 OK");
            // Framing-agnostic body drain (content-length forwarding is G4).
            let _body =
                if header_values(&headers, "transfer-encoding").any(|v| v.contains("chunked")) {
                    wire.read_chunked().await
                } else if let Some(cl) = header_values(&headers, "content-length").next() {
                    wire.read_n(cl.parse().unwrap()).await
                } else {
                    wire.read_to_eof().await
                };
        })
        .await
        .expect("request body must stream (deadlock = full buffering)");

        assert_eq!(
            full_body.lock().await.as_slice(),
            b"helloworld",
            "reassembled upstream body is the full stream"
        );
    }
}

#[cfg(test)]
mod socket_contract_g4 {
    use super::wire_support::*;

    const TOKEN: &str = "contract-token-0123456789abcdef";

    /// G4: `content-length` is NOT an iframe-blocking header — the removal set
    /// is exactly `{x-frame-options, content-security-policy,
    /// content-security-policy-report-only}` (`proxy-router.ts:19-23`), and
    /// legacy's `writeHead(status, strippedHeaders)` forwards everything else,
    /// length included. Because reqwest runs with zero compression features,
    /// response bytes are bit-exact (probe L4), so the advertised length stays
    /// truthful. hyper re-frames ONLY the genuinely hop-by-hop headers
    /// (`connection`, `transfer-encoding`, `keep-alive`).
    #[tokio::test]
    async fn response_forwards_content_length_and_every_non_blocking_header() {
        let upstream_port = spawn_raw_listener(move |mut wire| async move {
            let _req = read_request(&mut wire).await;
            wire.write_all(
                b"HTTP/1.1 200 OK\r\n\
                  content-type: text/plain; charset=utf-8\r\n\
                  content-length: 11\r\n\
                  etag: \"v1-abc\"\r\n\
                  cache-control: no-store\r\n\
                  x-custom-upstream: keep-me\r\n\
                  vary: accept-encoding\r\n\
                  x-frame-options: DENY\r\n\
                  content-security-policy: frame-ancestors 'none'\r\n\
                  content-security-policy-report-only: default-src 'self'\r\n\r\n\
                  hello world",
            )
            .await;
        });
        let proxy_port = spawn_proxy(TOKEN).await;
        let resp = raw_exchange(
            proxy_port,
            &proxy_head(proxy_port, TOKEN, "GET", upstream_port, "/page", &[]),
        )
        .await;
        assert_eq!(resp.status_code(), 200);
        assert_eq!(resp.body, b"hello world");
        assert_eq!(
            resp.header_values("content-length").collect::<Vec<_>>(),
            vec!["11"],
            "content-length must survive — it is not an iframe-blocking header"
        );
        assert_eq!(
            resp.header_values("etag").collect::<Vec<_>>(),
            vec!["\"v1-abc\""]
        );
        assert_eq!(
            resp.header_values("cache-control").collect::<Vec<_>>(),
            vec!["no-store"]
        );
        assert_eq!(
            resp.header_values("x-custom-upstream").collect::<Vec<_>>(),
            vec!["keep-me"]
        );
        assert_eq!(
            resp.header_values("vary").collect::<Vec<_>>(),
            vec!["accept-encoding"]
        );
        assert_eq!(
            resp.header_values("content-type").collect::<Vec<_>>(),
            vec!["text/plain; charset=utf-8"]
        );
        // The removal set is EXACTLY these three — nothing more.
        assert_eq!(resp.header_values("x-frame-options").count(), 0);
        assert_eq!(resp.header_values("content-security-policy").count(), 0);
        assert_eq!(
            resp.header_values("content-security-policy-report-only")
                .count(),
            0
        );
    }
}

#[cfg(test)]
mod socket_contract_rest {
    use super::wire_support::*;
    use std::sync::Arc;

    const TOKEN: &str = "contract-token-0123456789abcdef";

    async fn one_free_closed_port() -> u16 {
        // Bind then drop: nobody is listening at this port afterwards.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        port
    }

    /// Every HTTP method reaches upstream verbatim (`any(proxy)` mirrors
    /// Express's method-agnostic `router.use`).
    #[tokio::test]
    async fn all_methods_forward_verbatim() {
        for method in ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] {
            let (proxy_port, upstream_port, captured) = spawn_proxy_and_capture(TOKEN).await;
            let resp = raw_exchange(
                proxy_port,
                &proxy_head(proxy_port, TOKEN, method, upstream_port, "/m", &[]),
            )
            .await;
            assert_eq!(resp.status_code(), 200, "method {method}");
            let got = captured.lock().await;
            assert_eq!(got.len(), 1, "method {method}");
            assert!(
                got[0].request_line.starts_with(&format!("{method} /m ")),
                "method {method} must reach upstream verbatim: {:?}",
                got[0].request_line
            );
        }
    }

    /// Upstream statuses pass through untouched, including a 302 whose
    /// `location` header must reach the iframe (redirects are NEVER followed
    /// — Node's raw `http.request` follows none either).
    #[tokio::test]
    async fn statuses_and_redirect_location_forward_verbatim() {
        let cases: &[(&[u8], u16)] = &[
            (
                b"HTTP/1.1 201 Created\r\ncontent-length: 7\r\n\r\ncreated",
                201,
            ),
            (
                b"HTTP/1.1 302 Found\r\nlocation: /target?x=%2F&y=1\r\ncontent-length: 0\r\n\r\n",
                302,
            ),
            (
                b"HTTP/1.1 404 Not Found\r\ncontent-length: 7\r\n\r\nmissing",
                404,
            ),
            (
                b"HTTP/1.1 418 I'm a Teapot\r\ncontent-length: 6\r\n\r\nteapot",
                418,
            ),
        ];
        for (response_bytes, expected_status) in cases {
            let response_bytes = response_bytes.to_vec();
            let upstream_port = spawn_raw_listener(move |mut wire| {
                let response_bytes = response_bytes.clone();
                async move {
                    let _req = read_request(&mut wire).await;
                    wire.write_all(&response_bytes).await;
                }
            });
            let proxy_port = spawn_proxy(TOKEN).await;
            let resp = raw_exchange(
                proxy_port,
                &proxy_head(proxy_port, TOKEN, "GET", upstream_port, "/s", &[]),
            )
            .await;
            assert_eq!(resp.status_code(), *expected_status);
            if *expected_status == 302 {
                assert_eq!(
                    resp.header_values("location").collect::<Vec<_>>(),
                    vec!["/target?x=%2F&y=1"],
                    "the iframe must see the real 302 target (never followed)"
                );
            }
        }
    }

    /// Error shapes stay byte-compatible with legacy:
    /// `502 {"error":"Failed to connect to localhost:<port>"}`,
    /// `400 {"error":"Invalid port number"}`,
    /// `401 {"error":"Unauthorized"}`.
    #[tokio::test]
    async fn error_shapes_match_legacy() {
        let proxy_port = spawn_proxy(TOKEN).await;

        // 502: port with nobody listening.
        let closed = one_free_closed_port().await;
        let resp = raw_exchange(
            proxy_port,
            &proxy_head(proxy_port, TOKEN, "GET", closed, "/x", &[]),
        )
        .await;
        assert_eq!(resp.status_code(), 502);
        assert_eq!(
            String::from_utf8(resp.body).unwrap(),
            format!("{{\"error\":\"Failed to connect to localhost:{closed}\"}}")
        );

        // 400: out-of-range and non-numeric ports.
        for bad in ["0", "65536", "abc", "-1", "80x"] {
            let resp = raw_exchange(
                proxy_port,
                format!(
                    "GET /api/proxy/http/{bad}/x HTTP/1.1\r\n\
                     host: 127.0.0.1:{proxy_port}\r\n\
                     x-auth-token: {TOKEN}\r\n\
                     connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await;
            assert_eq!(resp.status_code(), 400, "port {bad:?}");
            assert_eq!(
                String::from_utf8(resp.body).unwrap(),
                "{\"error\":\"Invalid port number\"}"
            );
        }

        // 401: missing and wrong credentials.
        for auth_line in ["", "x-auth-token: wrong-token\r\n"] {
            let resp = raw_exchange(
                proxy_port,
                format!(
                    "GET /api/proxy/http/{closed}/x HTTP/1.1\r\n\
                     host: 127.0.0.1:{proxy_port}\r\n\
                     {auth_line}\
                     connection: close\r\n\r\n"
                )
                .as_bytes(),
            )
            .await;
            assert_eq!(resp.status_code(), 401, "auth line {auth_line:?}");
            assert_eq!(
                String::from_utf8(resp.body).unwrap(),
                "{\"error\":\"Unauthorized\"}"
            );
        }
    }

    /// Auth via the `freshell-auth` cookie (the browser pane's iframe path —
    /// `buildHttpProxyUrl` keeps requests same-origin, so the cookie rides).
    #[tokio::test]
    async fn cookie_auth_accepted() {
        let (proxy_port, upstream_port, _) = spawn_proxy_and_capture(TOKEN).await;
        let resp = raw_exchange(
            proxy_port,
            format!(
                "GET /api/proxy/http/{upstream_port}/ HTTP/1.1\r\n\
                 host: 127.0.0.1:{proxy_port}\r\n\
                 cookie: freshell-auth={TOKEN}\r\n\
                 connection: close\r\n\r\n"
            )
            .as_bytes(),
        )
        .await;
        assert_eq!(resp.status_code(), 200);
    }

    /// Useful request headers pass through; `host` is rewritten to the
    /// loopback target; hop-by-hop framing headers are dropped —
    /// `proxy-router.ts:90-93` plus the wrap-review r3 security strip on
    /// BOTH servers: the gate's own credentials (`x-auth-token` header,
    /// the `freshell-auth` cookie pair) are withheld from upstream while
    /// an app's own cookies (`session=live` here, mingled in ONE cookie
    /// header with the auth pair) still flow.
    #[tokio::test]
    async fn useful_request_headers_pass_host_rewritten_framing_dropped() {
        let (proxy_port, upstream_port, captured) = spawn_proxy_and_capture(TOKEN).await;
        let resp = raw_exchange(
            proxy_port,
            &proxy_head(
                proxy_port,
                TOKEN,
                "GET",
                upstream_port,
                "/h",
                &[
                    "cookie: freshell-auth=the-gate-token; session=live; theme=dark",
                    "authorization: Bearer abc123",
                    "user-agent: FreshellE2E/1.0",
                    "accept: text/html, application/xhtml+xml",
                    "accept-encoding: gzip",
                    "x-custom-request: yes-please",
                    "referer: http://127.0.0.1:9/inside",
                ],
            ),
        )
        .await;
        assert_eq!(resp.status_code(), 200);
        let got = captured.lock().await;
        assert_eq!(got.len(), 1);
        let req = &got[0];
        assert_eq!(
            req.header_values("host").collect::<Vec<_>>(),
            vec![format!("127.0.0.1:{upstream_port}")],
            "host is rewritten to the loopback target exactly"
        );
        assert_eq!(
            req.header_values("cookie").collect::<Vec<_>>(),
            vec!["session=live; theme=dark"],
            "the app's cookies survive; ONLY the freshell-auth pair is withheld"
        );
        assert_eq!(
            req.header_values("authorization").collect::<Vec<_>>(),
            vec!["Bearer abc123"]
        );
        assert_eq!(
            req.header_values("user-agent").collect::<Vec<_>>(),
            vec!["FreshellE2E/1.0"]
        );
        assert_eq!(
            req.header_values("accept").collect::<Vec<_>>(),
            vec!["text/html, application/xhtml+xml"]
        );
        assert_eq!(
            req.header_values("accept-encoding").collect::<Vec<_>>(),
            vec!["gzip"],
            "the client's accept-encoding forwards untouched (passthrough, L4)"
        );
        assert_eq!(
            req.header_values("x-custom-request").collect::<Vec<_>>(),
            vec!["yes-please"]
        );
        assert_eq!(
            req.header_values("referer").collect::<Vec<_>>(),
            vec!["http://127.0.0.1:9/inside"]
        );
        assert_eq!(
            req.header_values("connection").count(),
            0,
            "hop-by-hop dropped"
        );
        assert_eq!(
            req.header_values("keep-alive").count(),
            0,
            "hop-by-hop dropped"
        );
        // The gate's own credential must NEVER reach the upstream (the
        // wrap-review r3 strip — the original legacy leak is patched on
        // both servers).
        assert_eq!(
            req.header_values("x-auth-token").count(),
            0,
            "x-auth-token is withheld from upstream"
        );
    }

    /// A request carrying ONLY the auth cookie (the browser pane's iframe
    /// navigation shape: the browser attaches `freshell-auth` because the
    /// iframe is same-origin) arrives at the upstream with NO cookie header
    /// at all — not even an empty residue.
    #[tokio::test]
    async fn auth_only_cookie_is_dropped_entirely_upstream() {
        let (proxy_port, upstream_port, captured) = spawn_proxy_and_capture(TOKEN).await;
        let resp = raw_exchange(
            proxy_port,
            &proxy_head(
                proxy_port,
                TOKEN,
                "GET",
                upstream_port,
                "/only-auth",
                &["cookie: freshell-auth=the-gate-token"],
            ),
        )
        .await;
        assert_eq!(resp.status_code(), 200);
        let got = captured.lock().await;
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].header_values("cookie").count(),
            0,
            "a cookie header carrying only freshell-auth must not reach upstream"
        );
        assert_eq!(
            got[0].header_values("x-auth-token").count(),
            0,
            "the gate header never reaches upstream"
        );
    }

    /// Response streaming: the first chunk must be observable at the CLIENT
    /// while the upstream is still holding the second back — the response is a
    /// live pipe, not a filled buffer. Signal-gated both directions; zero
    /// wall-clock sleeps.
    #[tokio::test]
    async fn response_streams_chunk_by_chunk_incrementally() {
        let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
        let release_rx = Arc::new(tokio::sync::Mutex::new(Some(release_rx)));
        let upstream_port = spawn_raw_listener(move |mut wire| {
            let release_rx = Arc::clone(&release_rx);
            async move {
                let _req = read_request(&mut wire).await;
                wire.write_all(
                    b"HTTP/1.1 200 OK\r\n\
                      content-type: text/event-stream\r\n\
                      transfer-encoding: chunked\r\n\r\n\
                      5\r\nhello\r\n",
                )
                .await;
                // Hold the second chunk until the test proves the first one
                // already arrived at the client.
                if let Some(rx) = release_rx.lock().await.take() {
                    let _ = rx.await;
                }
                wire.write_all(b"5\r\nworld\r\n0\r\n\r\n").await;
            }
        });
        let proxy_port = spawn_proxy(TOKEN).await;

        tokio::time::timeout(std::time::Duration::from_secs(10), async move {
            let stream = tokio::net::TcpStream::connect(("127.0.0.1", proxy_port))
                .await
                .unwrap();
            let mut wire = Wire::new(stream);
            wire.write_all(&proxy_head(
                proxy_port,
                TOKEN,
                "GET",
                upstream_port,
                "/events",
                &[],
            ))
            .await;
            let head = wire.read_until(b"\r\n\r\n").await;
            let (status_line, _headers) = parse_head(&head);
            assert_eq!(status_line, "HTTP/1.1 200 OK");
            // First chunk ONLY (frame: "5\r\nhello\r\n").
            let size_line = wire.read_until(b"\r\n").await;
            assert_eq!(String::from_utf8_lossy(&size_line).trim(), "5");
            let first = wire.read_n(5).await;
            assert_eq!(
                first, b"hello",
                "first chunk arrives while upstream holds the rest"
            );
            let crlf = wire.read_n(2).await;
            assert_eq!(crlf, b"\r\n");
            // Release the upstream's second chunk; the full body reassembles.
            release_tx.send(()).unwrap();
            let rest = wire.read_chunked().await;
            assert_eq!(rest, b"world");
        })
        .await
        .expect("response must stream (deadlock = buffered response)");
    }

    /// HEAD: status + headers forward; the (declared-but-absent) body must not
    /// hang the client. Upstream follows HEAD semantics (no body bytes).
    #[tokio::test]
    async fn head_request_forwards_headers_without_body_hang() {
        let (proxy_port, upstream_port, captured) = spawn_proxy_and_capture(TOKEN).await;
        tokio::time::timeout(std::time::Duration::from_secs(10), async move {
            let stream = tokio::net::TcpStream::connect(("127.0.0.1", proxy_port))
                .await
                .unwrap();
            let mut wire = Wire::new(stream);
            wire.write_all(&proxy_head(
                proxy_port,
                TOKEN,
                "HEAD",
                upstream_port,
                "/h",
                &[],
            ))
            .await;
            let head = wire.read_until(b"\r\n\r\n").await;
            let (status_line, headers) = parse_head(&head);
            assert_eq!(status_line, "HTTP/1.1 200 OK", "HEAD status forwards");
            assert_eq!(
                header_values(&headers, "content-length").collect::<Vec<_>>(),
                vec!["2"],
                "HEAD content-length forwards"
            );
            let body = wire.read_to_eof().await;
            assert_eq!(body, b"", "HEAD never carries a body");
        })
        .await
        .expect("HEAD response must complete (not hang waiting for a body)");
        let got = captured.lock().await;
        assert_eq!(got.len(), 1);
        assert!(got[0].request_line.starts_with("HEAD /h "));
    }

    /// Bodies forward BYTE-EXACT — including pretty-printed JSON whitespace
    /// legacy would have re-serialized (deliberate, recorded divergence:
    /// strictly stronger body preservation) and arbitrary binary.
    #[tokio::test]
    async fn bodies_forward_byte_exact() {
        let pretty_json = "{\n  \"key\": \"v\u{00e8}lue\",\n  \"n\": 1\n}".as_bytes();
        let binary: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
        for (label, body) in [("pretty-json", pretty_json.to_vec()), ("binary", binary)] {
            let (proxy_port, upstream_port, captured) = spawn_proxy_and_capture(TOKEN).await;
            let mut request = format!(
                "POST /api/proxy/http/{upstream_port}/echo HTTP/1.1\r\n\
                 host: 127.0.0.1:{proxy_port}\r\n\
                 x-auth-token: {TOKEN}\r\n\
                 content-length: {}\r\n\
                 connection: close\r\n\r\n",
                body.len()
            )
            .into_bytes();
            request.extend_from_slice(&body);
            let resp = raw_exchange(proxy_port, &request).await;
            assert_eq!(resp.status_code(), 200, "{label}");
            let got = captured.lock().await;
            assert_eq!(got.len(), 1, "{label}");
            assert_eq!(got[0].body, body, "{label} must arrive byte-exact");
        }
    }
}
