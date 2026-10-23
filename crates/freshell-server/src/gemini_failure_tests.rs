//! Name-reliability Task 6: Gemini failure classification. HTTP answers are
//! fed as status + body; transport failures come from REAL `reqwest` errors
//! against loopback fixtures (a proxy that refuses the CONNECT, a closed
//! port, a server that never answers) or from synthetic source chains for
//! the certificate case. No request leaves the host.

use std::time::Duration;

use super::{
    classify_gemini_failure, classify_reqwest_error, classify_transport_error, GeminiFailure,
    GeminiFailureClass,
};

/// The live gateway's refusal (`scratchpad/live-evidence/gemini-probe.json`)
/// with its manage URL removed.
const ONECLI_ACCESS_RESTRICTED: &str = r#"{"error":"access_restricted","manage_url":"<removed>","message":"generativelanguage.googleapis.com credentials exist in OneCLI but this agent does not have access. Ask the user to attach the account to this agent: <removed>","provider":"generativelanguage.googleapis.com"}"#;

const GOOGLE_PERMISSION_DENIED: &str = r#"{"error":{"code":403,"message":"Method doesn't allow unregistered callers (callers without established identity). Please use API Key or other form of API consumer identity to call this API.","status":"PERMISSION_DENIED"}}"#;

const GOOGLE_API_KEY_INVALID: &str = r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID","domain":"googleapis.com","metadata":{"service":"generativelanguage.googleapis.com"}}]}}"#;

const GOOGLE_RESOURCE_EXHAUSTED: &str = r#"{"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}"#;

const GOOGLE_INTERNAL: &str =
    r#"{"error":{"code":500,"message":"An internal error has occurred.","status":"INTERNAL"}}"#;

fn assert_failure(failure: &GeminiFailure, class: GeminiFailureClass, code: &str) {
    assert_eq!(failure.class, class, "class of {failure:?}");
    assert_eq!(failure.code(), code, "code of {failure:?}");
}

#[test]
fn classify_onecli_access_restricted_as_capability() {
    let failure = classify_gemini_failure(403, ONECLI_ACCESS_RESTRICTED.as_bytes());
    assert_failure(
        &failure,
        GeminiFailureClass::Capability,
        "access_restricted",
    );
    assert_eq!(failure.status, Some(403));
    assert!(failure.pauses_naming());
    // The failure keeps a code, never the body or its URLs.
    let text = failure.to_string();
    assert_eq!(text, "gemini http 403 Forbidden (access_restricted)");
    assert!(!format!("{failure:?}").contains("removed"));
}

