//! Gemini AI title/summary support. Port of `server/ai-title.ts` +
//! `server/ai-prompts.ts`. Transport is trait-injected (workspace convention:
//! no HTTP-mock crates; see crates/freshell-opencode for precedent).
use std::sync::{Arc, RwLock};

use crate::gemini_failure::GeminiFailure;
use crate::session_name_capability::{
    KeyRouteTransport, NamingRoute, ProxyFacts, SessionNameTransport,
};

pub const GEMINI_MODEL: &str = "gemini-3.5-flash-lite";
pub const GEMINI_DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com/v1beta";
pub const SESSION_TITLE_MAX_OUTPUT_TOKENS: u32 = 30;
pub const TERMINAL_SUMMARY_MAX_OUTPUT_TOKENS: u32 = 120;
pub const SESSION_TITLE_CHAR_CAP: usize = 80;
pub const PROMPT_MESSAGE_CHAR_CAP: usize = 2000;

/// `ai-prompts.ts:42-60` defaultPrompt, joined with '\n'.
pub const SESSION_TITLE_DEFAULT_PROMPT: &str = concat!(
    "Generate a title for a tab that contains the coding agent for this conversation.\n",
    "Only the first word or two will show, so most specific and informative words first.\n",
    "E.g. if we're investigating a crash in freshell that happens when you mention sardines, ",
    "\"Sardine crash investigation\" because sardine is specific, crash is less specific, ",
    "and investigation is common to almost all tabs.\n",
    "Return ONLY the title text. No quotes, no markdown, no explanation.",
);

/// Over `PROMPT_MESSAGE_CHAR_CAP` chars, keep the first and last 1000 chars of
/// the message with an explicit elision marker instead of prefix-truncating.
/// NOTE: char-counted, not byte/UTF-16 — the same deliberate divergence as the
/// heuristic truncation in `extract_title_from_message` (sessions.rs),
/// consistent across surfaces.
const PROMPT_MESSAGE_WINDOW_EDGE_CHARS: usize = 1000;
const TRIMMED_MARKER: &str = "\n...[trimmed]...\n";

fn window_prompt_body(first_message: &str) -> String {
    let total = first_message.chars().count();
    if total <= PROMPT_MESSAGE_CHAR_CAP {
        return first_message.to_string();
    }
    let head: String = first_message
        .chars()
        .take(PROMPT_MESSAGE_WINDOW_EDGE_CHARS)
        .collect();
    let tail: String = first_message
        .chars()
        .skip(total - PROMPT_MESSAGE_WINDOW_EDGE_CHARS)
        .collect();
    format!("{head}{TRIMMED_MARKER}{tail}")
}

pub fn build_session_title_prompt(first_message: &str, custom_prompt: Option<&str>) -> String {
    let head = custom_prompt
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(SESSION_TITLE_DEFAULT_PROMPT);
    let body = window_prompt_body(first_message);
    format!("{head}\n\nFirst message from the user:\n{body}")
}

/// `ai-prompts.ts:27-41`.
pub fn build_terminal_summary_prompt(terminal_output: &str) -> String {
    format!(
        "You are summarizing a terminal session for an overview page.\n\
         Return a single short description (1-2 sentences, max 200 chars).\n\
         No markdown. No quotes.\n\n\
         Terminal output:\n{}",
        strip_ansi(terminal_output)
    )
}

/// `ai-prompts.ts:7-10` — CSI, OSC-to-BEL, and charset-select sequences.
pub fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut it = input.chars().peekable();
    while let Some(c) = it.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match it.peek() {
            Some('[') => {
                it.next();
                while let Some(&n) = it.peek() {
                    it.next();
                    if n.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            Some(']') => {
                it.next();
                for n in it.by_ref() {
                    if n == '\u{07}' {
                        break;
                    }
                }
            }
            Some('(') | Some(')') => {
                it.next();
                if matches!(it.peek(), Some('A' | 'B' | '0' | '1' | '2')) {
                    it.next();
                }
            }
            _ => {}
        }
    }
    out
}

/// Process-local mirror of Node's env-projected key (`AI_CONFIG`, ai-prompts.ts:13-23).
#[derive(Clone, Default)]
pub struct AiKeyCell(Arc<RwLock<Option<String>>>);

