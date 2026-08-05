//! `/api/sessions/:sessionId` — session rename/archive/delete overrides and
//! AI/first-message title generation. Faithful port of the write half of
//! `server/sessions-router.ts` (`PATCH` :122-165, `POST generate-title` :167-241,
//! including the provider-generated short-circuit and the real Gemini AI path
//! of `server/ai-title.ts`), plus the pure auto-naming decision fns of
//! `server/auto-title.ts` and the one-time stale-AI-title cleanup driver of
//! `server/coding-cli/provider-title-cleanup.ts` (the store half lives in
//! `crate::settings_store`),
//! backed by `SettingsStore::patch_session_override`. The REVERSE terminal-cascade
//! rename (`cascadeSessionRenameToTerminal`, `rename-cascade.ts:39-50`) IS
//! implemented in `patch_session` below: a rename of a session currently running
//! in a LIVE terminal (`TerminalIdentityRegistry::find_by_session`) rewrites that
//! terminal's own override, write-throughs the in-memory registry title, and
//! broadcasts `terminals.changed`, echoing the real terminal id as
//! `cascadedTerminalId` (`null` only when no live terminal matches). Proven by
//! `patch_rename_cascades_all_four_effects_to_a_live_terminal` and
//! `patch_rename_to_a_retired_terminal_identity_does_not_cascade` below.

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
    /// Fix Spec: Session Naming Cluster (SYMPTOM 2a reverse direction) — the
    /// shared terminal identity registry, read here to cascade a session rename
    /// to the terminal currently running it (`cascadeSessionRenameToTerminal`,
    /// `rename-cascade.ts:39-50`). Uses `.list()` (live-only) via
    /// `find_by_session`, matching `deps.terminalMetadata.list()`
    /// (`sessions-router.ts:149`) — an already-exited terminal is NOT retitled by
    /// a session rename (only the forward direction survives exit).
    pub identity: freshell_ws::identity::TerminalIdentityRegistry,
    /// The shared terminal registry, so a successful reverse cascade can
    /// write-through the live title the same way the terminals PATCH route does
    /// (`deps.registry?.updateTitle(cascadedTerminalId, cleanTitle)`,
    /// `sessions-router.ts:155`), and the shared broadcast bus + revision counter
    /// so `terminals.changed` fires (`sessions-router.ts:156`).
    pub registry: freshell_terminal::TerminalRegistry,
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    pub terminals_revision: Arc<std::sync::atomic::AtomicI64>,
    /// GAP-1 fix (reviewer Important, SESSION-09 follow-up): the shared
    /// `sessions.changed` revision counter (the SAME `Arc<AtomicI64>` as
    /// `freshell_ws::WsState::sessions_revision` and
    /// `FreshAgentState`'s, unified in commit b068d28b), wired here so a
    /// rename/archive/delete OVERRIDE write can broadcast directly instead
    /// of relying on the periodic session-directory sweep
    /// (`spawn_sessions_sweep`, `main.rs`) -- that sweep's `(count, max
    /// lastActivityAt)` signature is structurally blind to override-only
    /// changes (`IndexedSession` carries no archived/title-override
    /// fields), so an archive/rename toggle would otherwise never trip a
    /// broadcast. Legacy parity: `SessionsSyncService`'s differ
    /// (`hasSessionDirectorySnapshotChange`, `projection.ts:23`) diffs the
    /// FULL comparable snapshot -- including `archived`/`title` -- on
    /// every `codingCliIndexer.refresh()` call, which the legacy PATCH
    /// route always triggers.
    pub sessions_revision: Arc<std::sync::atomic::AtomicI64>,
    /// SESSION-04: the env read behind `AI_CONFIG.enabled()`
    /// (`server/ai-prompts.ts:12-15`) — `GOOGLE_GENERATIVE_AI_API_KEY` gates
    /// the real Gemini branch of `POST .../generate-title`.
    pub env: Arc<dyn freshell_platform::Env + Send + Sync>,
    /// SESSION-04: the injected title-generation transport
    /// (`generateAiSessionTitle`, `server/ai-title.ts:10-27`). `None` (tests)
    /// behaves like an empty model result (`{title:null, source:'none'}`).
    pub ai_title_generator: Option<AiTitleGenerator>,
    /// SESSION-04: the session index the provider-authoritative short-circuit
    /// consults (`deps.codingCliIndexer.getProjects()...find(...)`,
    /// `sessions-router.ts:180-190`). `None` skips the short-circuit (the
    /// legacy route would behave the same when the index can't match).
    pub session_index: Option<Arc<freshell_sessions::directory_index::SessionIndex>>,
}

/// The injected seam for `generateAiSessionTitle` (`server/ai-title.ts`):
/// given the request, produce the model's title text — `Ok(Some(title))`,
/// `Ok(None)` for an empty/unusable result, `Err(message)` for a failure the
/// route must echo as `{title:null, source:'none', error}` (never 5xx).
pub type AiTitleGenerator = Arc<
    dyn Fn(
            AiTitleRequest,
        )
            -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Option<String>, String>> + Send>>
        + Send
        + Sync,
>;

/// One `generateAiSessionTitle(firstMessage, customPrompt)` call — the key is
/// resolved by the caller (env, with the settings backfill the legacy
/// `applySettingsKey` call sites perform) so the transport stays pure.
#[derive(Debug, Clone)]
pub struct AiTitleRequest {
    pub api_key: String,
    pub first_message: String,
    pub custom_prompt: Option<String>,
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

    // Cascade: if this session is running in a LIVE terminal, also rename the
    // terminal (`cascadeSessionRenameToTerminal`, `rename-cascade.ts:39-50`,
    // driven from `sessions-router.ts:140-161`). `key` is always `provider:id`
    // (`composite_key` above guarantees the separator), so splitting on the
    // FIRST `:` recovers `(sessionProvider, sessionId)` exactly like the
    // original's `parts[0]` / `parts.slice(1).join(':')`.
    let mut cascaded_terminal_id: Option<String> = None;
    if let Some(clean_title) = &title {
        if let Some((session_provider, session_id)) = key.split_once(':') {
            if let Some(matched) = state.identity.find_by_session(session_provider, session_id) {
                state
                    .settings
                    .patch_terminal_override(
                        &matched.terminal_id,
                        &[("titleOverride", Some(Value::from(clean_title.clone())))],
                    )
                    .await;
                state
                    .registry
                    .update_title(&matched.terminal_id, clean_title);
                let revision = state
                    .terminals_revision
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                    + 1;
                let frame =
                    json!({ "type": "terminals.changed", "revision": revision }).to_string();
                let _ = state.broadcast_tx.send(frame);
                cascaded_terminal_id = Some(matched.terminal_id);
            }
        }
    }
    out.insert(
        "cascadedTerminalId".into(),
        cascaded_terminal_id.map(Value::from).unwrap_or(Value::Null),
    );

