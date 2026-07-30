//! `POST /api/sessions/resolve` — SYNC-06 port of the resolve route
//! (`server/sessions-router.ts`) + the hardened matching semantics of
//! `server/coding-cli/resolve-session.ts` (exact→fallback→prefix ordering,
//! case-sensitivity gating, subagent exclusion, candidate work budget).
//!
//! KNOWN DIVERGENCE — hardened response surface NOT yet ported: no
//! `degraded` status, `providerErrors`, `unsearchedProviders`, or `homeDir`,
//! and no scan-failure/warming-default merge. Tracked in
//! `docs/plans/2026-07-30-rust-resolve-parity-hardened.md` Tasks 3, 5, 6;
//! the `sessionResolve` capability flag is held `false` (`main.rs`) until
//! that lands.
//!
//! Behavior contract:
//! - auth: same `x-auth-token` / `freshell-auth` cookie check as every other
//!   `/api` route (`boot::is_authed`), 401 `{"error":"Unauthorized"}`.
//! - validation: strict body `{ input: string 1..=20000 }` (UTF-16 code
//!   units); any failure → 400
//!   `{"error":"Invalid resolve request","details":[issues]}` where the
//!   issue literals replicate the ACTUAL zod 4.3.6 wire output — field set,
//!   key ORDER (`expected`/`origin` before `code`; `preserve_order` + `json!`
//!   insertion order provide it), and message wording, probed against the
//!   real `ResumeResolveRequestSchema`. NOTHING reads `details` (the client
//!   dialog treats any non-2xx as request-failed without inspecting the
//!   body), so this is test-pinned parity; the literals are pinned to zod
//!   4.3.6 and MUST be re-probed on any zod bump.
//! - membership: the index snapshot is filtered through `deleted: true`
//!   session overrides before matching — Node's resolve reads the
//!   post-filter project groups (`session-indexer.ts:209,1155-1156`) and the
//!   Rust sidebar applies the same overlay (`session_directory.rs`
//!   `apply_session_overrides`). The exact-id fallbacks BYPASS the filter,
//!   as Node's do (they read sqlite/the filesystem directly).
//! - success is ALWAYS 200 — "not found" is `{status:"ready",matches:[]}`,
//!   cold index is `{status:"warming",matches:[],hint}` (never 404/5xx).
//!
//! Accepted deviations (status parity only, recorded): payloads Express's
//! strict body parser rejects with an HTML 400 before zod runs (malformed
//! JSON; JSON scalars string/number/bool/null) get the zod-shaped JSON 400
//! here; axum's default 2 MB body limit vs express `json({limit:'1mb'})`;
//! `PATCH`/`GET /api/sessions/resolve` answer 405 on the merged Rust router
//! where Express would dispatch `:sessionId="resolve"` (unreachable by any
//! known client).
//!
//! Readiness: `SessionIndex::peek()` `None` = never-published = Node's
//! `isIndexReady() === false`. A machine with no resolvable provider home
//! (`session_index: None`) also answers `warming` — the same honest-Unknown
//! convention `NoIndexProbe` uses for existence.

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde_json::{json, Map, Value};

use freshell_sessions::directory_index::{IndexedSession, SessionIndex};
use freshell_sessions::parse::OpencodeSessionDirectory;
use freshell_sessions::resume_resolve::{
    resolve_resume_input, ClaudeTranscriptHit, ResolveDeps, ResumeResolveResponse,
    ResumeResolveStatus,
};

use crate::boot::{is_authed, unauthorized};
use crate::session_metadata::SessionMetadataStore;
use crate::settings_store::SettingsStore;

/// zod `.max(20000)` on `input` (`shared/resume-resolve-contract.ts`).
const RESOLVE_INPUT_MAX_UTF16: usize = 20000;

/// opencode `ses_*` by-id fallback: `Some(hit)` = Node's by-id parent-walk
/// resolved the id (`hit.directory` is the row's own truthy `directory` —
/// the spawn cwd — and `None` for empty/NULL directories and legacy-schema
/// hits), `None` = walk miss (no row, orphaned chain, cycle) OR unreadable
/// DB (read errors are a miss here — the endpoint never 5xxes).
pub type OpencodeDirLookup = Arc<dyn Fn(&str) -> Option<OpencodeSessionDirectory> + Send + Sync>;