impl AiKeyCell {
    /// Boot semantics: env wins over settings (non-forcing apply, server/index.ts:251).
    pub fn init(env_key: Option<String>, settings_key: Option<String>) -> Self {
        let v = env_key
            .filter(|k| !k.is_empty())
            .or(settings_key.filter(|k| !k.is_empty()));
        Self(Arc::new(RwLock::new(v)))
    }
    /// Settings-save semantics: force overwrite; blank never clears (ai-prompts.ts:17-23).
    pub fn apply_settings_key_forced(&self, key: Option<&str>) {
        if let Some(k) = key.filter(|k| !k.is_empty()) {
            *self.0.write().expect("ai key cell lock") = Some(k.to_string());
        }
    }
    pub fn get(&self) -> Option<String> {
        self.0.read().expect("ai key cell lock").clone()
    }
    pub fn enabled(&self) -> bool {
        self.get().is_some_and(|k| !k.is_empty())
    }
}

pub type BoxFuture<T> = std::pin::Pin<Box<dyn std::future::Future<Output = T> + Send>>;

pub trait GeminiTransport: Send + Sync {
    fn generate_content(
        &self,
        prompt: String,
        max_output_tokens: u32,
    ) -> BoxFuture<Result<String, String>>;
}

/// The environment values that reqwest's system proxy matcher uses. Values
/// stay private because they can contain proxy credentials.
#[derive(Clone, Default)]
pub struct GeminiProxyEnvironment {
    https_proxy: String,
    http_proxy: String,
    all_proxy: String,
    no_proxy: String,
    request_method_present: bool,
}

impl GeminiProxyEnvironment {
    /// Capture the same proxy environment variables reqwest reads when it
    /// builds a client. Uppercase names take precedence even when empty.
    pub fn from_environment() -> Self {
        use std::env;

        fn variable(upper: &str, lower: &str) -> String {
            let upper = env::var(upper).ok();
            let lower = env::var(lower).ok();
            first_present(upper.as_deref(), lower.as_deref())
                .unwrap_or_default()
                .to_string()
        }

        Self {
            https_proxy: variable("HTTPS_PROXY", "https_proxy"),
            http_proxy: variable("HTTP_PROXY", "http_proxy"),
            all_proxy: variable("ALL_PROXY", "all_proxy"),
            no_proxy: variable("NO_PROXY", "no_proxy"),
            request_method_present: env::var_os("REQUEST_METHOD").is_some(),
        }
    }

    /// Construct proxy inputs without reading or changing process environment.
    #[cfg(test)]
    pub fn literal(
        https_proxy: Option<&str>,
        http_proxy: Option<&str>,
        all_proxy: Option<&str>,
        no_proxy: Option<&str>,
        request_method_present: bool,
    ) -> Self {
        Self {
            https_proxy: https_proxy.unwrap_or_default().to_string(),
            http_proxy: http_proxy.unwrap_or_default().to_string(),
            all_proxy: all_proxy.unwrap_or_default().to_string(),
            no_proxy: no_proxy.unwrap_or_default().to_string(),
            request_method_present,
        }
    }

    fn effective_proxy(&self, scheme: &str) -> Option<&str> {
        if self.request_method_present {
            return None;
        }
        let scheme_proxy = match scheme {
            "https" => &self.https_proxy,
            "http" => &self.http_proxy,
            _ => return None,
        };
        parse_proxy(scheme_proxy)
            .is_some()
            .then_some(scheme_proxy.as_str())
            .or_else(|| {
                parse_proxy(&self.all_proxy)
                    .is_some()
                    .then_some(self.all_proxy.as_str())
            })
    }

    /// The proxy reqwest would use for `url` under this environment, if any
    /// (NO_PROXY applied). Callers reduce it to booleans immediately: proxy
    /// URLs can carry credentials.
    pub(crate) fn proxy_for_url(&self, url: &str) -> Option<&str> {
        let destination = url.parse::<axum::http::Uri>().ok()?;
        let (Some(scheme), Some(host)) = (destination.scheme_str(), destination.host()) else {
            return None;
        };
        if self.bypasses_proxy(host) {
            return None;
        }
        self.effective_proxy(scheme)
    }

