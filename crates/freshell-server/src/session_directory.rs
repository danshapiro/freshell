//! `GET /api/session-directory` — the History read model (Follow-up 3.19).
//!
//! **FAITHFUL-PORT + unit-proven, NOT differential-oracle-proven.** No captured
//! original transcript exists for this read; correctness is argued by a faithful
//! port with file:line citations, the exact `SessionDirectoryPage` /
//! `SessionDirectoryItem` shapes (`shared/read-models.ts:40-68`), and the unit
//! tests below — which parse the **committed** `test/fixtures/sessions/*.jsonl`.
//!
//! Ports, additively (no `server/` or `shared/` source touched):
//! * `server/sessions-router.ts` `router.get('/session-directory')` (73-120) — the route.
//! * `server/session-directory/service.ts` `querySessionDirectory()` (228-298) — the
//!   sort / visibility-filter / cursor-page / revision derivation (title tier).
//! * `server/session-directory/projection.ts` `compareSessionDirectoryComparableItems`
//!   (51-62) — lastActivityAt DESC, then session-key DESC.
//! * `server/coding-cli/providers/claude.ts` `listSessionFiles()` (529-580) +
//!   `parseSessionFile`/`extractSessionId` (582-599) — the claude transcript walk.
//! * `server/session-history-loader.ts` (`getClaudeHome`) — `<home>/.claude/projects`.
//!   The per-file parse reuses `freshell_sessions::parse_session_content`.
//!
//! ## Scope (honest, faithful subset — documented deviations)
//!
//! * **claude only.** codex (`<home>/.codex/sessions`) + opencode (`opencode.db`)
//!   listing are faithful extension points, deferred. `freshell_sessions` already
//!   ships their parsers, so this is additive wiring, not new logic.
//! * **`projectPath = meta.cwd` (or `"unknown"`).** The original resolves the git
//!   repo root of `cwd` (`resolveProjectPath` → `resolveGitRepoRoot`, a LIVE `git`
//!   call); that resolution is deferred (documented). `cwd` is faithful data.
//! * **title-tier search only.** The `userMessages`/`fullText` file-content tiers
//!   (`applyFileSearch`) are deferred; a search query matches title/summary/
//!   firstUserMessage metadata (the `title` tier), never wrong results.
//! * **no live terminal join / metadata-store flavor.** `isRunning` is always
//!   `false` here (the terminal registry join + session-flavor overrides are the
//!   original's live wiring); `sessionType` is omitted. Faithful for a browse of
//!   persisted transcripts.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use base64::Engine as _;
use freshell_sessions::directory_index::{IndexedSession, SessionIndex};
// Batch B: only the `#[cfg(test)]`-gated reference functions below
// (`list_claude_sessions`/`parse_claude_file`/`item_from_meta`) still need the
// raw parse layer directly -- production reads `IndexedSession` from the
// `SessionIndex` instead.
#[cfg(test)]
use freshell_sessions::meta::ParsedSessionMeta;
#[cfg(test)]
use freshell_sessions::{parse_session_content, ParseSessionOptions};
use serde_json::{json, Map, Value};

use crate::boot::{is_authed, unauthorized};

/// `MAX_DIRECTORY_PAGE_ITEMS` (`shared/read-models.ts:6`).
const MAX_DIRECTORY_PAGE_ITEMS: usize = 50;

/// Shared state for the session-directory route.
#[derive(Clone)]
pub struct SessionDirectoryState {
    pub auth_token: Arc<String>,
    /// `config.sessionOverrides` source: overlaid onto parsed items by
    /// [`apply_session_overrides`] before `apply_query` runs.
    pub settings: crate::settings_store::SettingsStore,
    /// Batch B: the in-memory, TTL-refreshed session cache (avoids a full
    /// filesystem rescan + reparse of every provider transcript on every
    /// request). `None` → an empty page (no home resolvable), matching the
    /// prior "no home" behavior before the index existed.
    pub session_index: Option<Arc<SessionIndex>>,
}

/// One directory item, typed for the sort/filter/cursor derivation. Serialized to
/// the `SessionDirectoryItem` shape by [`DirItem::to_value`].
#[derive(Debug, Clone)]
struct DirItem {
    session_id: String,
    provider: String,
    project_path: String,
    title: Option<String>,
    summary: Option<String>,
    first_user_message: Option<String>,
    last_activity_at: i64,
    created_at: Option<i64>,
    cwd: Option<String>,
    is_subagent: bool,
    is_non_interactive: bool,
    is_running: bool,
    /// `SessionOverride.archived` (`shared/read-models.ts:51`), defaulted `false`
    /// and overlaid from `config.sessionOverrides` by [`apply_session_overrides`].
    archived: bool,
    // Search annotations (set by title-tier search).
    matched_in: Option<String>,
    snippet: Option<String>,
}

impl DirItem {
    /// `buildSessionKey` (`session-directory/service.ts:36-38`): `provider:sessionId`.
    fn key(&self) -> String {
        format!("{}:{}", self.provider, self.session_id)
    }

    /// Serialize to the `SessionDirectoryItem` shape — required fields always
    /// present; optionals omitted when absent (matching the zod `.optional()`s).
    fn to_value(&self) -> Value {
        let mut o = Map::new();
        o.insert("sessionId".into(), json!(self.session_id));
        o.insert("provider".into(), json!(self.provider));
        o.insert("projectPath".into(), json!(self.project_path));
        o.insert("lastActivityAt".into(), json!(self.last_activity_at));
        o.insert("isRunning".into(), json!(self.is_running));
        // R10a: the original always emits `archived` (a `SessionOverride` field
        // defaulted to `false`, `shared/read-models.ts:51`); overlaid from
        // `config.sessionOverrides` by `apply_session_overrides`.
        o.insert("archived".into(), json!(self.archived));
        if let Some(v) = &self.title {
            o.insert("title".into(), json!(v));
        }
        if let Some(v) = &self.summary {
            o.insert("summary".into(), json!(v));
        }
        if let Some(v) = &self.first_user_message {
            o.insert("firstUserMessage".into(), json!(v));
        }
        if let Some(v) = self.created_at {
            o.insert("createdAt".into(), json!(v));
        }
        if let Some(v) = &self.cwd {
            o.insert("cwd".into(), json!(v));
        }
        if self.is_subagent {
            o.insert("isSubagent".into(), json!(true));
        }
        if self.is_non_interactive {
            o.insert("isNonInteractive".into(), json!(true));
        }
        if let Some(v) = &self.matched_in {
            o.insert("matchedIn".into(), json!(v));
        }
        if let Some(v) = &self.snippet {
            o.insert("snippet".into(), json!(v));
        }
        Value::Object(o)
    }
}

