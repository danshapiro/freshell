//! Name-reliability Task 6: route selection, the naming pause, and the
//! session-name HTTP transport over each route. The fake Gemini and the fake
//! proxies are loopback axum servers; the "ambient" proxy a route would
//! honor is given to the normal client explicitly (never through the
//! process environment), and the same proxy URL feeds the route facts, as
//! the boot wiring derives both from one environment. No request leaves the
//! host.

use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::time::Instant;

use super::{
    proxy_facts, select_naming_route, CapabilityLatch, KeyRouteTransport, LatchTransition,
    LatchWindows, NamingRoute, PauseKind, ProxyFacts, SessionNameTransport,
    DEFAULT_CAPABILITY_REPROBE, DEFAULT_THROTTLE_REPROBE, THROTTLE_REPROBE_CAP,
};
use crate::ai_title::{
    AiKeyCell, BoxFuture, GeminiProxyEnvironment, GeminiSessionNameAuth, GeminiSessionNameHttp,
    SESSION_TITLE_MAX_OUTPUT_TOKENS,
};
use crate::gemini_failure::{classify_gemini_failure, GeminiFailure, GeminiFailureClass};

pub(crate) const GEMINI_GENERATE_PATH: &str =
    "/v1beta/models/gemini-3.5-flash-lite:generateContent";

pub(crate) const ONECLI_ACCESS_RESTRICTED_BODY: &str = r#"{"error":"access_restricted","manage_url":"<removed>","message":"credentials exist in OneCLI but this agent does not have access","provider":"generativelanguage.googleapis.com"}"#;

const GOOGLE_API_KEY_INVALID_BODY: &str = r#"{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"API_KEY_INVALID"}]}}"#;

fn gemini_answer(text: &str) -> String {
    serde_json::json!({ "candidates": [{ "content": { "parts": [{ "text": text }] } }] })
        .to_string()
}

fn response(status: u16, body: String) -> axum::response::Response {
    let mut response = axum::response::Response::new(axum::body::Body::from(body));
    *response.status_mut() = axum::http::StatusCode::from_u16(status).unwrap();
    response
        .headers_mut()
        .insert("content-type", "application/json".parse().unwrap());
    response
}

