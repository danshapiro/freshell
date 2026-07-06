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
use freshell_sessions::meta::ParsedSessionMeta;
use freshell_sessions::{parse_session_content, ParseSessionOptions};
use serde_json::{json, Map, Value};

use crate::boot::{is_authed, unauthorized};

/// `MAX_DIRECTORY_PAGE_ITEMS` (`shared/read-models.ts:6`).
const MAX_DIRECTORY_PAGE_ITEMS: usize = 50;

/// Shared state for the session-directory route.
#[derive(Clone)]
pub struct SessionDirectoryState {
    pub auth_token: Arc<String>,
    /// The isolated home whose `.claude/projects` holds the claude transcripts.
    /// `None` → an empty page (no home resolvable).
    pub home: Option<PathBuf>,
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

fn parse_query(raw: &std::collections::HashMap<String, String>) -> DirQuery {
    let flag = |k: &str| raw.get(k).map(|v| v == "1" || v == "true").unwrap_or(false);
    DirQuery {
        query: raw.get("query").filter(|s| !s.is_empty()).cloned(),
        cursor: raw.get("cursor").filter(|s| !s.is_empty()).cloned(),
        limit: raw.get("limit").and_then(|v| v.parse::<usize>().ok()),
        include_subagents: flag("includeSubagents"),
        include_non_interactive: flag("includeNonInteractive"),
        include_empty: flag("includeEmpty"),
    }
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
    let query = parse_query(&raw);
    let items = match &state.home {
        Some(home) => list_claude_sessions(&claude_home(home)),
        None => Vec::new(),
    };
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

/// `getClaudeHome()` (`server/claude-home.ts:4-7`): `CLAUDE_HOME` env else `<home>/.claude`.
fn claude_home(home: &Path) -> PathBuf {
    match std::env::var("CLAUDE_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => home.join(".claude"),
    }
}

/// Walk `<claudeHome>/projects/*/…*.jsonl` and parse each into a [`DirItem`],
/// mirroring `claudeProvider.listSessionFiles()` (`claude.ts:529-580`): top-level
/// `.jsonl` are sessions; `<project>/<session>/subagents/*.jsonl` are subagents.
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
fn parse_claude_file(path: &Path, force_subagent: bool) -> Option<DirItem> {
    let content = std::fs::read_to_string(path).ok()?;
    // `fallbackSessionId = basename(filePath, '.jsonl')` (claude.ts:583).
    let fallback = path.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let opts = ParseSessionOptions {
        fallback_session_id: Some(fallback.clone()),
        ..Default::default()
    };
    let meta = parse_session_content(&content, &opts);
    Some(item_from_meta(&meta, "claude", &fallback, force_subagent))
}

/// Build a [`DirItem`] from a parsed meta (pure — unit-tested). `session_id` falls
/// back to the file basename when the parser found no canonical id.
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
        matched_in: None,
        snippet: None,
    }
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
    let limit = q.limit.unwrap_or(MAX_DIRECTORY_PAGE_ITEMS).min(MAX_DIRECTORY_PAGE_ITEMS);
    let cursor = match &q.cursor {
        Some(c) => Some(decode_cursor(c)?),
        None => None,
    };

    // revision = max(0, all lastActivityAt) (no terminal meta here).
    let revision = items.iter().map(|i| i.last_activity_at).max().unwrap_or(0).max(0);

    // Sort: lastActivityAt DESC, then session-key DESC (projection.ts:51-62).
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
        items.retain(|i| i.is_running || i.title.as_deref().map(str::trim).is_some_and(|t| !t.is_empty()));
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
        assert_eq!(item.project_path, "D:\\Users\\Dan\\GoogleDrivePersonal\\code\\freshell");
        assert_eq!(item.title.as_deref(), Some("Test session 1"));
        assert_eq!(item.last_activity_at, 1_769_753_759_234);
        assert!(item.is_non_interactive);

        // Item value shape has the required keys.
        let v = item.to_value();
        assert_eq!(v["sessionId"], json!("b7936c10-4935-441c-837c-c1f33cafec2d"));
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
    fn default_query_hides_non_interactive_fixtures() {
        // All committed fixtures parse as non-interactive → the default History
        // browse (no includeNonInteractive) hides them all → empty page.
        let home = claude_home_with(&["real-corrupted.jsonl", "healthy.jsonl"]);
        let items = list_claude_sessions(&claude_home(&home));
        assert_eq!(items.len(), 2, "both fixtures discovered + parsed");
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
        let home = claude_home_with(&["real-corrupted.jsonl", "healthy.jsonl"]);
        let items = list_claude_sessions(&claude_home(&home));
        let q = DirQuery {
            include_non_interactive: true,
            include_empty: true,
            ..DirQuery::default()
        };
        let page = apply_query(items, &q).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        // Sorted lastActivityAt DESC: real-corrupted (…759_234) before healthy (…205_000).
        assert_eq!(arr[0]["sessionId"], json!("b7936c10-4935-441c-837c-c1f33cafec2d"));
        assert_eq!(arr[1]["sessionId"], json!("healthy"));
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
            matched_in: None,
            snippet: None,
        };
        let items = vec![mk("a", 100), mk("b", 200)];
        let q = DirQuery { limit: Some(1), ..DirQuery::default() };
        let page = apply_query(items, &q).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["sessionId"], json!("b")); // newest first
        let cursor = page["nextCursor"].as_str().expect("has next cursor");

        // Page 2 via the cursor → the older item.
        let items2 = vec![mk("a", 100), mk("b", 200)];
        let q2 = DirQuery { limit: Some(1), cursor: Some(cursor.to_string()), ..DirQuery::default() };
        let page2 = apply_query(items2, &q2).unwrap();
        let arr2 = page2["items"].as_array().unwrap();
        assert_eq!(arr2.len(), 1);
        assert_eq!(arr2[0]["sessionId"], json!("a"));
        assert_eq!(page2["nextCursor"], Value::Null);
    }

    #[test]
    fn invalid_cursor_is_rejected() {
        let q = DirQuery { cursor: Some("!!!not-base64!!!".into()), ..DirQuery::default() };
        let err = apply_query(Vec::new(), &q).unwrap_err();
        assert!(err.to_lowercase().contains("cursor"));
    }

    #[test]
    fn missing_home_projects_yields_empty_list() {
        let items = list_claude_sessions(Path::new("/nonexistent-claude-home-xyz"));
        assert!(items.is_empty());
    }
}