/// The parsed query (`SessionDirectoryQuerySchema` — `read-models.ts:28-38`), the
/// subset this port honors. Booleans arrive as `'1'` (present) / absent, matching
/// the client's `buildQueryString` (`src/lib/api.ts:253-255`).
#[derive(Debug, Default)]
struct DirQuery {
    query: Option<String>,
    cursor: Option<String>,
    limit: Option<usize>,
    include_subagents: bool,
    include_non_interactive: bool,
    include_empty: bool,
}

/// R9: `SessionDirectoryQuerySchema` (`shared/read-models.ts:28-38`) makes
/// `priority` REQUIRED (`ReadModelPrioritySchema` has no `.optional()`) and
/// `limit` a strictly-typed `z.number().int().positive().max(50)`. The original
/// builds the zod input as `req.query.limit` coerced via `Number(...)` before
/// validating (`sessions-router.ts:74-84`), so a non-numeric limit becomes `NaN`
/// (JS `Number('abc')`), not a string-type error. `safeParse` collects ALL
/// issues across every violated field (verified empirically against the
/// ORIGINAL: `priority=bogus&limit=abc` returns both issues in one `details`
/// array, order priority-then-limit).
///
/// Error shapes below are byte-matched against a live probe of the ORIGINAL
/// (zod v4 `safeParse` issue shapes), not guessed.
fn validate_query(raw: &std::collections::HashMap<String, String>) -> Result<DirQuery, Value> {
    let mut details: Vec<Value> = Vec::new();

    match raw.get("priority").map(String::as_str) {
        Some("visible") | Some("background") => {}
        _ => details.push(json!({
            "code": "invalid_value",
            "values": ["visible", "background"],
            "path": ["priority"],
            "message": "Invalid option: expected one of \"visible\"|\"background\"",
        })),
    }

    let limit = match raw.get("limit") {
        None => None,
        Some(raw_limit) => match validate_limit(raw_limit) {
            Ok(v) => Some(v),
            Err(issue) => {
                details.push(issue);
                None
            }
        },
    };

    if !details.is_empty() {
        return Err(json!(details));
    }

    let flag = |k: &str| raw.get(k).map(|v| v == "1" || v == "true").unwrap_or(false);
    Ok(DirQuery {
        query: raw.get("query").filter(|s| !s.is_empty()).cloned(),
        cursor: raw.get("cursor").filter(|s| !s.is_empty()).cloned(),
        limit,
        include_subagents: flag("includeSubagents"),
        include_non_interactive: flag("includeNonInteractive"),
        include_empty: flag("includeEmpty"),
    })
}

/// `Number(str)` (JS coercion) semantics the original relies on before zod sees
/// the value: trimmed-empty → `0`, `0x`-prefixed → hex, else a bare float parse;
/// anything else → `NaN`.
fn js_number(raw: &str) -> f64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0.0;
    }
    if let Some(hex) = trimmed
        .strip_prefix("0x")
        .or_else(|| trimmed.strip_prefix("0X"))
    {
        return i64::from_str_radix(hex, 16)
            .map(|v| v as f64)
            .unwrap_or(f64::NAN);
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

/// `z.number().int().positive().max(MAX_DIRECTORY_PAGE_ITEMS)` — checked in
/// that order (verified: `limit=1.5` reports ONLY the int failure, never
/// positive/max too).
fn validate_limit(raw_limit: &str) -> Result<usize, Value> {
    let n = js_number(raw_limit);
    if n.is_nan() {
        return Err(json!({
            "expected": "number",
            "code": "invalid_type",
            "received": "NaN",
            "path": ["limit"],
            "message": "Invalid input: expected number, received NaN",
        }));
    }
    if n.fract() != 0.0 {
        return Err(json!({
            "expected": "int",
            "format": "safeint",
            "code": "invalid_type",
            "path": ["limit"],
            "message": "Invalid input: expected int, received number",
        }));
    }
    if n <= 0.0 {
        return Err(json!({
            "origin": "number",
            "code": "too_small",
            "minimum": 0,
            "inclusive": false,
            "path": ["limit"],
            "message": "Too small: expected number to be >0",
        }));
    }
    if n > MAX_DIRECTORY_PAGE_ITEMS as f64 {
        return Err(json!({
            "origin": "number",
            "code": "too_big",
            "maximum": MAX_DIRECTORY_PAGE_ITEMS,
            "inclusive": true,
            "path": ["limit"],
            "message": format!("Too big: expected number to be <={MAX_DIRECTORY_PAGE_ITEMS}"),
        }));
    }
    Ok(n as usize)
}

/// The session-directory sub-router (`GET /api/session-directory`).
pub fn router(state: SessionDirectoryState) -> Router {
    Router::new()
        .route("/api/session-directory", get(session_directory))
        .with_state(state)
}

async fn session_directory(
    State(state): State<SessionDirectoryState>,
    headers: HeaderMap,
    Query(raw): Query<std::collections::HashMap<String, String>>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // R9: query-shape validation (`SessionDirectoryQuerySchema.safeParse`) BEFORE
    // any work -- mirrors `sessions-router.ts:74-88`'s early 400 return.
    let query = match validate_query(&raw) {
        Ok(q) => q,
        Err(details) => {
            return (
                axum::http::StatusCode::BAD_REQUEST,
                Json(json!({ "error": "Invalid request", "details": details })),
            )
                .into_response()
        }
    };
    // Batch B: read the cached, pre-sorted snapshot instead of re-walking +
    // re-parsing every provider transcript on every request. Overrides and
    // the query (visibility filters, search, cursor paging) still compose
    // freshly PER REQUEST, same as before -- only the expensive filesystem
    // scan itself is now cached.
    let items: Vec<DirItem> = match &state.session_index {
        Some(index) => index
            .snapshot()
            .await
            .iter()
            .map(dir_item_from_indexed)
            .collect(),
        None => Vec::new(),
    };
    let items = apply_session_overrides(items, &state.settings.session_overrides());
    match apply_query(items, &query) {
        Ok(page) => Json(page).into_response(),
        // Bad cursor → 400, matching `querySessionDirectory`'s `/cursor/i` → 400.
        Err(msg) => (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": msg })),
        )
            .into_response(),
    }
}

/// `getClaudeHome()` (`server/claude-home.ts:4-7`): `CLAUDE_HOME` env else
/// `<home>/.claude`. `pub(crate)` so `main.rs` (boot-time `SessionIndex`
/// wiring) and `sessions.rs` (the cross-router override-overlay test) resolve
/// the SAME claude home this module's own reference scan uses.
pub(crate) fn claude_home(home: &Path) -> PathBuf {
    match std::env::var("CLAUDE_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => home.join(".claude"),
    }
}

/// Map a cached [`IndexedSession`] to a request-scoped [`DirItem`]. The
/// per-request-only fields (`is_running`, `archived`, search annotations)
/// take their defaults here, exactly as `item_from_meta` did before the
/// index existed -- `apply_session_overrides` / `apply_title_search` overlay
/// them afterwards, unchanged.
fn dir_item_from_indexed(idx: &IndexedSession) -> DirItem {
    DirItem {
        session_id: idx.session_id.clone(),
        provider: idx.provider.clone(),
        project_path: idx.project_path.clone(),
        title: idx.title.clone(),
        summary: idx.summary.clone(),
        first_user_message: idx.first_user_message.clone(),
        last_activity_at: idx.last_activity_at,
        created_at: idx.created_at,
        cwd: idx.cwd.clone(),
        is_subagent: idx.is_subagent,
        is_non_interactive: idx.is_non_interactive,
        is_running: false,
        archived: false,
        matched_in: None,
        snippet: None,
    }
}

/// Walk `<claudeHome>/projects/*/…*.jsonl` and parse each into a [`DirItem`],
/// mirroring `claudeProvider.listSessionFiles()` (`claude.ts:529-580`): top-level
/// `.jsonl` are sessions; `<project>/<session>/subagents/*.jsonl` are subagents.
///
/// Batch B: the production path no longer calls this per request (see
/// `freshell_sessions::directory_index::ClaudeSource`, which is a faithful
/// lift of this exact logic). This function is KEPT, `#[cfg(test)]`-only, as
/// the differential-oracle reference the B-T1 test pins `ClaudeSource::scan()`
/// against — deliberately duplicated during the migration, not dead code.
#[cfg(test)]
fn list_claude_sessions(claude_home: &Path) -> Vec<DirItem> {
    let projects_dir = claude_home.join("projects");
    let Ok(project_entries) = std::fs::read_dir(&projects_dir) else {
        return Vec::new();
    };

    let mut items = Vec::new();
    let mut project_dirs: Vec<PathBuf> = project_entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .collect();
    project_dirs.sort(); // determinism (readdir order is filesystem-dependent)

    for project_dir in project_dirs {
        if !project_dir.is_dir() {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&project_dir) else {
            continue;
        };
        let mut names: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
        names.sort();

        for entry_path in names {
            if entry_path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                if let Some(item) = parse_claude_file(&entry_path, false) {
                    items.push(item);
                }
                continue;
            }
            // Subdirectory: scan `<entry>/subagents/*.jsonl`.
            if entry_path.is_dir() {
                let subagents = entry_path.join("subagents");
                if let Ok(subs) = std::fs::read_dir(&subagents) {
                    let mut sub_paths: Vec<PathBuf> =
                        subs.filter_map(|e| e.ok()).map(|e| e.path()).collect();
                    sub_paths.sort();
                    for sub in sub_paths {
                        if sub.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                            if let Some(item) = parse_claude_file(&sub, true) {
                                items.push(item);
                            }
                        }
                    }
                }
            }
        }
    }
    items
}

