//! `POST /api/ai/terminals/:terminalId/summary` — faithful port of
//! `server/ai-router.ts:19-71` (router mounts at `/api/ai`, so the real wire
//! path is `/api/ai/terminals/:terminalId/summary`). No request body is read.
//! Unknown terminal → **404** `{"error":"Terminal not found"}`; no AI key →
//! **200** `{"description": <heuristic>, "source": "heuristic"}`; Gemini ok →
//! **200** `{"description": <text.trim() capped 240, falling back to the
//! heuristic when empty>, "source": "ai"}`; Gemini error → **200** heuristic
//! with `"source":"heuristic"` (never 5xx). Gemini input = last **20,000**
//! chars of the PTY scrollback through `build_terminal_summary_prompt` (which
//! ANSI-strips), `maxOutputTokens` 120 (`TERMINAL_SUMMARY_MAX_OUTPUT_TOKENS`).

use axum::{
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json, Router,
};

use crate::boot::{is_authed, unauthorized};

/// Shared state for the `/api/ai` REST surface.
#[derive(Clone)]
pub struct AiRouterState {
    pub auth_token: std::sync::Arc<String>,
    /// The shared terminal registry — the scrollback snapshot source
    /// (`registry.get(terminalId)`, `server/ai-router.ts:22-26`).
    pub registry: freshell_terminal::TerminalRegistry,
    /// Task 2: the process-local Gemini key cell. Key presence alone selects
    /// the AI branch (`aiConfig.geminiApiKey`, `server/ai-router.ts:43`).
    pub ai_key: crate::ai_title::AiKeyCell,
    /// Trait-injected Gemini transport (same seam as `SessionsState.gemini`)
    /// so tests fake the wire — no live calls.
    pub gemini: std::sync::Arc<dyn crate::ai_title::GeminiTransport>,
}

/// The AI sub-router (`POST /api/ai/terminals/:terminalId/summary`).
pub fn router(state: AiRouterState) -> Router {
    Router::new()
        .route(
            "/api/ai/terminals/{terminal_id}/summary",
            axum::routing::post(terminal_summary),
        )
        .with_state(state)
}

/// `server/ai-router.ts:27-34`: strip ANSI, split lines, first two non-empty
/// (trimmed) lines joined `" - "`, cap 240 chars, default `"Terminal session"`.
pub fn heuristic_summary(snapshot_tail: &str) -> String {
    let cleaned = crate::ai_title::strip_ansi(snapshot_tail);
    let mut lines = cleaned.lines().map(str::trim).filter(|l| !l.is_empty());
    let first = lines.next().unwrap_or("Terminal session");
    let second = lines.next().unwrap_or("");
    let joined = if second.is_empty() {
        first.to_string()
    } else {
        format!("{first} - {second}")
    };
    let capped: String = joined.chars().take(240).collect();
    if capped.is_empty() {
        "Terminal session".to_string()
    } else {
        capped
    }
}

/// The scrollback snapshot for `terminal_id`, or `None` when the terminal is
/// unknown — the same `directory()` reassembly accessor
/// `terminal_tabs::maybe_capture` uses (`terminal_tabs.rs:1317-1322`).
fn registry_snapshot(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
) -> Option<String> {
    registry
        .directory()
        .into_iter()
        .find(|d| d.terminal_id == terminal_id)
        .map(|d| d.snapshot)
}

fn json_200(v: serde_json::Value) -> Response {
    Json(v).into_response()
}

