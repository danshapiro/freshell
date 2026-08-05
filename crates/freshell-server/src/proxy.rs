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
//! The `/api/proxy/forward` TCP port-forward (a remote-only path that requires
//! `netsh` host bridging) is intentionally NOT ported here — it is unused by
//! the loopback e2e and is a later, safety-gated step.
//!
//! ## WebSocket upgrade relay (BROWSER-02 — ports `proxy-router.ts:134-219`)
//!
//! `attachProxyUpgradeHandler` is ported as a branch of the same `/http/<port>`
//! route: an upgrade request on `/api/proxy/http/<port>/...` is authenticated
//! by the raw `freshell-auth` cookie, then relayed to `127.0.0.1:<port>` as a
//! raw TCP pipe (see [`relay_ws`]). The client's handshake is reconstructed
//! verbatim (path + **query**, `host` rewritten), the upstream's `101` —
//! **subprotocol**/extension selection included — flows back untouched, and
//! text/binary/ping/close frames all ride the bidirectional copy as opaque
//! bytes. Check order mirrors the original: port bounds → cookie auth →
//! upstream connect. An out-of-range port answers `400` (the original destroys
//! the socket without a response; a handler must return *something*, and a
//! refused handshake is the same observable failure to a WS client), a cookie
//! miss answers `401` with an empty body, and any upstream connect/handshake
//! failure answers `502` with the original's exact
//! `Extension server on port <port> is unavailable\r\n` text body — every
//! reject carries `Connection: close`, mirroring the original's
//! `socket.destroy()` right after its raw status write.
//!
//! Only structural delta vs the Express wiring: the original prepends itself
//! onto the net server's `upgrade` event and therefore never traverses
//! Express' middleware stack; here the relay is reached through the axum
//! router, so the outer logging/rate-limit layers technically wrap it (each
//! passes a 101 straight through, and one handshake dial consumes one
//! rate-limit token).

use std::convert::Infallible;
use std::sync::Arc;

use axum::{
    body::Body,
    extract::{FromRequestParts, Path, State},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Json, Router,
};
use hyper::upgrade::OnUpgrade;
use hyper_util::rt::TokioIo;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

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
///
/// The same route carries WebSocket-upgrade requests into the raw relay
/// (BROWSER-02, `attachProxyUpgradeHandler`): see [`relay_ws`].
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
    upgrade: MaybeOnUpgrade,
    body: axum::body::Bytes,
) -> Response {
    // Split `<port>` off the front; the remainder (possibly empty) is the upstream
    // path. `5173` → ("5173",""); `5173/` → ("5173",""); `5173/a/b` → ("5173","a/b").
    let (port_raw, rest) = match tail.split_once('/') {
        Some((port, rest)) => (port, rest),
        None => (tail.as_str(), ""),
    };

    // BROWSER-02: a WebSocket-upgrade request on this path takes the raw-relay
    // branch (`attachProxyUpgradeHandler`, `proxy-router.ts:144-219`). Plain
    // requests flow to the HTTP forward path unchanged.
    if let MaybeOnUpgrade(Some(on_upgrade)) = upgrade {
        return relay_ws(
            state,
            port_raw.to_string(),
            rest.to_string(),
            method,
            headers,
            uri,
            on_upgrade,
        )
        .await;
    }

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

/// Optional extractor: `Some(OnUpgrade)` iff the client asked for a WebSocket
/// upgrade on this request (hyper stashed `OnUpgrade` in the request
/// extensions). Non-WS requests — and exotic non-websocket upgrades — fall
/// through to the plain HTTP forward path.
struct MaybeOnUpgrade(Option<OnUpgrade>);

impl FromRequestParts<ProxyState> for MaybeOnUpgrade {
    type Rejection = Infallible;

    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        _state: &ProxyState,
    ) -> Result<Self, Self::Rejection> {
        let is_websocket = parts
            .headers
            .get(header::UPGRADE)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.eq_ignore_ascii_case("websocket"))
            .unwrap_or(false);
        if is_websocket {
            Ok(MaybeOnUpgrade(parts.extensions.remove::<OnUpgrade>()))
        } else {
            Ok(MaybeOnUpgrade(None))
        }
    }
}