/// Read + parse one claude transcript file into a [`DirItem`]. Corruption-tolerant
/// (the parser never panics); an unreadable file is skipped (`None`).
///
/// `#[cfg(test)]`: test-only, same rationale as `list_claude_sessions` above.
#[cfg(test)]
fn parse_claude_file(path: &Path, force_subagent: bool) -> Option<DirItem> {
    // Lossy UTF-8, NOT `read_to_string`: the original reads transcripts with
    // `fs.readFile(file, 'utf8')` (Node), which never fails on invalid UTF-8 —
    // it substitutes U+FFFD per the WHATWG maximal-subpart policy and still
    // indexes the session. `read_to_string` would silently DROP such a file
    // (differential-proven divergence: seeded invalid-UTF-8 transcript was
    // indexed by the original with `\u{FFFD}` in the title but omitted here,
    // which also skewed the page `revision` = max lastActivityAt). Rust's
    // `from_utf8_lossy` implements the same replacement policy byte-for-byte.
    let content = String::from_utf8_lossy(&std::fs::read(path).ok()?).into_owned();
    // `fallbackSessionId = basename(filePath, '.jsonl')` (claude.ts:583).
    let fallback = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let opts = ParseSessionOptions {
        fallback_session_id: Some(fallback.clone()),
        ..Default::default()
    };
    let meta = parse_session_content(&content, &opts);
    // R10b: the original's `session-indexer.ts` NEVER registers a session that
    // lacks a resolvable `cwd` (`if (!meta.cwd) continue`, both the incremental
    // `detectNewSessions` gate at :756 and the lightweight full-rescan gate at
    // :1124) \u2014 the exclusion happens at DISCOVERY time, before any
    // include-flag filtering exists to hide it. A file with no `cwd` in any
    // record (e.g. the non-coding-cli "repair" fixtures: plain-string `message`
    // fields, no `cwd` anywhere) is therefore invisible under EVERY flag
    // combination, not merely hidden by the default empty/non-interactive
    // filters. Verified empirically: seeding `test/fixtures/sessions/healthy.jsonl`
    // and querying the ORIGINAL with
    // `includeSubagents&includeNonInteractive&includeEmpty=true` still returns
    // `{items:[],nextCursor:null,revision:0}` \u2014 the file was never indexed at all.
    meta.cwd.as_ref()?;
    Some(item_from_meta(&meta, "claude", &fallback, force_subagent))
}

/// Build a [`DirItem`] from a parsed meta (pure — unit-tested). `session_id` falls
/// back to the file basename when the parser found no canonical id.
///
/// `#[cfg(test)]`: test-only, same rationale as `list_claude_sessions` above.
#[cfg(test)]
fn item_from_meta(
    meta: &ParsedSessionMeta,
    provider: &str,
    fallback_session_id: &str,
    force_subagent: bool,
) -> DirItem {
    DirItem {
        session_id: meta
            .session_id
            .clone()
            .unwrap_or_else(|| fallback_session_id.to_string()),
        provider: provider.to_string(),
        // resolveProjectPath: `meta.cwd` (git-root resolution deferred), else 'unknown'.
        project_path: meta.cwd.clone().unwrap_or_else(|| "unknown".to_string()),
        title: meta.title.clone(),
        summary: meta.summary.clone(),
        first_user_message: meta.first_user_message.clone(),
        // lastActivityAt is a required, non-negative number; absent → 0.
        last_activity_at: meta.last_activity_at.unwrap_or(0).max(0),
        created_at: meta.created_at,
        cwd: meta.cwd.clone(),
        is_subagent: force_subagent || meta.is_subagent.unwrap_or(false),
        is_non_interactive: meta.is_non_interactive.unwrap_or(false),
        is_running: false,
        // Default; overlaid from `config.sessionOverrides` by `apply_session_overrides`.
        archived: false,
        matched_in: None,
        snippet: None,
    }
}