    // GAP-1 fix: broadcast `sessions.changed` directly for this override
    // write, rather than relying on the periodic session-directory sweep
    // (which is structurally blind to override-only changes -- see the
    // `sessions_revision` field doc comment on `SessionsState` above).
    // Guarded on a non-empty patch: an empty body (no recognized fields) is
    // schema-valid but performs no actual write, so nothing changed to
    // broadcast. Emitted AFTER the terminal cascade (if any) so a rename
    // that also cascades produces `terminals.changed` before
    // `sessions.changed`, preserving the existing cascade test's
    // single-`try_recv()` assumption.
    if !patch.is_empty() {
        let revision = state
            .sessions_revision
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            + 1;
        let frame = json!({ "type": "sessions.changed", "revision": revision }).to_string();
        let _ = state.broadcast_tx.send(frame);
    }

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

/// The default `maxLen` every call site shares (`title-utils.ts:9`): client,
/// auto-title pass, and the generate-title route must never disagree.
const FIRST_MESSAGE_TITLE_LEN: usize = 50;

/// `AI_CONFIG.model` (`server/ai-prompts.ts:13`).
pub(crate) const AI_TITLE_MODEL: &str = "gemini-2.5-flash-lite";

/// `PROMPTS.sessionTitle.maxOutputTokens` (`server/ai-prompts.ts:44`).
const AI_TITLE_MAX_OUTPUT_TOKENS: u32 = 30;

/// `(result.text || '').trim().slice(0, 80)` truncation cap (`ai-title.ts:25`).
const AI_TITLE_MAX_LEN: usize = 80;

/// `firstMessage.slice(0, 2000)` prompt-input cap (`ai-prompts.ts:57`).
const AI_FIRST_MESSAGE_MAX_LEN: usize = 2000;

/// `PROMPTS.sessionTitle.defaultPrompt` (`server/ai-prompts.ts:45-50`), line-joined.
const DEFAULT_SESSION_TITLE_PROMPT: &str = "Generate a title for a tab that contains the coding agent for this conversation.\nOnly the first word or two will show, so most specific and informative words first.\nE.g. if we're investigating a crash in freshell that happens when you mention sardines, \"Sardine crash investigation\" because sardine is specific, crash is less specific, and investigation is common to almost all tabs.\nReturn ONLY the title text. No quotes, no markdown, no explanation.";

/// `PROMPTS.sessionTitle.build(firstMessage, customPrompt)`
/// (`ai-prompts.ts:51-59`): a trimmed non-empty custom prompt replaces the
/// default instructions; the message rides below, capped at 2000 chars.
fn build_session_title_prompt(first_message: &str, custom_prompt: Option<&str>) -> String {
    let instructions = custom_prompt
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(DEFAULT_SESSION_TITLE_PROMPT);
    let message: String = first_message.chars().take(AI_FIRST_MESSAGE_MAX_LEN).collect();
    format!("{instructions}\n\nFirst message from the user:\n{message}")
}

/// The post-processing half of `generateAiSessionTitle` (`ai-title.ts:25-26`):
/// `(result.text || '').trim().slice(0, 80)` — empty after trimming is `null`.
fn finalize_ai_title_text(raw: &str) -> Option<String> {
    let trimmed: String = raw.trim().chars().take(AI_TITLE_MAX_LEN).collect();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// The `AI_CONFIG.enabled()` + `applySettingsKey` NET EFFECT
/// (`ai-prompts.ts:14-23`, call sites `server/index.ts:248` boot backfill and
/// `server/settings-router.ts:139` forced overwrite on settings save): a
/// Gemini key counts as configured when the env var is set non-empty OR the
/// persisted `ai.geminiApiKey` is set non-empty (the legacy call sites copy
/// the settings key INTO the env, so `enabled()`'s env-only check sees it).
/// The env value wins when both exist — the common post-boot state.
fn resolve_gemini_key(
    env: &(dyn freshell_platform::Env + Send + Sync),
    settings: &freshell_protocol::ServerSettings,
) -> Option<String> {
    env.get("GOOGLE_GENERATIVE_AI_API_KEY")
        .filter(|k| !k.is_empty())
        .or_else(|| {
            settings
                .ai
                .gemini_api_key
                .clone()
                .filter(|k| !k.is_empty())
        })
}

/// The live transport behind [`AiTitleGenerator`]
/// (`generateAiSessionTitle`'s `generateText({model, prompt,
/// maxOutputTokens})`, `ai-title.ts:15-27`): one `generateContent` POST
/// against the Gemini API with the key in the `x-goog-api-key` header (the
/// `@ai-sdk/google` default). [`build_session_title_prompt`] +
/// [`finalize_ai_title_text`] carry the exact pre/post-processing; only the
/// network shape is new.
pub fn gemini_ai_title_generator() -> AiTitleGenerator {
    Arc::new(
        |req: AiTitleRequest| -> std::pin::Pin<
            Box<dyn std::future::Future<Output = Result<Option<String>, String>> + Send>,
        > { Box::pin(async move { gemini_generate_title(&req).await }) },
    )
}

async fn gemini_generate_title(req: &AiTitleRequest) -> Result<Option<String>, String> {
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{AI_TITLE_MODEL}:generateContent"
    );
    let body = json!({
        "contents": [{ "parts": [{ "text": build_session_title_prompt(&req.first_message, req.custom_prompt.as_deref()) }] }],
        "generationConfig": { "maxOutputTokens": AI_TITLE_MAX_OUTPUT_TOKENS },
    });
    let response = reqwest::Client::new()
        .post(url)
        .header("x-goog-api-key", &req.api_key)
        .header("content-type", "application/json")
        .body(serde_json::to_string(&body).map_err(|e| e.to_string())?)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("Gemini API returned {}", response.status().as_u16()));
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    let payload: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    // Gemini generateContent shape: the first candidate's concatenated text
    // parts are the model output (the ai-sdk `result.text`).
    let text = payload
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|p| p.get("text").and_then(Value::as_str))
                .collect::<String>()
        })
        .unwrap_or_default();
    Ok(finalize_ai_title_text(&text))
}