/// claude transcript exact-id fallback: lowercased id + original cwd.
pub type ClaudeLocator = Arc<dyn Fn(&str) -> Option<ClaudeTranscriptHit> + Send + Sync>;

/// Shared state for the resolve surface.
#[derive(Clone)]
pub struct ResolveState {
    pub auth_token: Arc<String>,
    /// `config.sessionOverrides` reader (`settings_store.rs`): the resolve
    /// read model drops `deleted: true` sessions exactly like the sidebar's
    /// `apply_session_overrides` and Node's post-filter `getProjects()`.
    pub settings: SettingsStore,
    pub session_index: Option<Arc<SessionIndex>>,
    pub session_metadata: SessionMetadataStore,
    pub opencode_dir_by_id: Option<OpencodeDirLookup>,
    pub locate_claude_transcript: Option<ClaudeLocator>,
}

pub fn router(state: ResolveState) -> Router {
    Router::new()
        .route("/api/sessions/resolve", post(resolve_session))
        .with_state(state)
}

/// zod v4's received-type word for a JSON value.
fn received_type(value: &Value) -> &'static str {
    match value {
        Value::Array(_) => "array",
        Value::String(_) => "string",
        Value::Number(_) => "number",
        Value::Bool(_) => "boolean",
        Value::Null => "null",
        Value::Object(_) => "object",
    }
}