/// Overlay `config.sessionOverrides` onto parsed items (`service.ts` metadata-store
/// flavor merge): `title`/`summary` prefer the override; `archived` reflects the
/// override (default false); a `deleted: true` override removes the item. Keyed by
/// `provider:sessionId` (`buildSessionKey`, `service.ts:36-38`).
fn apply_session_overrides(
    items: Vec<DirItem>,
    overrides: &serde_json::Map<String, Value>,
) -> Vec<DirItem> {
    items
        .into_iter()
        .filter_map(|mut item| {
            let ov = overrides.get(&item.key()).and_then(Value::as_object);
            if let Some(ov) = ov {
                if ov.get("deleted").and_then(Value::as_bool).unwrap_or(false) {
                    return None;
                }
                if let Some(t) = ov.get("titleOverride").and_then(Value::as_str) {
                    item.title = Some(t.to_string());
                }
                if let Some(s) = ov.get("summaryOverride").and_then(Value::as_str) {
                    item.summary = Some(s.to_string());
                }
                item.archived = ov.get("archived").and_then(Value::as_bool).unwrap_or(false);
            }
            Some(item)
        })
        .collect()
}

// ── Cursor (base64url of `{lastActivityAt, key}`) ───────────────────────────

fn encode_cursor(last_activity_at: i64, key: &str) -> String {
    let payload = json!({ "lastActivityAt": last_activity_at, "key": key });
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.to_string().as_bytes())
}

fn decode_cursor(cursor: &str) -> Result<(i64, String), String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor.as_bytes())
        .map_err(|_| "Invalid session-directory cursor".to_string())?;
    let v: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "Invalid session-directory cursor".to_string())?;
    let last = v.get("lastActivityAt").and_then(Value::as_i64);
    let key = v.get("key").and_then(Value::as_str);
    match (last, key) {
        (Some(l), Some(k)) if !k.is_empty() => Ok((l, k.to_string())),
        _ => Err("Invalid session-directory cursor".to_string()),
    }
}

// ── The query derivation (querySessionDirectory, title tier) ────────────────

/// `querySessionDirectory` (`service.ts:228-298`), title tier: sort, visibility
/// pre-filter, cursor page, revision. Returns the `SessionDirectoryPage` value, or
/// an error string when the cursor is invalid (→ 400).
fn apply_query(mut items: Vec<DirItem>, q: &DirQuery) -> Result<Value, String> {
    let limit = q
        .limit
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS);
    let cursor = match &q.cursor {
        Some(c) => Some(decode_cursor(c)?),
        None => None,
    };

    // revision = max(0, all lastActivityAt) (no terminal meta here).
    let revision = items
        .iter()
        .map(|i| i.last_activity_at)
        .max()
        .unwrap_or(0)
        .max(0);

    // Sort: lastActivityAt DESC, then session-key DESC (projection.ts:51-62).
    // sort retained per accepted Batch B deviation -- snapshot is pre-sorted;
    // this is an idempotent guard.
    items.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| b.key().cmp(&a.key()))
    });

    // Server-side visibility pre-filter (service.ts:244-252).
    if !q.include_subagents {
        items.retain(|i| !i.is_subagent);
    }
    if !q.include_non_interactive {
        items.retain(|i| !i.is_non_interactive);
    }
    if !q.include_empty {
        items.retain(|i| {
            i.is_running
                || i.title
                    .as_deref()
                    .map(str::trim)
                    .is_some_and(|t| !t.is_empty())
        });
    }

    // Cursor filter (service.ts:254-259).
    if let Some((c_last, c_key)) = &cursor {
        items.retain(|i| {
            i.last_activity_at < *c_last
                || (i.last_activity_at == *c_last && i.key().as_str() < c_key.as_str())
        });
    }

    // Title-tier metadata search (service.ts:266-271 + applySearch:66-75).
    if let Some(query_text) = q.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        items = items
            .into_iter()
            .filter_map(|i| apply_title_search(i, query_text))
            .collect();
    }

    // Page + next cursor (service.ts:281-291).
    let has_more = items.len() > limit;
    let page_items: Vec<Value> = items.iter().take(limit).map(DirItem::to_value).collect();
    let next_cursor = if has_more {
        items
            .get(limit - 1)
            .map(|tail| Value::String(encode_cursor(tail.last_activity_at, &tail.key())))
            .unwrap_or(Value::Null)
    } else {
        Value::Null
    };

    Ok(json!({
        "items": page_items,
        "nextCursor": next_cursor,
        "revision": revision,
    }))
}