    fn bypasses_proxy(&self, host: &str) -> bool {
        self.no_proxy.split(',').map(str::trim).any(|entry| {
            if entry == "*" {
                return true;
            }
            if entry.is_empty() {
                return false;
            }

            let domain = entry.strip_prefix('.').unwrap_or(entry);
            host.eq_ignore_ascii_case(domain)
                || host.len() > domain.len()
                    && host
                        .get(host.len() - domain.len()..)
                        .is_some_and(|suffix| suffix.eq_ignore_ascii_case(domain))
                    && host.as_bytes().get(host.len() - domain.len() - 1) == Some(&b'.')
        })
    }
}

/// The credential and proxy facts for session-name Gemini requests
/// (name-reliability Task 6). The key cell stays live, so a Settings save
/// takes effect at the next attempt; the proxy facts are read once at
/// construction, as reqwest reads the proxy environment once per client.
/// The route itself is chosen per attempt by
/// [`crate::session_name_capability::select_naming_route`].
#[derive(Clone)]
pub struct GeminiSessionNameAuth {
    key: AiKeyCell,
    facts: ProxyFacts,
}

impl GeminiSessionNameAuth {
    pub fn from_environment(key: AiKeyCell, gemini_base_url: &str) -> Self {
        Self::from_proxy_environment(
            key,
            gemini_base_url,
            &GeminiProxyEnvironment::from_environment(),
        )
    }

    pub fn from_proxy_environment(
        key: AiKeyCell,
        gemini_base_url: &str,
        proxy_environment: &GeminiProxyEnvironment,
    ) -> Self {
        Self {
            key,
            facts: crate::session_name_capability::proxy_facts(proxy_environment, gemini_base_url),
        }
    }

    /// The route the next attempt uses.
    pub fn route(&self) -> NamingRoute {
        crate::session_name_capability::select_naming_route(&self.key, self.facts)
    }

    pub fn facts(&self) -> ProxyFacts {
        self.facts
    }

    /// Whether any credential route is available (a key, or a OneCLI proxy).
    pub fn enabled(&self) -> bool {
        self.route().is_available()
    }

    pub fn key(&self) -> Option<String> {
        self.key.get().filter(|key| !key.is_empty())
    }

    pub fn key_configured(&self) -> bool {
        self.key.enabled()
    }

    /// No ambient proxy: a configured key is the only route.
    #[cfg(test)]
    pub(crate) fn direct_for_test(key: AiKeyCell) -> Self {
        Self {
            key,
            facts: ProxyFacts::default(),
        }
    }

    /// A OneCLI-marked ambient proxy.
    #[cfg(test)]
    pub(crate) fn onecli_for_test(key: AiKeyCell) -> Self {
        Self {
            key,
            facts: ProxyFacts {
                via_proxy: true,
                onecli_marker: true,
            },
        }
    }
}

/// The session-name Gemini transport (name-reliability Task 6): one request
/// per attempt on the route [`GeminiSessionNameAuth::route`] picks. A keyed
/// request always carries the key; it goes DIRECT when the ambient proxy is
/// OneCLI's and through the normal (proxy-honoring) client otherwise; a
/// keyless request (the inherited OneCLI route) uses the normal client.
/// Failures come back classified ([`crate::gemini_failure`]) and never carry
/// reqwest's error text, which can name the proxy.
pub struct GeminiSessionNameHttp {
    /// Honors the ambient proxy environment (`reqwest::Client::builder()`).
    client: reqwest::Client,
    /// Ignores it.
    direct_client: reqwest::Client,
    auth: GeminiSessionNameAuth,
    base_url: String,
}

/// How long either session-name client waits for a connection (name
/// resolution, TCP, the proxy and the TLS handshake). Shorter than the
/// worker's 20-second request bound, so a route whose packets are silently
/// dropped fails as a connect error, which pauses naming and uses no
/// attempt, instead of timing out and using one.
pub const SESSION_NAME_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

