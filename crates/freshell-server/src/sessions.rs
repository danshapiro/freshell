//! `/api/sessions/:sessionId` — session rename/archive/delete overrides and
//! AI/first-message title generation. Faithful port of the write half of
//! `server/sessions-router.ts` (`PATCH` :122-165, `POST generate-title` :167-210),
//! backed by `SettingsStore::patch_session_override`. The terminal-cascade rename
//! (`cascadeSessionRenameToTerminal`) is out of scope; `cascadedTerminalId` is
//! always emitted as `null` so the wire shape matches.

use std::sync::Arc;

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{patch, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::boot::{is_authed, unauthorized};
use crate::settings_store::SettingsStore;

/// Shared state for the `/api/sessions` write surface.
#[derive(Clone)]
pub struct SessionsState {
    pub auth_token: Arc<String>,
    pub settings: SettingsStore,
}

/// The sessions sub-router (`PATCH /api/sessions/:id` + `POST .../generate-title`).
pub fn router(state: SessionsState) -> Router {
    Router::new()
        .route("/api/sessions/{session_id}", patch(patch_session))
        .route(
            "/api/sessions/{session_id}/generate-title",
            post(generate_title),
        )
        .with_state(state)
}

/// `rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)` — the axum
/// path extractor already percent-decodes, so `codex%3Axyz` arrives as `codex:xyz`.
fn composite_key(raw: &str, provider: &str) -> String {
    if raw.contains(':') {
        raw.to_string()
    } else {
        format!("{provider}:{raw}")
    }
}

fn provider_of(q: &std::collections::HashMap<String, String>) -> String {
    q.get("provider")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| "claude".into())
}

/// `cleanString` (`server/utils.ts`): trim; empty/whitespace/absent/null → clear.
fn clean_string(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `PATCH /api/sessions/:sessionId` — validate the `SessionPatchSchema` body,
/// build the JS-spread patch tuple list, persist via
/// `SettingsStore::patch_session_override`, and respond with the merged
/// override plus the always-`null` `cascadedTerminalId` (the terminal-cascade
/// rename is out of scope for this port).
async fn patch_session(
    State(state): State<SessionsState>,
    AxumPath(raw_id): AxumPath<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // SessionPatchSchema shape validation (sessions-router.ts:31-63):
    // titleOverride/summaryOverride: string|null; archived/deleted: bool;
    // createdAtOverride: number. Any wrong type → 400 {error:"Invalid request",details:[...]}.
    if let Some(details) = validate_session_patch(&body) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid request", "details": details })),
        )
            .into_response();
    }
    let key = composite_key(&raw_id, &provider_of(&q));

    let title = clean_string(body.get("titleOverride"));
    let mut patch: Vec<(&str, Option<Value>)> = Vec::new();
    if body.get("titleOverride").is_some() {
        patch.push(("titleOverride", title.clone().map(Value::from)));
        // titleSource:'user' only when a non-empty title is present (sessions-router.ts:132-133).
        if title.is_some() {
            patch.push(("titleSource", Some(json!("user"))));
        }
    }
    if body.get("summaryOverride").is_some() {
        patch.push((
            "summaryOverride",
            clean_string(body.get("summaryOverride")).map(Value::from),
        ));
    }
    if let Some(a) = body.get("archived") {
        patch.push(("archived", Some(a.clone())));
    }
    if let Some(d) = body.get("deleted") {
        patch.push(("deleted", Some(d.clone())));
    }
    if let Some(c) = body.get("createdAtOverride") {
        patch.push(("createdAtOverride", Some(c.clone())));
    }

    let merged = state.settings.patch_session_override(&key, &patch).await;
    let mut out = merged.as_object().cloned().unwrap_or_default();
    out.insert("cascadedTerminalId".into(), Value::Null);
    Json(Value::Object(out)).into_response()
}