/// `POST /api/ai/terminals/:terminalId/summary` (`server/ai-router.ts:19-71`).
/// No request body is read. Unknown terminal is the only 404; everything else
/// resolves to 200 — a Gemini failure degrades to the heuristic, never 5xx.
async fn terminal_summary(
    State(state): State<AiRouterState>,
    AxumPath(terminal_id): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(snapshot) = registry_snapshot(&state.registry, &terminal_id) else {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({ "error": "Terminal not found" })),
        )
            .into_response();
    };
    // last 20_000 chars (server/ai-router.ts:39)
    let tail: String = {
        let chars: Vec<char> = snapshot.chars().collect();
        chars[chars.len().saturating_sub(20_000)..].iter().collect()
    };
    let heuristic = heuristic_summary(&tail);
    if !state.ai_key.enabled() {
        return json_200(serde_json::json!({ "description": heuristic, "source": "heuristic" }));
    }
    let prompt = crate::ai_title::build_terminal_summary_prompt(&tail);
    match state
        .gemini
        .generate_content(prompt, crate::ai_title::TERMINAL_SUMMARY_MAX_OUTPUT_TOKENS)
        .await
    {
        Ok(text) => {
            let desc: String = text.trim().chars().take(240).collect();
            let desc = if desc.is_empty() { heuristic } else { desc };
            json_200(serde_json::json!({ "description": desc, "source": "ai" }))
        }
        Err(e) => {
            tracing::warn!(error = %e, terminal_id = %terminal_id, "AI summary failed; using heuristic");
            json_200(serde_json::json!({ "description": heuristic, "source": "heuristic" }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    /// Same 4-line fake as `auto_title_sweep`/`sessions_tests`' transport: the
    /// wired-in result IS the Gemini reply. NO live Gemini calls in tests, ever.
    struct FakeGemini(Result<String, String>);
    impl crate::ai_title::GeminiTransport for FakeGemini {
        fn generate_content(
            &self,
            _p: String,
            _m: u32,
        ) -> crate::ai_title::BoxFuture<Result<String, String>> {
            let r = self.0.clone();
            Box::pin(async move { r })
        }
    }

    /// AI disabled by default; tests that exercise the AI branch overwrite
    /// these fields (the no-key path never touches gemini).
    fn state(registry: freshell_terminal::TerminalRegistry) -> AiRouterState {
        AiRouterState {
            auth_token: std::sync::Arc::new("tok".into()),
            registry,
            ai_key: crate::ai_title::AiKeyCell::init(None, None),
            gemini: std::sync::Arc::new(FakeGemini(Err("unused in default test state".into()))),
        }
    }

    /// Same throwaway-real-terminal pattern as
    /// `sessions_tests::spawn_headless_terminal_for_test`, parameterized on the
    /// `sh -c` script so a test can emit deterministic scrollback. The caller
    /// is responsible for `registry.kill(terminal_id)` afterward.
    fn spawn_headless_terminal_for_test(
        registry: &freshell_terminal::TerminalRegistry,
        terminal_id: &str,
        script: &str,
    ) {
        use freshell_platform::spawn::{SpawnSpec, DEFAULT_COLS, DEFAULT_ROWS};
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), script.into()],
            env_overrides: Default::default(),
            cwd: None,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        };
        registry
            .create(
                &spec,
                &std::collections::BTreeMap::new(),
                terminal_id.to_string(),
                "stream-test".to_string(),
                "shell",
                None,
                None,
                None,
                None,
            )
            .expect("spawn headless test terminal");
    }

    /// The PTY reader thread delivers output asynchronously; poll the registry
    /// directory until the scrollback snapshot contains `needle` (max ~5s).
    async fn wait_for_snapshot_contains(
        registry: &freshell_terminal::TerminalRegistry,
        terminal_id: &str,
        needle: &str,
    ) {
        for _ in 0..100 {
            if registry_snapshot(registry, terminal_id).is_some_and(|s| s.contains(needle)) {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("terminal {terminal_id} never produced output containing {needle:?}");
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    /// Oneshots `POST /api/ai/terminals/{terminal_id}/summary` (no request
    /// body — the Node route never reads one) against a router built from a
    /// CLONE of `st`.
    async fn post_summary(
        st: &AiRouterState,
        terminal_id: &str,
        auth: bool,
    ) -> (StatusCode, serde_json::Value) {
        let mut req = Request::builder()
            .method("POST")
            .uri(format!("/api/ai/terminals/{terminal_id}/summary"));
        if auth {
            req = req.header("x-auth-token", "tok");
        }
        let resp = router(st.clone())
            .oneshot(req.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        (status, body_json(resp).await)
    }

    #[test]
    fn heuristic_summary_first_two_lines_dash_joined_capped_240() {
        assert_eq!(
            heuristic_summary("\n\n  first line  \n second \n third"),
            "first line - second"
        );
        assert_eq!(heuristic_summary(""), "Terminal session");
        assert_eq!(heuristic_summary("\u{1b}[31monly\u{1b}[0m"), "only");
        let long = format!("{}\n{}", "a".repeat(300), "b");
        assert_eq!(heuristic_summary(&long).chars().count(), 240);
    }

    #[tokio::test]
    async fn summary_404_when_terminal_unknown() {
        let st = state(freshell_terminal::TerminalRegistry::new());
        let (status, body) = post_summary(&st, "nope", true).await;
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body, serde_json::json!({ "error": "Terminal not found" }));
    }

    #[tokio::test]
    async fn summary_heuristic_when_no_key_and_when_gemini_fails() {
        let registry = freshell_terminal::TerminalRegistry::new();
        spawn_headless_terminal_for_test(
            &registry,
            "term-sum",
            "printf 'first line\\nsecond line\\n'; sleep 5",
        );
        wait_for_snapshot_contains(&registry, "term-sum", "second line").await;

        // No key -> heuristic (first two non-empty scrollback lines, " - "-joined).
        let st = state(registry.clone());
        let (status, body) = post_summary(&st, "term-sum", true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["description"], "first line - second line");
        assert_eq!(body["source"], "heuristic");

        // Key present but Gemini throws -> same 200 heuristic shape (never 5xx).
        let mut st = state(registry.clone());
        st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
        st.gemini = std::sync::Arc::new(FakeGemini(Err("boom".into())));
        let (status, body) = post_summary(&st, "term-sum", true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["description"], "first line - second line");
        assert_eq!(body["source"], "heuristic");

        registry.kill("term-sum");
    }

    #[tokio::test]
    async fn summary_ai_path_caps_240_and_reports_source_ai() {
        let registry = freshell_terminal::TerminalRegistry::new();
        spawn_headless_terminal_for_test(&registry, "term-ai", "sleep 5");
        let mut st = state(registry.clone());
        st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
        st.gemini = std::sync::Arc::new(FakeGemini(Ok(format!("  {}  ", "x".repeat(500)))));
        let (status, body) = post_summary(&st, "term-ai", true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["description"].as_str().unwrap().chars().count(), 240);
        assert_eq!(body["source"], "ai");
        registry.kill("term-ai");
    }

    #[tokio::test]
    async fn summary_requires_auth() {
        let st = state(freshell_terminal::TerminalRegistry::new());
        let (status, body) = post_summary(&st, "any", false).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body, serde_json::json!({ "error": "Unauthorized" }));
    }
}