#[test]
fn classify_onecli_400_access_restricted_as_capability() {
    // The gateway reports a BAD key as 400 with its own body (V1): that is a
    // credential refusal, not an invalid request.
    let failure = classify_gemini_failure(400, ONECLI_ACCESS_RESTRICTED.as_bytes());
    assert_failure(
        &failure,
        GeminiFailureClass::Capability,
        "access_restricted",
    );
    // Other OneCLI codes ride the same rule.
    for code in [
        "credential_not_found",
        "app_not_connected",
        "approval_required",
    ] {
        let body = format!(r#"{{"error":"{code}"}}"#);
        assert_failure(
            &classify_gemini_failure(401, body.as_bytes()),
            GeminiFailureClass::Capability,
            code,
        );
    }
}

#[test]
fn classify_google_permission_denied_as_capability() {
    let failure = classify_gemini_failure(403, GOOGLE_PERMISSION_DENIED.as_bytes());
    assert_failure(
        &failure,
        GeminiFailureClass::Capability,
        "PERMISSION_DENIED",
    );
    // 401 and 407 without a structured body are credential refusals too.
    assert_failure(
        &classify_gemini_failure(401, b"unauthorized"),
        GeminiFailureClass::Capability,
        "http_401",
    );
    assert_failure(
        &classify_gemini_failure(407, b""),
        GeminiFailureClass::Capability,
        "http_407",
    );
}

#[test]
fn classify_api_key_invalid_as_capability() {
    let failure = classify_gemini_failure(400, GOOGLE_API_KEY_INVALID.as_bytes());
    assert_failure(&failure, GeminiFailureClass::Capability, "API_KEY_INVALID");
    // A plain 400 without that reason is an invalid request (consumed).
    let plain = classify_gemini_failure(
        400,
        br#"{"error":{"code":400,"message":"bad","status":"INVALID_ARGUMENT"}}"#,
    );
    assert_failure(&plain, GeminiFailureClass::Invalid, "INVALID_ARGUMENT");
    assert!(!plain.pauses_naming());
}

#[test]
fn classify_429_as_throttled() {
    let failure = classify_gemini_failure(429, GOOGLE_RESOURCE_EXHAUSTED.as_bytes());
    assert_failure(&failure, GeminiFailureClass::Throttled, "throttled");
    assert_eq!(failure.provider_code.as_deref(), Some("RESOURCE_EXHAUSTED"));
    assert!(failure.pauses_naming());
    assert_failure(
        &classify_gemini_failure(429, b""),
        GeminiFailureClass::Throttled,
        "throttled",
    );
}

#[test]
fn classify_429_before_the_onecli_body_rule() {
    // A quota answer rewritten by the gateway (LB-B10) must not latch as a
    // 15-minute capability pause.
    let failure = classify_gemini_failure(429, br#"{"error":"rate_limited"}"#);
    assert_failure(&failure, GeminiFailureClass::Throttled, "throttled");
}

#[test]
fn classify_500_as_transient() {
    let failure = classify_gemini_failure(500, GOOGLE_INTERNAL.as_bytes());
    assert_failure(&failure, GeminiFailureClass::Transient, "INTERNAL");
    assert!(!failure.pauses_naming());
    assert_failure(
        &classify_gemini_failure(503, b"<html>unavailable</html>"),
        GeminiFailureClass::Transient,
        "http_503",
    );
    assert_failure(
        &classify_gemini_failure(404, b"{}"),
        GeminiFailureClass::Invalid,
        "http_404",
    );
    // A code from the body is a short safe token, never free text.
    let odd = classify_gemini_failure(403, br#"{"error":"has spaces and https://x.test/"}"#);
    assert_eq!(odd.class, GeminiFailureClass::Capability);
    assert!(!odd.code().contains("https"), "{}", odd.code());
}

/// A loopback "proxy" that answers every CONNECT with 407.
async fn start_refusing_connect_proxy() -> std::net::SocketAddr {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            tokio::spawn(async move {
                let mut seen = Vec::new();
                let mut buf = [0u8; 1024];
                while !seen.windows(4).any(|w| w == b"\r\n\r\n") {
                    match socket.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => seen.extend_from_slice(&buf[..n]),
                    }
                }
                let _ = socket
                    .write_all(
                        b"HTTP/1.1 407 Proxy Authentication Required\r\ncontent-length: 0\r\n\r\n",
                    )
                    .await;
            });
        }
    });
    addr
}

async fn closed_port() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

/// A target that cannot resolve: if a request ever bypassed the proxy it
/// would fail locally, never reach the internet.
const UNREACHABLE_HTTPS_TARGET: &str = "https://gemini.invalid/v1beta/models/m:generateContent";

#[tokio::test]
async fn classify_proxy_connect_refusal_as_capability() {
    // A proxy that refuses the CONNECT with 407.
    let proxy = start_refusing_connect_proxy().await;
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::https(format!("http://{proxy}")).unwrap())
        .build()
        .unwrap();
    let error = client
        .post(UNREACHABLE_HTTPS_TARGET)
        .body("{}")
        .send()
        .await
        .expect_err("the proxy refuses the tunnel");
    let failure = classify_reqwest_error(&error, true);
    assert_failure(
        &failure,
        GeminiFailureClass::Capability,
        "proxy_unreachable",
    );
    assert_eq!(failure.status, None);

    // A proxy that is not listening.
    let port = closed_port().await;
    let client = reqwest::Client::builder()
        .proxy(reqwest::Proxy::https(format!("http://127.0.0.1:{port}")).unwrap())
        .build()
        .unwrap();
    let error = client
        .post(UNREACHABLE_HTTPS_TARGET)
        .body("{}")
        .send()
        .await
        .expect_err("nothing listens on the proxy port");
    assert_failure(
        &classify_reqwest_error(&error, true),
        GeminiFailureClass::Capability,
        "proxy_unreachable",
    );
}