fn api_key_of(headers: &axum::http::HeaderMap) -> Option<String> {
    headers
        .get("x-goog-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
}

/// A loopback fake Gemini. With `valid_key`, any other key answers Google's
/// 400 `API_KEY_INVALID` and no key answers 403; without it every request
/// gets `reply`.
pub(crate) struct FakeGemini {
    pub base_url: String,
    pub keys: Arc<Mutex<Vec<Option<String>>>>,
}

pub(crate) async fn start_fake_gemini(reply: &str, valid_key: Option<&str>) -> FakeGemini {
    let keys = Arc::new(Mutex::new(Vec::new()));
    let observed = Arc::clone(&keys);
    let reply = reply.to_string();
    let valid_key = valid_key.map(str::to_string);
    let app = axum::Router::new().route(
        GEMINI_GENERATE_PATH,
        axum::routing::post(move |headers: axum::http::HeaderMap| {
            let observed = Arc::clone(&observed);
            let reply = reply.clone();
            let valid_key = valid_key.clone();
            async move {
                let key = api_key_of(&headers);
                observed.lock().unwrap().push(key.clone());
                match (&valid_key, &key) {
                    (Some(_), None) => response(
                        403,
                        r#"{"error":{"code":403,"status":"PERMISSION_DENIED"}}"#.to_string(),
                    ),
                    (Some(valid), Some(key)) if valid != key => {
                        response(400, GOOGLE_API_KEY_INVALID_BODY.to_string())
                    }
                    _ => response(200, gemini_answer(&reply)),
                }
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    FakeGemini {
        base_url: format!("http://{addr}/v1beta"),
        keys,
    }
}

/// How the fake proxy answers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProxyMode {
    /// Answer as the gateway's own credential would: the AI reply.
    Ok,
    /// The real gateway's refusal: 403 without a key, 400 with one.
    AccessRestricted,
}

/// One request the fake proxy saw (never its body or credentials).
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProxiedRequest {
    pub path: String,
    pub has_api_key: bool,
}

/// A loopback forward proxy for `http://` targets. It records every request
/// it receives and answers itself (it never forwards).
pub(crate) struct FakeProxy {
    pub port: u16,
    pub requests: Arc<Mutex<Vec<ProxiedRequest>>>,
    pub mode: Arc<Mutex<ProxyMode>>,
}

impl FakeProxy {
    /// A proxy URL carrying OneCLI's authorization marker (percent-encoded,
    /// as the e2e fake does).
    pub fn onecli_url(&self) -> String {
        format!("http://%61oc_test_marker@127.0.0.1:{}", self.port)
    }

    pub fn ordinary_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub fn set_mode(&self, mode: ProxyMode) {
        *self.mode.lock().unwrap() = mode;
    }

    pub fn recorded(&self) -> Vec<ProxiedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

pub(crate) async fn start_fake_proxy(reply: &str, mode: ProxyMode) -> FakeProxy {
    let requests = Arc::new(Mutex::new(Vec::new()));
    let mode = Arc::new(Mutex::new(mode));
    let (observed, current_mode) = (Arc::clone(&requests), Arc::clone(&mode));
    let reply = reply.to_string();
    let app = axum::Router::new().fallback(move |request: axum::extract::Request| {
        let observed = Arc::clone(&observed);
        let current_mode = Arc::clone(&current_mode);
        let reply = reply.clone();
        async move {
            let has_api_key = api_key_of(request.headers()).is_some();
            observed.lock().unwrap().push(ProxiedRequest {
                path: request.uri().path().to_string(),
                has_api_key,
            });
            let mode = *current_mode.lock().unwrap();
            match (mode, has_api_key) {
                (ProxyMode::Ok, _) => response(200, gemini_answer(&reply)),
                (ProxyMode::AccessRestricted, false) => {
                    response(403, ONECLI_ACCESS_RESTRICTED_BODY.to_string())
                }
                (ProxyMode::AccessRestricted, true) => {
                    response(400, ONECLI_ACCESS_RESTRICTED_BODY.to_string())
                }
            }
        }
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    FakeProxy {
        port,
        requests,
        mode,
    }
}

/// The session-name transport the boot wiring builds for `key` under an
/// ambient `http_proxy` (None = no proxy): the route facts come from that
/// environment and the normal client honors the same proxy.
pub(crate) fn session_name_http(
    key: AiKeyCell,
    gemini_base_url: &str,
    http_proxy: Option<&str>,
) -> (GeminiSessionNameAuth, Arc<GeminiSessionNameHttp>) {
    let environment = GeminiProxyEnvironment::literal(None, http_proxy, None, None, false);
    let auth = GeminiSessionNameAuth::from_proxy_environment(key, gemini_base_url, &environment);
    let client = match http_proxy {
        Some(proxy) => reqwest::Client::builder().proxy(reqwest::Proxy::http(proxy).unwrap()),
        None => reqwest::Client::builder().no_proxy(),
    };
    let http = Arc::new(GeminiSessionNameHttp::new(
        client,
        auth.clone(),
        gemini_base_url.to_string(),
    ));
    (auth, http)
}

async fn generate(http: &GeminiSessionNameHttp) -> Result<String, GeminiFailure> {
    SessionNameTransport::generate_content(
        http,
        "Name this session".to_string(),
        SESSION_TITLE_MAX_OUTPUT_TOKENS,
    )
    .await
}

// ---------------------------------------------------------------------------
// Route selection over the real HTTP transport
// ---------------------------------------------------------------------------

#[tokio::test]
async fn configured_key_goes_direct_when_the_ambient_proxy_is_onecli() {
    let gemini = start_fake_gemini("Flux repair", None).await;
    let proxy = start_fake_proxy("Proxy answer", ProxyMode::Ok).await;
    let key = AiKeyCell::init(Some("configured-key-value".to_string()), None);
    let (auth, http) = session_name_http(key, &gemini.base_url, Some(&proxy.onecli_url()));
    assert_eq!(auth.route(), NamingRoute::Key(KeyRouteTransport::Direct));

    assert_eq!(generate(&http).await.unwrap(), "Flux repair");
    assert_eq!(
        *gemini.keys.lock().unwrap(),
        vec![Some("configured-key-value".to_string())],
        "exactly one keyed request reaches Gemini directly"
    );
    assert!(
        proxy.recorded().is_empty(),
        "the OneCLI proxy sees no request: {:?}",
        proxy.recorded()
    );
}

#[tokio::test]
async fn configured_key_uses_an_ordinary_ambient_proxy() {
    let gemini = start_fake_gemini("Direct answer", None).await;
    let proxy = start_fake_proxy("Proxied answer", ProxyMode::Ok).await;
    let key = AiKeyCell::init(Some("configured-key-value".to_string()), None);
    let (auth, http) = session_name_http(key, &gemini.base_url, Some(&proxy.ordinary_url()));
    assert_eq!(
        auth.route(),
        NamingRoute::Key(KeyRouteTransport::AmbientProxy)
    );

    assert_eq!(generate(&http).await.unwrap(), "Proxied answer");
    assert_eq!(
        proxy.recorded(),
        vec![ProxiedRequest {
            path: GEMINI_GENERATE_PATH.to_string(),
            has_api_key: true,
        }],
        "the keyed request goes through the ordinary proxy"
    );
    assert!(gemini.keys.lock().unwrap().is_empty());
}

#[tokio::test]
async fn settings_key_is_used_when_no_env_key() {
    let gemini = start_fake_gemini("Settings answer", Some("settings-only-key")).await;
    let key = AiKeyCell::init(None, Some("settings-only-key".to_string()));
    let (auth, http) = session_name_http(key, &gemini.base_url, None);
    assert_eq!(
        auth.route(),
        NamingRoute::Key(KeyRouteTransport::AmbientProxy)
    );
    assert_eq!(generate(&http).await.unwrap(), "Settings answer");
    assert_eq!(
        *gemini.keys.lock().unwrap(),
        vec![Some("settings-only-key".to_string())]
    );
}

#[tokio::test]
async fn no_key_uses_the_inherited_onecli_proxy_without_a_key() {
    let gemini = start_fake_gemini("Direct answer", None).await;
    let proxy = start_fake_proxy("Gateway answer", ProxyMode::Ok).await;
    let (auth, http) = session_name_http(
        AiKeyCell::default(),
        &gemini.base_url,
        Some(&proxy.onecli_url()),
    );
    assert_eq!(auth.route(), NamingRoute::InheritedOneCli);
    assert!(auth.enabled());

    assert_eq!(generate(&http).await.unwrap(), "Gateway answer");
    assert_eq!(
        proxy.recorded(),
        vec![ProxiedRequest {
            path: GEMINI_GENERATE_PATH.to_string(),
            has_api_key: false,
        }]
    );
    assert!(gemini.keys.lock().unwrap().is_empty());

    // A refusing gateway is a classified capability failure, one request,
    // no retry.
    proxy.set_mode(ProxyMode::AccessRestricted);
    let failure = generate(&http).await.expect_err("the gateway refuses");
    assert_eq!(failure.class, GeminiFailureClass::Capability);
    assert_eq!(failure.code(), "access_restricted");
    assert_eq!(proxy.recorded().len(), 2);
}

#[tokio::test]
async fn no_credential_route_sends_nothing() {
    let gemini = start_fake_gemini("Unused", None).await;
    let (auth, http) = session_name_http(AiKeyCell::default(), &gemini.base_url, None);
    assert_eq!(auth.route(), NamingRoute::Unavailable);
    assert!(!auth.enabled());
    let failure = generate(&http).await.expect_err("no route");
    assert_eq!(failure, GeminiFailure::no_credential());
    assert!(gemini.keys.lock().unwrap().is_empty());
}

#[tokio::test]
async fn keyed_failures_are_classified_on_the_direct_route() {
    let gemini = start_fake_gemini("Unused", Some("the-valid-key")).await;
    let proxy = start_fake_proxy("Unused", ProxyMode::AccessRestricted).await;
    let key = AiKeyCell::init(None, Some("a-wrong-key".to_string()));
    let (_auth, http) = session_name_http(key, &gemini.base_url, Some(&proxy.onecli_url()));
    let failure = generate(&http).await.expect_err("Gemini refuses the key");
    assert_eq!(failure.class, GeminiFailureClass::Capability);
    assert_eq!(failure.code(), "API_KEY_INVALID");
    assert_eq!(failure.status, Some(400));
    assert!(proxy.recorded().is_empty());
}

#[test]
fn proxy_facts_follow_the_effective_proxy_and_no_proxy() {
    let url = "http://generativelanguage.googleapis.com/v1beta";
    let https_url = "https://generativelanguage.googleapis.com/v1beta";
    let env = |https: Option<&str>, http: Option<&str>, no: Option<&str>| {
        GeminiProxyEnvironment::literal(https, http, None, no, false)
    };
    assert_eq!(
        proxy_facts(&env(None, Some("http://aoc_x@127.0.0.1:1"), None), url),
        ProxyFacts {
            via_proxy: true,
            onecli_marker: true,
        }
    );
    assert_eq!(
        proxy_facts(&env(None, Some("http://127.0.0.1:1"), None), url),
        ProxyFacts {
            via_proxy: true,
            onecli_marker: false,
        }
    );
    assert_eq!(
        proxy_facts(&env(Some("http://aoc_x@127.0.0.1:1"), None, None), url),
        ProxyFacts::default(),
        "an https proxy does not apply to an http URL"
    );
    assert_eq!(
        proxy_facts(
            &env(
                Some("http://aoc_x@127.0.0.1:1"),
                None,
                Some(".googleapis.com")
            ),
            https_url
        ),
        ProxyFacts::default(),
        "NO_PROXY bypasses the proxy"
    );
    assert_eq!(
        ProxyFacts {
            via_proxy: true,
            onecli_marker: true,
        }
        .key_route_transport(),
        KeyRouteTransport::Direct
    );
    assert_eq!(
        ProxyFacts::default().key_route_transport(),
        KeyRouteTransport::AmbientProxy
    );
}

#[test]
fn select_naming_route_prefers_a_configured_key() {
    let onecli = ProxyFacts {
        via_proxy: true,
        onecli_marker: true,
    };
    let ordinary = ProxyFacts {
        via_proxy: true,
        onecli_marker: false,
    };
    let key = AiKeyCell::init(Some("k".repeat(12)), None);
    let none = AiKeyCell::default();
    assert_eq!(
        select_naming_route(&key, onecli),
        NamingRoute::Key(KeyRouteTransport::Direct)
    );
    assert_eq!(
        select_naming_route(&key, ordinary),
        NamingRoute::Key(KeyRouteTransport::AmbientProxy)
    );
    assert_eq!(
        select_naming_route(&none, onecli),
        NamingRoute::InheritedOneCli
    );
    assert_eq!(
        select_naming_route(&none, ordinary),
        NamingRoute::Unavailable
    );
    // A Settings save takes effect at the next selection.
    none.apply_settings_key_forced(Some("saved-key-value"));
    assert_eq!(
        select_naming_route(&none, onecli),
        NamingRoute::Key(KeyRouteTransport::Direct)
    );
    assert!(!NamingRoute::Key(KeyRouteTransport::Direct).request_via_proxy(onecli));
    assert!(NamingRoute::Key(KeyRouteTransport::AmbientProxy).request_via_proxy(ordinary));
    assert!(
        !NamingRoute::Key(KeyRouteTransport::AmbientProxy).request_via_proxy(ProxyFacts::default())
    );
    assert!(NamingRoute::InheritedOneCli.request_via_proxy(onecli));
}

// ---------------------------------------------------------------------------
// The pause
// ---------------------------------------------------------------------------

fn capability(code: &str) -> GeminiFailure {
    classify_gemini_failure(403, format!(r#"{{"error":"{code}"}}"#).as_bytes())
}

fn throttled() -> GeminiFailure {
    classify_gemini_failure(429, b"")
}

fn windows(capability_ms: u64, throttle_ms: u64) -> LatchWindows {
    LatchWindows {
        capability: Duration::from_millis(capability_ms),
        throttle_base: Duration::from_millis(throttle_ms),
    }
}

#[test]
fn latch_windows_read_the_test_seams() {
    assert_eq!(
        LatchWindows::from_values(None, None),
        LatchWindows {
            capability: DEFAULT_CAPABILITY_REPROBE,
            throttle_base: DEFAULT_THROTTLE_REPROBE,
        }
    );
    assert_eq!(DEFAULT_CAPABILITY_REPROBE, Duration::from_secs(900));
    assert_eq!(DEFAULT_THROTTLE_REPROBE, Duration::from_secs(60));
    assert_eq!(
        LatchWindows::from_values(Some("2000"), Some("20")),
        windows(2000, 20)
    );
    // Garbage and zero fall back to the defaults.
    assert_eq!(
        LatchWindows::from_values(Some("0"), Some("soon")),
        LatchWindows::default()
    );
}

#[test]
fn a_capability_failure_pauses_until_the_reprobe_time() {
    let latch = CapabilityLatch::new(windows(50, 20));
    let t0 = Instant::now();
    assert!(latch.ready(t0));
    assert_eq!(
        latch.record_failure(&capability("access_restricted"), t0, latch.epoch()),
        LatchTransition::Paused {
            kind: PauseKind::Capability,
            code: "access_restricted".to_string(),
        }
    );
    assert_eq!(latch.pause_kind(), Some(PauseKind::Capability));
    assert!(!latch.ready(t0 + Duration::from_millis(49)));
    assert_eq!(
        latch.reprobe_in(t0 + Duration::from_millis(10)),
        Some(Duration::from_millis(40))
    );
    assert!(
        latch.ready(t0 + Duration::from_millis(50)),
        "one probe per window"
    );

    // The probe fails the same way: no new transition, a new window.
    let t1 = t0 + Duration::from_millis(50);
    assert_eq!(
        latch.record_failure(&capability("access_restricted"), t1, latch.epoch()),
        LatchTransition::Unchanged
    );
    assert!(!latch.ready(t1 + Duration::from_millis(49)));
    // A different code is a new transition.
    assert_eq!(
        latch.record_failure(&capability("API_KEY_INVALID"), t1, latch.epoch()),
        LatchTransition::Paused {
            kind: PauseKind::Capability,
            code: "API_KEY_INVALID".to_string(),
        }
    );
    // A transport failure with no answer keeps the pause and re-arms it.
    let t2 = t1 + Duration::from_millis(60);
    assert!(latch.ready(t2));
    let timeout = crate::gemini_failure::classify_transport_error(
        &std::io::Error::other("timed out"),
        false,
        true,
        false,
    );
    assert_eq!(
        latch.record_failure(&timeout, t2, latch.epoch()),
        LatchTransition::Unchanged
    );
    assert!(!latch.ready(t2 + Duration::from_millis(10)));
    // A probe that reaches the provider restores naming.
    assert_eq!(
        latch.record_reachable(latch.epoch()),
        LatchTransition::Restored
    );
    assert!(latch.ready(t2));
    assert_eq!(latch.pause_kind(), None);
    assert_eq!(
        latch.record_reachable(latch.epoch()),
        LatchTransition::Unchanged
    );
    // An HTTP answer that is neither refused nor throttled also restores.
    latch.record_failure(&capability("access_restricted"), t2, latch.epoch());
    assert_eq!(
        latch.record_failure(&classify_gemini_failure(500, b""), t2, latch.epoch()),
        LatchTransition::Restored
    );
}

#[test]
fn throttle_reprobe_doubles_caps_and_resets() {
    let latch = CapabilityLatch::new(windows(50, 20));
    let mut now = Instant::now();
    assert_eq!(
        latch.record_failure(&throttled(), now, latch.epoch()),
        LatchTransition::Paused {
            kind: PauseKind::Throttled,
            code: "throttled".to_string(),
        }
    );
    let mut expected = Vec::new();
    for _ in 0..4 {
        let window = latch.reprobe_in(now).unwrap();
        expected.push(window.as_millis());
        now += window;
        assert!(latch.ready(now));
        assert_eq!(
            latch.record_failure(&throttled(), now, latch.epoch()),
            LatchTransition::Unchanged
        );
    }
    assert_eq!(expected, vec![20, 40, 80, 160]);
    // One success resets the base.
    assert_eq!(
        latch.record_reachable(latch.epoch()),
        LatchTransition::Restored
    );
    latch.record_failure(&throttled(), now, latch.epoch());
    assert_eq!(latch.reprobe_in(now), Some(Duration::from_millis(20)));
    // A key change clears the pause and the streak.
    assert!(latch.clear());
    assert!(latch.ready(now));
    assert!(!latch.clear());
    latch.record_failure(&throttled(), now, latch.epoch());
    assert_eq!(latch.reprobe_in(now), Some(Duration::from_millis(20)));

    // The window never exceeds the cap.
    let capped = CapabilityLatch::new(windows(50, 400_000));
    let mut now = Instant::now();
    for _ in 0..4 {
        capped.record_failure(&throttled(), now, capped.epoch());
        now += capped.reprobe_in(now).unwrap();
    }
    capped.record_failure(&throttled(), now, capped.epoch());
    assert_eq!(capped.reprobe_in(now), Some(THROTTLE_REPROBE_CAP));
}

/// An attempt that began before a key change says nothing about the new
/// key: its refusal does not pause naming, its timeout does not re-arm a
/// pause, and its answer does not lift one.
#[test]
fn an_outcome_from_before_a_key_change_leaves_the_pause_alone() {
    let latch = CapabilityLatch::new(windows(600_000, 600_000));
    let now = Instant::now();
    let old_key = latch.epoch();
    assert!(!latch.clear(), "the key changes while nothing is paused");
    let new_key = latch.epoch();
    assert_ne!(old_key, new_key);

    assert_eq!(
        latch.record_failure(&capability("access_restricted"), now, old_key),
        LatchTransition::Superseded
    );
    assert_eq!(
        latch.record_failure(&throttled(), now, old_key),
        LatchTransition::Superseded
    );
    assert!(latch.ready(now), "the new key is tried at once");
    assert_eq!(latch.pause_kind(), None);

    // A pause the new key earned is not touched by the old key's outcomes.
    assert_eq!(
        latch.record_failure(&capability("API_KEY_INVALID"), now, new_key),
        LatchTransition::Paused {
            kind: PauseKind::Capability,
            code: "API_KEY_INVALID".to_string(),
        }
    );
    assert_eq!(latch.record_reachable(old_key), LatchTransition::Superseded);
    let later = now + Duration::from_secs(600);
    let timeout = crate::gemini_failure::classify_transport_error(
        &std::io::Error::other("timed out"),
        false,
        true,
        false,
    );
    assert_eq!(
        latch.record_failure(&timeout, later, old_key),
        LatchTransition::Superseded
    );
    assert!(
        latch.ready(later),
        "the old key's timeout did not re-arm the window"
    );
    assert_eq!(latch.pause_kind(), Some(PauseKind::Capability));
    assert_eq!(
        latch.record_reachable(new_key),
        LatchTransition::Restored,
        "the new key's own answer still restores naming"
    );
}

/// A counting transport for tests: answers come from a script, one per call
/// (the last entry repeats).
pub(crate) struct ScriptedTransport {
    pub script: Mutex<Vec<Result<String, GeminiFailure>>>,
    pub calls: AtomicU32,
    pub call_times: Mutex<Vec<Instant>>,
}

impl ScriptedTransport {
    pub fn new(script: Vec<Result<String, GeminiFailure>>) -> Arc<Self> {
        Arc::new(Self {
            script: Mutex::new(script),
            calls: AtomicU32::new(0),
            call_times: Mutex::new(Vec::new()),
        })
    }

    pub fn calls(&self) -> u32 {
        self.calls.load(Ordering::SeqCst)
    }
}

impl SessionNameTransport for ScriptedTransport {
    fn generate_content(
        &self,
        _prompt: String,
        _max_output_tokens: u32,
    ) -> BoxFuture<Result<String, GeminiFailure>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.call_times.lock().unwrap().push(Instant::now());
        let mut script = self.script.lock().unwrap();
        let answer = if script.len() > 1 {
            script.remove(0)
        } else {
            script.first().cloned().unwrap_or_else(|| Ok(String::new()))
        };
        Box::pin(async move { answer })
    }
}