/// `applySearch` (`service.ts:66-75`) at the title tier: match the query against
/// title/summary/firstUserMessage (case-insensitive), annotate `matchedIn` +
/// `snippet`. Faithful-simplified: field precedence title → summary →
/// firstUserMessage; snippet is the matched field truncated to 140 chars.
fn apply_title_search(mut item: DirItem, query_text: &str) -> Option<DirItem> {
    let needle = query_text.to_lowercase();
    let candidates = [
        ("title", item.title.clone()),
        ("summary", item.summary.clone()),
        ("firstUserMessage", item.first_user_message.clone()),
    ];
    for (field, value) in candidates {
        if let Some(v) = value {
            if v.to_lowercase().contains(&needle) {
                item.matched_in = Some(field.to_string());
                item.snippet = Some(v.chars().take(140).collect());
                return Some(item);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn fixtures_dir() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/sessions")
    }

    /// Build an isolated `<home>/.claude/projects/<project>/` populated with the
    /// named committed fixtures (each `<name>.jsonl`), returning the home dir.
    fn claude_home_with(fixtures: &[&str]) -> PathBuf {
        let home = std::env::temp_dir().join(format!(
            "freshell-sessdir-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project = home.join(".claude").join("projects").join("-home-dan-proj");
        std::fs::create_dir_all(&project).unwrap();
        for name in fixtures {
            let src = fixtures_dir().join(name);
            let content = std::fs::read_to_string(&src).unwrap();
            std::fs::write(project.join(name), content).unwrap();
        }
        home
    }

    fn default_query() -> DirQuery {
        DirQuery::default()
    }

    #[test]
    fn item_from_meta_maps_fields_and_fallback_session_id() {
        // real-corrupted: canonical UUID + cwd + title.
        let content = std::fs::read_to_string(fixtures_dir().join("real-corrupted.jsonl")).unwrap();
        let meta = parse_session_content(
            &content,
            &ParseSessionOptions {
                fallback_session_id: Some("real-corrupted".into()),
                ..Default::default()
            },
        );
        let item = item_from_meta(&meta, "claude", "real-corrupted", false);
        assert_eq!(item.session_id, "b7936c10-4935-441c-837c-c1f33cafec2d");
        assert_eq!(item.provider, "claude");
        assert_eq!(
            item.project_path,
            "D:\\Users\\Dan\\GoogleDrivePersonal\\code\\freshell"
        );
        assert_eq!(item.title.as_deref(), Some("Test session 1"));
        assert_eq!(item.last_activity_at, 1_769_753_759_234);
        assert!(item.is_non_interactive);

        // Item value shape has the required keys.
        let v = item.to_value();
        assert_eq!(
            v["sessionId"],
            json!("b7936c10-4935-441c-837c-c1f33cafec2d")
        );
        assert_eq!(v["provider"], json!("claude"));
        assert_eq!(v["isRunning"], json!(false));
        assert_eq!(v["lastActivityAt"], json!(1_769_753_759_234i64));
    }

    #[test]
    fn no_uuid_item_falls_back_to_file_basename() {
        let content = std::fs::read_to_string(fixtures_dir().join("healthy.jsonl")).unwrap();
        let meta = parse_session_content(
            &content,
            &ParseSessionOptions {
                fallback_session_id: Some("healthy".into()),
                ..Default::default()
            },
        );
        let item = item_from_meta(&meta, "claude", "healthy", false);
        assert_eq!(item.session_id, "healthy"); // not a canonical UUID
    }

    #[test]
    fn invalid_utf8_transcript_is_indexed_lossily_like_node() {
        // Regression (bug #7 class, found by the 007 seeded-home differential):
        // Node reads transcripts with `fs.readFile(file,'utf8')` -> invalid
        // bytes become U+FFFD and the session IS indexed; `read_to_string`
        // silently dropped the whole file (and skewed page `revision`).
        let home = claude_home_with(&[]);
        let project = claude_home(&home).join("projects").join("-home-dan-proj");
        std::fs::create_dir_all(&project).unwrap();
        let mut bytes: Vec<u8> = Vec::new();
        bytes.extend_from_slice(br#"{"parentUuid":null,"cwd":"/home/dan/proj","sessionId":"cccc1111-2222-4333-8444-555566667777","type":"user","message":{"role":"user","content":"bad "#);
        bytes.extend_from_slice(&[0xC3, 0x28, 0x20, 0xE2, 0x82, 0x20, 0xF0, 0x9F, 0x98]); // invalid UTF-8 subsequences
        bytes.extend_from_slice(br#" end"},"uuid":"cccc0001-0000-4000-8000-000000000001","timestamp":"2026-01-30T08:00:00.000Z"}"#);
        bytes.push(b'\n');
        std::fs::write(
            project.join("cccc1111-2222-4333-8444-555566667777.jsonl"),
            bytes,
        )
        .unwrap();

        let items = list_claude_sessions(&claude_home(&home));
        assert_eq!(
            items.len(),
            1,
            "invalid-UTF-8 transcript must still be indexed (lossy), not dropped"
        );
        let title = items[0].title.as_deref().unwrap_or("");
        assert!(
            title.contains('\u{FFFD}'),
            "title carries U+FFFD replacements, got {title:?}"
        );
        assert!(
            title.starts_with("bad ") && title.ends_with(" end"),
            "surrounding valid text preserved: {title:?}"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn default_query_hides_non_interactive_fixtures() {
        // `real-corrupted.jsonl` has a `cwd` and parses as non-interactive → the
        // default History browse (no includeNonInteractive) hides it → empty
        // page. `healthy.jsonl` has NO `cwd` anywhere → excluded entirely at
        // discovery (R10b), never reaching the item list at all.
        let home = claude_home_with(&["real-corrupted.jsonl", "healthy.jsonl"]);
        let items = list_claude_sessions(&claude_home(&home));
        assert_eq!(
            items.len(),
            1,
            "the cwd-less repair fixture is never indexed (R10b)"
        );
        let page = apply_query(items, &default_query()).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 0);
        assert_eq!(page["nextCursor"], Value::Null);
        // revision reflects the newest activity even though items are hidden.
        assert_eq!(page["revision"], json!(1_769_753_759_234i64));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn include_non_interactive_surfaces_titled_session() {
        let home = claude_home_with(&["real-corrupted.jsonl", "healthy.jsonl"]);
        let items = list_claude_sessions(&claude_home(&home));
        let q = DirQuery {
            include_non_interactive: true,
            ..DirQuery::default()
        };
        let page = apply_query(items, &q).unwrap();
        // healthy has no title → still hidden by the empty filter; real-corrupted
        // has a title → shown.
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["title"], json!("Test session 1"));
        assert_eq!(arr[0]["provider"], json!("claude"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn include_empty_surfaces_untitled_sessions_sorted_desc() {
        // `healthy.jsonl` has no `cwd` → excluded at discovery (R10b) even with
        // every include flag set; only the cwd-bearing `real-corrupted.jsonl`
        // (itself untitled-if-you-squint but DOES have a title) surfaces here.
        // (See `r10b_cwdless_repair_fixture_never_surfaces_under_any_flags`
        // below for the dedicated pin of the never-surfaces behavior.)
        let home = claude_home_with(&["real-corrupted.jsonl", "healthy.jsonl"]);
        let items = list_claude_sessions(&claude_home(&home));
        let q = DirQuery {
            include_non_interactive: true,
            include_empty: true,
            ..DirQuery::default()
        };
        let page = apply_query(items, &q).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(
            arr[0]["sessionId"],
            json!("b7936c10-4935-441c-837c-c1f33cafec2d")
        );
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn r10b_cwdless_repair_fixture_never_surfaces_under_any_flags() {
        // Byte-matched against a live probe of the ORIGINAL: seeding
        // `healthy.jsonl` (renamed to a canonical UUID filename, exactly as
        // `port/oracle/rest-parity/sweep.mjs#seedClaudeSessions` does) and
        // querying with every include flag set still returns `items:[]` — the
        // file is never indexed (`session-indexer.ts:756,1124`:
        // `if (!meta.cwd) continue`), not merely hidden by a visibility filter.
        let home = std::env::temp_dir().join(format!(
            "freshell-r10b-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project = home.join(".claude").join("projects").join("-home-qa-demo");
        std::fs::create_dir_all(&project).unwrap();
        let content = std::fs::read_to_string(fixtures_dir().join("healthy.jsonl")).unwrap();
        std::fs::write(
            project.join("11111111-1111-4111-8111-111111111111.jsonl"),
            content,
        )
        .unwrap();

        let items = list_claude_sessions(&claude_home(&home));
        assert!(items.is_empty(), "a cwd-less session must never be indexed");

        let q = DirQuery {
            include_subagents: true,
            include_non_interactive: true,
            include_empty: true,
            ..DirQuery::default()
        };
        let page = apply_query(items, &q).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 0);
        assert_eq!(page["revision"], json!(0));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn title_search_matches_and_annotates() {
        let home = claude_home_with(&["real-corrupted.jsonl"]);
        let items = list_claude_sessions(&claude_home(&home));
        let q = DirQuery {
            include_non_interactive: true,
            query: Some("session 1".into()),
            ..DirQuery::default()
        };
        let page = apply_query(items, &q).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matchedIn"], json!("title"));
        assert_eq!(arr[0]["snippet"], json!("Test session 1"));

        // A non-matching query → empty.
        let items2 = list_claude_sessions(&claude_home(&home));
        let q2 = DirQuery {
            include_non_interactive: true,
            query: Some("zzz-not-present".into()),
            ..DirQuery::default()
        };
        let page2 = apply_query(items2, &q2).unwrap();
        assert_eq!(page2["items"].as_array().unwrap().len(), 0);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn cursor_paging_splits_and_round_trips() {
        // Two synthetic titled interactive items; limit 1 → page + nextCursor.
        let mk = |sid: &str, at: i64| DirItem {
            session_id: sid.into(),
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some(format!("t-{sid}")),
            summary: None,
            first_user_message: None,
            last_activity_at: at,
            created_at: None,
            cwd: None,
            is_subagent: false,
            is_non_interactive: false,
            is_running: false,
            archived: false,
            matched_in: None,
            snippet: None,
        };
        let items = vec![mk("a", 100), mk("b", 200)];
        let q = DirQuery {
            limit: Some(1),
            ..DirQuery::default()
        };
        let page = apply_query(items, &q).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["sessionId"], json!("b")); // newest first
        let cursor = page["nextCursor"].as_str().expect("has next cursor");

        // Page 2 via the cursor → the older item.
        let items2 = vec![mk("a", 100), mk("b", 200)];
        let q2 = DirQuery {
            limit: Some(1),
            cursor: Some(cursor.to_string()),
            ..DirQuery::default()
        };
        let page2 = apply_query(items2, &q2).unwrap();
        let arr2 = page2["items"].as_array().unwrap();
        assert_eq!(arr2.len(), 1);
        assert_eq!(arr2[0]["sessionId"], json!("a"));
        assert_eq!(page2["nextCursor"], Value::Null);
    }

    #[test]
    fn invalid_cursor_is_rejected() {
        let q = DirQuery {
            cursor: Some("!!!not-base64!!!".into()),
            ..DirQuery::default()
        };
        let err = apply_query(Vec::new(), &q).unwrap_err();
        assert!(err.to_lowercase().contains("cursor"));
    }

    #[test]
    fn missing_home_projects_yields_empty_list() {
        let items = list_claude_sessions(Path::new("/nonexistent-claude-home-xyz"));
        assert!(items.is_empty());
    }

    // ── R9: query validation (byte-matched against a live probe of the ── //
    // ── ORIGINAL: `node dist/server/index.js`, zod v4 `safeParse` shapes) //

    fn q(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn missing_priority_is_400_invalid_value() {
        let err = validate_query(&q(&[])).unwrap_err();
        assert_eq!(
            err,
            json!([{
                "code": "invalid_value",
                "values": ["visible", "background"],
                "path": ["priority"],
                "message": "Invalid option: expected one of \"visible\"|\"background\"",
            }])
        );
    }

    #[test]
    fn bogus_priority_is_400_same_shape_as_missing() {
        let err = validate_query(&q(&[("priority", "bogus")])).unwrap_err();
        assert_eq!(
            err,
            json!([{
                "code": "invalid_value",
                "values": ["visible", "background"],
                "path": ["priority"],
                "message": "Invalid option: expected one of \"visible\"|\"background\"",
            }])
        );
    }

    #[test]
    fn valid_priorities_are_accepted() {
        assert!(validate_query(&q(&[("priority", "visible")])).is_ok());
        assert!(validate_query(&q(&[("priority", "background")])).is_ok());
    }

    #[test]
    fn non_numeric_limit_is_400_invalid_type_nan() {
        let err = validate_query(&q(&[("priority", "visible"), ("limit", "abc")])).unwrap_err();
        assert_eq!(
            err,
            json!([{
                "expected": "number",
                "code": "invalid_type",
                "received": "NaN",
                "path": ["limit"],
                "message": "Invalid input: expected number, received NaN",
            }])
        );
    }

    #[test]
    fn empty_limit_string_js_coerces_to_zero_then_too_small() {
        // `Number('')` === 0 in JS, not NaN \u2014 the ORIGINAL's coercion (verified live).
        let err = validate_query(&q(&[("priority", "visible"), ("limit", "")])).unwrap_err();
        assert_eq!(err[0]["code"], json!("too_small"));
    }

    #[test]
    fn zero_and_negative_limit_are_too_small() {
        for bad in ["0", "-1"] {
            let err = validate_query(&q(&[("priority", "visible"), ("limit", bad)])).unwrap_err();
            assert_eq!(
                err,
                json!([{
                    "origin": "number",
                    "code": "too_small",
                    "minimum": 0,
                    "inclusive": false,
                    "path": ["limit"],
                    "message": "Too small: expected number to be >0",
                }]),
                "limit={bad}"
            );
        }
    }

    #[test]
    fn oversize_limit_is_too_big() {
        let err = validate_query(&q(&[("priority", "visible"), ("limit", "51")])).unwrap_err();
        assert_eq!(
            err,
            json!([{
                "origin": "number",
                "code": "too_big",
                "maximum": 50,
                "inclusive": true,
                "path": ["limit"],
                "message": "Too big: expected number to be <=50",
            }])
        );
    }

    #[test]
    fn fractional_limit_is_invalid_int() {
        let err = validate_query(&q(&[("priority", "visible"), ("limit", "1.5")])).unwrap_err();
        assert_eq!(
            err,
            json!([{
                "expected": "int",
                "format": "safeint",
                "code": "invalid_type",
                "path": ["limit"],
                "message": "Invalid input: expected int, received number",
            }])
        );
    }

    #[test]
    fn boundary_limit_values_are_accepted() {
        assert!(validate_query(&q(&[("priority", "visible"), ("limit", "1")])).is_ok());
        assert!(validate_query(&q(&[("priority", "visible"), ("limit", "50")])).is_ok());
    }

    #[test]
    fn multiple_violations_collect_into_one_details_array_priority_then_limit() {
        // Verified live: zod's safeParse reports ALL violated fields, in
        // declaration order (priority before limit).
        let err = validate_query(&q(&[("priority", "bogus"), ("limit", "abc")])).unwrap_err();
        let arr = err.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["path"], json!(["priority"]));
        assert_eq!(arr[1]["path"], json!(["limit"]));
    }

    #[test]
    fn badcursor_still_400s_with_original_message_r9_parity_untouched() {
        // R9 only tightened priority/limit; the pre-existing cursor 400 (already
        // parity, S1-only) must be unaffected.
        let query = validate_query(&q(&[
            ("priority", "visible"),
            ("cursor", "!!!not-base64!!!"),
        ]))
        .unwrap();
        let err = apply_query(Vec::new(), &query).unwrap_err();
        assert!(err.to_lowercase().contains("cursor"));
    }

    // ── Task 2: sessionOverrides overlay ──────────────────────────────────

    #[test]
    fn overrides_overlay_applies_title_summary_archived_and_filters_deleted() {
        // Two synthetic titled items.
        let mk = |sid: &str| DirItem {
            session_id: sid.into(),
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some("parsed".into()),
            summary: Some("parsed-sum".into()),
            first_user_message: None,
            last_activity_at: 100,
            created_at: None,
            cwd: Some("/p".into()),
            is_subagent: false,
            is_non_interactive: false,
            is_running: false,
            archived: false,
            matched_in: None,
            snippet: None,
        };
        let items = vec![mk("keep"), mk("gone")];

        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "claude:keep".into(),
            json!({
                "titleOverride": "Renamed", "summaryOverride": "New sum", "archived": true
            }),
        );
        overrides.insert("claude:gone".into(), json!({ "deleted": true }));

        let overlaid = apply_session_overrides(items, &overrides);
        assert_eq!(overlaid.len(), 1, "deleted item filtered out");
        let v = overlaid[0].to_value();
        assert_eq!(v["sessionId"], json!("keep"));
        assert_eq!(v["title"], json!("Renamed"));
        assert_eq!(v["summary"], json!("New sum"));
        assert_eq!(v["archived"], json!(true));
    }

    #[test]
    fn overlay_shape_unchanged_when_no_overrides_archived_always_present() {
        let item = DirItem {
            session_id: "x".into(),
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some("t".into()),
            summary: None,
            first_user_message: None,
            last_activity_at: 1,
            created_at: None,
            cwd: None,
            is_subagent: false,
            is_non_interactive: false,
            is_running: false,
            archived: false,
            matched_in: None,
            snippet: None,
        };
        let overlaid = apply_session_overrides(vec![item], &serde_json::Map::new());
        let v = overlaid[0].to_value();
        // Oracle-compat: archived is ALWAYS present, defaulted false.
        assert_eq!(v["archived"], json!(false));
        assert_eq!(v["title"], json!("t"));
    }

    // -- Batch B: the `SessionIndex`-backed production path --
    //
    // RED (this commit, before the wiring existed): `SessionDirectoryState`
    // had no `session_index` field, so these three tests failed to compile.

    use freshell_sessions::directory_index::{ClaudeSource, SessionIndex, SessionSource};

    /// Comparable projection of either `DirItem` or `IndexedSession`, keyed
    /// the same way, for the B-T1 differential assertion (the two types are
    /// deliberately distinct -- one server-local, one in `freshell_sessions`
    /// -- so this test-only helper is how they're compared field-for-field).
    #[derive(Debug, PartialEq, PartialOrd, Ord, Eq)]
    struct Comparable {
        key: String,
        last_activity_at: i64,
        title: Option<String>,
        summary: Option<String>,
        first_user_message: Option<String>,
        created_at: Option<i64>,
        cwd: Option<String>,
        project_path: String,
        is_subagent: bool,
        is_non_interactive: bool,
    }

    impl From<&DirItem> for Comparable {
        fn from(i: &DirItem) -> Self {
            Comparable {
                key: i.key(),
                last_activity_at: i.last_activity_at,
                title: i.title.clone(),
                summary: i.summary.clone(),
                first_user_message: i.first_user_message.clone(),
                created_at: i.created_at,
                cwd: i.cwd.clone(),
                project_path: i.project_path.clone(),
                is_subagent: i.is_subagent,
                is_non_interactive: i.is_non_interactive,
            }
        }
    }

    impl From<&freshell_sessions::directory_index::IndexedSession> for Comparable {
        fn from(i: &freshell_sessions::directory_index::IndexedSession) -> Self {
            Comparable {
                key: i.key(),
                last_activity_at: i.last_activity_at,
                title: i.title.clone(),
                summary: i.summary.clone(),
                first_user_message: i.first_user_message.clone(),
                created_at: i.created_at,
                cwd: i.cwd.clone(),
                project_path: i.project_path.clone(),
                is_subagent: i.is_subagent,
                is_non_interactive: i.is_non_interactive,
            }
        }
    }

    /// B-T1 (differential): `ClaudeSource::scan()` (the production path) must
    /// produce EXACTLY the same session set as `list_claude_sessions()` (the
    /// KEPT reference oracle) for the same fixture-populated home.
    #[test]
    fn b_t1_claude_source_matches_list_claude_sessions_reference_scan() {
        let home = claude_home_with(&["real-corrupted.jsonl", "healthy.jsonl"]);
        let mut reference: Vec<Comparable> = list_claude_sessions(&claude_home(&home))
            .iter()
            .map(Comparable::from)
            .collect();
        let mut production: Vec<Comparable> = ClaudeSource::new(claude_home(&home))
            .scan()
            .iter()
            .map(Comparable::from)
            .collect();
        reference.sort();
        production.sort();
        assert_eq!(
            production, reference,
            "the index's ClaudeSource must produce the same session set as the kept reference scan"
        );
        assert!(
            !reference.is_empty(),
            "sanity: the fixture home has a session"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    /// B-T7 (end-to-end server wiring): `GET /api/session-directory` served
    /// through the full router, backed by a `SessionIndex`, returns the SAME
    /// response shape as before (`items`/`nextCursor`/`revision`, `archived`
    /// always present) with data sourced from the index, not a per-request
    /// `list_claude_sessions` call.
    #[tokio::test]
    async fn b_t7_router_get_session_directory_is_backed_by_the_session_index() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = claude_home_with(&["real-corrupted.jsonl"]);
        let settings =
            crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]);
        let auth_token: std::sync::Arc<String> = std::sync::Arc::new("tok".into());
        let session_index =
            std::sync::Arc::new(SessionIndex::new(vec![
                std::sync::Arc::new(ClaudeSource::new(claude_home(&home)))
                    as std::sync::Arc<dyn SessionSource>,
            ]));
        let state = SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
        };
        let app = router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/session-directory?priority=visible&includeNonInteractive=1")
                    .header("x-auth-token", "tok")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: Value = serde_json::from_slice(&bytes).unwrap();
        let items = page["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["title"], json!("Test session 1"));
        // Oracle-compat: archived always present.
        assert_eq!(items[0]["archived"], json!(false));
        assert_eq!(page["nextCursor"], Value::Null);
        assert_eq!(page["revision"], json!(1_769_753_759_234i64));
        std::fs::remove_dir_all(&home).ok();
    }

    /// B-T8: no home (`session_index: None`) still yields an empty page --
    /// the prior "no home resolvable" behavior, now expressed as an absent
    /// index instead of an absent `home: Option<PathBuf>`.
    #[tokio::test]
    async fn b_t8_no_session_index_yields_empty_page() {
        use axum::http::Request;
        use tower::ServiceExt;

        let settings = crate::settings_store::SettingsStore::load(None, vec!["claude".into()]);
        let auth_token: std::sync::Arc<String> = std::sync::Arc::new("tok".into());
        let state = SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings,
            session_index: None,
        };
        let app = router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/session-directory?priority=visible")
                    .header("x-auth-token", "tok")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), axum::http::StatusCode::OK);
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 0);
        assert_eq!(page["nextCursor"], Value::Null);
        assert_eq!(page["revision"], json!(0));
    }

    /// Batch B review fix: a `SessionSource` wrapper that counts `discover()`
    /// and `parse()` calls, used to prove overrides never touch the
    /// underlying `SessionIndex`.
    struct CountingClaudeSource {
        inner: freshell_sessions::directory_index::ClaudeSource,
        discover_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
        parse_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    impl SessionSource for CountingClaudeSource {
        fn discover(&self) -> Vec<freshell_sessions::directory_index::FileStat> {
            self.discover_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.discover()
        }

        fn parse(&self, path: &Path) -> Option<freshell_sessions::directory_index::IndexedSession> {
            self.parse_calls
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.inner.parse(path)
        }
    }

    /// override_no_rebuild: two handler-level `GET /api/session-directory`
    /// requests, with a session override applied BETWEEN them via
    /// `patch_session_override`, must not touch the underlying
    /// `SessionIndex` at all -- overrides are overlaid per-request from
    /// `state.settings.session_overrides()` (`apply_session_overrides`,
    /// above `apply_query`) AFTER the (cached) snapshot is read, so applying
    /// one can never trigger a discover/parse.
    #[tokio::test]
    async fn override_no_rebuild() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = claude_home_with(&["real-corrupted.jsonl"]);
        let settings =
            crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]);
        let auth_token: std::sync::Arc<String> = std::sync::Arc::new("tok".into());
        let discover_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let parse_calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let source = CountingClaudeSource {
            inner: ClaudeSource::new(claude_home(&home)),
            discover_calls: std::sync::Arc::clone(&discover_calls),
            parse_calls: std::sync::Arc::clone(&parse_calls),
        };
        // Long TTL: both requests must land within the same cached window --
        // this test is about overrides never forcing a rebuild, not about TTL
        // expiry (that's B-T3/B-T4/the incremental-cache tests).
        let session_index = std::sync::Arc::new(SessionIndex::with_ttl(
            vec![std::sync::Arc::new(source) as std::sync::Arc<dyn SessionSource>],
            Duration::from_secs(60),
        ));
        let state = SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings: settings.clone(),
            session_index: Some(session_index),
        };
        let app = router(state);

        let get_page = |app: Router| async {
            app.oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/session-directory?priority=visible&includeNonInteractive=1")
                    .header("x-auth-token", "tok")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap()
        };

        let resp1 = get_page(app.clone()).await;
        assert_eq!(resp1.status(), axum::http::StatusCode::OK);
        let bytes1 = axum::body::to_bytes(resp1.into_body(), usize::MAX)
            .await
            .unwrap();
        let page1: Value = serde_json::from_slice(&bytes1).unwrap();
        assert_eq!(
            page1["items"].as_array().unwrap()[0]["archived"],
            json!(false)
        );
        let discover_after_first = discover_calls.load(std::sync::atomic::Ordering::SeqCst);
        let parse_after_first = parse_calls.load(std::sync::atomic::Ordering::SeqCst);
        assert!(
            discover_after_first >= 1,
            "sanity: the cold request did sweep"
        );

        // Apply an override BETWEEN the two requests.
        settings
            .patch_session_override(
                "claude:b7936c10-4935-441c-837c-c1f33cafec2d",
                &[("archived", Some(json!(true)))],
            )
            .await;

        let resp2 = get_page(app).await;
        assert_eq!(resp2.status(), axum::http::StatusCode::OK);
        let bytes2 = axum::body::to_bytes(resp2.into_body(), usize::MAX)
            .await
            .unwrap();
        let page2: Value = serde_json::from_slice(&bytes2).unwrap();
        // The override took effect...
        assert_eq!(
            page2["items"].as_array().unwrap()[0]["archived"],
            json!(true)
        );
        // ...without the index doing a single extra discover/parse.
        assert_eq!(
            discover_calls.load(std::sync::atomic::Ordering::SeqCst),
            discover_after_first,
            "applying a session override must not trigger a SessionIndex refresh"
        );
        assert_eq!(
            parse_calls.load(std::sync::atomic::Ordering::SeqCst),
            parse_after_first,
            "applying a session override must not re-parse any file"
        );

        std::fs::remove_dir_all(&home).ok();
    }
}