/// BROWSER-02: the raw WebSocket-upgrade relay — ports `attachProxyUpgradeHandler`
/// (`proxy-router.ts:144-219`). The client's handshake is replayed verbatim to
/// `127.0.0.1:<port>` (path + query preserved, `host` rewritten), the upstream's
/// `101` (subprotocol/extension selection included) flows back untouched, and
/// from then on both sockets are a raw bidirectional pipe: text, binary, ping and
/// close frames all ride it as opaque bytes, so a clean close handshake and an
/// error teardown both propagate exactly as the upstream drives them.
async fn relay_ws(
    state: ProxyState,
    port_raw: String,
    rest: String,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    on_upgrade: OnUpgrade,
) -> Response {
    // The original's exact check order: port bounds → cookie auth → upstream dial.
    let target_port: u32 = match port_raw.parse::<u32>() {
        Ok(p) if (1..=65535).contains(&p) => p,
        _ => return ws_reject(StatusCode::BAD_REQUEST, "Invalid port number".to_string()),
    };
    if !crate::boot::is_authed(&headers, &state.auth_token) {
        return ws_reject(StatusCode::UNAUTHORIZED, String::new());
    }

    // Dial the loopback target and replay the client's handshake verbatim.
    let mut upstream = match TcpStream::connect(("127.0.0.1", target_port as u16)).await {
        Ok(stream) => stream,
        Err(_) => return upstream_unavailable(target_port),
    };
    let handshake = build_handshake_request(target_port, &rest, &method, &uri, &headers);
    if upstream.write_all(&handshake).await.is_err() {
        return upstream_unavailable(target_port);
    }

    // Read the upstream's handshake response. Only a 101 proceeds; a refused or
    // mangled handshake is the original's "502 + destroy".
    let (status, up_headers, leftover) = match read_handshake_response(&mut upstream).await {
        Some(parsed) => parsed,
        None => return upstream_unavailable(target_port),
    };
    if status != 101 {
        return upstream_unavailable(target_port);
    }

    // Answer the client with the upstream's own 101 (accept key, subprotocol and
    // extension headers ride back verbatim), then hand both sockets to the relay.
    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let out = response.headers_mut();
    for (name, value) in up_headers {
        out.append(name, value);
    }

    tokio::spawn(async move {
        let upgraded = match on_upgrade.await {
            Ok(upgraded) => upgraded,
            Err(_) => return, // client vanished before its own upgrade completed
        };
        let mut client = TokioIo::new(upgraded);
        // Frames the upstream already pipelined behind its 101 go first.
        if !leftover.is_empty() && client.write_all(&leftover).await.is_err() {
            return;
        }
        let mut upstream = upstream;
        let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
    });

    response
}

/// Cap on buffered upstream handshake headers; a valid WS handshake is a few
/// hundred bytes, so 16 KiB is far beyond generous.
const MAX_HANDSHAKE_BYTES: usize = 16 * 1024;