/// Validate the request body against `ResumeResolveRequestSchema` semantics:
/// strict object, `input: string`, 1..=20000 UTF-16 code units. Returns the
/// input on success, or the `details` issue array on failure — every literal
/// (field set, key ORDER, message wording) is the ACTUAL zod 4.3.6 wire
/// output, probed against the real schema; see the module doc for the
/// version-fragility and no-consumer notes. `json!` insertion order IS the
/// serialized key order (workspace-wide `preserve_order`).
fn validate_resolve_body(body: &Value) -> Result<String, Value> {
    let Value::Object(map) = body else {
        // zod 4.3.6: `expected` precedes `code`; message carries the
        // received type: `[1,2]` -> "...received array", `"x"` ->
        // "...received string", etc.
        return Err(json!([{
            "expected": "object",
            "code": "invalid_type",
            "path": [],
            "message": format!("Invalid input: expected object, received {}", received_type(body))
        }]));
    };
    let mut issues: Vec<Value> = Vec::new();
    // zod emits the shape (`input`) issue BEFORE `unrecognized_keys`
    // (probed: `{foo:1}` -> [invalid_type(input), unrecognized_keys]).
    match map.get("input") {
        Some(Value::String(s)) => {
            let len = s.encode_utf16().count();
            if len < 1 {
                issues.push(json!({
                    "origin": "string",
                    "code": "too_small",
                    "minimum": 1,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too small: expected string to have >=1 characters"
                }));
            } else if len > RESOLVE_INPUT_MAX_UTF16 {
                issues.push(json!({
                    "origin": "string",
                    "code": "too_big",
                    "maximum": RESOLVE_INPUT_MAX_UTF16,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too big: expected string to have <=20000 characters"
                }));
            }
        }
        other => {
            // Missing (`received undefined`) and non-string values both
            // surface zod's invalid_type, with the actual received type.
            let received = other.map_or("undefined", received_type);
            issues.push(json!({
                "expected": "string",
                "code": "invalid_type",
                "path": ["input"],
                "message": format!("Invalid input: expected string, received {received}")
            }));
        }
    }
    let unknown: Vec<&str> = map
        .keys()
        .map(String::as_str)
        .filter(|k| *k != "input")
        .collect();
    if !unknown.is_empty() {
        // zod 4.3.6: double-quoted names, singular/plural noun.
        let listed = unknown
            .iter()
            .map(|k| format!("\"{k}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let noun = if unknown.len() == 1 { "key" } else { "keys" };
        issues.push(json!({
            "code": "unrecognized_keys",
            "keys": unknown,
            "path": [],
            "message": format!("Unrecognized {noun}: {listed}")
        }));
    }
    if issues.is_empty() {
        Ok(map
            .get("input")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string())
    } else {
        Err(Value::Array(issues))
    }
}

/// `POST /api/sessions/resolve`. Body taken as raw bytes (never an
/// axum-flavored rejection): an ABSENT or UNPARSEABLE body becomes `{}` —
/// the same value Express's `req.body ?? {}` hands zod for an absent body —
/// so it 400s with the missing-`input` issue. Parsed non-object values
/// (array/string/number/bool/null) flow to the invalid_type-object branch.
/// Recorded deviation (module doc): Express's strict body parser answers
/// malformed JSON and JSON scalars with an HTML 400 before zod ever runs;
/// this port answers those with the zod-shaped JSON 400 (status parity only
/// — no consumer reads 400 bodies). Arrays reach zod on both sides.
async fn resolve_session(
    State(state): State<ResolveState>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let parsed: Value = serde_json::from_slice(&body).unwrap_or_else(|_| Value::Object(Map::new()));
    let input = match validate_resolve_body(&parsed) {
        Ok(input) => input,
        Err(details) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Invalid resolve request", "details": details })),
            )
                .into_response();
        }
    };

    // Readiness gate = Node's `getIndexReadiness()`: a never-published (or
    // absent) index answers `warming`. When a snapshot exists, `snapshot()`
    // returns it immediately (stale-while-revalidate) — it only blocks when
    // truly cold, which `peek()` has already excluded.
    let snapshot = match state.session_index.as_ref() {
        Some(index) => match index.peek() {
            Some(_) => Some(index.snapshot().await),
            None => None,
        },
        None => None,
    };

    // Deleted-override filter: Node's resolve reads the POST-filter project
    // groups (`session-indexer.ts:209,1155-1156`) and the Rust sidebar
    // applies the same overlay (`session_directory.rs`
    // `apply_session_overrides`) — the resolve read model must agree with
    // both. Composite key `"{provider}:{session_id}"` ONLY: Node's extra
    // bare-id/legacy-claude override keys are a pre-existing accepted
    // divergence (the Rust sidebar does not consult them either). The
    // exact-id FALLBACKS below intentionally BYPASS this filter — Node's
    // fallbacks read sqlite/the filesystem directly and never consult
    // overrides — bug-for-bug.
    let snapshot: Option<Vec<IndexedSession>> = snapshot.map(|sessions| {
        let overrides = state.settings.session_overrides();
        sessions
            .iter()
            .filter(|session| {
                overrides
                    .get(&session.key())
                    .and_then(Value::as_object)
                    .is_none_or(|ov| !ov.get("deleted").and_then(Value::as_bool).unwrap_or(false))
            })
            .cloned()
            .collect()
    });

    // sessionType overlay (Node: `session-indexer.ts:1159-1161`), keyed
    // `"{provider}:{session_id}"`. Only needed when we can match at all.
    let session_types: HashMap<String, String> = if snapshot.is_some() {
        state
            .session_metadata
            .get_all()
            .await
            .into_iter()
            .filter_map(|(key, entry)| {
                entry
                    .get("sessionType")
                    .and_then(Value::as_str)
                    .map(|t| (key, t.to_string()))
            })
            .collect()
    } else {
        HashMap::new()
    };

    let opencode = state.opencode_dir_by_id.clone();
    let claude = state.locate_claude_transcript.clone();
    let joined = tokio::task::spawn_blocking(move || {
        let deps = ResolveDeps {
            // as_deref (Option<Vec<T>> -> Option<&[T]>): as_ref().map(|s| s.as_slice())
            // trips clippy's warn-by-default `option_as_ref_deref` under -D warnings.
            sessions: snapshot.as_deref(),
            session_types: &session_types,
            opencode_dir_by_id: opencode.as_deref(),
            locate_claude_transcript: claude.as_deref(),
        };
        resolve_resume_input(&input, &deps)
    })
    .await;

    // JoinError = the resolve task panicked. Express would 500 here; this
    // port answers a benign ready-empty (Global Constraint: never 5xx) and
    // the panic is already on stderr for diagnosis.
    let response = joined.unwrap_or(ResumeResolveResponse {
        status: ResumeResolveStatus::Ready,
        matches: Vec::new(),
        hint: None,
    });
    Json(response).into_response()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    use freshell_sessions::directory_index::{
        FileStat, IndexedSession, SessionIndex, SessionSource,
    };

    const CLAUDE_ID: &str = "ed2afda6-a340-443e-ba60-024a1b3554b4";

    /// A file-less, direct-listed source: `discover()` empty, `direct_list()`
    /// serves the fixture rows — a hermetic SessionIndex with zero disk IO.
    struct FixtureSource(Vec<IndexedSession>);

    impl SessionSource for FixtureSource {
        fn discover(&self) -> Vec<FileStat> {
            Vec::new()
        }
        fn parse(&self, _path: &std::path::Path) -> Option<IndexedSession> {
            None
        }
        fn direct_change_token(&self) -> Option<i64> {
            Some(1)
        }
        fn direct_list(&self) -> Result<Vec<IndexedSession>, String> {
            Ok(self.0.clone())
        }
    }

    async fn fixture_index(sessions: Vec<IndexedSession>) -> Arc<SessionIndex> {
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(FixtureSource(sessions)) as Arc<dyn SessionSource>],
            std::time::Duration::from_secs(3600),
            None,
        ));
        index.warm().await;
        index
    }

    fn claude_fixture() -> IndexedSession {
        IndexedSession {
            session_id: CLAUDE_ID.to_string(),
            provider: "claude".to_string(),
            project_path: "/repo/alpha".to_string(),
            title: Some("Fix the parser".to_string()),
            summary: None,
            first_user_message: Some("fix the parser".to_string()),
            last_activity_at: 400,
            created_at: None,
            cwd: Some("/repo/alpha".to_string()),
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "frs-resolve-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir temp dir");
        dir
    }

    fn state(dir: &std::path::Path, index: Option<Arc<SessionIndex>>) -> super::ResolveState {
        super::ResolveState {
            auth_token: Arc::new("tok".into()),
            // Isolated home: overrides read/write under `<dir>/.freshell/`,
            // never the developer's real config (same pattern as the
            // session_directory router tests).
            settings: crate::settings_store::SettingsStore::load(Some(dir), vec!["claude".into()]),
            session_index: index,
            session_metadata: crate::session_metadata::SessionMetadataStore::new(dir),
            opencode_dir_by_id: None,
            locate_claude_transcript: None,
        }
    }

    async fn post(
        state: super::ResolveState,
        body: serde_json::Value,
        with_auth: bool,
    ) -> (StatusCode, serde_json::Value) {
        let app = super::router(state);
        let mut builder = Request::builder()
            .method("POST")
            .uri("/api/sessions/resolve")
            .header("content-type", "application/json");
        if with_auth {
            builder = builder.header("x-auth-token", "tok");
        }
        let request = builder.body(Body::from(body.to_string())).unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        (status, value)
    }

    #[tokio::test]
    async fn rejects_unauthenticated_requests() {
        let dir = temp_dir("auth");
        let (status, body) = post(
            state(&dir, None),
            serde_json::json!({ "input": CLAUDE_ID }),
            false,
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(body, serde_json::json!({ "error": "Unauthorized" }));
    }

    #[tokio::test]
    async fn rejects_unknown_keys_with_the_zod_4_3_6_literal() {
        // `input` valid, two unknown keys: exactly ONE issue, plural noun,
        // double-quoted names, key order code/keys/path/message.
        let dir = temp_dir("strict");
        let (status, body) = post(
            state(&dir, None),
            serde_json::json!({ "input": "x", "foo": 1, "bar": 2 }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "Invalid resolve request");
        assert_eq!(
            body["details"],
            serde_json::json!([{
                "code": "unrecognized_keys",
                "keys": ["foo", "bar"],
                "path": [],
                "message": "Unrecognized keys: \"foo\", \"bar\""
            }])
        );
    }

    #[tokio::test]
    async fn multi_issue_order_is_input_issue_then_unrecognized_keys() {
        // Probed zod 4.3.6 behavior for `{foo:1}`: the `input` invalid_type
        // issue comes FIRST, `unrecognized_keys` (singular form) SECOND.
        let dir = temp_dir("multi");
        let (status, body) = post(state(&dir, None), serde_json::json!({ "foo": 1 }), true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            body["details"],
            serde_json::json!([
                {
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["input"],
                    "message": "Invalid input: expected string, received undefined"
                },
                {
                    "code": "unrecognized_keys",
                    "keys": ["foo"],
                    "path": [],
                    "message": "Unrecognized key: \"foo\""
                }
            ])
        );
    }

    #[tokio::test]
    async fn zod_details_literals_match_zod_4_3_6_wire_output() {
        // One case per failure class; expectations are the EXACT zod 4.3.6
        // `parsed.error.issues` output probed against the real schema. The
        // scalar bodies (`null` here) are the recorded deviation: Express's
        // strict body parser HTML-400s them before zod, Rust answers the
        // zod-shaped issue for the parsed value instead.
        let dir = temp_dir("bounds");
        let cases: Vec<(serde_json::Value, serde_json::Value)> = vec![
            (
                serde_json::json!({ "input": "" }),
                serde_json::json!([{
                    "origin": "string",
                    "code": "too_small",
                    "minimum": 1,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too small: expected string to have >=1 characters"
                }]),
            ),
            (
                serde_json::json!({}),
                serde_json::json!([{
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["input"],
                    "message": "Invalid input: expected string, received undefined"
                }]),
            ),
            (
                serde_json::json!({ "input": 123 }),
                serde_json::json!([{
                    "expected": "string",
                    "code": "invalid_type",
                    "path": ["input"],
                    "message": "Invalid input: expected string, received number"
                }]),
            ),
            (
                serde_json::json!({ "input": "x".repeat(20001) }),
                serde_json::json!([{
                    "origin": "string",
                    "code": "too_big",
                    "maximum": 20000,
                    "inclusive": true,
                    "path": ["input"],
                    "message": "Too big: expected string to have <=20000 characters"
                }]),
            ),
            (
                serde_json::json!([1, 2]),
                serde_json::json!([{
                    "expected": "object",
                    "code": "invalid_type",
                    "path": [],
                    "message": "Invalid input: expected object, received array"
                }]),
            ),
            (
                serde_json::json!(null),
                serde_json::json!([{
                    "expected": "object",
                    "code": "invalid_type",
                    "path": [],
                    "message": "Invalid input: expected object, received null"
                }]),
            ),
        ];
        for (body, details) in cases {
            let (status, response) = post(state(&dir, None), body.clone(), true).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "body {body}");
            assert_eq!(response["error"], "Invalid resolve request", "body {body}");
            assert_eq!(response["details"], details, "body {body}");
        }
        // Key ORDER is part of the wire shape (zod v4 emits `expected` /
        // `origin` BEFORE `code`). `Value` equality is order-insensitive, so
        // pin one case as a serialized string — `preserve_order` makes the
        // parsed order round-trip the wire order.
        let (_, response) =
            post(state(&dir, None), serde_json::json!({ "input": 123 }), true).await;
        assert_eq!(
            serde_json::to_string(&response["details"]).unwrap(),
            r#"[{"expected":"string","code":"invalid_type","path":["input"],"message":"Invalid input: expected string, received number"}]"#
        );
    }

    #[tokio::test]
    async fn input_of_exactly_20000_chars_is_accepted() {
        let dir = temp_dir("maxok");
        let (status, body) = post(
            state(&dir, None),
            serde_json::json!({ "input": "x".repeat(20000) }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "warming"); // no index in this state
    }

    #[tokio::test]
    async fn warming_with_hint_when_index_never_published() {
        let dir = temp_dir("warming");
        let (status, body) = post(
            state(&dir, None),
            serde_json::json!({ "input": format!("claude --resume {CLAUDE_ID}") }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body,
            serde_json::json!({
                "status": "warming",
                "matches": [],
                "hint": { "provider": "claude", "source": "command" }
            })
        );
    }

    #[tokio::test]
    async fn exact_match_returns_full_metadata_via_the_index() {
        let dir = temp_dir("exact");
        let index = fixture_index(vec![claude_fixture()]).await;
        let (status, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": CLAUDE_ID }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(
            body["matches"],
            serde_json::json!([{
                "provider": "claude",
                "sessionId": CLAUDE_ID,
                "cwd": "/repo/alpha",
                // Hardened Node emits `sessionType ?? provider` — never absent.
                "sessionType": "claude",
                "title": "Fix the parser",
                "firstUserMessage": "fix the parser",
                "lastActivityAt": 400,
                "matchKind": "exact"
            }])
        );
    }

    #[tokio::test]
    async fn session_type_overlays_from_the_metadata_store_file() {
        let dir = temp_dir("stype");
        std::fs::write(
            dir.join("session-metadata.json"),
            serde_json::json!({
                "version": 1,
                "sessions": {
                    "claude": {
                        CLAUDE_ID: { "sessionType": "freshclaude", "sessionTypeSource": "explicit" }
                    }
                }
            })
            .to_string(),
        )
        .unwrap();
        let index = fixture_index(vec![claude_fixture()]).await;
        let (_, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": CLAUDE_ID }),
            true,
        )
        .await;
        assert_eq!(body["matches"][0]["sessionType"], "freshclaude");
    }

    #[tokio::test]
    async fn unknown_id_is_ready_empty_never_404() {
        let dir = temp_dir("miss");
        let index = fixture_index(vec![claude_fixture()]).await;
        let (status, body) = post(
            state(&dir, Some(index)),
            serde_json::json!({ "input": "019fffff-ffff-7fff-bfff-ffffffffffff" }),
            true,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn opencode_fallback_answers_with_row_directory() {
        let dir = temp_dir("ocfb");
        let index = fixture_index(vec![claude_fixture()]).await;
        let unknown = "ses_child000000000000000000000";
        let mut st = state(&dir, Some(index));
        st.opencode_dir_by_id = Some(Arc::new(|_id: &str| {
            Some(freshell_sessions::parse::OpencodeSessionDirectory {
                directory: Some("/repo/beta".to_string()),
            })
        }));
        let (status, body) = post(st, serde_json::json!({ "input": unknown }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["matches"],
            serde_json::json!([{
                "provider": "opencode",
                "sessionId": unknown,
                "cwd": "/repo/beta",
                "sessionType": "opencode",
                "matchKind": "exact"
            }])
        );
    }

    #[tokio::test]
    async fn claude_transcript_fallback_answers_on_index_miss() {
        let dir = temp_dir("clfb");
        let index = fixture_index(vec![claude_fixture()]).await;
        let unknown = "aaaaaaaa-1111-4222-8333-444444444444";
        let mut st = state(&dir, Some(index));
        st.locate_claude_transcript = Some(Arc::new(move |id: &str| {
            Some(freshell_sessions::resume_resolve::ClaudeTranscriptHit {
                session_id: id.to_ascii_lowercase(),
                cwd: Some("/repo/gamma".to_string()),
            })
        }));
        let (status, body) = post(st, serde_json::json!({ "input": unknown }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            body["matches"],
            serde_json::json!([{
                "provider": "claude",
                "sessionId": unknown,
                "cwd": "/repo/gamma",
                "sessionType": "claude",
                "matchKind": "exact"
            }])
        );
    }

    #[tokio::test]
    async fn deleted_override_hides_the_session_from_resolve() {
        // Node's resolve reads the post-deleted-filter project groups
        // (`session-indexer.ts:209,1155-1156`) and the Rust sidebar filters
        // the same way (`session_directory.rs::apply_session_overrides`) —
        // the resolve read model must agree with both. Written through the
        // REAL override write path (`patch_session_override`, the same call
        // `PATCH /api/sessions/{id}` lands on).
        let dir = temp_dir("deleted");
        let index = fixture_index(vec![claude_fixture()]).await;
        let st = state(&dir, Some(index));
        st.settings
            .patch_session_override(
                &format!("claude:{CLAUDE_ID}"),
                &[("deleted", Some(serde_json::json!(true)))],
            )
            .await;
        let (status, body) = post(st, serde_json::json!({ "input": CLAUDE_ID }), true).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["status"], "ready");
        assert_eq!(body["matches"], serde_json::json!([]));
    }

    #[tokio::test]
    async fn malformed_json_body_degrades_to_the_missing_input_400() {
        // Express's strict body parser answers malformed JSON with an HTML
        // 400 before zod runs; this port treats an unparseable body as `{}`
        // (Node's absent-body `req.body ?? {}`) and answers the zod-shaped
        // missing-`input` 400 — status parity only, a recorded deviation.
        let dir = temp_dir("badjson");
        let app = super::router(state(&dir, None));
        let request = Request::builder()
            .method("POST")
            .uri("/api/sessions/resolve")
            .header("content-type", "application/json")
            .header("x-auth-token", "tok")
            .body(Body::from("{not json"))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"], "Invalid resolve request");
        assert_eq!(
            body["details"],
            serde_json::json!([{
                "expected": "string",
                "code": "invalid_type",
                "path": ["input"],
                "message": "Invalid input: expected string, received undefined"
            }])
        );
    }
}