impl GeminiSessionNameHttp {
    /// `client` is the normal (proxy-honoring) client's builder; both
    /// clients get [`SESSION_NAME_CONNECT_TIMEOUT`].
    pub fn new(
        client: reqwest::ClientBuilder,
        auth: GeminiSessionNameAuth,
        base_url: String,
    ) -> Self {
        // A build fails only when the TLS backend cannot initialize, which
        // `reqwest::Client::new()` would panic on too. Never fall back to
        // the proxy-honoring client: the direct route must not reach a
        // OneCLI proxy.
        let build = |builder: reqwest::ClientBuilder| {
            builder
                .connect_timeout(SESSION_NAME_CONNECT_TIMEOUT)
                .build()
                .expect("the TLS backend initializes, as for reqwest::Client::new()")
        };
        Self {
            client: build(client),
            direct_client: build(reqwest::Client::builder().no_proxy()),
            auth,
            base_url,
        }
    }
}

impl SessionNameTransport for GeminiSessionNameHttp {
    fn generate_content(
        &self,
        prompt: String,
        max_output_tokens: u32,
    ) -> BoxFuture<Result<String, GeminiFailure>> {
        let route = self.auth.route();
        let (client, key) = match route {
            NamingRoute::Key(KeyRouteTransport::Direct) => {
                (self.direct_client.clone(), self.auth.key())
            }
            NamingRoute::Key(KeyRouteTransport::AmbientProxy) => {
                (self.client.clone(), self.auth.key())
            }
            NamingRoute::InheritedOneCli => (self.client.clone(), None),
            NamingRoute::Unavailable => {
                return Box::pin(async { Err(GeminiFailure::no_credential()) });
            }
        };
        let via_proxy = route.request_via_proxy(self.auth.facts());
        let url = format!(
            "{}/models/{GEMINI_MODEL}:generateContent",
            self.base_url.trim_end_matches('/')
        );
        Box::pin(async move {
            let request = build_gemini_request(&client, &url, prompt, max_output_tokens, key)
                .map_err(|_| GeminiFailure::request_encoding())?;
            let response = request.send().await.map_err(|error| {
                crate::gemini_failure::classify_reqwest_error(&error, via_proxy)
            })?;
            let status = response.status().as_u16();
            if !response.status().is_success() {
                // An unreadable error body still classifies by status.
                let body = response.bytes().await.unwrap_or_default();
                return Err(crate::gemini_failure::classify_gemini_failure(
                    status, &body,
                ));
            }
            let bytes = response
                .bytes()
                .await
                .map_err(|_| GeminiFailure::response_read_failed(status))?;
            let value: serde_json::Value = serde_json::from_slice(&bytes)
                .map_err(|_| GeminiFailure::malformed_response(status))?;
            Ok(extract_candidate_text(&value))
        })
    }
}

/// The legacy string-error view, for the callers that still take a
/// [`GeminiTransport`] (the sweep's excluded-provider ladder and the
/// generate-title compatibility route): the same route and request, with
/// the failure rendered as its safe text.
impl GeminiTransport for GeminiSessionNameHttp {
    fn generate_content(
        &self,
        prompt: String,
        max_output_tokens: u32,
    ) -> BoxFuture<Result<String, String>> {
        let call = SessionNameTransport::generate_content(self, prompt, max_output_tokens);
        Box::pin(async move { call.await.map_err(|failure| failure.to_string()) })
    }
}

/// Build the shared Gemini wire request. reqwest's `json` feature is disabled
/// in this crate, so serialize the body explicitly.
fn build_gemini_request(
    client: &reqwest::Client,
    url: &str,
    prompt: String,
    max_output_tokens: u32,
    key: Option<String>,
) -> Result<reqwest::RequestBuilder, String> {
    let body = serde_json::json!({
        "generationConfig": { "maxOutputTokens": max_output_tokens },
        "contents": [ { "role": "user", "parts": [ { "text": prompt } ] } ]
    });
    let body_bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    let request = client
        .post(url)
        .header("content-type", "application/json")
        .body(body_bytes);
    Ok(match key {
        Some(key) => request.header("x-goog-api-key", key),
        None => request,
    })
}

async fn send_gemini_request(request: reqwest::RequestBuilder) -> Result<String, String> {
    let response = request.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("gemini http {status}"));
    }
    parse_gemini_success_response(response).await
}