/// `POST /api/sessions/:sessionId/generate-title` (`sessions-router.ts:167-241`)
/// — a blank `firstMessage` is the only 400 this emits (:174-176); everything
/// else resolves to `200`, never `5xx` (Global Constraint 8). Priority order:
/// 1. PROVIDER-GENERATED SHORT-CIRCUIT (:180-190): when the indexer's parsed
///    session for this key carries an authoritative provider-generated title
///    (e.g. Amplifier's own AI-generated name), respond with it and write
///    nothing — freshell never shadows it.
/// 2. AI/GEMINI (:224-241 + `ai-title.ts`): with a Gemini key configured,
///    generate via the injected transport and persist as source `'ai'`
///    through the title-source ladder. An empty model result is
///    `{title:null, source:'none'}`; a failure is `{title:null, source:'none',
///    error}` (`:236-240`), logged not thrown.
/// 3. FIRST-MESSAGE HEURISTIC (:193-201): no key — finalize from the first
///    user message (source `'first-message'`).
/// The response always reflects the STORED (ladder-resolved) title/source —
/// faithfully reflecting a ladder-blocked write (`:185-190`, `:235`).
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

    // Provider-authoritative short-circuit — BEFORE any AI/heuristic write.
    if let Some(index) = &state.session_index {
        let snapshot = index.snapshot().await;
        if let Some(parsed) = snapshot.iter().find(|s| s.key() == key) {
            if parsed.title_provider_generated {
                return Json(json!({
                    "title": parsed.title.clone().map(Value::from).unwrap_or(Value::Null),
                    "source": "provider-generated",
                }))
                .into_response();
            }
        }
    }

    let settings = state.settings.get().await;

    // AI path — `AI_CONFIG.enabled()` (+ the settings-key backfill);
    // `generateAiSessionTitle(firstMessage, settings.ai?.titlePrompt)`.
    if let Some(api_key) = resolve_gemini_key(state.env.as_ref(), &settings) {
        let Some(generator) = &state.ai_title_generator else {
            // Enabled but no transport wired: the empty-result shape.
            return Json(json!({ "title": null, "source": "none" })).into_response();
        };
        let request = AiTitleRequest {
            api_key,
            first_message: first_message.to_string(),
            custom_prompt: settings.ai.title_prompt.clone(),
        };
        return match generator(request).await {
            Ok(Some(title)) => {
                let stored = state
                    .settings
                    .patch_session_override(
                        &key,
                        &[
                            ("titleOverride", Some(json!(title))),
                            ("titleSource", Some(json!("ai"))),
                        ],
                    )
                    .await;
                // Respond with the STORED (ladder-resolved) value, faithfully.
                let title = stored.get("titleOverride").cloned().unwrap_or(Value::Null);
                let source = stored.get("titleSource").cloned().unwrap_or(json!("none"));
                Json(json!({ "title": title, "source": source })).into_response()
            }
            Ok(None) => Json(json!({ "title": null, "source": "none" })).into_response(),
            Err(err) => {
                tracing::warn!(error = %err, "sessions.generate_title.ai_failed");
                Json(json!({ "title": null, "source": "none", "error": err })).into_response()
            }
        };
    }

    let heuristic = extract_title_from_message(first_message, FIRST_MESSAGE_TITLE_LEN);
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

/// `basenameSegment` (`shared/path-basename.ts:11-22`): the last segment of a
/// path across BOTH separator families; trailing separators stripped; the Unix
/// root yields `"/"`, a Windows drive root yields `"C:\\"`; `None` when no
/// meaningful segment exists. Consumed by the auto-title decision fns below
/// (lines using `basename_segment(cwd)`) and their tests.
fn basename_segment(path: &str) -> Option<String> {
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() && path.starts_with('/') {
        return Some("/".into());
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Some(format!("{trimmed}\\"));
    }
    trimmed
        .split(['/', '\\'])
        .next_back()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `isFinalizedTitleSource` (`shared/title-source.ts:44-46`): any recorded
/// source other than the `dir` placeholder freezes the name against automatic
/// writers.
fn is_finalized_title_source(source: Option<&str>) -> bool {
    matches!(source, Some(s) if s != "dir")
}

/// The two fields of a stored session override the auto-title pass reads
/// (`existing?.titleOverride` / `existing?.titleSource`, `auto-title.ts`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ExistingTitleOverride<'a> {
    pub title_override: Option<&'a str>,
    pub title_source: Option<&'a str>,
}

/// The `SessionOverride` patch `computeAutoTitlePatch` returns
/// (`{titleOverride, titleSource}`, `auto-title.ts:37`/`:42`).
#[derive(Debug, Clone, PartialEq)]
pub struct AutoTitlePatch {
    pub title_override: String,
    pub title_source: &'static str,
}

/// `computeAutoTitlePatch` (`server/auto-title.ts:24-46`): a finalized name is
/// never touched; with AI auto-naming OFF a first user message finalizes as
/// `'first-message'` (upgrading a dir placeholder too); otherwise seed the
/// working-directory placeholder (source `'dir'`) when no override exists —
/// when AI WILL auto-name the dir placeholder is deliberately left in place
/// so the Gemini pass can finalize it as `'ai'`.
pub fn compute_auto_title_patch(
    cwd: Option<&str>,
    first_user_message: Option<&str>,
    existing: ExistingTitleOverride<'_>,
    ai_will_auto_name: bool,
) -> Option<AutoTitlePatch> {
    if is_finalized_title_source(existing.title_source) {
        return None;
    }

    if !ai_will_auto_name {
        if let Some(first) = first_user_message.filter(|m| !m.trim().is_empty()) {
            // Same default length as the client + generate-title route so the
            // displayed name never disagrees across surfaces (auto-title.ts:21-23).
            let title = extract_title_from_message(first, FIRST_MESSAGE_TITLE_LEN);
            if !title.is_empty() {
                return Some(AutoTitlePatch {
                    title_override: title,
                    title_source: "first-message",
                });
            }
        }
    }

    // JS `!existing?.titleOverride` — absent AND empty-string both reseed.
    if existing.title_override.map(str::is_empty).unwrap_or(true) {
        if let Some(cwd) = cwd {
            if let Some(segment) = basename_segment(cwd) {
                return Some(AutoTitlePatch {
                    title_override: segment,
                    title_source: "dir",
                });
            }
        }
    }

    None
}

/// The result of `computeSessionTitleSync` (`auto-title.ts:69-90`).
#[derive(Debug, Clone, PartialEq)]
pub struct SessionTitleSync {
    pub override_patch: Option<AutoTitlePatch>,
    pub canonical_title: Option<String>,
    pub terminal_ids_to_update: Vec<String>,
    pub should_generate_ai: bool,
}