#[derive(Debug)]
struct ChainWrapper(std::io::Error);

impl std::fmt::Display for ChainWrapper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "client error (Connect)")
    }
}

impl std::error::Error for ChainWrapper {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

#[derive(Debug)]
struct RustlsWrapper(rustls::Error);

impl std::fmt::Display for RustlsWrapper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "tls handshake")
    }
}

impl std::error::Error for RustlsWrapper {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}

#[test]
fn classify_untrusted_certificate_by_downcast() {
    let unknown_issuer =
        || rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer);
    // The shape reqwest produces: wrapper → io::Error → rustls error. The
    // io::Error's own `source()` skips its inner error, so the classifier
    // must look inside it.
    let chain = ChainWrapper(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        unknown_issuer(),
    ));
    assert_failure(
        &classify_transport_error(&chain, true, false, true),
        GeminiFailureClass::Capability,
        "proxy_tls",
    );
    assert_failure(
        &classify_transport_error(&chain, true, false, false),
        GeminiFailureClass::Capability,
        "tls_untrusted",
    );
    // A rustls error reached through `source()` directly.
    let direct = RustlsWrapper(unknown_issuer());
    assert_failure(
        &classify_transport_error(&direct, true, false, false),
        GeminiFailureClass::Capability,
        "tls_untrusted",
    );
    // Text alone is never a certificate class.
    let text_only = ChainWrapper(std::io::Error::other(
        "invalid peer certificate: UnknownIssuer",
    ));
    assert_failure(
        &classify_transport_error(&text_only, true, false, true),
        GeminiFailureClass::Capability,
        "proxy_unreachable",
    );
    // A non-certificate rustls error is not a certificate class either.
    let other = ChainWrapper(std::io::Error::new(
        std::io::ErrorKind::InvalidData,
        rustls::Error::DecryptError,
    ));
    assert_failure(
        &classify_transport_error(&other, true, false, false),
        GeminiFailureClass::Capability,
        "direct_unreachable",
    );
}

#[tokio::test]
async fn classify_direct_connect_failure_as_capability() {
    let port = closed_port().await;
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let error = client
        .post(format!(
            "http://127.0.0.1:{port}/v1beta/models/m:generateContent"
        ))
        .body("{}")
        .send()
        .await
        .expect_err("nothing listens");
    assert!(error.is_connect());
    let failure = classify_reqwest_error(&error, false);
    assert_failure(
        &failure,
        GeminiFailureClass::Capability,
        "direct_unreachable",
    );
    assert_eq!(
        failure.to_string(),
        "gemini request failed (direct_unreachable)"
    );
}

#[tokio::test]
async fn classify_timeout_as_transient() {
    // Synthetic: a timeout that is not a connect failure.
    let chain = ChainWrapper(std::io::Error::other("operation timed out"));
    assert_failure(
        &classify_transport_error(&chain, false, true, false),
        GeminiFailureClass::Transient,
        "timeout",
    );
    // Real: a server that accepts and never answers.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((socket, _)) = listener.accept().await {
            held.push(socket);
        }
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_millis(100))
        .build()
        .unwrap();
    let error = client
        .post(format!("http://{addr}/v1beta/models/m:generateContent"))
        .body("{}")
        .send()
        .await
        .expect_err("the server never answers");
    assert!(error.is_timeout());
    assert_failure(
        &classify_reqwest_error(&error, false),
        GeminiFailureClass::Transient,
        "timeout",
    );
    // Anything else is transient too.
    assert_failure(
        &classify_transport_error(&chain, false, false, true),
        GeminiFailureClass::Transient,
        "request_failed",
    );
}