/// Faithful subset of `SessionPatchSchema` — returns zod-shaped `details` on a
/// type violation, `None` when the body is valid.
///
/// **Note on details shape:** the legacy body validator emits zod v4 `issues`.
/// The exact `details` wording for session-patch type errors was not captured
/// in the investigation reports; this emits shapes consistent with the
/// session-directory validator style. Not claimed byte-exact.
fn validate_session_patch(body: &Value) -> Option<Value> {
    let Value::Object(map) = body else {
        return Some(json!([{
            "code": "invalid_type",
            "expected": "object",
            "path": [],
            "message": "Invalid input: expected object"
        }]));
    };
    let mut issues: Vec<Value> = Vec::new();
    let str_or_null = |k: &str, issues: &mut Vec<Value>| {
        if let Some(v) = map.get(k) {
            if !v.is_string() && !v.is_null() {
                issues.push(json!({
                    "code": "invalid_type",
                    "expected": "string",
                    "path": [k],
                    "message": "Invalid input: expected string"
                }));
            }
        }
    };
    let bool_field = |k: &str, issues: &mut Vec<Value>| {
        if let Some(v) = map.get(k) {
            if !v.is_boolean() {
                issues.push(json!({
                    "code": "invalid_type",
                    "expected": "boolean",
                    "path": [k],
                    "message": "Invalid input: expected boolean"
                }));
            }
        }
    };
    str_or_null("titleOverride", &mut issues);
    str_or_null("summaryOverride", &mut issues);
    bool_field("archived", &mut issues);
    bool_field("deleted", &mut issues);
    if let Some(v) = map.get("createdAtOverride") {
        if !v.is_number() {
            issues.push(json!({
                "code": "invalid_type",
                "expected": "number",
                "path": ["createdAtOverride"],
                "message": "Invalid input: expected number"
            }));
        }
    }
    if issues.is_empty() {
        None
    } else {
        Some(Value::Array(issues))
    }
}

/// `extractTitleFromMessage` (`shared/title-utils.ts:9-30`): maxLen 50;
/// multi-line -> first non-empty line (trimmed + whitespace-collapsed);
/// single-line -> trim + collapse whitespace, then truncate to `max_len`.
fn extract_title_from_message(content: &str, max_len: usize) -> String {
    let collapse = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = if content.contains('\n') {
        match content.lines().find(|l| !l.trim().is_empty()) {
            Some(first) => collapse(first.trim()),
            None => return String::new(),
        }
    } else {
        collapse(content.trim())
    };
    cleaned.chars().take(max_len).collect()
}

