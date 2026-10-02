//! Gemini AI title/summary support. Port of `server/ai-title.ts` +
//! `server/ai-prompts.ts`. Transport is trait-injected (workspace convention:
//! no HTTP-mock crates; see crates/freshell-opencode for precedent).
use std::sync::{Arc, RwLock};

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

/// Authentication source selected for session-name Gemini requests.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GeminiCredentialRoute {
    Direct,
    OneCliProxy,
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

/// Whether session-name requests can use either the selected OneCLI proxy or
/// an existing direct API key. The proxy route is captured at construction;
/// the shared key cell remains live for settings-save updates.
#[derive(Clone)]
pub struct GeminiSessionNameAuth {
    direct_key: AiKeyCell,
    route: GeminiCredentialRoute,
}

impl GeminiSessionNameAuth {
    pub fn from_environment(direct_key: AiKeyCell, gemini_base_url: &str) -> Self {
        let proxy_environment = GeminiProxyEnvironment::from_environment();
        let route = Self::route_for(gemini_base_url, &proxy_environment);
        Self { direct_key, route }
    }

    pub fn enabled(&self) -> bool {
        self.route == GeminiCredentialRoute::OneCliProxy || self.direct_key().is_some()
    }

    pub fn direct_key(&self) -> Option<String> {
        self.direct_key.get().filter(|key| !key.is_empty())
    }

    #[cfg(test)]
    pub fn route(&self) -> GeminiCredentialRoute {
        self.route
    }

    pub fn route_for(
        gemini_base_url: &str,
        proxy_environment: &GeminiProxyEnvironment,
    ) -> GeminiCredentialRoute {
        let Ok(destination) = gemini_base_url.parse::<axum::http::Uri>() else {
            return GeminiCredentialRoute::Direct;
        };
        let (Some(scheme), Some(host)) = (destination.scheme_str(), destination.host()) else {
            return GeminiCredentialRoute::Direct;
        };
        if proxy_environment.bypasses_proxy(host) {
            return GeminiCredentialRoute::Direct;
        }
        proxy_environment
            .effective_proxy(scheme)
            .filter(|proxy| has_onecli_authorization(proxy))
            .map_or(GeminiCredentialRoute::Direct, |_| {
                GeminiCredentialRoute::OneCliProxy
            })
    }

    #[cfg(test)]
    pub(crate) fn direct_for_test(direct_key: AiKeyCell) -> Self {
        Self {
            direct_key,
            route: GeminiCredentialRoute::Direct,
        }
    }
}

/// Name-specific Gemini transport. Unlike [`GeminiHttp`], it leaves the
/// direct API-key header off when reqwest routes through OneCLI.
pub struct GeminiSessionNameHttp {
    client: reqwest::Client,
    auth: GeminiSessionNameAuth,
    base_url: String,
}

impl GeminiSessionNameHttp {
    pub fn new(client: reqwest::Client, auth: GeminiSessionNameAuth, base_url: String) -> Self {
        Self {
            client,
            auth,
            base_url,
        }
    }
}

impl GeminiTransport for GeminiSessionNameHttp {
    fn generate_content(
        &self,
        prompt: String,
        max_output_tokens: u32,
    ) -> BoxFuture<Result<String, String>> {
        let client = self.client.clone();
        let direct_key = match self.auth.route {
            GeminiCredentialRoute::Direct => self.auth.direct_key(),
            GeminiCredentialRoute::OneCliProxy => None,
        };
        let route = self.auth.route;
        let url = format!(
            "{}/models/{GEMINI_MODEL}:generateContent",
            self.base_url.trim_end_matches('/')
        );
        Box::pin(async move {
            if route == GeminiCredentialRoute::Direct && direct_key.is_none() {
                return Err("no gemini api key".to_string());
            }
            let request =
                build_gemini_request(&client, &url, prompt, max_output_tokens, direct_key)?;
            send_gemini_request(request).await.map_err(|reason| {
                if reason.starts_with("gemini http ") {
                    reason
                } else {
                    // reqwest errors can include details from its proxy
                    // connection. The naming worker logs returned errors, so
                    // keep those details out of diagnostics.
                    "gemini request failed".to_string()
                }
            })
        })
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
fn has_onecli_authorization(proxy: &str) -> bool {
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
        userinfo
            .split([':', '@'])
            .any(|component| component.starts_with("aoc_"))
    }))
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
    let title: String = text.trim().chars().take(SESSION_TITLE_CHAR_CAP).collect();
    Ok(if title.is_empty() { None } else { Some(title) })
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
        let route = |base_url: &str, env: &GeminiProxyEnvironment| {
            GeminiSessionNameAuth::route_for(base_url, env)
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
            GeminiCredentialRoute::OneCliProxy,
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
            GeminiCredentialRoute::OneCliProxy,
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
            GeminiCredentialRoute::OneCliProxy,
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
            GeminiCredentialRoute::Direct,
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
            GeminiCredentialRoute::OneCliProxy,
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
                GeminiCredentialRoute::Direct,
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
            GeminiCredentialRoute::OneCliProxy,
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
            GeminiCredentialRoute::Direct,
            "REQUEST_METHOD disables environment proxies",
        );
        assert_eq!(
            first_present(Some(""), Some("http://aoc_fixture@127.0.0.1:10255")),
            Some(""),
            "an empty uppercase variable still wins over lowercase",
        );

        let no_key = AiKeyCell::default();
        let proxy_auth = GeminiSessionNameAuth {
            direct_key: no_key.clone(),
            route: GeminiCredentialRoute::OneCliProxy,
        };
        assert!(proxy_auth.enabled());
        assert_eq!(proxy_auth.direct_key(), None);
        assert!(!GeminiSessionNameAuth::direct_for_test(no_key).enabled());
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
        let auth = GeminiSessionNameAuth {
            direct_key: key_cell,
            route: GeminiCredentialRoute::Direct,
        };
        assert_eq!(auth.route(), GeminiCredentialRoute::Direct);
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let http = GeminiSessionNameHttp::new(client, auth, format!("http://{addr}/v1beta"));
        let title = http
            .generate_content("hello world".into(), SESSION_TITLE_MAX_OUTPUT_TOKENS)
            .await
            .unwrap();

        assert_eq!(title, "Flux repair");
        assert_eq!(
            *observed_keys.lock().unwrap(),
            vec![Some("synthetic-direct-key".to_string())],
        );
    }

    #[tokio::test]
    async fn session_name_onecli_route_omits_direct_key() {
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
                        observed
                            .lock()
                            .unwrap()
                            .push(headers.contains_key("x-goog-api-key"));
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
        let auth = GeminiSessionNameAuth {
            direct_key: key_cell,
            route: GeminiCredentialRoute::OneCliProxy,
        };
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let http = GeminiSessionNameHttp::new(client, auth, format!("http://{addr}/v1beta"));
        let title = http
            .generate_content("hello world".into(), SESSION_TITLE_MAX_OUTPUT_TOKENS)
            .await
            .unwrap();

        assert_eq!(title, "Flux repair");
        assert_eq!(*observed_keys.lock().unwrap(), vec![false]);
    }
}