async fn parse_gemini_success_response(response: reqwest::Response) -> Result<String, String> {
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    Ok(extract_candidate_text(&value))
}

fn first_present<'a>(upper: Option<&'a str>, lower: Option<&'a str>) -> Option<&'a str> {
    upper.or(lower)
}

/// Validate a proxy using the schemes accepted by hyper-util's reqwest
/// environment matcher, then inspect its parsed authority for OneCLI's
/// authorization marker. This deliberately returns only a boolean so proxy
/// credentials can never enter diagnostics.
pub(crate) fn has_onecli_authorization(proxy: &str) -> bool {
    parse_proxy(proxy).unwrap_or(false)
}

fn parse_proxy(proxy: &str) -> Option<bool> {
    let uri = proxy.parse::<axum::http::Uri>().ok()?;
    let scheme = uri.scheme_str().unwrap_or("http");
    if !matches!(
        scheme,
        "http" | "https" | "socks4" | "socks4a" | "socks5" | "socks5h"
    ) {
        return None;
    }
    let authority = uri.authority()?.as_str();
    let userinfo = authority
        .split_once('@')
        .map(|(userinfo, _host_port)| userinfo);
    Some(userinfo.is_some_and(|userinfo| {
        let (username, password) = userinfo
            .split_once(':')
            .map_or((userinfo, None), |(username, password)| {
                (username, Some(password))
            });
        decode_proxy_credential(username).starts_with("aoc_")
            || password
                .is_some_and(|password| decode_proxy_credential(password).starts_with("aoc_"))
    }))
}