/// `POST /api/sessions/:sessionId/generate-title` — a blank `firstMessage` is
/// the only 400 this emits (`sessions-router.ts:167-179`); everything else
/// resolves to `200`, never `5xx` (Global Constraint 8). No Gemini/AI key path
/// in this port (matches legacy no-key behavior): the first-message heuristic
/// is applied and persisted through the title-source ladder, then the STORED
/// (ladder-resolved) title/source is returned — faithfully reflecting a
/// ladder-blocked write (`sessions-router.ts:185-190`).
async fn generate_title(
    State(state): State<SessionsState>,
    AxumPath(raw_id): AxumPath<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let first_message = body
        .get("firstMessage")
        .and_then(Value::as_str)
        .unwrap_or("");
    if first_message.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "firstMessage is required" })),
        )
            .into_response();
    }
    let key = composite_key(&raw_id, &provider_of(&q));
    let heuristic = extract_title_from_message(first_message, 50);
    if heuristic.is_empty() {
        return Json(json!({ "title": null, "source": "none" })).into_response();
    }
    let stored = state
        .settings
        .patch_session_override(
            &key,
            &[
                ("titleOverride", Some(json!(heuristic))),
                ("titleSource", Some(json!("first-message"))),
            ],
        )
        .await;
    // Respond with the STORED (ladder-resolved) value, faithfully.
    let title = stored.get("titleOverride").cloned().unwrap_or(Value::Null);
    let source = stored.get("titleSource").cloned().unwrap_or(json!("none"));
    Json(json!({ "title": title, "source": source })).into_response()
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn state(dir: &std::path::Path) -> super::SessionsState {
        super::SessionsState {
            auth_token: std::sync::Arc::new("tok".into()),
            settings: crate::settings_store::SettingsStore::load(Some(dir), vec!["claude".into()]),
        }
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn patch_rename_persists_and_returns_merged_plus_cascade_null() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/abc123?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"titleOverride":"My Title"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["titleOverride"], serde_json::json!("My Title"));
        assert_eq!(v["titleSource"], serde_json::json!("user"));
        assert_eq!(v["cascadedTerminalId"], serde_json::Value::Null);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn patch_requires_auth() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/abc")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn patch_url_encoded_composite_key_is_decoded() {
        // A raw id already containing ':' (url-encoded %3A) is used verbatim.
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/codex%3Axyz")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"archived":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            cfg["sessionOverrides"]["codex:xyz"]["archived"],
            serde_json::json!(true)
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn generate_title_blank_first_message_is_400() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let v = body_json(resp).await;
        assert_eq!(v["error"], serde_json::json!("firstMessage is required"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn generate_title_no_key_uses_first_message_heuristic() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"firstMessage":"Fix the login bug\nmore detail"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::json!("Fix the login bug")); // first non-empty line
        assert_eq!(v["source"], serde_json::json!("first-message"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn generate_title_after_user_rename_is_ladder_blocked() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state(&dir);
        // Pre-seed a user rename (rank 5).
        st.settings
            .patch_session_override(
                "claude:abc",
                &[
                    ("titleOverride", Some(serde_json::json!("User Named"))),
                    ("titleSource", Some(serde_json::json!("user"))),
                ],
            )
            .await;
        let app = super::router(st);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"Some prompt"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        // first-message (3) cannot upgrade user (5): store keeps the user title; the
        // response reflects the STORED (merged) value, faithfully (sessions-router.ts:185-190).
        assert_eq!(v["title"], serde_json::json!("User Named"));
        assert_eq!(v["source"], serde_json::json!("user"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn generate_title_multiline_takes_first_nonempty_line_truncated() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let long_line = "a".repeat(80);
        let first_message = format!("\n   \n{long_line}\nsecond line");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "firstMessage": first_message }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::json!("a".repeat(50)));
        assert_eq!(v["source"], serde_json::json!("first-message"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// End-to-end sanity: a PATCH through THIS router persists a
    /// `sessionOverride` that `session_directory`'s overlay (Task 2) then
    /// surfaces on the matching item — the same `SettingsStore` backs both.
    #[tokio::test]
    async fn patch_override_is_visible_through_session_directory_overlay() {
        use axum::http::Request as HttpRequest;

        let home = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        let project = home.join(".claude").join("projects").join("-tmp-proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(home.join(".freshell")).unwrap();
        // Inline transcript (not the committed `healthy.jsonl` fixture, which
        // deliberately has no `cwd` and is excluded at discovery, R10b): a
        // `cwd`-bearing, two-user-message session so it survives both the
        // discovery `cwd` requirement and the default `isNonInteractive` filter.
        let content = [
            r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"user","message":{"role":"user","content":"first prompt"},"timestamp":"2025-01-30T10:00:00.000Z"}"#,
            r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"assistant","message":{"role":"assistant","content":"ack"},"timestamp":"2025-01-30T10:00:01.000Z"}"#,
            r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"user","message":{"role":"user","content":"second prompt"},"timestamp":"2025-01-30T10:00:02.000Z"}"#,
        ]
        .join("\n");
        std::fs::write(project.join("healthy-session-id.jsonl"), content).unwrap();

        let settings =
            crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]);
        let auth_token: std::sync::Arc<String> = std::sync::Arc::new("tok".into());

        // Patch title + archived through the sessions router.
        let sessions_app = super::router(super::SessionsState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings: settings.clone(),
        });
        let patch_resp = sessions_app
            .oneshot(
                HttpRequest::builder()
                    .method("PATCH")
                    .uri("/api/sessions/healthy-session-id?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"titleOverride":"Overlay Title","archived":true}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(patch_resp.status(), StatusCode::OK);

        // Query the session-directory read model with the SAME settings store.
        let dir_app =
            crate::session_directory::router(crate::session_directory::SessionDirectoryState {
                auth_token: std::sync::Arc::clone(&auth_token),
                home: Some(home.clone()),
                settings,
            });
        let dir_resp = dir_app
            .oneshot(
                HttpRequest::builder()
                    .method("GET")
                    .uri("/api/session-directory?priority=visible")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(dir_resp.status(), StatusCode::OK);
        let page = body_json(dir_resp).await;
        let items = page["items"].as_array().unwrap();
        let item = items
            .iter()
            .find(|i| i["sessionId"] == serde_json::json!("healthy-session-id"))
            .expect("patched session present in directory");
        assert_eq!(item["title"], serde_json::json!("Overlay Title"));
        assert_eq!(item["archived"], serde_json::json!(true));

        std::fs::remove_dir_all(&home).ok();
    }

    fn uuid_like() -> String {
        format!("{}-{:?}", std::process::id(), std::time::SystemTime::now())
            .replace([':', '.', ' '], "-")
    }
}
