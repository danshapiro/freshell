//! `/api/sessions/:sessionId` — session rename/archive/delete overrides and
//! AI/first-message title generation. Faithful port of the write half of
//! `server/sessions-router.ts` (`PATCH` :122-165, `POST generate-title` :167-210),
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
    /// Task 6: the process-local Gemini key cell -- `generate_title` gates its
    /// AI branch on key presence ONLY, never on
    /// `settings.sidebar.autoGenerateTitles` (that gate belongs exclusively to
    /// the background sweep; real Node asymmetry, Scope Decision 7,
    /// `sessions-router.ts:181-184`).
    pub ai_key: crate::ai_title::AiKeyCell,
    /// Trait-injected Gemini transport (same seam as
    /// `AutoTitleSweepState.gemini`) so tests fake the wire -- no live calls.
    pub gemini: Arc<dyn crate::ai_title::GeminiTransport>,
    /// The shared session index, consulted ONLY for the provider-generated
    /// short-circuit (`sessions-router.ts:186-192`). `None` when no provider
    /// home resolves (the same `Option` main.rs threads everywhere else).
    pub index: Option<Arc<freshell_sessions::directory_index::SessionIndex>>,
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
        broadcast_sessions_changed_from(&state);
    }

    Json(Value::Object(out)).into_response()
}

/// The one `sessions.changed` emit site (revision bump + frame send), factored
/// from `patch_session` so the generate-title write paths (heuristic + AI)
/// share it exactly (D11: Node reaches the equivalent broadcast via
/// `codingCliIndexer.refresh()` -> sessionsSync publish).
fn broadcast_sessions_changed_from(state: &SessionsState) {
    let revision = state
        .sessions_revision
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let frame = json!({ "type": "sessions.changed", "revision": revision }).to_string();
    let _ = state.broadcast_tx.send(frame);
}

/// Snapshot the shared index (same accessor as the sweeps) and find the
/// session whose `provider:sessionId` key equals `key`.
async fn lookup_indexed_session(
    index: &freshell_sessions::directory_index::SessionIndex,
    key: &str,
) -> Option<freshell_sessions::directory_index::IndexedSession> {
    let items = index.snapshot().await;
    items.iter().find(|s| s.key() == key).cloned()
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
/// resolves to `200`, never `5xx` (Global Constraint 8). Resolution order
/// (`sessions-router.ts:180-221`): (1) a parsed session whose `titleSource` is
/// `provider-generated` short-circuits with the parsed title — NO write, no
/// broadcast; (2) no AI key → the first-message heuristic, persisted through
/// the title-source ladder; (3) key present → Gemini via the injected
/// transport, persisted as `titleSource:'ai'` through the ladder (`Ok(None)`
/// → `{title:null,source:'none'}` with no write; `Err` → 200
/// `{title:null,source:'none',error}` with no write). Deliberately NOT gated
/// on `settings.sidebar.autoGenerateTitles` (real Node asymmetry, Scope
/// Decision 7) — key presence alone selects the AI branch. Both write paths
/// broadcast `sessions.changed` after the write (D11: Node reaches this via
/// `codingCliIndexer.refresh()`), and both respond with the STORED
/// (ladder-resolved) title/source — faithfully reflecting a ladder-blocked
/// write (`sessions-router.ts:185-190`).
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

    // (1) provider-generated short-circuit (`sessions-router.ts:186-192`): a
    // session whose PARSED title is provider-authored is never renamed by
    // this route -- echo the parsed title; no write, no broadcast.
    if let Some(index) = &state.index {
        if let Some(parsed) = lookup_indexed_session(index, &key).await {
            if parsed.title_source.as_deref() == Some("provider-generated") {
                return Json(json!({
                    "title": parsed.title.clone().map(Value::from).unwrap_or(Value::Null),
                    "source": "provider-generated",
                }))
                .into_response();
            }
        }
    }

    if !state.ai_key.enabled() {
        // (2) AI disabled: the first-message heuristic (`sessions-router.ts:196-209`).
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
        broadcast_sessions_changed_from(&state);
        // Respond with the STORED (ladder-resolved) value, faithfully.
        let title = stored.get("titleOverride").cloned().unwrap_or(Value::Null);
        let source = stored.get("titleSource").cloned().unwrap_or(json!("none"));
        Json(json!({ "title": title, "source": source })).into_response()
    } else {
        // (3) AI enabled -- key presence ONLY (Scope Decision 7; the
        // `autoGenerateTitles` toggle never gates this route).
        let custom_prompt = state.settings.get().await.ai.title_prompt;
        match crate::ai_title::generate_ai_session_title(
            &*state.gemini,
            first_message,
            custom_prompt.as_deref(),
        )
        .await
        {
            Ok(None) => Json(json!({ "title": null, "source": "none" })).into_response(),
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
                broadcast_sessions_changed_from(&state);
                Json(json!({
                    "title": stored.get("titleOverride").cloned().unwrap_or(Value::Null),
                    "source": stored.get("titleSource").cloned().unwrap_or(Value::Null),
                }))
                .into_response()
            }
            Err(e) => Json(json!({ "title": null, "source": "none", "error": e })).into_response(),
        }
    }
}

#[cfg(test)]
#[path = "sessions_tests.rs"]
mod tests;