/// `computeSessionTitleSync` (`server/auto-title.ts:61-91`): keep an active
/// coding-agent session's live terminals aligned with the canonical
/// (server-override) name — the override after this pass's dir/first-message
/// write, else the applyOverride'd session title — and decide whether the
/// Gemini auto-naming pass should fire (once per session; a finalized name or
/// a provider-generated parsed title suppresses it).
pub fn compute_session_title_sync(
    session_title: Option<&str>,
    existing: ExistingTitleOverride<'_>,
    cwd: Option<&str>,
    first_user_message: Option<&str>,
    ai_will_auto_name: bool,
    parsed_title_provider_generated: bool,
    terminals: &[(String, Option<String>)],
) -> SessionTitleSync {
    let override_patch =
        compute_auto_title_patch(cwd, first_user_message, existing, ai_will_auto_name);
    let canonical_title = override_patch
        .as_ref()
        .map(|p| p.title_override.clone())
        .or_else(|| session_title.map(str::to_string));

    let terminal_ids_to_update = match &canonical_title {
        Some(canonical) => terminals
            .iter()
            .filter(|(_, title)| title.as_deref() != Some(canonical.as_str()))
            .map(|(id, _)| id.clone())
            .collect(),
        None => Vec::new(),
    };

    let should_generate_ai = ai_will_auto_name
        && first_user_message
            .map(|m| !m.trim().is_empty())
            .unwrap_or(false)
        && !is_finalized_title_source(existing.title_source)
        && !parsed_title_provider_generated;

    SessionTitleSync {
        override_patch,
        canonical_title,
        terminal_ids_to_update,
        should_generate_ai,
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn state(dir: &std::path::Path) -> super::SessionsState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
        super::SessionsState {
            auth_token: std::sync::Arc::new("tok".into()),
            settings: crate::settings_store::SettingsStore::load(Some(dir), vec!["claude".into()]),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            registry: freshell_terminal::TerminalRegistry::new(),
            broadcast_tx: std::sync::Arc::new(tx),
            terminals_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            env: std::sync::Arc::new(freshell_platform::MapEnv::new()),
            ai_title_generator: None,
            session_index: None,
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

    /// Registers a REAL (but throwaway, immediately killable) terminal in the
    /// shared `TerminalRegistry` so the reverse cascade's registry
    /// write-through (`registry.update_title`) has an actual entry to mutate.
    /// `TerminalRegistry::insert_headless` (used by `freshell-terminal`'s own
    /// unit tests to avoid a real spawn) is private to that crate's test
    /// module, so this port spawns a minimal `sleep` child instead -- the
    /// caller is responsible for `registry.kill(terminal_id)` afterward.
    fn spawn_headless_terminal_for_test(
        registry: &freshell_terminal::TerminalRegistry,
        terminal_id: &str,
    ) {
        use freshell_platform::spawn::{SpawnSpec, DEFAULT_COLS, DEFAULT_ROWS};
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 5".into()],
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

    /// Reviewer finding (Important, commit d5cf534a): the REVERSE rename
    /// cascade (`cascadeSessionRenameToTerminal`, `rename-cascade.ts:39-50`,
    /// implemented in `patch_session` above) had ZERO positive-match test
    /// coverage -- reverting the entire cascade block still left all prior
    /// tests green, since they only covered the no-match case. This proves
    /// all FOUR effects a live match must produce: (a) the terminal's OWN
    /// override is written with the new title, (b) the in-memory registry
    /// title is updated (write-through, not just the on-disk override), (c) a
    /// `terminals.changed` broadcast fires, and (d) the response echoes the
    /// REAL `cascadedTerminalId` (not the always-null placeholder a prior
    /// version of this router emitted).
    #[tokio::test]
    async fn patch_rename_cascades_all_four_effects_to_a_live_terminal() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state(&dir);

        // A terminal currently running `claude:sess-live` (the session key
        // this PATCH targets) -- `find_by_session` needs a LIVE (non-retired)
        // match, and the registry write-through needs a REAL registered
        // terminal_id (`update_title` is a no-op against an unknown id).
        st.identity
            .upsert("term-live", Some("claude"), Some("sess-live"), None, 1000);
        spawn_headless_terminal_for_test(&st.registry, "term-live");

        // Subscribe BEFORE the PATCH so the `terminals.changed` send lands in
        // this receiver's buffer.
        let mut broadcast_rx = st.broadcast_tx.subscribe();

        let app = super::router(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/sess-live?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"titleOverride":"Renamed From Session"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;

        // (d) the REAL cascadedTerminalId, not null.
        assert_eq!(
            v["cascadedTerminalId"],
            serde_json::json!("term-live"),
            "response must echo the live terminal's id, not null"
        );

        // (a) the terminal's OWN override was written with the new title.
        let terminal_overrides = st.settings.terminal_overrides();
        let term_override = terminal_overrides
            .get("term-live")
            .expect("terminal override written by the reverse cascade");
        assert_eq!(
            term_override["titleOverride"],
            serde_json::json!("Renamed From Session")
        );

        // (b) the in-memory registry title was updated (write-through, not
        // just the on-disk override).
        let entry = st
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == "term-live")
            .expect("terminal present in the registry directory");
        assert_eq!(entry.title, "Renamed From Session");

        // (c) a `terminals.changed` broadcast fired.
        let frame = broadcast_rx
            .try_recv()
            .expect("terminals.changed broadcast fired");
        let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(frame["type"], serde_json::json!("terminals.changed"));

        st.registry.kill("term-live");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The reverse cascade's terminal lookup is LIVE-only (`.list()` via
    /// `find_by_session`, matching `deps.terminalMetadata.list()`,
    /// `sessions-router.ts:149`): a RETIRED (already-exited) terminal's
    /// session can still be renamed through this route, but the rename does
    /// NOT reach back into the exited terminal -- `cascadedTerminalId` stays
    /// `null`. This pins the live-only semantic against the OPPOSITE
    /// (terminal -> session) direction's `.get()`-based
    /// `rename_cascades_even_after_the_terminal_has_exited` test in
    /// `terminals.rs`, which deliberately DOES still cascade for a retired
    /// terminal -- the two directions are asymmetric on purpose.
    #[tokio::test]
    async fn patch_rename_to_a_retired_terminal_identity_does_not_cascade() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state(&dir);

        st.identity.upsert(
            "term-exited",
            Some("claude"),
            Some("sess-exited"),
            None,
            1000,
        );
        st.identity.retire("term-exited");

        let app = super::router(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/sess-exited?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"titleOverride":"Renamed After Exit"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;

        assert_eq!(v["cascadedTerminalId"], serde_json::Value::Null);
        assert_eq!(
            v["titleOverride"],
            serde_json::json!("Renamed After Exit"),
            "the session override itself still lands -- only the reach-back to the terminal is skipped"
        );
        assert!(
            st.settings.terminal_overrides().is_empty(),
            "no terminal override should be fabricated for a retired terminal"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// GAP-1 fix (reviewer Important, SESSION-09 follow-up): the periodic
    /// session-directory sweep (`spawn_sessions_sweep`, `main.rs`) is
    /// structurally blind to override-only changes -- its `(count, max
    /// lastActivityAt)` signature never moves for a title-override write,
    /// since `IndexedSession` carries no override fields at all. Legacy
    /// broadcasts `sessions.changed` on ANY sidebar-visible change (its
    /// differ, `projection.ts:23`, diffs the full comparable snapshot
    /// including `title`), so THIS write site must broadcast directly.
    /// Proves a rename PATCH produces exactly one `sessions.changed` frame
    /// with a positive, monotonic revision.
    #[tokio::test]
    async fn patch_rename_broadcasts_sessions_changed_with_increased_revision() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state(&dir);

        // Subscribe BEFORE the PATCH so the `sessions.changed` send lands in
        // this receiver's buffer.
        let mut broadcast_rx = st.broadcast_tx.subscribe();

        let app = super::router(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/abc123?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"titleOverride":"Renamed Session"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let frame = broadcast_rx
            .try_recv()
            .expect("sessions.changed broadcast fired for the rename override write");
        let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(frame["type"], serde_json::json!("sessions.changed"));
        let revision = frame["revision"].as_i64().expect("revision is a number");
        assert!(revision > 0, "revision must be a positive counter value");

        // Exactly one frame -- no duplicate/extra broadcast for a plain
        // rename (no live-terminal cascade in play here).
        assert!(
            broadcast_rx.try_recv().is_err(),
            "exactly one broadcast frame expected for a plain rename PATCH"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Companion to the rename case above: an archive toggle is exactly the
    /// kind of sidebar-visible, sweep-invisible change GAP-1 covers (the
    /// reviewer's own example). Also proves the revision counter is shared
    /// across successive PATCHes (strictly increasing, not reset per call).
    #[tokio::test]
    async fn patch_archive_broadcasts_sessions_changed_and_revision_is_monotonic() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state(&dir);
        let mut broadcast_rx = st.broadcast_tx.subscribe();

        let app = super::router(st.clone());
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/abc123?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"archived":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let first_frame = broadcast_rx
            .try_recv()
            .expect("sessions.changed broadcast fired for the archive override write");
        let first_frame: serde_json::Value = serde_json::from_str(&first_frame).unwrap();
        let first_revision = first_frame["revision"].as_i64().unwrap();

        // A second override write on the SAME state must bump the counter
        // further (shared, monotonic sequence -- not reset per request).
        let resp2 = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/abc123?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"archived":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp2.status(), StatusCode::OK);
        let second_frame = broadcast_rx
            .try_recv()
            .expect("sessions.changed broadcast fired for the second override write");
        let second_frame: serde_json::Value = serde_json::from_str(&second_frame).unwrap();
        let second_revision = second_frame["revision"].as_i64().unwrap();

        assert!(
            second_revision > first_revision,
            "revision must strictly increase across successive override writes"
        );

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
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
        let sessions_app = super::router(super::SessionsState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings: settings.clone(),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            registry: freshell_terminal::TerminalRegistry::new(),
            broadcast_tx: std::sync::Arc::new(tx),
            terminals_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            env: std::sync::Arc::new(freshell_platform::MapEnv::new()),
            ai_title_generator: None,
            session_index: None,
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
        // Batch B: the read model is backed by a `SessionIndex` now, not a
        // per-request `home: Option<PathBuf>` scan.
        let session_index =
            std::sync::Arc::new(freshell_sessions::directory_index::SessionIndex::new(vec![
                std::sync::Arc::new(freshell_sessions::directory_index::ClaudeSource::new(
                    crate::session_directory::claude_home(&home),
                ))
                    as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
            ]));
        let dir_app =
            crate::session_directory::router(crate::session_directory::SessionDirectoryState {
                auth_token: std::sync::Arc::clone(&auth_token),
                settings,
                session_index: Some(session_index),
                identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
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

    // ------------------------------------------------------------------
    // SESSION-04: provider-aware title + real AI-title behavior.
    // ------------------------------------------------------------------

    /// Build state with the AI/env/index seams explicitly set (the plain
    /// `state()` helper leaves all three inert, preserving every no-key test
    /// above).
    fn state_with_ai(
        dir: &std::path::Path,
        env: freshell_platform::MapEnv,
        generator: Option<super::AiTitleGenerator>,
        session_index: Option<
            std::sync::Arc<freshell_sessions::directory_index::SessionIndex>,
        >,
    ) -> super::SessionsState {
        let mut st = state(dir);
        st.env = std::sync::Arc::new(env);
        st.ai_title_generator = generator;
        st.session_index = session_index;
        st
    }

    /// A generator that records every request it receives, then resolves with
    /// the canned result — the deterministic fake-AI stand-in for the
    /// `generateAiSessionTitle` Gemini call.
    fn recording_generator(
        result: Result<Option<String>, String>,
        calls: std::sync::Arc<std::sync::Mutex<Vec<super::AiTitleRequest>>>,
    ) -> super::AiTitleGenerator {
        std::sync::Arc::new(
            move |req: super::AiTitleRequest| -> std::pin::Pin<
                Box<
                    dyn std::future::Future<Output = Result<Option<String>, String>>
                        + Send,
                >,
            > {
                let result = result.clone();
                let calls = std::sync::Arc::clone(&calls);
                Box::pin(async move {
                    calls.lock().expect("calls lock").push(req);
                    result
                })
            },
        )
    }

    /// A direct-listed `SessionSource` stub: hands the index a fixed session
    /// set (the parse layer is exercised elsewhere; this pins ROUTE behavior).
    struct StubSource {
        sessions: Vec<freshell_sessions::directory_index::IndexedSession>,
    }

    impl freshell_sessions::directory_index::SessionSource for StubSource {
        fn discover(&self) -> Vec<freshell_sessions::directory_index::FileStat> {
            Vec::new()
        }
        fn parse(
            &self,
            _path: &std::path::Path,
        ) -> Option<freshell_sessions::directory_index::IndexedSession> {
            None
        }
        fn direct_change_token(&self) -> Option<i64> {
            Some(0)
        }
        fn direct_list(
            &self,
        ) -> Result<Vec<freshell_sessions::directory_index::IndexedSession>, String> {
            Ok(self.sessions.clone())
        }
    }

    fn indexed_session(provider_generated: bool, title: Option<&str>) -> freshell_sessions::directory_index::IndexedSession {
        freshell_sessions::directory_index::IndexedSession {
            session_id: "prov-1".into(),
            provider: "claude".into(),
            project_path: "/tmp/proj".into(),
            title: title.map(str::to_string),
            title_provider_generated: provider_generated,
            summary: None,
            first_user_message: Some("Fix the login crash".into()),
            last_activity_at: 1_000,
            created_at: Some(1_000),
            cwd: Some("/tmp/proj".into()),
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    fn stub_index(
        sessions: Vec<freshell_sessions::directory_index::IndexedSession>,
    ) -> std::sync::Arc<freshell_sessions::directory_index::SessionIndex> {
        std::sync::Arc::new(freshell_sessions::directory_index::SessionIndex::new(vec![
            std::sync::Arc::new(StubSource { sessions })
                as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
        ]))
    }

    /// The full happy path the audit called missing: a configured Gemini key
    /// routes `generate-title` through the AI transport, persists the model's
    /// title as source `'ai'`, and responds with the stored value
    /// (`sessions-router.ts:224-235`).
    #[tokio::test]
    async fn generate_title_with_ai_key_calls_generator_and_stores_ai_source() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let st = state_with_ai(
            &dir,
            freshell_platform::MapEnv::new()
                .with("GOOGLE_GENERATIVE_AI_API_KEY", "sk-test"),
            Some(recording_generator(
                Ok(Some("Sardine crash investigation".to_string())),
                std::sync::Arc::clone(&calls),
            )),
            None,
        );
        let app = super::router(st);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"we are chasing a sardine crash"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::json!("Sardine crash investigation"));
        assert_eq!(v["source"], serde_json::json!("ai"));
        assert!(v.get("error").is_none(), "no error field on success");

        // The transport got the env key + the raw first message, with no
        // custom prompt configured.
        let recorded = calls.lock().expect("calls lock");
        assert_eq!(recorded.len(), 1);
        assert_eq!(recorded[0].api_key, "sk-test");
        assert_eq!(recorded[0].first_message, "we are chasing a sardine crash");
        assert_eq!(recorded[0].custom_prompt, None);
        drop(recorded);

        // Persisted through the ladder as source "ai".
        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            cfg["sessionOverrides"]["claude:abc"]["titleOverride"],
            serde_json::json!("Sardine crash investigation")
        );
        assert_eq!(
            cfg["sessionOverrides"]["claude:abc"]["titleSource"],
            serde_json::json!("ai")
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `settings.ai.titlePrompt` reaches the transport as `customPrompt`
    /// (`sessions-router.ts:227` passes `settings.ai?.titlePrompt`).
    #[tokio::test]
    async fn generate_title_passes_settings_title_prompt_to_the_transport() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let st = state_with_ai(
            &dir,
            freshell_platform::MapEnv::new().with("GOOGLE_GENERATIVE_AI_API_KEY", "sk-test"),
            Some(recording_generator(
                Ok(Some("Custom".to_string())),
                std::sync::Arc::clone(&calls),
            )),
            None,
        );
        st.settings
            .patch(&serde_json::json!({ "ai": { "titlePrompt": "Custom instructions" } }))
            .await
            .expect("settings patch ok");
        let app = super::router(st);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"hello there"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let recorded = calls.lock().expect("calls lock");
        assert_eq!(recorded.len(), 1);
        assert_eq!(
            recorded[0].custom_prompt,
            Some("Custom instructions".to_string())
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The `applySettingsKey` net effect: a persisted `ai.geminiApiKey` alone
    /// (env unset) enables the AI path (`ai-prompts.ts:17-23`,
    /// `server/index.ts:248`).
    #[tokio::test]
    async fn generate_title_settings_gemini_key_alone_enables_the_ai_path() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let st = state_with_ai(
            &dir,
            freshell_platform::MapEnv::new(), // env key deliberately UNSET
            Some(recording_generator(
                Ok(Some("From Settings Key".to_string())),
                std::sync::Arc::clone(&calls),
            )),
            None,
        );
        st.settings
            .patch(&serde_json::json!({ "ai": { "geminiApiKey": "sk-from-settings" } }))
            .await
            .expect("settings patch ok");
        let app = super::router(st);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"hello there"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["source"], serde_json::json!("ai"));
        let recorded = calls.lock().expect("calls lock");
        assert_eq!(recorded.len(), 1, "AI path fired without any env key");
        assert_eq!(recorded[0].api_key, "sk-from-settings");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// An empty/unusable model result is `{title:null, source:'none'}` and
    /// writes nothing (`ai-title.ts:26`, `sessions-router.ts:228-230`).
    #[tokio::test]
    async fn generate_title_ai_empty_result_returns_none_and_writes_nothing() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state_with_ai(
            &dir,
            freshell_platform::MapEnv::new().with("GOOGLE_GENERATIVE_AI_API_KEY", "sk-test"),
            Some(recording_generator(
                Ok(None),
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            )),
            None,
        );
        let app = super::router(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"hello"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::Value::Null);
        assert_eq!(v["source"], serde_json::json!("none"));
        assert!(
            st.settings.session_overrides().get("claude:abc").is_none(),
            "an empty model result must not persist any override"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A transport failure is `{title:null, source:'none', error}` at HTTP 200
    /// — NEVER 5xx (`sessions-router.ts:236-240`, Global Constraint 8).
    #[tokio::test]
    async fn generate_title_ai_failure_echoes_the_error_and_stays_200() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state_with_ai(
            &dir,
            freshell_platform::MapEnv::new().with("GOOGLE_GENERATIVE_AI_API_KEY", "sk-test"),
            Some(recording_generator(
                Err("quota exceeded".to_string()),
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            )),
            None,
        );
        let app = super::router(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"hello"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::Value::Null);
        assert_eq!(v["source"], serde_json::json!("none"));
        assert_eq!(v["error"], serde_json::json!("quota exceeded"));
        assert!(
            st.settings.session_overrides().get("claude:abc").is_none(),
            "a failed generation must not persist any override"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The AI write still passes through the title-source ladder: `user` (5)
    /// beats `ai` (4), so the response reflects the STORED user title
    /// (`sessions-router.ts:235` returns `stored.titleOverride/titleSource`).
    #[tokio::test]
    async fn generate_title_ai_write_is_ladder_blocked_by_a_user_rename() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state_with_ai(
            &dir,
            freshell_platform::MapEnv::new().with("GOOGLE_GENERATIVE_AI_API_KEY", "sk-test"),
            Some(recording_generator(
                Ok(Some("AI Name".to_string())),
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            )),
            None,
        );
        st.settings
            .patch_session_override(
                "claude:abc",
                &[
                    ("titleOverride", Some(serde_json::json!("User Named"))),
                    ("titleSource", Some(serde_json::json!("user"))),
                ],
            )
            .await;
        let app = super::router(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"hello"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::json!("User Named"));
        assert_eq!(v["source"], serde_json::json!("user"));
        let stored = st.settings.session_overrides();
        assert_eq!(
            stored
                .get("claude:abc")
                .and_then(|o| o.get("titleOverride"))
                .cloned(),
            Some(serde_json::json!("User Named")),
            "the user rename survives the AI attempt"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The reverse conflict order: `ai` (4) DOES upgrade a non-finalized
    /// `dir` placeholder (1).
    #[tokio::test]
    async fn generate_title_ai_upgrades_a_dir_placeholder() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state_with_ai(
            &dir,
            freshell_platform::MapEnv::new().with("GOOGLE_GENERATIVE_AI_API_KEY", "sk-test"),
            Some(recording_generator(
                Ok(Some("AI Upgraded".to_string())),
                std::sync::Arc::new(std::sync::Mutex::new(Vec::new())),
            )),
            None,
        );
        st.settings
            .patch_session_override(
                "claude:abc",
                &[
                    ("titleOverride", Some(serde_json::json!("proj"))),
                    ("titleSource", Some(serde_json::json!("dir"))),
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
                    .body(Body::from(r#"{"firstMessage":"hello"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::json!("AI Upgraded"));
        assert_eq!(v["source"], serde_json::json!("ai"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Enabled but with no transport wired (defensive): the empty-result
    /// shape, not a panic or 5xx.
    #[tokio::test]
    async fn generate_title_enabled_without_a_transport_returns_the_none_shape() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state_with_ai(
            &dir,
            freshell_platform::MapEnv::new().with("GOOGLE_GENERATIVE_AI_API_KEY", "sk-test"),
            None,
            None,
        );
        let app = super::router(st);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"hello"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::Value::Null);
        assert_eq!(v["source"], serde_json::json!("none"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Provider-authoritative priority (`sessions-router.ts:180-190`): a
    /// parsed provider-generated title is ALREADY canonical — the route
    /// responds with it, BEFORE the AI transport AND without persisting
    /// anything (no `'ai'` shadow write).
    #[tokio::test]
    async fn generate_title_provider_generated_title_short_circuits_all_writes() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let calls = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let st = state_with_ai(
            &dir,
            freshell_platform::MapEnv::new().with("GOOGLE_GENERATIVE_AI_API_KEY", "sk-test"),
            Some(recording_generator(
                Ok(Some("Should Never Ship".to_string())),
                std::sync::Arc::clone(&calls),
            )),
            Some(stub_index(vec![indexed_session(true, Some("Amplifier AI Name"))])),
        );
        let app = super::router(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/prov-1/generate-title?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"Fix the login crash"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::json!("Amplifier AI Name"));
        assert_eq!(v["source"], serde_json::json!("provider-generated"));
        assert!(
            calls.lock().expect("calls lock").is_empty(),
            "the Gemini transport must never run for a provider-generated title"
        );
        assert!(
            st.settings.session_overrides().get("claude:prov-1").is_none(),
            "no override write shadows the provider title"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The short-circuit is SCOPED to provider-generated sessions: a matched
    /// session WITHOUT that flag flows into the normal (no-key first-message)
    /// path.
    #[tokio::test]
    async fn generate_title_non_provider_generated_match_falls_through() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state_with_ai(
            &dir,
            freshell_platform::MapEnv::new(),
            None,
            Some(stub_index(vec![indexed_session(false, Some("Parsed Title"))])),
        );
        let app = super::router(st);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/prov-1/generate-title?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"Fix the login crash"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::json!("Fix the login crash"));
        assert_eq!(v["source"], serde_json::json!("first-message"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// `finalize_ai_title_text` (`ai-title.ts:25-26`): trim, 80-char cap,
    /// empty → none.
    #[test]
    fn finalize_ai_title_text_trims_caps_and_nulls_empty() {
        assert_eq!(
            super::finalize_ai_title_text("  Hello there  "),
            Some("Hello there".to_string())
        );
        assert_eq!(
            super::finalize_ai_title_text(&"x".repeat(100)),
            Some("x".repeat(super::AI_TITLE_MAX_LEN))
        );
        assert_eq!(super::finalize_ai_title_text("   "), None);
        assert_eq!(super::finalize_ai_title_text(""), None);
    }

    /// `PROMPTS.sessionTitle.build` (`ai-prompts.ts:51-59`): default
    /// instructions + a 2000-char message cap.
    #[test]
    fn build_session_title_prompt_uses_default_and_caps_the_message() {
        let prompt = super::build_session_title_prompt("short message", None);
        assert!(prompt.starts_with("Generate a title for a tab"));
        assert!(prompt.ends_with("\n\nFirst message from the user:\nshort message"));

        let long = "m".repeat(3000);
        let prompt = super::build_session_title_prompt(&long, None);
        assert!(prompt.ends_with(&format!(
            "First message from the user:\n{}",
            "m".repeat(super::AI_FIRST_MESSAGE_MAX_LEN)
        )));
    }

    /// A custom prompt replaces the default WHEN it trims non-empty
    /// (`customPrompt?.trim() || defaultPrompt`).
    #[test]
    fn build_session_title_prompt_custom_prompt_trimmed_or_default() {
        let prompt = super::build_session_title_prompt("msg", Some("  Be terse. \n"));
        assert!(prompt.starts_with("Be terse."));
        assert!(!prompt.contains("Generate a title for a tab"));

        let prompt = super::build_session_title_prompt("msg", Some("   "));
        assert!(prompt.starts_with("Generate a title for a tab"));
    }

    /// `basenameSegment` (`shared/path-basename.ts:11-22`) edge cases — both
    /// separator families, trailing separators, unix root, drive root.
    #[test]
    fn basename_segment_matches_the_shared_edge_cases() {
        assert_eq!(super::basename_segment("/"), Some("/".into()));
        assert_eq!(super::basename_segment("C:\\"), Some("C:\\".into()));
        assert_eq!(super::basename_segment("/a/b/"), Some("b".into()));
        assert_eq!(super::basename_segment("a\\b"), Some("b".into()));
        assert_eq!(super::basename_segment("/a/b/c"), Some("c".into()));
        assert_eq!(super::basename_segment("solo"), Some("solo".into()));
        assert_eq!(super::basename_segment(""), None);
    }

    /// `computeAutoTitlePatch` (`auto-title.ts:24-46): a finalized name (user /
    /// ai / first-message / legacy) is never touched by the auto pass.
    #[test]
    fn auto_title_patch_never_touches_a_finalized_name() {
        for source in ["user", "ai", "first-message", "legacy"] {
            let existing = super::ExistingTitleOverride {
                title_override: Some("Kept"),
                title_source: Some(source),
            };
            assert_eq!(
                super::compute_auto_title_patch(
                    Some("/work/proj"),
                    Some("a fresh first message"),
                    existing,
                    false,
                ),
                None,
                "source {source} is finalized"
            );
        }
    }

    /// With AI auto-naming OFF, the first user message finalizes the name as
    /// `'first-message'` (and upgrades a dir placeholder).
    #[test]
    fn auto_title_patch_finalizes_from_first_message_when_ai_is_off() {
        let none = super::ExistingTitleOverride {
            title_override: None,
            title_source: None,
        };
        let patch = super::compute_auto_title_patch(
            Some("/work/proj"),
            Some("Fix the crash\nwith detail"),
            none,
            false,
        )
        .expect("first-message patch");
        assert_eq!(patch.title_override, "Fix the crash");
        assert_eq!(patch.title_source, "first-message");

        let dir_placeholder = super::ExistingTitleOverride {
            title_override: Some("proj"),
            title_source: Some("dir"),
        };
        let patch = super::compute_auto_title_patch(
            Some("/work/proj"),
            Some("Fix the crash"),
            dir_placeholder,
            false,
        )
        .expect("dir placeholder upgrades");
        assert_eq!(patch.title_source, "first-message");
    }

    /// With AI auto-naming ON the first message does NOT finalize; the pass
    /// deliberately leaves the dir placeholder in place for the Gemini path.
    #[test]
    fn auto_title_patch_leaves_the_dir_placeholder_for_the_gemini_path() {
        let none = super::ExistingTitleOverride {
            title_override: None,
            title_source: None,
        };
        let patch = super::compute_auto_title_patch(
            Some("/work/proj"),
            Some("Fix the crash"),
            none,
            true, // aiWillAutoName
        )
        .expect("dir placeholder seeded, not first-message");
        assert_eq!(patch.title_source, "dir");
        assert_eq!(patch.title_override, "proj");
    }

    /// No first message + no existing override + a cwd: seed the basename as
    /// the `'dir'` placeholder — exactly once (an existing placeholder is not
    /// rewritten).
    #[test]
    fn auto_title_patch_seeds_the_dir_placeholder_exactly_once() {
        let none = super::ExistingTitleOverride {
            title_override: None,
            title_source: None,
        };
        let patch = super::compute_auto_title_patch(Some("/work/my-proj/"), None, none, true)
            .expect("dir patch");
        assert_eq!(patch.title_override, "my-proj");
        assert_eq!(patch.title_source, "dir");

        let already = super::ExistingTitleOverride {
            title_override: Some("my-proj"),
            title_source: Some("dir"),
        };
        assert_eq!(
            super::compute_auto_title_patch(Some("/work/other"), None, already, true),
            None,
            "an existing placeholder is never rewritten"
        );

        assert_eq!(
            super::compute_auto_title_patch(None, None, none, true),
            None,
            "no cwd → no placeholder"
        );
    }

    /// `computeSessionTitleSync` (`auto-title.ts:61-91`): the dir/first-message
    /// patch becomes the canonical title and every out-of-sync terminal is
    /// pushed; terminals already aligned are untouched; an UNTITLED terminal
    /// (JS `undefined !== canonicalTitle`) is pushed too.
    #[test]
    fn session_title_sync_pushes_every_out_of_sync_terminal() {
        let none = super::ExistingTitleOverride {
            title_override: None,
            title_source: None,
        };
        let sync = super::compute_session_title_sync(
            Some("Old Parsed Title"),
            none,
            Some("/work/proj"),
            Some("Fix the crash"),
            false, // aiWillAutoName → first-message finalizes
            false,
            &[
                ("t-aligned".into(), Some("Fix the crash".into())),
                ("t-stale".into(), Some("Old Parsed Title".into())),
                ("t-untitled".into(), None),
            ],
        );
        assert_eq!(sync.canonical_title.as_deref(), Some("Fix the crash"));
        assert_eq!(
            sync.override_patch.as_ref().map(|p| p.title_source),
            Some("first-message")
        );
        assert_eq!(
            sync.terminal_ids_to_update,
            vec!["t-stale".to_string(), "t-untitled".to_string()]
        );

        // No patch + no session title → NO terminal pushes at all
        // (`canonicalTitle` undefined short-circuits the filter).
        let sync = super::compute_session_title_sync(None, none, None, None, false, false, &[]);
        assert_eq!(sync.canonical_title, None);
        assert!(sync.terminal_ids_to_update.is_empty());
        assert_eq!(sync.override_patch, None);
    }

    /// `shouldGenerateAi` is the conjunction of ALL of: aiWillAutoName, a
    /// non-blank first message, an unfinalized override, and a parsed title
    /// that is NOT provider-generated (`auto-title.ts:84-88`).
    #[test]
    fn session_title_sync_should_generate_ai_conjunction() {
        let none = super::ExistingTitleOverride {
            title_override: None,
            title_source: None,
        };
        fn base(
            ai_will: bool,
            message: Option<&str>,
            existing: super::ExistingTitleOverride<'_>,
            provider_generated: bool,
        ) -> bool {
            super::compute_session_title_sync(
                Some("t"),
                existing,
                Some("/work/proj"),
                message,
                ai_will,
                provider_generated,
                &[],
            )
            .should_generate_ai
        }

        assert!(base(true, Some("hello"), none, false), "all conditions met");
        assert!(!base(false, Some("hello"), none, false), "aiWillAutoName off");
        assert!(!base(true, Some("   "), none, false), "blank message");
        assert!(!base(true, None, none, false), "no message");
        let finalized = super::ExistingTitleOverride {
            title_override: Some("Kept"),
            title_source: Some("user"),
        };
        assert!(!base(true, Some("hello"), finalized, false), "finalized override");
        assert!(
            !base(true, Some("hello"), none, true),
            "provider-generated parsed title suppresses the Gemini pass"
        );
    }

    fn uuid_like() -> String {
        format!("{}-{:?}", std::process::id(), std::time::SystemTime::now())
            .replace([':', '.', ' '], "-")
    }
}