/// Rebuild the client's WS handshake upstream: original method, the path after
/// `<port>` with the query preserved, `host` rewritten to the loopback target,
/// every other header (cookie, `sec-websocket-key`, `sec-websocket-protocol`,
/// extensions, origin) copied verbatim (`proxy-router.ts:190-196`).
fn build_handshake_request(
    port: u32,
    rest: &str,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
) -> Vec<u8> {
    let mut out = Vec::with_capacity(512);
    let query = uri.query().map(|q| format!("?{q}")).unwrap_or_default();
    out.extend_from_slice(format!("{method} /{rest}{query} HTTP/1.1\r\n").as_bytes());
    out.extend_from_slice(format!("host: 127.0.0.1:{port}\r\n").as_bytes());
    for (name, value) in headers.iter() {
        if name.as_str() == "host" {
            continue;
        }
        out.extend_from_slice(name.as_str().as_bytes());
        out.extend_from_slice(b": ");
        out.extend_from_slice(value.as_bytes());
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(b"\r\n");
    out
}

/// Read the upstream handshake response, tolerating arbitrary chunking and
/// keeping any frame bytes that arrived in the same read as the header tail.
/// `None` on EOF mid-headers, an unparseable status line, or an oversized
/// header block.
async fn read_handshake_response<S>(stream: &mut S) -> Option<(u16, Vec<(HeaderName, HeaderValue)>, Vec<u8>)>
where
    S: AsyncRead + Unpin,
{
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    loop {
        if let Some((status, headers, end)) = parse_handshake_response(&buf) {
            return Some((status, headers, buf.split_off(end)));
        }
        if buf.len() >= MAX_HANDSHAKE_BYTES {
            return None;
        }
        match stream.read(&mut chunk).await {
            Ok(0) | Err(_) => return None,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
    }
}

/// Parse a buffered upstream handshake response. Returns `None` while the header
/// block is incomplete (or the status line is unparseable); on success yields
/// the status code, the response headers, and the offset just past the blank
/// line — bytes at/after it are already-read WS frames to replay to the client.
fn parse_handshake_response(buf: &[u8]) -> Option<(u16, Vec<(HeaderName, HeaderValue)>, usize)> {
    let end = find_subslice(buf, b"\r\n\r\n")? + 4;
    let head = std::str::from_utf8(&buf[..end - 4]).ok()?;
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next()?.split_whitespace().nth(1)?.parse().ok()?;
    let mut headers = Vec::new();
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.trim().as_bytes()),
            HeaderValue::from_bytes(value.trim().as_bytes()),
        ) else {
            continue;
        };
        headers.push((name, value));
    }
    Some((status, headers, end))
}

/// Find `needle` in `hay`, returning its start index.
fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|window| window == needle)
}

/// `502` with the original's exact upstream-unavailable line
/// (`proxy-router.ts:207-213`).
fn upstream_unavailable(port: u32) -> Response {
    ws_reject(StatusCode::BAD_GATEWAY, unavailable_body(port))
}

/// The original's exact unavailable text, trailing CRLF included.
fn unavailable_body(port: u32) -> String {
    format!("Extension server on port {port} is unavailable\r\n")
}

