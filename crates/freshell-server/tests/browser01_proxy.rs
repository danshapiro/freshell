//! BROWSER-01 outer black-box test: boots the REAL `freshell-server` binary
//! (diag01 pattern — this crate is `[[bin]]`-only, so the mounted-app wiring
//! is only provable by driving the compiled thing over real sockets) and
//! exercises the same-origin reverse proxy (`/api/proxy/http/<port>/*`)
//! end to end: mount + `is_authed` gate + raw path/query (G1), duplicate
//! headers (G2), content-length + exact removal set (G4), and the legacy
//! 400/401/502 shapes — with a raw TCP upstream capturing verbatim bytes and
//! a raw client asserting verbatim responses (no framework normalization on
//! either side of the wire).
//!
//! The fine-grained streaming/body contract lives in the in-module socket
//! tests (`src/proxy.rs::socket_contract*`); this file pins the main.rs
//! wiring proof and the headline behaviors.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ── Binary boot (mirrors diag01_diag03_logging.rs) ─────────────────────────

fn discover_server_binary() -> PathBuf {
    if let Some(explicit) = std::env::var_os("FRESHELL_SERVER_BIN") {
        return PathBuf::from(explicit);
    }
    let suffix = std::env::consts::EXE_SUFFIX;
    if let Some(found) = find_sibling(suffix) {
        return found;
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let status = Command::new(env!("CARGO"))
        .args(["build", "--bin", "freshell-server"])
        .current_dir(&manifest_dir)
        .status()
        .expect("spawn `cargo build --bin freshell-server`");
    assert!(status.success(), "cargo build --bin freshell-server failed");
    find_sibling(suffix).expect("freshell-server binary not found even after building it")
}

fn find_sibling(suffix: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    for dir in exe.ancestors().skip(1).take(3) {
        let candidate = dir.join(format!("freshell-server{suffix}"));
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn allocate_ephemeral_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    listener.local_addr().expect("local_addr").port()
}

async fn wait_for_health(port: u16, child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let url = format!("http://127.0.0.1:{port}/api/health");
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return false;
        }
        if let Ok(resp) = reqwest::Client::new().get(&url).send().await {
            if resp.status().is_success() {
                return true;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

fn drain_stderr(child: &mut Child) -> String {
    let mut buf = String::new();
    if let Some(stderr) = child.stderr.as_mut() {
        let _ = stderr.read_to_string(&mut buf);
    }
    buf
}

/// Kill-on-drop guard: a panicking assertion must never orphan the spawned
/// server (std's `Child` does NOT kill on drop; a leaked freshell-server
/// would hold its port and confuse sibling swarm workers).
struct ChildGuard(Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

// ── Raw wire helpers (verbatim both directions) ────────────────────────────

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || hay.len() < needle.len() {
        return None;
    }
    hay.windows(needle.len()).position(|w| w == needle)
}

fn parse_head(raw: &[u8]) -> (String, Vec<(String, String)>) {
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

fn header_values<'a>(
    headers: &'a [(String, String)],
    name: &'a str,
) -> impl Iterator<Item = &'a str> {
    headers
        .iter()
        .filter(move |(n, _)| n.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

struct Wire {
    stream: tokio::net::TcpStream,
    buf: Vec<u8>,
}

impl Wire {
    fn new(stream: tokio::net::TcpStream) -> Self {
        Self {
            stream,
            buf: Vec::new(),
        }
    }

    async fn write_all(&mut self, bytes: &[u8]) {
        self.stream.write_all(bytes).await.unwrap();
    }

    async fn read_until(&mut self, needle: &[u8]) -> Vec<u8> {
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

    async fn read_n(&mut self, n: usize) -> Vec<u8> {
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

    async fn read_chunked(&mut self) -> Vec<u8> {
        let mut body = Vec::new();
        loop {
            let size_line = self.read_until(b"\r\n").await;
            let size_text = String::from_utf8_lossy(&size_line);
            let size_text = size_text.trim();
            let size = usize::from_str_radix(size_text.split(';').next().unwrap_or("").trim(), 16)
                .unwrap_or_else(|_| panic!("bad chunk size line {size_text:?}"));
            if size == 0 {
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

#[derive(Debug, Default)]
struct CapturedRequest {
    request_line: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl CapturedRequest {
    fn raw_target(&self) -> &str {
        self.request_line.split(' ').nth(1).unwrap_or("")
    }
}

async fn read_request(wire: &mut Wire) -> CapturedRequest {
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

struct RawResponse {
    status_line: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl RawResponse {
    fn status_code(&self) -> u16 {
        self.status_line
            .split(' ')
            .nth(1)
            .and_then(|c| c.parse().ok())
            .expect("status code")
    }
    fn header_values<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a str> {
        header_values(&self.headers, name)
    }
}

async fn raw_exchange(port: u16, request: &[u8]) -> RawResponse {
    tokio::time::timeout(Duration::from_secs(15), async {
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let mut wire = Wire::new(stream);
        wire.write_all(request).await;
        let head = wire.read_until(b"\r\n\r\n").await;
        let (status_line, headers) = parse_head(&head);
        let body = if header_values(&headers, "transfer-encoding").any(|v| v.contains("chunked")) {
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

impl Wire {
    async fn read_to_eof(&mut self) -> Vec<u8> {
        let mut tmp = [0u8; 8192];
        loop {
            match self.stream.read(&mut tmp).await {
                Ok(0) | Err(_) => break,
                Ok(n) => self.buf.extend_from_slice(&tmp[..n]),
            }
        }
        std::mem::take(&mut self.buf)
    }
}

/// Spawn the in-test raw upstream fixture (capture + scripted verbatim
/// response) and return (port, captured-requests handle).
fn spawn_upstream(
    response: &'static [u8],
) -> (
    u16,
    std::sync::Arc<tokio::sync::Mutex<Vec<CapturedRequest>>>,
) {
    let captured = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let cap = std::sync::Arc::clone(&captured);
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let cap = std::sync::Arc::clone(&cap);
            tokio::spawn(async move {
                let mut wire = Wire::new(stream);
                let req = read_request(&mut wire).await;
                cap.lock().await.push(req);
                wire.write_all(response).await;
            });
        }
    });
    (port, captured)
}

// ── The outer test ─────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browser01_proxy_through_the_real_binary() {
    let server_binary = discover_server_binary();
    let home = tempfile::tempdir().expect("create temp home");
    let port = allocate_ephemeral_port();
    let token = format!("browser01-outer-test-secret-{}", std::process::id());

    let mut child = Command::new(&server_binary)
        .env("PORT", port.to_string())
        .env("AUTH_TOKEN", &token)
        .env("FRESHELL_BIND_HOST", "127.0.0.1")
        .env_remove("FRESHELL_MANAGED_RUNTIME_V1")
        .env("HOME", home.path())
        .env("FRESHELL_HOME", home.path())
        .env_remove("RUST_LOG")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn freshell-server");

    let healthy = wait_for_health(port, &mut child, Duration::from_secs(30)).await;
    if !healthy {
        let stderr = drain_stderr(&mut child);
        let _ = child.kill();
        let _ = child.wait();
        panic!("freshell-server never became healthy on port {port}; stderr:\n{stderr}");
    }

    // From here on the guard owns teardown: any panic in the flow still
    // kills and reaps the child.
    let _guard = ChildGuard(child);
    run_proxy_flow(port, &token).await;
}

async fn run_proxy_flow(port: u16, token: &str) {
    // (1) GET: iframe-blocking headers removed, everything else survives —
    //     multi set-cookie (G2), content-length (G4), custom headers.
    let (upstream_port, captured) = spawn_upstream(
        b"HTTP/1.1 200 OK\r\n\
          content-type: text/html\r\n\
          content-length: 12\r\n\
          x-frame-options: DENY\r\n\
          content-security-policy: frame-ancestors 'none'\r\n\
          content-security-policy-report-only: default-src 'self'\r\n\
          set-cookie: session=abc; Path=/\r\n\
          set-cookie: prefs=dark; Path=/\r\n\
          x-upstream-marker: through-real-binary\r\n\r\n\
          <h1>hi!</h1>",
    );

    let resp = raw_exchange(
        port,
        format!(
            "GET /api/proxy/http/{upstream_port}/ HTTP/1.1\r\n\
             host: 127.0.0.1:{port}\r\n\
             x-auth-token: {token}\r\n\
             cookie: freshell-auth={token}; app=kept\r\n\
             connection: close\r\n\r\n"
        )
        .as_bytes(),
    )
    .await;
    assert_eq!(resp.status_code(), 200, "proxied GET status");
    // The proxy gate's own credentials never cross to the upstream
    // (wrap-review r3, both servers): the captured upstream request carries
    // neither `x-auth-token` nor the `freshell-auth` cookie pair — while
    // the proxied app's own cookie survives.
    {
        let got = captured.lock().await;
        let upstream_req = got
            .iter()
            .find(|r| r.raw_target() == "/")
            .expect("upstream captured the GET");
        assert!(
            !upstream_req
                .headers
                .iter()
                .any(|(k, _)| k.eq_ignore_ascii_case("x-auth-token")),
            "x-auth-token leaked upstream: {:?}",
            upstream_req.headers
        );
        let cookie = upstream_req
            .headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case("cookie"))
            .map(|(_, v)| v.as_str());
        assert_eq!(
            cookie,
            Some("app=kept"),
            "freshell-auth pair filtered, app cookie preserved"
        );
    }
    assert_eq!(resp.body, b"<h1>hi!</h1>");
    assert_eq!(resp.header_values("x-frame-options").count(), 0);
    assert_eq!(resp.header_values("content-security-policy").count(), 0);
    assert_eq!(
        resp.header_values("content-security-policy-report-only")
            .count(),
        0
    );
    assert_eq!(
        resp.header_values("set-cookie").collect::<Vec<_>>(),
        vec!["session=abc; Path=/", "prefs=dark; Path=/"],
        "BOTH set-cookie headers survive through the real binary"
    );
    assert_eq!(
        resp.header_values("content-length").collect::<Vec<_>>(),
        vec!["12"],
        "content-length survives through the real binary"
    );
    assert_eq!(
        resp.header_values("x-upstream-marker").collect::<Vec<_>>(),
        vec!["through-real-binary"]
    );

    // (2) POST: raw path+query byte-exact (G1), body byte-exact with the
    //     original content-length framing (G3-through-real-server).
    let (upstream2, captured2) = spawn_upstream(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok");
    let body = b"{\"a\": 1, \"b\": [true, null]}";
    let resp = raw_exchange(port, &{
        let mut req = format!(
            "POST /api/proxy/http/{upstream2}/a%2Fb/c%20d?q=%2F&n=1+2 HTTP/1.1\r\n\
                 host: 127.0.0.1:{port}\r\n\
                 x-auth-token: {token}\r\n\
                 content-type: application/json\r\n\
                 content-length: {}\r\n\
                 connection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        req.extend_from_slice(body);
        req
    })
    .await;
    assert_eq!(resp.status_code(), 200, "proxied POST status");
    let got = captured2.lock().await;
    assert_eq!(got.len(), 1);
    assert_eq!(
        got[0].raw_target(),
        "/a%2Fb/c%20d?q=%2F&n=1+2",
        "raw path+query must reach the upstream byte-exact through the real binary"
    );
    assert_eq!(got[0].body, body, "post body byte-exact");
    assert_eq!(
        header_values(&got[0].headers, "content-length").collect::<Vec<_>>(),
        vec![body.len().to_string()],
        "original content-length framing preserved"
    );
    assert!(got[0].request_line.starts_with("POST "));
    drop(got);

    // (3) Legacy error shapes through the mounted app (404 fallback never
    //     interferes: these come from the proxy handler itself).
    // 401 missing token:
    let resp = raw_exchange(
        port,
        format!(
            "GET /api/proxy/http/{upstream2}/ HTTP/1.1\r\n\
             host: 127.0.0.1:{port}\r\n\
             connection: close\r\n\r\n"
        )
        .as_bytes(),
    )
    .await;
    assert_eq!(resp.status_code(), 401);
    assert_eq!(
        String::from_utf8(resp.body).unwrap(),
        "{\"error\":\"Unauthorized\"}"
    );

    // 400 invalid port:
    let resp = raw_exchange(
        port,
        format!(
            "GET /api/proxy/http/99999/x HTTP/1.1\r\n\
             host: 127.0.0.1:{port}\r\n\
             x-auth-token: {token}\r\n\
             connection: close\r\n\r\n"
        )
        .as_bytes(),
    )
    .await;
    assert_eq!(resp.status_code(), 400);
    assert_eq!(
        String::from_utf8(resp.body).unwrap(),
        "{\"error\":\"Invalid port number\"}"
    );

    // 502 upstream connection refused:
    let closed = allocate_ephemeral_port(); // bind-then-drop → nobody listening
    let resp = raw_exchange(
        port,
        format!(
            "GET /api/proxy/http/{closed}/x HTTP/1.1\r\n\
             host: 127.0.0.1:{port}\r\n\
             x-auth-token: {token}\r\n\
             connection: close\r\n\r\n"
        )
        .as_bytes(),
    )
    .await;
    assert_eq!(resp.status_code(), 502);
    assert_eq!(
        String::from_utf8(resp.body).unwrap(),
        format!("{{\"error\":\"Failed to connect to localhost:{closed}\"}}")
    );

    // Sanity: the capture fixture from (1) saw exactly one request and the
    // proxied request carried method + host rewrite.
    let got1 = captured.lock().await;
    assert_eq!(got1.len(), 1);
    assert!(got1[0].request_line.starts_with("GET / "));
    assert_eq!(
        header_values(&got1[0].headers, "host").collect::<Vec<_>>(),
        vec![format!("127.0.0.1:{upstream_port}")]
    );
}