/// Decode URI userinfo the way the locked hyper-util proxy matcher does:
/// valid `%HH` sequences become bytes, malformed sequences remain literal,
/// plus signs are unchanged, and invalid UTF-8 is replaced lossily.
fn decode_proxy_credential(value: &str) -> String {
    let encoded = value.as_bytes();
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut index = 0;
    while index < encoded.len() {
        if encoded[index] == b'%' && index + 2 < encoded.len() {
            if let (Some(high), Some(low)) =
                (hex_value(encoded[index + 1]), hex_value(encoded[index + 2]))
            {
                decoded.push((high << 4) | low);
                index += 3;
                continue;
            }
        }
        decoded.push(encoded[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn extract_candidate_text(value: &serde_json::Value) -> String {
    let mut text = String::new();
    if let Some(parts) = value
        .pointer("/candidates/0/content/parts")
        .and_then(|parts| parts.as_array())
    {
        for part in parts {
            if part.get("thought").and_then(|thought| thought.as_bool()) == Some(true) {
                continue;
            }
            if let Some(part_text) = part.get("text").and_then(|text| text.as_str()) {
                text.push_str(part_text);
            }
        }
    }
    text
}

pub struct GeminiHttp {
    client: reqwest::Client,
    key_cell: AiKeyCell,
    base_url: String,
}

impl GeminiHttp {
    pub fn new(client: reqwest::Client, key_cell: AiKeyCell, base_url: String) -> Self {
        Self {
            client,
            key_cell,
            base_url,
        }
    }
}

impl GeminiTransport for GeminiHttp {
    fn generate_content(
        &self,
        prompt: String,
        max_output_tokens: u32,
    ) -> BoxFuture<Result<String, String>> {
        let client = self.client.clone();
        let key = self.key_cell.get();
        let url = format!(
            "{}/models/{GEMINI_MODEL}:generateContent",
            self.base_url.trim_end_matches('/')
        );
        Box::pin(async move {
            let key = key.ok_or_else(|| "no gemini api key".to_string())?;
            let request =
                build_gemini_request(&client, &url, prompt, max_output_tokens, Some(key))?;
            send_gemini_request(request).await
        })
    }
}

/// `server/ai-title.ts:10-27`. Caller decides enablement; this function only
/// formats, calls, trims, caps at 80, and maps empty → None.
pub async fn generate_ai_session_title(
    transport: &dyn GeminiTransport,
    first_message: &str,
    custom_prompt: Option<&str>,
) -> Result<Option<String>, String> {
    let prompt = build_session_title_prompt(first_message, custom_prompt);
    let text = transport
        .generate_content(prompt, SESSION_TITLE_MAX_OUTPUT_TOKENS)
        .await?;
    Ok(finalize_session_title(&text))
}

/// Trim the model's answer, cap it at 80 characters, and map empty to None.
pub fn finalize_session_title(text: &str) -> Option<String> {
    let title: String = text.trim().chars().take(SESSION_TITLE_CHAR_CAP).collect();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_cell_boot_env_wins_over_settings_nonforcing() {
        let cell = AiKeyCell::init(Some("envkey".into()), Some("settingskey".into()));
        assert_eq!(cell.get().as_deref(), Some("envkey"));
        let cell2 = AiKeyCell::init(None, Some("settingskey".into()));
        assert_eq!(cell2.get().as_deref(), Some("settingskey"));
        assert!(!AiKeyCell::init(None, None).enabled());
    }
    #[test]
    fn key_cell_forced_apply_overwrites_but_blank_never_clears() {
        let cell = AiKeyCell::init(Some("envkey".into()), None);
        cell.apply_settings_key_forced(Some("newkey"));
        assert_eq!(cell.get().as_deref(), Some("newkey"));
        cell.apply_settings_key_forced(None);
        assert_eq!(cell.get().as_deref(), Some("newkey")); // `if (key)` guard, ai-prompts.ts:18
        cell.apply_settings_key_forced(Some(""));
        assert_eq!(cell.get().as_deref(), Some("newkey"));
    }
    #[test]
    fn session_title_prompt_windows_long_messages_and_keeps_custom_legs() {
        // ≤ 2000 chars: passthrough, no marker.
        let exact = "x".repeat(PROMPT_MESSAGE_CHAR_CAP);
        let p = build_session_title_prompt(&exact, None);
        assert!(p.starts_with("Generate a title for a tab"));
        assert!(p.contains("\n\nFirst message from the user:\n"));
        assert!(!p.contains("...[trimmed]..."));
        let body = p.rsplit('\n').next().unwrap();
        assert_eq!(body.chars().count(), PROMPT_MESSAGE_CHAR_CAP);

        // 2500 chars of distinct runs: first 1000 + marker + last 1000.
        let long = format!(
            "{}{}{}",
            "a".repeat(1000),
            "b".repeat(500),
            "c".repeat(1000)
        );
        let p2 = build_session_title_prompt(&long, None);
        let expected = format!(
            "{}\n...[trimmed]...\n{}",
            "a".repeat(1000),
            "c".repeat(1000)
        );
        assert!(p2.ends_with(&expected));
        assert!(!p2.contains(&"b".repeat(10)));
        assert_eq!(expected.chars().count(), 2017); // 1000 + 17 + 1000

        // Char-accurate (not byte-accurate) windowing with multibyte input.
        let mb = format!("{}{}{}", "a".repeat(1500), "é".repeat(400), "z".repeat(600));
        let p3 = build_session_title_prompt(&mb, None);
        let tail_expected = format!("{}{}", "é".repeat(400), "z".repeat(600));
        assert!(p3.ends_with(&tail_expected));
        assert!(p3.contains(&format!("{}\n...[trimmed]...\n", "a".repeat(1000))));

        // Custom-prompt legs unchanged (build: customPrompt?.trim() || default).
        let c = build_session_title_prompt("hi", Some("  Custom prompt  "));
        assert!(c.starts_with("Custom prompt"));
        let d = build_session_title_prompt("hi", Some("   "));
        assert!(d.starts_with("Generate a title for a tab"));
    }
    #[test]
    fn strip_ansi_removes_csi_osc_and_charset_sequences() {
        let s = "a\u{1b}[31mred\u{1b}[0mb\u{1b}]0;title\u{07}c\u{1b}(Bd";
        assert_eq!(strip_ansi(s), "aredbcd");
    }

    struct FakeTransport(Result<String, String>);
    impl GeminiTransport for FakeTransport {
        fn generate_content(&self, _p: String, _m: u32) -> BoxFuture<Result<String, String>> {
            let r = self.0.clone();
            Box::pin(async move { r })
        }
    }
    #[tokio::test]
    async fn ai_title_trims_caps_at_80_and_empty_is_none() {
        let long = format!("  {}  ", "t".repeat(200));
        let t = generate_ai_session_title(&FakeTransport(Ok(long)), "hi", None)
            .await
            .unwrap();
        assert_eq!(t.unwrap().chars().count(), 80);
        let none = generate_ai_session_title(&FakeTransport(Ok("   ".into())), "hi", None)
            .await
            .unwrap();
        assert!(none.is_none());
        let err = generate_ai_session_title(&FakeTransport(Err("boom".into())), "hi", None).await;
        assert!(err.is_err());
    }

    /// Loopback HTTP test for GeminiHttp — no live Gemini, no mock crates:
    /// bind an axum server on 127.0.0.1:0 that asserts the wire contract
    /// (required fields only — method, path, header, essential body fields —
    /// not byte-exact bodies; validator-A1 test-shape guidance). The response
    /// includes a `"thought": true` part which MUST be excluded from the
    /// extracted text (validator-A1 live capture).
    #[tokio::test]
    async fn gemini_http_posts_expected_body_and_parses_candidates_excluding_thoughts() {
        use axum::{routing::post, Json, Router};
        let app = Router::new().route(
            "/v1beta/models/gemini-3.5-flash-lite:generateContent",
            post(
                |headers: axum::http::HeaderMap, Json(body): Json<serde_json::Value>| async move {
                    assert_eq!(headers.get("x-goog-api-key").unwrap(), "tok-123");
                    assert_eq!(body["generationConfig"]["maxOutputTokens"], 30);
                    assert_eq!(body["contents"][0]["role"], "user");
                    assert!(body["contents"][0]["parts"][0]["text"]
                        .as_str()
                        .unwrap()
                        .contains("hello world"));
                    Json(serde_json::json!({
                        "candidates": [{ "content": { "parts": [
                            {"text": "internal reasoning", "thought": true},
                            {"text": "Flux "}, {"text": "repair"}
                        ] } }]
                    }))
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let cell = AiKeyCell::init(Some("tok-123".into()), None);
        let http = GeminiHttp::new(
            reqwest::Client::new(),
            cell,
            format!("http://{addr}/v1beta"),
        );
        let title = generate_ai_session_title(&http, "hello world", None)
            .await
            .unwrap();
        assert_eq!(title.as_deref(), Some("Flux repair"));
    }

    #[test]
    fn onecli_route_detection_matches_effective_reqwest_proxy() {
        let https_gemini = "https://generativelanguage.googleapis.com/v1beta";
        let http_gemini = "http://generativelanguage.googleapis.com/v1beta";
        // The OneCLI marker of the effective proxy (name-reliability Task 6
        // moved route choice to `session_name_capability`; the marker
        // detection itself is unchanged).
        let route = |base_url: &str, env: &GeminiProxyEnvironment| {
            if crate::session_name_capability::proxy_facts(env, base_url).onecli_marker {
                "onecli"
            } else {
                "none"
            }
        };
        let env =
            |https: Option<&str>, http: Option<&str>, all: Option<&str>, no: Option<&str>, cgi| {
                GeminiProxyEnvironment::literal(https, http, all, no, cgi)
            };

        assert_eq!(
            route(
                https_gemini,
                &env(
                    Some("http://aoc_fixture@127.0.0.1:10255"),
                    None,
                    None,
                    None,
                    false
                ),
            ),
            "onecli",
        );
        assert_eq!(
            route(
                http_gemini,
                &env(
                    None,
                    Some("http://aoc_fixture@127.0.0.1:10255"),
                    None,
                    None,
                    false
                ),
            ),
            "onecli",
        );
        assert_eq!(
            route(
                https_gemini,
                &env(
                    None,
                    None,
                    Some("http://aoc_fixture@127.0.0.1:10255"),
                    None,
                    false
                ),
            ),
            "onecli",
        );
        assert_eq!(
            route(
                https_gemini,
                &env(
                    Some("http://ordinary-proxy.example:8080"),
                    None,
                    Some("http://aoc_fixture@127.0.0.1:10255"),
                    None,
                    false,
                ),
            ),
            "none",
            "a valid scheme-specific proxy takes precedence over ALL_PROXY",
        );
        assert_eq!(
            route(
                https_gemini,
                &env(
                    Some("not a proxy"),
                    None,
                    Some("http://aoc_fixture@127.0.0.1:10255"),
                    None,
                    false,
                ),
            ),
            "onecli",
            "an unparseable scheme-specific proxy falls back to ALL_PROXY",
        );

        for no_proxy in [
            "generativelanguage.googleapis.com",
            ".googleapis.com",
            ".GOOGLEAPIS.COM",
            "*",
        ] {
            assert_eq!(
                route(
                    https_gemini,
                    &env(
                        Some("http://aoc_fixture@127.0.0.1:10255"),
                        None,
                        None,
                        Some(no_proxy),
                        false,
                    ),
                ),
                "none",
                "NO_PROXY entry {no_proxy:?} bypasses the proxy",
            );
        }
        assert_eq!(
            route(
                https_gemini,
                &env(
                    Some("http://aoc_fixture@127.0.0.1:10255"),
                    None,
                    None,
                    Some("notgoogleapis.com"),
                    false,
                ),
            ),
            "onecli",
            "a nonmatching domain must not bypass the proxy",
        );
        assert_eq!(
            route(
                https_gemini,
                &env(
                    Some("http://aoc_fixture@127.0.0.1:10255"),
                    None,
                    None,
                    None,
                    true,
                ),
            ),
            "none",
            "REQUEST_METHOD disables environment proxies",
        );
        assert_eq!(
            first_present(Some(""), Some("http://aoc_fixture@127.0.0.1:10255")),
            Some(""),
            "an empty uppercase variable still wins over lowercase",
        );

        let no_key = AiKeyCell::default();
        let proxy_auth = GeminiSessionNameAuth::onecli_for_test(no_key.clone());
        assert!(proxy_auth.enabled());
        assert_eq!(proxy_auth.key(), None);
        assert!(!GeminiSessionNameAuth::direct_for_test(no_key).enabled());
    }

    #[test]
    fn onecli_route_detection_decodes_encoded_proxy_username_and_password() {
        let https_gemini = "https://generativelanguage.googleapis.com/v1beta";
        for proxy in [
            "http://%61oc_fixture@127.0.0.1:10255",
            "http://proxy:%61oc_fixture@127.0.0.1:10255",
        ] {
            let environment = GeminiProxyEnvironment::literal(Some(proxy), None, None, None, false);
            assert!(
                crate::session_name_capability::proxy_facts(&environment, https_gemini)
                    .onecli_marker,
                "a percent-encoded OneCLI marker in either proxy credential selects the proxy route",
            );
        }
    }

    #[tokio::test]
    async fn direct_session_name_route_uses_existing_key_when_onecli_proxy_is_absent() {
        use axum::{routing::post, Json, Router};
        use std::sync::{Arc, Mutex};

        let observed_keys = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&observed_keys);
        let app = Router::new().route(
            "/v1beta/models/gemini-3.5-flash-lite:generateContent",
            post(
                move |headers: axum::http::HeaderMap, Json(_body): Json<serde_json::Value>| {
                    let observed = Arc::clone(&observed);
                    async move {
                        observed.lock().unwrap().push(
                            headers
                                .get("x-goog-api-key")
                                .and_then(|value| value.to_str().ok())
                                .map(str::to_string),
                        );
                        Json(serde_json::json!({
                            "candidates": [{ "content": { "parts": [{ "text": "Flux repair" }] } }]
                        }))
                    }
                },
            ),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

        let key_cell = AiKeyCell::init(Some("synthetic-direct-key".into()), None);
        let auth = GeminiSessionNameAuth::direct_for_test(key_cell);
        assert_eq!(
            auth.route(),
            NamingRoute::Key(KeyRouteTransport::AmbientProxy)
        );
        let client = reqwest::Client::builder().no_proxy();
        let http = GeminiSessionNameHttp::new(client, auth, format!("http://{addr}/v1beta"));
        let title = SessionNameTransport::generate_content(
            &http,
            "hello world".into(),
            SESSION_TITLE_MAX_OUTPUT_TOKENS,
        )
        .await
        .unwrap();

        assert_eq!(title, "Flux repair");
        assert_eq!(
            *observed_keys.lock().unwrap(),
            vec![Some("synthetic-direct-key".to_string())],
        );
    }
}