/// A raw-socket reject: status + text body + `Connection: close`, mirroring the
/// original's immediate `socket.destroy()` right after its raw status write.
fn ws_reject(status: StatusCode, body: String) -> Response {
    let mut response = (status, body).into_response();
    response
        .headers_mut()
        .insert(header::CONNECTION, HeaderValue::from_static("close"));
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
    fn handshake_request_replays_client_verbatim_with_rewritten_host() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("intranet.panel:8080"));
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("freshell-auth=tok123; other=1"),
        );
        headers.insert(header::CONNECTION, HeaderValue::from_static("Upgrade"));
        headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
        headers.insert(
            "sec-websocket-key",
            HeaderValue::from_static("dGhlIHNhbXBsZSBub25jZQ=="),
        );
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_static("graphql-ws"),
        );
        let uri: Uri = "/api/proxy/http/5173/ws/v1?token=abc&lang=en".parse().unwrap();

        let bytes = build_handshake_request(5173, "ws/v1", &Method::GET, &uri, &headers);
        let text = String::from_utf8(bytes).unwrap();

        // Request line: path after `<port>`, query preserved (`proxy-router.ts:191`).
        assert!(
            text.starts_with("GET /ws/v1?token=abc&lang=en HTTP/1.1\r\n"),
            "{text}"
        );
        // `host` rewritten to the loopback target, the client's original gone.
        assert!(text.contains("host: 127.0.0.1:5173\r\n"), "{text}");
        assert!(!text.contains("intranet.panel"), "{text}");
        // Everything else rides through verbatim: cookie auth, subprotocol offer.
        assert!(text.contains("cookie: freshell-auth=tok123; other=1\r\n"), "{text}");
        assert!(text.contains("sec-websocket-protocol: graphql-ws\r\n"), "{text}");
        assert!(text.ends_with("\r\n\r\n"), "{text}");
    }

    #[test]
    fn handshake_request_root_path_without_query() {
        let uri: Uri = "/api/proxy/http/8080".parse().unwrap();
        let bytes = build_handshake_request(8080, "", &Method::GET, &uri, &HeaderMap::new());
        let text = String::from_utf8(bytes).unwrap();
        assert!(
            text.starts_with("GET / HTTP/1.1\r\nhost: 127.0.0.1:8080\r\n"),
            "{text}"
        );
    }

    #[test]
    fn handshake_response_parses_101_with_subprotocol_and_leftover_frames() {
        let raw = b"HTTP/1.1 101 Switching Protocols\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\nsec-websocket-protocol: graphql-ws\r\n\r\n\x81\x05hello";
        let (status, headers, end) = parse_handshake_response(raw).unwrap();
        assert_eq!(status, 101);
        // Bytes past the blank line are already-read WS frames for the client.
        assert_eq!(&raw[end..], b"\x81\x05hello");
        let proto = headers
            .iter()
            .find(|(n, _)| n == "sec-websocket-protocol")
            .map(|(_, v)| v.clone());
        assert_eq!(proto, Some(HeaderValue::from_static("graphql-ws")));
        let accept = headers
            .iter()
            .find(|(n, _)| n == "sec-websocket-accept")
            .map(|(_, v)| v.clone());
        assert_eq!(
            accept,
            Some(HeaderValue::from_static("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="))
        );
    }

    #[test]
    fn handshake_response_reports_non_101_status() {
        let raw = b"HTTP/1.1 502 Bad Gateway\r\ncontent-length: 11\r\n\r\n";
        let (status, _headers, end) = parse_handshake_response(raw).unwrap();
        assert_eq!(status, 502);
        assert_eq!(end, raw.len());
    }

    #[test]
    fn handshake_response_waits_for_header_terminator() {
        // No blank line yet: the caller must keep reading.
        assert!(
            parse_handshake_response(b"HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\n")
                .is_none()
        );
    }

    #[tokio::test]
    async fn read_handshake_response_splits_headers_from_early_frames() {
        let (mut client, mut server) = tokio::io::duplex(128);
        server
            .write_all(b"HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nsec-web")
            .await
            .unwrap();
        server
            .write_all(b"socket-protocol: chat\r\n\r\n\x82\x04\x01\x02\x03\x04")
            .await
            .unwrap();
        let (status, headers, leftover) = read_handshake_response(&mut client).await.unwrap();
        assert_eq!(status, 101);
        // The binary frame that arrived glued to the header tail survives intact.
        assert_eq!(leftover, b"\x82\x04\x01\x02\x03\x04");
        assert!(headers.iter().any(|(n, v)| n == "upgrade" && v == "websocket"));
        assert!(headers.iter().any(|(n, _)| n == "sec-websocket-protocol"));
    }

    #[tokio::test]
    async fn read_handshake_response_fails_on_eof_mid_headers() {
        let (mut client, mut server) = tokio::io::duplex(64);
        server
            .write_all(b"HTTP/1.1 101 Switching Protocols\r\n")
            .await
            .unwrap();
        drop(server);
        assert!(read_handshake_response(&mut client).await.is_none());
    }

    #[test]
    fn ws_rejects_match_the_originals_raw_socket_writes() {
        // Cookie miss: 401 + empty body, socket closed right after.
        let r = ws_reject(StatusCode::UNAUTHORIZED, String::new());
        assert_eq!(r.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(r.headers().get(header::CONNECTION).unwrap(), "close");

        // Dead upstream: 502 + the original's byte-exact line (`proxy-router.ts:211`).
        let r = upstream_unavailable(9999);
        assert_eq!(r.status(), StatusCode::BAD_GATEWAY);
        assert_eq!(r.headers().get(header::CONNECTION).unwrap(), "close");
        assert_eq!(
            unavailable_body(9999),
            "Extension server on port 9999 is unavailable\r\n"
        );

        // Out-of-range port: 400 (the original destroys the socket silently; a
        // handler must refuse the handshake with *some* response).
        let r = ws_reject(StatusCode::BAD_REQUEST, "Invalid port number".to_string());
        assert_eq!(r.status(), StatusCode::BAD_REQUEST);
        assert_eq!(r.headers().get(header::CONNECTION).unwrap(), "close");
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
