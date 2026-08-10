//! Gemini AI title/summary support. Port of `server/ai-title.ts` +
//! `server/ai-prompts.ts`. Transport is trait-injected (workspace convention:
//! no HTTP-mock crates; see crates/freshell-opencode for precedent).
use std::sync::{Arc, RwLock};

pub const GEMINI_MODEL: &str = "gemini-2.5-flash-lite";
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

pub fn build_session_title_prompt(first_message: &str, custom_prompt: Option<&str>) -> String {
    let head = custom_prompt
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(SESSION_TITLE_DEFAULT_PROMPT);
    // NOTE: JS slices UTF-16 units; we count chars — same deliberate divergence
    // as the existing heuristic port (sessions.rs:291), consistent across surfaces.
    let body: String = first_message
        .chars()
        .take(PROMPT_MESSAGE_CHAR_CAP)
        .collect();
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
            let body = serde_json::json!({
                "generationConfig": { "maxOutputTokens": max_output_tokens },
                "contents": [ { "role": "user", "parts": [ { "text": prompt } ] } ]
            });
            // NOTE: reqwest is built with default-features = false,
            // features = ["stream", "rustls"] (Cargo.toml:54) — the `json`
            // feature is NOT enabled, so do NOT use .json(&body) or
            // resp.json::<T>(). Serialize/deserialize manually via
            // serde_json, matching the existing updater.rs:101-114 idiom.
            let body_bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
            let resp = client
                .post(&url)
                .header("x-goog-api-key", key)
                .header("content-type", "application/json")
                .body(body_bytes)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            let status = resp.status();
            if !status.is_success() {
                return Err(format!("gemini http {status}"));
            }
            let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
            let v: serde_json::Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            // Only candidates[0] is consulted; parts with "thought": true are
            // reasoning output and MUST be excluded (validator-A1 live capture).
            let mut text = String::new();
            if let Some(parts) = v
                .pointer("/candidates/0/content/parts")
                .and_then(|p| p.as_array())
            {
                for part in parts {
                    if part.get("thought").and_then(|t| t.as_bool()) == Some(true) {
                        continue;
                    }
                    if let Some(t) = part.get("text").and_then(|t| t.as_str()) {
                        text.push_str(t);
                    }
                }
            }
            Ok(text)
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
    fn session_title_prompt_uses_default_then_custom_and_caps_message_at_2000() {
        let long = "m".repeat(3000);
        let p = build_session_title_prompt(&long, None);
        assert!(p.starts_with("Generate a title for a tab"));
        assert!(p.contains("\n\nFirst message from the user:\n"));
        let body = p.rsplit('\n').next().unwrap();
        assert_eq!(body.chars().count(), 2000);
        let c = build_session_title_prompt("hi", Some("  Custom prompt  "));
        assert!(c.starts_with("Custom prompt"));
        // blank custom falls back to default (ai-prompts.ts build: customPrompt?.trim() || default)
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
            "/v1beta/models/gemini-2.5-flash-lite:generateContent",
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
}
