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
//! ## Scope (what this module actually covers today)
//!
//! * **claude + codex + opencode.** The `SessionIndex` enumerates all three
//!   providers (`ClaudeSource` / `CodexSource` / `OpencodeSource`,
//!   `freshell_sessions::directory_index`); the original "claude only" Batch-B
//!   fence is long gone.
//! * **`projectPath = meta.cwd` (or `"unknown"`).** The original resolves the git
//!   repo root of `cwd` (`resolveProjectPath` → `resolveGitRepoRoot`, a LIVE `git`
//!   call); that resolution is deferred (documented). `cwd` is faithful data.
//! * **all three search tiers.** The `title` metadata tier plus the SESSION-07
//!   `userMessages`/`fullText` file-content tiers (`apply_file_search`, porting
//!   `server/session-directory/file-search.ts`).
//! * **live terminal join + metadata-store flavor.** The sidebar join below
//!   ([`join_live_terminals`], Fix Spec: Session Naming Cluster) fuses the live
//!   `TerminalIdentityRegistry` set into the parsed items: a matched item gains
//!   `isRunning`/`runningTerminalId`, and each unmatched live identity gets
//!   exactly one synthesized entry (with `sessionType`); `sessionType` is also
//!   read-joined from the SESSION-06 metadata store
//!   ([`apply_session_metadata`], Task 20).

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
// SESSION-07: the `userMessages`/`fullText` tier file-content search
// (`apply_file_search`, below) -- ports `server/session-directory/file-search.ts`.
use freshell_sessions::{search_session_file, FileSearchTier};
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
    /// Fix Spec: Session Naming Cluster (SYMPTOM 1) — the shared terminal
    /// identity registry, joined against the parsed session items by
    /// [`join_live_terminals`] (`toItems`/`joinRunningState`/
    /// `buildLiveTerminalSessionItem`, `service.ts:77-151`). `O(terminals)` per
    /// request, no new I/O — reads the already-in-memory registry snapshot.
    pub identity: freshell_ws::identity::TerminalIdentityRegistry,
    /// STATUS-STRIP: stamped on every session-directory page (`serverInstance`);
    /// clients order pages by `snapshotSeq` only within one instance.
    pub server_instance: Arc<String>,
    /// Task 20 (read-join): the SESSION-06 metadata store
    /// (`session-metadata.json`, same `.freshell` home dir as the POST route)
    /// whose `sessionType` tags [`apply_session_metadata`] overlays onto
    /// matching items per request (`session-indexer.ts:1144-1148`, key =
    /// `provider:sessionId`).
    pub metadata: crate::session_metadata::SessionMetadataStore,
}

/// One directory item, typed for the sort/filter/cursor derivation. Serialized to
/// the `SessionDirectoryItem` shape by [`DirItem::to_value`].
#[derive(Debug, Clone)]
struct DirItem {
    session_id: String,
    /// Compatibility alias for user-authored state recorded before a provider
    /// identity migration. Internal only: never serialized and never used for
    /// joining/routing session identity.
    legacy_session_id: Option<String>,
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
    /// Fix Spec: Session Naming Cluster (SYMPTOM 1, sidebar join) —
    /// `SessionDirectoryItem.runningTerminalId` (`shared/read-models.ts:58`): the
    /// terminal id backing this item when [`Self::is_running`] is `true`. Set by
    /// [`join_running_state`] (a matched session-file item) or
    /// [`build_live_terminal_session_item`] (a synthesized live-only item).
    running_terminal_id: Option<String>,
    /// `SessionDirectoryItem.liveTerminalOnly` (`shared/read-models.ts:59`): `true`
    /// only for a synthesized live-terminal item with NO coding-CLI session id yet
    /// (`buildLiveTerminalSessionItem`, `service.ts:128`, `!meta.sessionId`) —
    /// never set on a real session-file item.
    live_terminal_only: bool,
    /// `SessionDirectoryItem.sessionType` (`shared/read-models.ts:53`): set on a
    /// synthesized live-terminal item (`service.ts:125`,
    /// `sessionType: meta.provider`) — a real session-file item never sets this
    /// in this port (the original's parsed items don't set it either, see
    /// `toItems`/`joinRunningState`, `service.ts:132-151`).
    session_type: Option<String>,
    /// The PARSED (pre-override) title source (`IndexedSession::title_source`,
    /// Node's `ParsedSessionTitleSource`; `"provider-generated"` or absent) --
    /// consulted by [`apply_session_overrides`]'s provider-generated
    /// read-guard (`applyOverride`, `session-indexer.ts:204-220`). Internal
    /// only: never serialized by [`DirItem::to_value`] (this port's directory
    /// response has never carried `titleSource`; exposing it would be a
    /// separate parity decision).
    title_source: Option<String>,
    /// SESSION-07: the on-disk transcript to scan for the `userMessages`/
    /// `fullText` tiers (`IndexedSession::source_file`). Internal only --
    /// never serialized (`to_value` never reads it), mirroring
    /// `sourceFiles.get(key)` (`session-directory/service.ts:164-173`), which
    /// is looked up server-side and never sent to the client either.
    source_file: Option<PathBuf>,
    /// STATUS-STRIP: live token usage (`SessionDirectoryItem.tokenUsage`,
    /// `shared/read-models.ts`; Node's `CodingCliSession.tokenUsage`,
    /// `coding-cli/types.ts:190`). Powers the fresh-agent strip's context
    /// meter (`compactPercent` etc.). `None` when the source carries none
    /// (opencode direct rows, live-terminal synthesized items).
    token_usage: Option<freshell_sessions::meta::TokenSummary>,
}

impl DirItem {
    /// `buildSessionKey` (`session-directory/service.ts:36-38`): `provider:sessionId`.
    fn key(&self) -> String {
        format!("{}:{}", self.provider, self.session_id)
    }

    /// The compatibility key is only for reading prior user-owned metadata.
    /// It never participates in sorting, filtering, live-terminal joins, or
    /// the session identity invariant.
    fn legacy_key(&self) -> Option<String> {
        self.legacy_session_id
            .as_ref()
            .map(|session_id| format!("{}:{session_id}", self.provider))
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
            // A linked worktree is grouped under its common repository but
            // must retain its checkout for the client’s worktree-aware
            // sidebar presentation. Ordinary checkouts omit this redundant
            // field when checkout and project paths are identical.
            if let Some(checkout_path) = freshell_platform::git_meta::resolve_git_checkout_root(v)
                .filter(|checkout_path| checkout_path != &self.project_path)
            {
                o.insert("checkoutPath".into(), json!(checkout_path));
            }
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
        if let Some(v) = &self.running_terminal_id {
            o.insert("runningTerminalId".into(), json!(v));
        }
        if self.live_terminal_only {
            o.insert("liveTerminalOnly".into(), json!(true));
        }
        if let Some(v) = &self.session_type {
            o.insert("sessionType".into(), json!(v));
        }
        if let Some(u) = &self.token_usage {
            o.insert("tokenUsage".into(), token_usage_value(u));
        }
        Value::Object(o)
    }
}

/// Serialize a [`freshell_sessions::meta::TokenSummary`] to the
/// `TokenSummarySchema` wire shape (`shared/ws-protocol.ts:61-72`): required
/// numeric fields always present, the context/compact optionals omitted when
/// absent (matching the zod `.optional()`s).
fn token_usage_value(u: &freshell_sessions::meta::TokenSummary) -> Value {
    let mut o = Map::new();
    o.insert("inputTokens".into(), json!(u.input_tokens));
    o.insert("outputTokens".into(), json!(u.output_tokens));
    o.insert("cachedTokens".into(), json!(u.cached_tokens));
    o.insert("totalTokens".into(), json!(u.total_tokens));
    if let Some(v) = u.context_tokens {
        o.insert("contextTokens".into(), json!(v));
    }
    if let Some(v) = u.model_context_window {
        o.insert("modelContextWindow".into(), json!(v));
    }
    if let Some(v) = u.compact_threshold_tokens {
        o.insert("compactThresholdTokens".into(), json!(v));
    }
    if let Some(v) = u.compact_percent {
        o.insert("compactPercent".into(), json!(v));
    }
    Value::Object(o)
}

/// `SessionDirectoryQuerySchema.tier` (`shared/read-models.ts:30`,
/// `z.enum(['title', 'userMessages', 'fullText']).default('title')`).
/// SESSION-07: `UserMessages`/`FullText` dispatch to
/// `freshell_sessions::search::search_session_file` (see
/// [`apply_file_search`]); `Title` keeps the existing metadata-only
/// [`apply_title_search`] path unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum Tier {
    #[default]
    Title,
    UserMessages,
    FullText,
}

/// The parsed query (`SessionDirectoryQuerySchema` — `read-models.ts:28-38`), the
/// subset this port honors. Booleans arrive as `'1'` (present) / absent, matching
/// the client's `buildQueryString` (`src/lib/api.ts:253-255`).
#[derive(Debug, Default)]
struct DirQuery {
    query: Option<String>,
    tier: Tier,
    cursor: Option<String>,
    limit: Option<usize>,
    include_subagents: bool,
    include_non_interactive: bool,
    include_empty: bool,
    /// STATUS-STRIP: `includeKeys` (`shared/read-models.ts`) — comma-separated
    /// `provider:sessionId` keys whose usage the client needs regardless of
    /// the sidebar search/pagination window. Matching sessions are returned
    /// out-of-band as `contextUsageExtras` (never merged into `items`).
    include_keys: Vec<String>,
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

    // SESSION-07: `tier` (`SessionDirectoryQuerySchema.tier`,
    // `shared/read-models.ts:30`) -- `z.enum([...]).default('title')`, so an
    // ABSENT value is valid (defaults), only a PRESENT-but-unrecognized value
    // is a validation error (same shape convention as `priority` above).
    let tier = match raw.get("tier").map(String::as_str) {
        None | Some("title") => Tier::Title,
        Some("userMessages") => Tier::UserMessages,
        Some("fullText") => Tier::FullText,
        Some(_) => {
            details.push(json!({
                "code": "invalid_value",
                "values": ["title", "userMessages", "fullText"],
                "path": ["tier"],
                "message": "Invalid option: expected one of \"title\"|\"userMessages\"|\"fullText\"",
            }));
            Tier::Title
        }
    };

    // STATUS-STRIP: `includeKeys` (comma-separated; `shared/read-models.ts`
    // `z.array(z.string().min(1)).max(200)` — the 200-pane ceiling). Issues
    // join the SAME details
    // array as the fields above (zod collects issues across every violated
    // field into one response). The client self-enforces ≤200 via its own
    // schema parse (`getSessionDirectoryPage`), so the over-limit issue text
    // is not wire-probed byte-for-byte — a hand-rolled request beyond the cap
    // gets a 400 with a zod-flavored issue, enough for a 400 contract check
    // without pretending to byte-parity.
    let mut include_keys: Vec<String> = raw
        .get("includeKeys")
        .map(|v| {
            v.split(',')
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if include_keys.len() > 200 {
        details.push(json!({
            "code": "too_big",
            "maximum": 200,
            "path": ["includeKeys"],
            "message": "Too big: expected array to have <=200 items",
        }));
        include_keys.truncate(200);
    }

    if !details.is_empty() {
        return Err(json!(details));
    }

    let flag = |k: &str| raw.get(k).map(|v| v == "1" || v == "true").unwrap_or(false);
    Ok(DirQuery {
        query: raw.get("query").filter(|s| !s.is_empty()).cloned(),
        tier,
        cursor: raw.get("cursor").filter(|s| !s.is_empty()).cloned(),
        limit,
        include_subagents: flag("includeSubagents"),
        include_non_interactive: flag("includeNonInteractive"),
        include_empty: flag("includeEmpty"),
        include_keys,
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

/// STATUS-STRIP: monotonic per-process page sequence (`snapshotSeq`, stamped
/// on every session-directory response). NEVER derives from data (revision is
/// a max-activity timestamp and can decrease) — seeded from the wall clock so
/// a restarted process of the same instance never restamps lower than any
/// page it already served, then incremented per query via a single atomic.
fn next_snapshot_seq() -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    SEQ.fetch_max(now, std::sync::atomic::Ordering::Relaxed);
    SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
}

/// STATUS-STRIP: per-PROCESS boot nonce (`bootId`). Seq ordering is trusted
/// only within the same instance+boot (a clock-seeded counter cannot prove
/// monotonicity across restarts under wall-clock rewind).
fn directory_boot_id() -> &'static str {
    static BOOT_ID: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    BOOT_ID
        .get_or_init(|| format!("boot-{}", uuid::Uuid::new_v4()))
        .as_str()
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
    // STATUS-STRIP: assign the monotonic snapshot sequence AFTER the index
    // snapshot is captured — captured order is authoritative, and a seq
    // assigned pre-await would interleave with concurrent requests.
    let snapshot_seq = next_snapshot_seq();
    let items = apply_session_overrides(items, &state.settings.session_overrides());
    // Task 20: read-join `sessionType` from the SESSION-06 metadata store --
    // ONE `get_all()` per request (a cached read; disk is touched at most
    // once per store lifetime), mirroring the original indexer reading the
    // store snapshot while building items (`session-indexer.ts:1109,
    // :1144-1148`). Ordered after the overrides overlay (the original applies
    // `applyOverride` first, then the metadata `sessionType`) and BEFORE the
    // live-terminal join (the original's indexer output already carries
    // `sessionType` when `toItems` runs).
    let items = apply_session_metadata(items, &state.metadata.get_all().await);
    // Capture the revision before quarantining corrupt persisted rows. A
    // change to a conflicting source must still invalidate a client's cached
    // read model even though that source is not safe to render.
    let identities = state.identity.list();
    let revision = items
        .iter()
        .map(|item| item.last_activity_at)
        .chain(identities.iter().map(|identity| identity.updated_at))
        .max()
        .unwrap_or(0)
        .max(0);
    let collisions = persisted_identity_collisions(&items);
    let identity_collision = if !collisions.is_empty() {
        let log_summary = persisted_identity_collision_log_summary(&collisions);
        let collision_samples_json =
            serde_json::to_string(&log_summary.samples).unwrap_or_else(|_| "[]".to_string());
        tracing::error!(
            target: "freshell_server::session_directory",
            collision_count = log_summary.collision_count,
            duplicate_item_count = log_summary.duplicate_item_count,
            collision_sample_count = log_summary.samples.len(),
            collision_samples_truncated = log_summary.collision_samples_truncated,
            collision_samples_json = %collision_samples_json,
            "session_directory_identity_collision"
        );
        Some((
            collisions
                .iter()
                .map(|collision| collision.key.clone())
                .collect::<std::collections::HashSet<_>>(),
            log_summary.collision_count,
            log_summary.duplicate_item_count,
        ))
    } else {
        None
    };
    // A collision remains an ERROR-level integrity event, but a single copied
    // transcript must not make every healthy session inaccessible. Exclude
    // every ambiguous PERSISTED row (never choose an arbitrary file winner),
    // preserve all unambiguous rows, and allow the subsequent live-terminal
    // join to create a safe generic placeholder when applicable.
    let items = match &identity_collision {
        Some((keys, ..)) => items
            .into_iter()
            .filter(|item| !keys.contains(&item.key()))
            .collect(),
        None => items,
    };
    // Fix Spec: Session Naming Cluster (SYMPTOM 1) -- join the LIVE terminal
    // identity set against the parsed session items (`toItems`, `service.ts:132-151`).
    // `.list()` (live-only, excludes retired terminals): an exited terminal is not
    // part of the sidebar's "running" set, matching the original's
    // `TerminalMetadataService.list()` input to `toItems`.
    let items = join_live_terminals(items, &identities);
    match apply_query(items, &query, &identities) {
        Ok(mut page) => {
            page["revision"] = json!(revision);
            page["snapshotSeq"] = json!(snapshot_seq);
            page["serverInstance"] = json!(state.server_instance.as_str());
            page["bootId"] = json!(directory_boot_id());
            if let Some((_, collision_count, duplicate_item_count)) = identity_collision {
                // Keep an I/O/budget partial reason if the same request also
                // encountered one. Collision identity travels only in the
                // additive integrity object: an old cached SPA rejects an
                // unknown enum value but strips an unknown object field.
                if page.get("partial").is_none() {
                    page["partial"] = json!(true);
                }
                page["integrityError"] = json!({
                    "kind": "identity_collision",
                    "collisionCount": collision_count,
                    "duplicateItemCount": duplicate_item_count,
                });
            }
            // SESSION-05 (project colors, read half): embed the config's
            // `projectColors` map on the page when non-empty — the channel
            // the shared client's refetch-after-`sessions.changed` reads to
            // overlay each project group's header color
            // (`shared/read-models.ts`
            // `SessionDirectoryPageSchema.projectColors`; legacy mirror:
            // `server/session-directory/service.ts`). Omitted entirely when
            // empty, matching the legacy service's conditional assignment.
            let colors = state.settings.project_colors();
            if !colors.is_empty() {
                page["projectColors"] = Value::Object(colors);
            }
            Json(page).into_response()
        }
        // Bad cursor → 400, matching `querySessionDirectory`'s `/cursor/i` → 400.
        Err(msg) => (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": msg })),
        )
            .into_response(),
    }
}

#[derive(Debug, serde::Serialize)]
struct PersistedIdentityCollision {
    key: String,
    source_files: Vec<String>,
}

const IDENTITY_COLLISION_KEY_SAMPLE_LIMIT: usize = 20;
const IDENTITY_COLLISION_SOURCE_SAMPLE_LIMIT: usize = 4;

#[derive(Debug, serde::Serialize)]
struct PersistedIdentityCollisionLogSample {
    key: String,
    source_file_count: usize,
    source_files: Vec<String>,
    source_files_truncated: bool,
}

struct PersistedIdentityCollisionLogSummary {
    collision_count: usize,
    duplicate_item_count: usize,
    samples: Vec<PersistedIdentityCollisionLogSample>,
    collision_samples_truncated: bool,
}

/// Detect the server-owned session-directory identity invariant before any
/// visibility filter, search tier, cursor, pagination, or live-terminal join.
/// Provider is part of the identity, so the same raw session id from two
/// different providers is legal. Multiple persisted rows with the same
/// composite key are an ERROR-level integrity event; callers quarantine every
/// ambiguous persisted row instead of hiding the error or choosing an
/// arbitrary file winner.
fn persisted_identity_collisions(items: &[DirItem]) -> Vec<PersistedIdentityCollision> {
    // The sidebar hot path normally has no collision. Keep borrowed identity
    // references and source indices until a duplicate is proven so a healthy
    // request does not allocate a key and lossy path string for every row.
    enum Occurrences {
        First(usize),
        Duplicate(Vec<usize>),
    }

    let mut occurrences: std::collections::BTreeMap<(&str, &str), Occurrences> =
        std::collections::BTreeMap::new();
    for (index, item) in items.iter().enumerate() {
        use std::collections::btree_map::Entry;

        match occurrences.entry((&item.provider, &item.session_id)) {
            Entry::Vacant(entry) => {
                entry.insert(Occurrences::First(index));
            }
            Entry::Occupied(mut entry) => {
                let first_index = match entry.get() {
                    Occurrences::First(first_index) => Some(*first_index),
                    Occurrences::Duplicate(_) => None,
                };
                if let Some(first_index) = first_index {
                    entry.insert(Occurrences::Duplicate(vec![first_index, index]));
                } else if let Occurrences::Duplicate(indices) = entry.get_mut() {
                    indices.push(index);
                }
            }
        }
    }

    occurrences
        .into_iter()
        .filter_map(|((provider, session_id), occurrences)| {
            let Occurrences::Duplicate(indices) = occurrences else {
                return None;
            };
            let mut source_files: Vec<String> = indices
                .into_iter()
                .map(|index| {
                    items[index]
                        .source_file
                        .as_deref()
                        .map(|path| path.to_string_lossy().into_owned())
                        .unwrap_or_else(|| "<unknown>".to_string())
                })
                .collect();
            source_files.sort();
            Some(PersistedIdentityCollision {
                key: format!("{provider}:{session_id}"),
                source_files,
            })
        })
        .collect()
}

/// Build a deterministic, bounded diagnostic sample for the collision log.
/// Counts cover the complete collision set; only local-path context is
/// sampled so a corrupt corpus cannot create an unbounded single JSONL event.
fn persisted_identity_collision_log_summary(
    collisions: &[PersistedIdentityCollision],
) -> PersistedIdentityCollisionLogSummary {
    let samples = collisions
        .iter()
        .take(IDENTITY_COLLISION_KEY_SAMPLE_LIMIT)
        .map(|collision| PersistedIdentityCollisionLogSample {
            key: collision.key.clone(),
            source_file_count: collision.source_files.len(),
            source_files: collision
                .source_files
                .iter()
                .take(IDENTITY_COLLISION_SOURCE_SAMPLE_LIMIT)
                .cloned()
                .collect(),
            source_files_truncated: collision.source_files.len()
                > IDENTITY_COLLISION_SOURCE_SAMPLE_LIMIT,
        })
        .collect();
    PersistedIdentityCollisionLogSummary {
        collision_count: collisions.len(),
        duplicate_item_count: collisions
            .iter()
            .map(|collision| collision.source_files.len())
            .sum(),
        samples,
        collision_samples_truncated: collisions.len() > IDENTITY_COLLISION_KEY_SAMPLE_LIMIT,
    }
}

/// Resolve the REAL home directory for coding-CLI provider transcript
/// sources (claude/codex), deliberately IGNORING `FRESHELL_HOME`.
///
/// Legacy parity: `server/claude-home.ts` (`getClaudeHome`) and
/// `server/coding-cli/providers/codex.ts` (`defaultCodexHome`) both derive
/// from `os.homedir()` directly -- NEVER from `getFreshellHomeDir()`
/// (`server/freshell-home.ts`), which is reserved for the isolated
/// `.freshell/config.json` root (`server/config-store.ts:79`,
/// `server/bootstrap.ts:168`). `FRESHELL_HOME` re-roots the config dir ONLY;
/// provider session directories always resolve against the real `HOME`
/// (`CLAUDE_HOME`/`CODEX_HOME` overrides are applied afterwards, inside
/// [`claude_home`]/[`codex_home`] themselves).
///
/// Fixes a bake-in-launch regression: `main.rs`'s single `resolve_home()`
/// (FRESHELL_HOME-then-HOME) previously fed BOTH the settings-store's
/// isolated config root AND this module's provider-source wiring, so a
/// launch that set `FRESHELL_HOME` to a temp dir (while leaving `HOME` as
/// the real user home) made claude/codex sessions invisible -- they were
/// looked up under `<FRESHELL_HOME>/.claude` / `.codex`, which don't exist.
///
/// Windows/Tauri parity: Node derives these via `os.homedir()` (libuv
/// `uv_os_homedir`), whose PLATFORM semantics matter -- production Tauri
/// deliberately inherits the desktop environment WITHOUT setting `HOME`
/// (`freshell-tauri/src/lib.rs`, `home: None`). On Windows, `os.homedir()`
/// reads `USERPROFILE` (HOME is NEVER consulted); on POSIX it reads `HOME`
/// when set and non-empty, else the effective user's passwd-entry home
/// (`getpwuid_r`) -- so the POSIX result is Some even with HOME unset, and
/// `main.rs` still constructs a real session index (no permanent `warming`).
/// Rust's `std::env::home_dir()` (un-deprecated since 1.87, MSRV here is
/// 1.96) implements exactly these platform rules -- USERPROFILE-else-profile
/// API on Windows, non-empty-HOME-else-`getpwuid_r` on unix, never an empty
/// path -- so this delegates to it. An earlier interim version approximated
/// this as HOME-then-USERPROFILE on ALL platforms; that both consulted
/// USERPROFILE on POSIX (Node never does) and preferred HOME on Windows
/// (Node never reads it).
pub(crate) fn provider_home() -> Option<PathBuf> {
    std::env::home_dir()
}

/// Serializes tests (crate-wide) that mutate the process-global
/// `HOME`/`USERPROFILE`/`CLAUDE_HOME`/`FRESHELL_HOME` env vars: cargo runs
/// tests in parallel THREADS within one process, so two tests racing to
/// mutate the SAME vars would otherwise flake (one test's assertion
/// observing the OTHER test's in-flight env state). Shared `pub(crate)` so
/// `main.rs`'s resolve-wiring tests serialize with this module's
/// `provider_home()` tests.
#[cfg(test)]
pub(crate) static HOME_ENV_TEST_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Test-only oracle for the effective user's passwd-entry home directory
/// (`getpwuid_r`) — the Node `os.homedir()` POSIX fallback when `HOME` is
/// unset or empty. `pub(crate)` so `main.rs`'s resolve-wiring tests assert
/// against the SAME fallback value [`provider_home`] must produce.
#[cfg(all(test, unix))]
pub(crate) fn passwd_entry_home() -> PathBuf {
    use std::os::unix::ffi::OsStrExt;
    let uid = unsafe { libc::geteuid() };
    let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0u8; 16 * 1024];
    let mut result: *mut libc::passwd = std::ptr::null_mut();
    let rc = unsafe {
        libc::getpwuid_r(
            uid,
            &mut pwd,
            buf.as_mut_ptr().cast::<libc::c_char>(),
            buf.len(),
            &mut result,
        )
    };
    assert_eq!(rc, 0, "getpwuid_r must succeed for the effective uid");
    assert!(!result.is_null(), "effective uid must have a passwd entry");
    let dir = unsafe { std::ffi::CStr::from_ptr(pwd.pw_dir) };
    PathBuf::from(std::ffi::OsStr::from_bytes(dir.to_bytes()))
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

/// `defaultCodexHome()` (`providers/codex.ts:25-27`): `CODEX_HOME` env else
/// `<home>/.codex` -- same shape as [`claude_home`]. Batch C:
/// `freshell_sessions::directory_index::CodexSource` joins `sessions` itself
/// (mirroring `ClaudeSource` joining `projects`), so callers pass this
/// resolved codex home, not the sessions dir.
pub(crate) fn codex_home(home: &Path) -> PathBuf {
    match std::env::var("CODEX_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => home.join(".codex"),
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
        legacy_session_id: idx.legacy_session_id.clone(),
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
        running_terminal_id: None,
        live_terminal_only: false,
        session_type: None,
        title_source: idx.title_source.clone(),
        source_file: idx.source_file.clone(),
        token_usage: idx.token_usage.clone(),
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
    let is_subagent = force_subagent || meta.is_subagent.unwrap_or(false);
    // Keep the test-only differential oracle aligned with production: choose
    // Claude's filename identity during construction. Child transcripts embed
    // their parent id, which is not a child compatibility alias.
    let legacy_session_id = (!is_subagent)
        .then_some(meta.session_id.as_deref())
        .flatten()
        .filter(|session_id| *session_id != fallback)
        .map(str::to_owned);
    Some(item_from_meta(
        &meta,
        "claude",
        fallback,
        force_subagent,
        Some(path.to_path_buf()),
        legacy_session_id,
    ))
}

/// Build a [`DirItem`] from a parsed meta (pure — unit-tested). `session_id` falls
/// back to the file basename when the parser found no canonical id.
///
/// `#[cfg(test)]`: test-only, same rationale as `list_claude_sessions` above.
#[cfg(test)]
fn item_from_meta(
    meta: &ParsedSessionMeta,
    provider: &str,
    session_id: String,
    force_subagent: bool,
    source_file: Option<PathBuf>,
    legacy_session_id: Option<String>,
) -> DirItem {
    DirItem {
        session_id,
        legacy_session_id,
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
        running_terminal_id: None,
        live_terminal_only: false,
        session_type: None,
        title_source: meta.title_source.clone(),
        source_file,
        token_usage: None,
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
    let canonical_keys: std::collections::HashSet<String> =
        items.iter().map(DirItem::key).collect();
    items
        .into_iter()
        .filter_map(|mut item| {
            let canonical_key = item.key();
            // A compatibility identity is usable only after its canonical
            // row disappeared. Otherwise a copied transcript would inherit
            // the original's rename, archive, or deleted state.
            let legacy_key = item
                .legacy_key()
                .filter(|key| !canonical_keys.contains(key));
            let ov = overrides
                .get(&canonical_key)
                .or_else(|| legacy_key.as_ref().and_then(|key| overrides.get(key)))
                .and_then(Value::as_object);
            if let Some(ov) = ov {
                if ov.get("deleted").and_then(Value::as_bool).unwrap_or(false) {
                    return None;
                }
                if let Some(t) = ov.get("titleOverride").and_then(Value::as_str) {
                    // Node's applyOverride guard (`session-indexer.ts:210-214`):
                    // the override title applies iff it is NON-EMPTY (JS `!!`)
                    // AND NOT (the PARSED source is 'provider-generated' AND
                    // the row's `titleSource` is exactly 'dir'/'first-message',
                    // strict `===` -- 'ai'/'user'/absent/any-other row source
                    // still applies). Without this, the auto-title sweep's
                    // dir/first-message row re-shadows a provider-generated
                    // title within one 2s tick of the ai-title-shadow-cleanup
                    // migration clearing it.
                    let row_source = ov.get("titleSource").and_then(Value::as_str);
                    let provider_generated_shadow = item.title_source.as_deref()
                        == Some("provider-generated")
                        && matches!(row_source, Some("dir") | Some("first-message"));
                    if !t.is_empty() && !provider_generated_shadow {
                        item.title = Some(t.to_string());
                    }
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

/// Task 20 (read-join): overlay `sessionType` from the SESSION-06 metadata
/// store onto matching items, keyed by `provider:sessionId` -- ports the
/// original indexer's read-join (`session-indexer.ts:1144-1148`: `const meta
/// = sessionMetadata[metaKey]; if (meta?.sessionType) merged.sessionType =
/// meta.sessionType`). The JS truthiness gate means an absent, non-string, or
/// EMPTY `sessionType` never applies.
fn apply_session_metadata(
    items: Vec<DirItem>,
    metadata: &std::collections::HashMap<String, Value>,
) -> Vec<DirItem> {
    let canonical_keys: std::collections::HashSet<String> =
        items.iter().map(DirItem::key).collect();
    items
        .into_iter()
        .map(|mut item| {
            let canonical_key = item.key();
            // Match the override path: never let a still-present canonical
            // original's metadata spill into a copied transcript.
            let legacy_key = item
                .legacy_key()
                .filter(|key| !canonical_keys.contains(key));
            if let Some(session_type) = metadata
                .get(&canonical_key)
                .or_else(|| legacy_key.as_ref().and_then(|key| metadata.get(key)))
                .and_then(|entry| entry.get("sessionType"))
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                item.session_type = Some(session_type.to_string());
            }
            item
        })
        .collect()
}

// ── Sidebar join (Fix Spec: Session Naming Cluster, SYMPTOM 1) ─────────────
//
// Ports `toItems`/`joinRunningState`/`buildLiveTerminalSessionItem`/
// `providerDisplayName` (`session-directory/service.ts:77-151`): fuse the LIVE
// terminal identity set into the parsed session-file items so a coding-CLI
// session currently running in a terminal shows `isRunning`/`runningTerminalId`
// on its (one) sidebar entry, and a terminal with no matching session-file item
// yet gets exactly ONE synthesized entry instead of being invisible.
//
// Deliberately NOT built here (fenced by the fix spec): no filesystem watcher,
// no cwd-fuzzy join (the join key is `provider:sessionId` ONLY, matching the
// original), no server-side pane-layout store, no client edits. A freshly
// created `codex` terminal with no session id yet surfaces as a
// `liveTerminalOnly` item that an index refresh may briefly duplicate once its
// session file appears — a TRANSIENT pre-adoption window (pinned by a test
// below), not a permanent residual: the B2 codex locator
// (`freshell_ws::codex_identity`) adopts the real session id into the identity
// registry, after which the rung-1 registry consultation here
// (`join_running_state`, dedupe in `join_live_terminals`) collapses the pair
// to one entry. A rung-2 `PaneLedger` fallback for this join was evaluated
// during P1.14 planning and deliberately REJECTED: no production window exists
// where a live identity lacks a `session_id` while a Bound ledger row covers
// its current terminal id, so the fallback would be dormant machinery.

/// `providerDisplayName` (`service.ts:97-108`).
fn provider_display_name(provider: &str) -> String {
    match provider {
        "claude" => "Claude CLI".to_string(),
        "codex" => "Codex CLI".to_string(),
        "opencode" => "OpenCode".to_string(),
        other => other.to_string(),
    }
}

/// `joinRunningState` (`service.ts:77-95`): a session-file item whose
/// `provider:sessionId` matches a LIVE terminal identity gains
/// `isRunning`/`runningTerminalId`; no match clears both (matching the
/// original's explicit `isRunning: false` no-match arm).
fn join_running_state(
    mut item: DirItem,
    identities: &[freshell_ws::identity::TerminalIdentity],
) -> DirItem {
    let matched = identities.iter().find(|identity| {
        identity.provider.as_deref() == Some(item.provider.as_str())
            && identity.session_id.as_deref() == Some(item.session_id.as_str())
    });
    match matched {
        Some(identity) => {
            item.is_running = true;
            item.running_terminal_id = Some(identity.terminal_id.clone());
        }
        None => {
            item.is_running = false;
            item.running_terminal_id = None;
        }
    }
    item
}

/// `buildLiveTerminalSessionItem` (`service.ts:110-130`): synthesize a sidebar
/// item for a live terminal identity, for the "no session-file item exists
/// (yet)" case. `None` when the identity has no coding-CLI `provider` at all
/// (a plain shell — the original's `if (!meta.provider) return undefined`).
fn build_live_terminal_session_item(
    identity: &freshell_ws::identity::TerminalIdentity,
) -> Option<DirItem> {
    let provider = identity.provider.clone()?;
    let session_id = identity
        .session_id
        .clone()
        .unwrap_or_else(|| format!("terminal:{}", identity.terminal_id));
    let project_path = identity
        .cwd
        .clone()
        .unwrap_or_else(|| format!("terminal:{}", identity.terminal_id));
    Some(DirItem {
        session_id,
        legacy_session_id: None,
        provider: provider.clone(),
        project_path,
        title: Some(provider_display_name(&provider)),
        summary: None,
        first_user_message: None,
        last_activity_at: identity.updated_at,
        created_at: Some(identity.updated_at),
        cwd: identity.cwd.clone(),
        // Bug-1 (sidebar rail): a live terminal launched at a subagent
        // session projects the classification; the client's existing
        // showSubagents filter (sidebarSelectors.ts:656) then hides it.
        is_subagent: identity.is_subagent.unwrap_or(false),
        is_non_interactive: false,
        is_running: true,
        archived: false,
        matched_in: None,
        snippet: None,
        running_terminal_id: Some(identity.terminal_id.clone()),
        live_terminal_only: identity.session_id.is_none(),
        session_type: Some(provider),
        // A synthesized live-terminal item has no parsed transcript, hence no
        // parsed title source (Node's `buildLiveTerminalSessionItem` sets no
        // `titleSource` either, `service.ts:110-130`).
        title_source: None,
        source_file: None,
        // PARITY NOTE: Rust's `TerminalIdentity` carries no token usage, so a
        // live-terminal-only row reports none here — unlike Node, whose
        // `TerminalMeta` carries `tokenUsage`. Fresh-agent pane sessions are
        // indexed from transcripts (their usage arrives via that path), so
        // this gap only covers pre-adoption transient rows.
        token_usage: None,
    })
}

/// `toItems` (`service.ts:132-151`): join every parsed item against the live
/// set, then append exactly ONE synthesized item per UNMATCHED live identity
/// (deduped by `provider:sessionId` — a matched live terminal never also emits
/// a `liveTerminalOnly` duplicate).
fn join_live_terminals(
    items: Vec<DirItem>,
    identities: &[freshell_ws::identity::TerminalIdentity],
) -> Vec<DirItem> {
    let mut items: Vec<DirItem> = items
        .into_iter()
        .map(|item| join_running_state(item, identities))
        .collect();
    let mut existing_keys: std::collections::HashSet<String> =
        items.iter().map(DirItem::key).collect();

    for identity in identities {
        let Some(candidate) = build_live_terminal_session_item(identity) else {
            continue;
        };
        let key = candidate.key();
        if existing_keys.contains(&key) {
            continue;
        }
        existing_keys.insert(key);
        items.push(candidate);
    }
    items
}

#[cfg(test)]
mod join_tests {
    use super::*;
    use freshell_ws::identity::TerminalIdentityRegistry;

    struct LinkedWorktreeFixture {
        root: std::path::PathBuf,
        project: std::path::PathBuf,
        checkout: std::path::PathBuf,
        gitdir: std::path::PathBuf,
    }

    impl LinkedWorktreeFixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "freshell-session-directory-worktree-{}-{}",
                std::process::id(),
                uuid::Uuid::new_v4()
            ));
            let project = root.join("project");
            let checkout = root.join("checkouts/feature");
            let gitdir = root.join("administrative/.git/worktrees/feature");
            std::fs::create_dir_all(project.join(".git")).unwrap();
            std::fs::create_dir_all(&checkout).unwrap();
            std::fs::create_dir_all(&gitdir).unwrap();
            std::fs::write(
                checkout.join(".git"),
                format!("gitdir: {}\n", gitdir.display()),
            )
            .unwrap();
            std::fs::write(gitdir.join("commondir"), "../../../../project/.git\n").unwrap();

            Self {
                root,
                project,
                checkout,
                gitdir,
            }
        }
    }

    impl Drop for LinkedWorktreeFixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    fn file_item(provider: &str, session_id: &str, last_activity_at: i64) -> DirItem {
        DirItem {
            session_id: session_id.to_string(),
            legacy_session_id: None,
            provider: provider.to_string(),
            project_path: "/repo".to_string(),
            title: Some("A real session".to_string()),
            summary: None,
            first_user_message: None,
            last_activity_at,
            created_at: Some(last_activity_at),
            cwd: Some("/repo".to_string()),
            is_subagent: false,
            is_non_interactive: false,
            is_running: false,
            archived: false,
            matched_in: None,
            snippet: None,
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file: None,
            token_usage: None,
        }
    }

    #[test]
    fn linked_worktree_payload_keeps_checkout_path_separate_from_project_path() {
        let fixture = LinkedWorktreeFixture::new();
        assert_eq!(
            std::fs::read_to_string(fixture.checkout.join(".git")).unwrap(),
            format!("gitdir: {}\n", fixture.gitdir.display())
        );
        assert_eq!(
            std::fs::read_to_string(fixture.gitdir.join("commondir")).unwrap(),
            "../../../../project/.git\n"
        );
        let checkout_path = fixture.checkout.to_string_lossy().into_owned();
        let project_path = fixture.project.to_string_lossy().into_owned();
        assert_eq!(
            freshell_platform::git_meta::resolve_git_repo_root(&checkout_path).as_deref(),
            Some(project_path.as_str()),
            "the commondir fixture must select the common repository, not the administrative fallback"
        );

        let mut item = file_item("claude", "session-1", 1);
        item.project_path = project_path.clone();
        item.cwd = Some(checkout_path.clone());
        let payload = item.to_value();

        assert_eq!(payload["projectPath"], serde_json::json!(project_path));
        assert_eq!(payload["checkoutPath"], serde_json::json!(checkout_path));
        assert_eq!(payload["cwd"], serde_json::json!(checkout_path));
    }

    // ── provider_display_name ──

    #[test]
    fn provider_display_name_matches_known_providers_and_falls_back_to_raw() {
        assert_eq!(provider_display_name("claude"), "Claude CLI");
        assert_eq!(provider_display_name("codex"), "Codex CLI");
        assert_eq!(provider_display_name("opencode"), "OpenCode");
        assert_eq!(provider_display_name("amplifier"), "amplifier");
    }

    // ── join_running_state ──

    #[test]
    fn join_running_state_matches_live_terminal_and_sets_running_fields() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("term-1", Some("claude"), Some("sess-1"), None, 1000);
        let item = file_item("claude", "sess-1", 500);

        let joined = join_running_state(item, &reg.list());
        assert!(joined.is_running);
        assert_eq!(joined.running_terminal_id.as_deref(), Some("term-1"));
    }

    #[test]
    fn join_running_state_no_match_leaves_not_running() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("term-1", Some("claude"), Some("other-session"), None, 1000);
        let item = file_item("claude", "sess-1", 500);

        let joined = join_running_state(item, &reg.list());
        assert!(!joined.is_running);
        assert_eq!(joined.running_terminal_id, None);
    }

    // ── build_live_terminal_session_item ──

    #[test]
    fn build_live_terminal_session_item_none_without_a_provider() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("term-1", None, None, None, 1000);
        let identity = reg.list().into_iter().next().unwrap();
        assert!(build_live_terminal_session_item(&identity).is_none());
    }

    #[test]
    fn build_live_terminal_session_item_with_session_id_is_not_live_terminal_only() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert(
            "term-9",
            Some("opencode"),
            Some("sess-77"),
            Some("/home/dan/project"),
            2000,
        );
        let identity = reg.list().into_iter().next().unwrap();
        let item = build_live_terminal_session_item(&identity).expect("has provider");

        assert_eq!(item.provider, "opencode");
        assert_eq!(item.session_id, "sess-77");
        assert_eq!(item.project_path, "/home/dan/project");
        assert_eq!(item.title.as_deref(), Some("OpenCode"));
        assert_eq!(item.session_type.as_deref(), Some("opencode"));
        assert!(item.is_running);
        assert_eq!(item.running_terminal_id.as_deref(), Some("term-9"));
        assert!(!item.live_terminal_only);
        assert_eq!(item.last_activity_at, 2000);
    }

    /// Bug-1 (sidebar rail): a live terminal launched at a subagent session
    /// projects the identity classification onto the synthesized item (and its
    /// `isSubagent` wire emission); unclassified identities stay non-subagent.
    #[test]
    fn live_terminal_item_mirrors_identity_subagent_flag() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert(
            "term-9",
            Some("opencode"),
            Some("sess-77"),
            Some("/home/dan/project"),
            2000,
        );
        let mut identity = reg.list().into_iter().next().unwrap();
        identity.is_subagent = Some(true);
        let item = build_live_terminal_session_item(&identity).expect("item");
        assert!(item.is_subagent, "identity Some(true) must project");
        assert_eq!(item.to_value()["isSubagent"], serde_json::json!(true));

        identity.is_subagent = None;
        let item = build_live_terminal_session_item(&identity).expect("item");
        assert!(!item.is_subagent, "unclassified stays non-subagent");
    }

    /// A codex terminal established at create time with NO session id yet
    /// (`buildLiveTerminalSessionItem`, `service.ts:128`, `!meta.sessionId`).
    #[test]
    fn build_live_terminal_session_item_without_session_id_is_live_terminal_only() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("term-5", Some("codex"), None, None, 3000);
        let identity = reg.list().into_iter().next().unwrap();
        let item = build_live_terminal_session_item(&identity).expect("has provider");

        assert!(item.live_terminal_only);
        assert_eq!(item.session_id, "terminal:term-5");
        assert_eq!(item.project_path, "terminal:term-5");
        assert_eq!(item.title.as_deref(), Some("Codex CLI"));
    }

    // ── join_live_terminals (toItems) ──

    /// One session-file item + its matching live terminal -> ONE item, tagged
    /// running (never a duplicate for a matched terminal).
    #[test]
    fn join_live_terminals_matched_session_yields_one_running_item() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("term-1", Some("claude"), Some("sess-1"), None, 1000);
        let items = vec![file_item("claude", "sess-1", 500)];

        let joined = join_live_terminals(items, &reg.list());
        assert_eq!(joined.len(), 1);
        assert!(joined[0].is_running);
        assert_eq!(joined[0].running_terminal_id.as_deref(), Some("term-1"));
    }

    /// A live terminal with NO matching session-file item yet synthesizes
    /// exactly ONE extra `liveTerminalOnly` item.
    #[test]
    fn join_live_terminals_unmatched_terminal_synthesizes_one_live_only_item() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("term-2", Some("codex"), None, None, 4000);

        let joined = join_live_terminals(Vec::new(), &reg.list());
        assert_eq!(joined.len(), 1);
        assert!(joined[0].live_terminal_only);
        assert_eq!(joined[0].running_terminal_id.as_deref(), Some("term-2"));
    }

    /// Dedup: a live terminal that MATCHES an existing session-file item must
    /// never ALSO emit a synthesized `liveTerminalOnly` duplicate for the same
    /// `provider:sessionId` key.
    #[test]
    fn join_live_terminals_matched_terminal_is_never_double_emitted() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("term-3", Some("claude"), Some("sess-3"), None, 1000);
        let items = vec![file_item("claude", "sess-3", 500)];

        let joined = join_live_terminals(items, &reg.list());
        assert_eq!(joined.len(), 1, "no duplicate for a matched terminal");
    }

    /// A TRANSIENT pre-adoption window (P1.14): a fresh codex terminal
    /// identity (no session id, hence keyed `terminal:<id>`) and an
    /// ALREADY-INDEXED codex session file with its own real session id are
    /// DIFFERENT join keys -- codex assigns its own session id independently,
    /// so BOTH surface until the B2 codex locator
    /// (`freshell_ws::codex_identity`) adopts the real session id into the
    /// identity registry. After adoption, the EXISTING rung-1 registry
    /// consultation here (`join_running_state`, dedupe in
    /// `join_live_terminals`) collapses the pair to one entry, and the
    /// identity-aware sweep (`main.rs`, Task 3) pushes the refresh. Pinned
    /// here: the NO-IDENTITY input still yields two entries -- the duplicate
    /// is transient pending locator adoption, no longer a permanent residual.
    #[test]
    fn codex_fresh_terminal_pre_adoption_duplicate_is_transient_pending_locator_adoption() {
        let reg = TerminalIdentityRegistry::new();
        // The live terminal, no session id yet (pre-adoption).
        reg.upsert("term-codex", Some("codex"), None, None, 5000);
        // The session file the codex CLI eventually writes, under ITS OWN real
        // session id -- a different join key than `terminal:term-codex`.
        let items = vec![file_item("codex", "real-codex-session-id", 4500)];

        let joined = join_live_terminals(items, &reg.list());
        assert_eq!(
            joined.len(),
            2,
            "pre-adoption: unassociated codex terminal + its session file don't merge yet"
        );
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
fn apply_query(
    mut items: Vec<DirItem>,
    q: &DirQuery,
    identities: &[freshell_ws::identity::TerminalIdentity],
) -> Result<Value, String> {
    let limit = q
        .limit
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS);
    let cursor = match &q.cursor {
        Some(c) => Some(decode_cursor(c)?),
        None => None,
    };

    // revision = max(0, all lastActivityAt, all terminal-identity updatedAt)
    // (`querySessionDirectory`, `service.ts:232-236`). Computed independently of
    // the joined `items` list (not derived from it) so a LIVE terminal's
    // identity-only `updated_at` (e.g. a rename that hasn't reached the parsed
    // session file yet) still bumps the revision even when that terminal is
    // already matched onto an existing session-file item (whose own
    // `last_activity_at` may lag behind).
    let revision = items
        .iter()
        .map(|i| i.last_activity_at)
        .chain(identities.iter().map(|i| i.updated_at))
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

    // STATUS-STRIP: snapshot the extras candidate list BEFORE the sidebar
    // visibility filters too — a fresh-agent pane's own session may be
    // subagent-classed, non-interactive, or untitled/idle, and its meter must
    // stay live regardless of the sidebar window's filtering state. Extras are
    // returned out-of-band and never merged into `items`, so lowering the
    // visibility bar here cannot leak hidden rows into the sidebar. The
    // snapshot carries ONLY the three fields the extras need (never a full
    // per-request DirItem clone).
    let extras_candidates: Option<
        Vec<(
            String,
            String,
            Option<freshell_sessions::meta::TokenSummary>,
        )>,
    > = if q.include_keys.is_empty() {
        None
    } else {
        Some(
            items
                .iter()
                .map(|i| {
                    (
                        i.provider.clone(),
                        i.session_id.clone(),
                        i.token_usage.clone(),
                    )
                })
                .collect(),
        )
    };

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

    // SESSION-07: search dispatch (service.ts:266-278). `title` stays the
    // existing metadata-only path (`applySearch:66-75`); `userMessages`/
    // `fullText` scan the source transcripts (`applyFileSearch:153-226`) and
    // may report `partial`/`partialReason`.
    let mut partial = false;
    let mut partial_reason: Option<&'static str> = None;
    if let Some(query_text) = q.query.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        match q.tier {
            Tier::Title => {
                items = items
                    .into_iter()
                    .filter_map(|i| apply_title_search(i, query_text))
                    .collect();
            }
            Tier::UserMessages | Tier::FullText => {
                let file_tier = if q.tier == Tier::UserMessages {
                    FileSearchTier::UserMessages
                } else {
                    FileSearchTier::FullText
                };
                let result = apply_file_search(items, query_text, file_tier, limit);
                items = result.items;
                partial = result.partial;
                partial_reason = result.partial_reason;
            }
        }
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

    let mut page = json!({
        "items": page_items,
        "nextCursor": next_cursor,
        "revision": revision,
    });
    // `SessionDirectoryPage.partial`/`partialReason` (`shared/read-models.ts:66-67`):
    // omitted entirely when not partial (matches the zod `.optional()` shape;
    // the original only sets these keys at all inside `if (partial) {...}`,
    // `service.ts:293-296`).
    if partial {
        page["partial"] = json!(true);
        if let Some(reason) = partial_reason {
            page["partialReason"] = json!(reason);
        }
    }

    // STATUS-STRIP: out-of-band usage for `includeKeys` sessions that fell
    // outside this page's `items` (search-filtered or paged out). Omitted
    // entirely when nothing matched (zod `.optional()` shape — the original
    // only sets the key when there is at least one extra).
    if let Some(candidates) = extras_candidates {
        let page_keys: std::collections::HashSet<String> =
            items.iter().take(limit).map(DirItem::key).collect();
        let wanted: std::collections::HashSet<&str> =
            q.include_keys.iter().map(String::as_str).collect();
        let extras: Vec<Value> = candidates
            .iter()
            .filter(|(provider, session_id, _)| {
                let key = format!("{provider}:{session_id}");
                wanted.contains(key.as_str()) && !page_keys.contains(&key)
            })
            .map(|(provider, session_id, token_usage)| {
                let mut o = Map::new();
                o.insert("provider".into(), json!(provider));
                o.insert("sessionId".into(), json!(session_id));
                if let Some(u) = token_usage {
                    o.insert("tokenUsage".into(), token_usage_value(u));
                }
                Value::Object(o)
            })
            .collect();
        if !extras.is_empty() {
            page["contextUsageExtras"] = json!(extras);
        }
    }
    Ok(page)
}

/// The file-tier search outcome: the (possibly annotated + reordered-to-matches)
/// item list plus the `partial`/`partialReason` page annotations.
struct FileSearchOutcome {
    items: Vec<DirItem>,
    partial: bool,
    partial_reason: Option<&'static str>,
}

/// `applyFileSearch` (`service.ts:153-226`): scan each post-cursor item's
/// source transcript for the `userMessages`/`fullText` tiers. Bounded by a
/// scan budget (`maxScan = limit * 10`, `service.ts:176`) and an early stop
/// once `limit + 1` matches accumulate (`service.ts:182`) -- the `+1` lets
/// [`apply_query`]'s existing `items.len() > limit` next-cursor check detect
/// "more exist" without this function ever scanning the entire remaining
/// list (unlike the title tier, which does).
///
/// An item with no [`DirItem::source_file`] (a live-terminal-only item, or a
/// provider with no per-file source -- opencode/amplifier) or an unsupported
/// `provider` is skipped WITHOUT counting against the scan budget, mirroring
/// `service.ts:191-195`'s `if (!sourceFile) continue` / `if (!provider) continue`
/// (both `continue` before the `scanned++` at :197).
fn apply_file_search(
    items: Vec<DirItem>,
    query_text: &str,
    tier: FileSearchTier,
    limit: usize,
) -> FileSearchOutcome {
    let max_scan = limit * 10;
    let mut results: Vec<DirItem> = Vec::new();
    let mut scanned = 0usize;
    let mut partial = false;
    let mut partial_reason: Option<&'static str> = None;

    for item in items {
        if results.len() > limit {
            break;
        }
        if scanned >= max_scan {
            partial = true;
            partial_reason = Some("budget");
            break;
        }
        let Some(source_file) = item.source_file.clone() else {
            continue;
        };
        if !matches!(item.provider.as_str(), "claude" | "codex") {
            continue;
        }
        scanned += 1;

        match search_session_file(&source_file, &item.provider, query_text, tier) {
            Ok(Some(m)) => {
                let mut matched = item;
                matched.matched_in = Some(m.matched_in.to_string());
                matched.snippet = Some(m.snippet);
                results.push(matched);
            }
            Ok(None) => {}
            Err(_) => {
                partial = true;
                if partial_reason.is_none() {
                    partial_reason = Some("io_error");
                }
            }
        }
    }

    FileSearchOutcome {
        items: results,
        partial,
        partial_reason,
    }
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

    /// A fresh, unique temp dir for Batch C's codex/opencode handler tests
    /// (which need a bare `<home>` to nest `.codex`/`opencode-data` under,
    /// unlike `claude_home_with`'s claude-specific layout).
    fn unique_temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!(
            "freshell-sessdir-batchc-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ))
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

    // `provider_home()` (FRESHELL_HOME root-alignment fix): coding-CLI provider
    // session sources must resolve against the REAL `HOME`, never the
    // `FRESHELL_HOME`-overridden config root. Each test saves + restores both
    // vars around itself since they're real process env (no injected `Env`
    // plumbing exists at this call site), matching the existing convention in
    // `files.rs` (`expand_tilde_uses_home` et al.) -- but ALSO serializes on
    // `PROVIDER_HOME_ENV_LOCK` because cargo runs tests in parallel THREADS
    // within one process: two tests racing to mutate the SAME process-global
    // `HOME`/`FRESHELL_HOME` vars would otherwise flake (one test's assertion
    // observing the OTHER test's in-flight env state). The lock itself is the
    // crate-wide `HOME_ENV_TEST_LOCK` (module level, above) so `main.rs`'s
    // resolve-wiring tests serialize with these.
    use super::HOME_ENV_TEST_LOCK as PROVIDER_HOME_ENV_LOCK;

    #[cfg(unix)]
    #[test]
    fn provider_home_ignores_freshell_home_uses_real_home() {
        let _guard = PROVIDER_HOME_ENV_LOCK.lock().unwrap();
        let saved_freshell_home = std::env::var("FRESHELL_HOME").ok();
        let saved_home = std::env::var("HOME").ok();

        std::env::set_var("FRESHELL_HOME", "/tmp/freshell-isolated-config-root");
        std::env::set_var("HOME", "/home/real-user-fixture");

        assert_eq!(
            provider_home(),
            Some(PathBuf::from("/home/real-user-fixture")),
            "provider_home() must resolve the real HOME, ignoring FRESHELL_HOME"
        );

        match saved_freshell_home {
            Some(v) => std::env::set_var("FRESHELL_HOME", v),
            None => std::env::remove_var("FRESHELL_HOME"),
        }
        match saved_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }

    // Node `os.homedir()` platform semantics (libuv `uv_os_homedir`): on
    // POSIX an unset (or empty) HOME falls back to the EFFECTIVE USER'S
    // passwd-entry home (`getpwuid_r`) — USERPROFILE is NEVER consulted, and
    // the result is still Some, so `main.rs` still constructs a real session
    // index instead of `session_index: None` (permanent `warming`). On
    // Windows only USERPROFILE is read (HOME is never consulted).
    #[cfg(unix)]
    #[test]
    fn provider_home_unix_uses_passwd_entry_when_home_and_userprofile_unset() {
        let _guard = PROVIDER_HOME_ENV_LOCK.lock().unwrap();
        let saved_freshell_home = std::env::var("FRESHELL_HOME").ok();
        let saved_home = std::env::var("HOME").ok();
        let saved_userprofile = std::env::var("USERPROFILE").ok();

        std::env::set_var("FRESHELL_HOME", "/tmp/freshell-isolated-config-root-2");
        std::env::remove_var("HOME");
        std::env::remove_var("USERPROFILE");

        let resolved = provider_home();
        assert!(
            resolved.is_some(),
            "POSIX must still resolve a home with HOME unset (passwd-entry fallback)"
        );
        assert_eq!(
            resolved,
            Some(super::passwd_entry_home()),
            "an unset HOME must fall back to the passwd-entry home (Node os.homedir() POSIX semantics)"
        );

        match saved_freshell_home {
            Some(v) => std::env::set_var("FRESHELL_HOME", v),
            None => std::env::remove_var("FRESHELL_HOME"),
        }
        match saved_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match saved_userprofile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_home_unix_ignores_userprofile_when_home_unset() {
        let _guard = PROVIDER_HOME_ENV_LOCK.lock().unwrap();
        let saved_home = std::env::var("HOME").ok();
        let saved_userprofile = std::env::var("USERPROFILE").ok();

        std::env::remove_var("HOME");
        std::env::set_var("USERPROFILE", "/Users/win-fixture");

        let resolved = provider_home();
        assert_ne!(
            resolved,
            Some(PathBuf::from("/Users/win-fixture")),
            "POSIX must NEVER consult USERPROFILE (Node os.homedir() reads it on Windows only)"
        );
        assert_eq!(
            resolved,
            Some(super::passwd_entry_home()),
            "with HOME unset, POSIX must resolve the passwd-entry home"
        );

        match saved_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match saved_userprofile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_home_unix_treats_empty_home_as_unset_using_passwd_entry() {
        // A lingering `HOME=""` (empty, not unset) must behave exactly like
        // an unset HOME — Node's `os.homedir()` never returns an empty
        // string; on POSIX it falls back to the passwd-entry home, never
        // USERPROFILE.
        let _guard = PROVIDER_HOME_ENV_LOCK.lock().unwrap();
        let saved_home = std::env::var("HOME").ok();
        let saved_userprofile = std::env::var("USERPROFILE").ok();

        std::env::set_var("HOME", "");
        std::env::set_var("USERPROFILE", "/Users/win-fixture-empty");

        assert_eq!(
            provider_home(),
            Some(super::passwd_entry_home()),
            "an EMPTY HOME must behave like unset HOME: passwd-entry fallback, never USERPROFILE"
        );

        match saved_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match saved_userprofile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
    }

    #[cfg(unix)]
    #[test]
    fn provider_home_unix_prefers_home_and_never_consults_userprofile() {
        let _guard = PROVIDER_HOME_ENV_LOCK.lock().unwrap();
        let saved_home = std::env::var("HOME").ok();
        let saved_userprofile = std::env::var("USERPROFILE").ok();

        std::env::set_var("HOME", "/home/real-user-fixture");
        std::env::set_var("USERPROFILE", "/Users/win-fixture");

        assert_eq!(
            provider_home(),
            Some(PathBuf::from("/home/real-user-fixture")),
            "a set, non-empty HOME must win on POSIX (USERPROFILE is never consulted)"
        );

        match saved_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match saved_userprofile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
    }

    // Native Windows/Tauri parity: `os.homedir()` reads USERPROFILE on
    // Windows and NEVER consults HOME — a process with both variables set
    // must index against USERPROFILE, not HOME.
    #[cfg(windows)]
    #[test]
    fn provider_home_windows_uses_userprofile_never_home() {
        let _guard = PROVIDER_HOME_ENV_LOCK.lock().unwrap();
        let saved_home = std::env::var("HOME").ok();
        let saved_userprofile = std::env::var("USERPROFILE").ok();

        std::env::set_var("HOME", "C:\\never-consulted");
        std::env::set_var("USERPROFILE", "C:\\Users\\win-fixture");

        assert_eq!(
            provider_home(),
            Some(PathBuf::from("C:\\Users\\win-fixture")),
            "Windows must read USERPROFILE and never consult HOME (Node os.homedir() parity)"
        );

        match saved_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
        match saved_userprofile {
            Some(v) => std::env::set_var("USERPROFILE", v),
            None => std::env::remove_var("USERPROFILE"),
        }
    }

    #[test]
    fn item_from_meta_maps_fields_with_an_explicit_canonical_session_id() {
        // real-corrupted: canonical UUID + cwd + title.
        let content = std::fs::read_to_string(fixtures_dir().join("real-corrupted.jsonl")).unwrap();
        let meta = parse_session_content(
            &content,
            &ParseSessionOptions {
                fallback_session_id: Some("real-corrupted".into()),
                ..Default::default()
            },
        );
        let item = item_from_meta(
            &meta,
            "claude",
            "real-corrupted".to_string(),
            false,
            None,
            Some("b7936c10-4935-441c-837c-c1f33cafec2d".to_string()),
        );
        assert_eq!(item.session_id, "real-corrupted");
        assert_eq!(
            item.legacy_session_id.as_deref(),
            Some("b7936c10-4935-441c-837c-c1f33cafec2d")
        );
        assert_eq!(item.provider, "claude");
        assert_eq!(
            item.project_path,
            "D:\\Users\\Dan\\GoogleDrivePersonal\\code\\freshell"
        );
        assert_eq!(item.title.as_deref(), Some("Test Session 1"));
        assert_eq!(item.last_activity_at, 1_769_753_759_234);
        assert!(item.is_non_interactive);

        // Item value shape has the required keys.
        let v = item.to_value();
        assert_eq!(v["sessionId"], json!("real-corrupted"));
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
        let item = item_from_meta(&meta, "claude", "healthy".to_string(), false, None, None);
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
        let page = apply_query(items, &default_query(), &[]).unwrap();
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
        let page = apply_query(items, &q, &[]).unwrap();
        // healthy has no title → still hidden by the empty filter; real-corrupted
        // has a title → shown.
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["title"], json!("Test Session 1"));
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
        let page = apply_query(items, &q, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["sessionId"], json!("real-corrupted"));
        std::fs::remove_dir_all(&home).ok();
    }

    /// STATUS-STRIP: a DirItem carrying usage (mirrors `service.test.ts`'s
    /// `meter-hit` rows).
    fn usage_dir_item(session_id: &str, last_activity_at: i64, title: &str) -> DirItem {
        DirItem {
            session_id: session_id.to_string(),
            legacy_session_id: None,
            provider: "claude".to_string(),
            project_path: "/repo/meter".to_string(),
            title: Some(title.to_string()),
            summary: None,
            first_user_message: None,
            last_activity_at,
            created_at: Some(last_activity_at),
            cwd: Some("/repo/meter".to_string()),
            is_subagent: false,
            is_non_interactive: false,
            is_running: false,
            archived: false,
            matched_in: None,
            snippet: None,
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file: None,
            token_usage: Some(freshell_sessions::meta::TokenSummary {
                input_tokens: 10,
                output_tokens: 5,
                cached_tokens: 0,
                total_tokens: 15,
                context_tokens: Some(900),
                model_context_window: None,
                compact_threshold_tokens: Some(1000),
                compact_percent: Some(90),
            }),
        }
    }

    #[test]
    fn token_usage_serializes_on_items() {
        let items = vec![usage_dir_item("meter-hit", 500, "Metered session")];
        let page = apply_query(items, &default_query(), &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["tokenUsage"]["compactPercent"], json!(90));
        assert_eq!(arr[0]["tokenUsage"]["contextTokens"], json!(900));
        assert_eq!(arr[0]["tokenUsage"]["compactThresholdTokens"], json!(1000));
        assert_eq!(arr[0]["tokenUsage"]["inputTokens"], json!(10));
    }

    #[test]
    fn include_keys_returns_usage_for_session_excluded_by_search_query() {
        let items = vec![
            usage_dir_item("meter-hit", 500, "Metered session"),
            DirItem {
                token_usage: None,
                ..usage_dir_item("meter-other", 400, "Something else entirely")
            },
        ];
        let q = DirQuery {
            query: Some("Something else".to_string()),
            include_keys: vec!["claude:meter-hit".to_string()],
            ..DirQuery::default()
        };
        let page = apply_query(items, &q, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["sessionId"], json!("meter-other"));
        let extras = page["contextUsageExtras"].as_array().unwrap();
        assert_eq!(extras.len(), 1);
        assert_eq!(extras[0]["provider"], json!("claude"));
        assert_eq!(extras[0]["sessionId"], json!("meter-hit"));
        assert_eq!(extras[0]["tokenUsage"]["compactPercent"], json!(90));
    }

    #[test]
    fn include_keys_returns_usage_for_session_paged_out_of_the_window() {
        // Page 1 (limit 1) contains meter-hit as a normal item → NOT duplicated
        // as an extra.
        let q1 = DirQuery {
            limit: Some(1),
            include_keys: vec!["claude:meter-hit".to_string()],
            ..DirQuery::default()
        };
        let items = vec![
            usage_dir_item("meter-hit", 500, "Metered session"),
            usage_dir_item("meter-other", 400, "Other"),
        ];
        let page = apply_query(items.clone(), &q1, &[]).unwrap();
        assert_eq!(
            page["items"].as_array().unwrap()[0]["sessionId"],
            json!("meter-hit")
        );
        assert!(page.get("contextUsageExtras").is_none());
        // Page 2 paged it out → arrives as an extra instead.
        let cursor = page["nextCursor"].as_str().unwrap().to_string();
        let q2 = DirQuery {
            limit: Some(1),
            cursor: Some(cursor),
            include_keys: vec!["claude:meter-hit".to_string()],
            ..DirQuery::default()
        };
        let page2 = apply_query(items, &q2, &[]).unwrap();
        assert_eq!(
            page2["items"].as_array().unwrap()[0]["sessionId"],
            json!("meter-other")
        );
        assert_eq!(
            page2["contextUsageExtras"].as_array().unwrap()[0]["sessionId"],
            json!("meter-hit")
        );
    }

    #[test]
    fn include_keys_without_match_emits_no_extras_key() {
        let items = vec![usage_dir_item("meter-hit", 500, "Metered session")];
        let q = DirQuery {
            include_keys: vec!["claude:no-such-session".to_string()],
            ..DirQuery::default()
        };
        let page = apply_query(items, &q, &[]).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        assert!(page.get("contextUsageExtras").is_none());
    }

    #[test]
    fn include_keys_bypass_sidebar_visibility_filters() {
        // Subagent-classed AND untitled/idle open-pane sessions get no row in
        // the default sidebar window, but their meter must stay live — extras
        // match above the visibility filters (service.ts).
        let items = vec![
            DirItem {
                is_subagent: true,
                ..usage_dir_item("meter-subagent", 300, "Subagent row")
            },
            DirItem {
                title: None,
                ..usage_dir_item("meter-untitled", 200, "ignored-title")
            },
        ];
        let q = DirQuery {
            include_keys: vec![
                "claude:meter-subagent".to_string(),
                "claude:meter-untitled".to_string(),
            ],
            ..DirQuery::default()
        };
        let page = apply_query(items, &q, &[]).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 0);
        let extras: Vec<&str> = page["contextUsageExtras"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["sessionId"].as_str().unwrap())
            .collect();
        assert!(
            extras.contains(&"meter-subagent") && extras.contains(&"meter-untitled"),
            "visibility-filtered open-pane sessions still arrive as extras: {extras:?}"
        );
    }

    #[tokio::test]
    async fn page_stamps_snapshot_seq_and_server_instance() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = claude_home_with(&["real-corrupted.jsonl"]);
        let app = static_directory_app(Vec::new(), &home);
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
        assert!(page["snapshotSeq"].as_u64().unwrap() > 0);
        assert_eq!(page["serverInstance"], json!("srv-test"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn snapshot_seq_counter_is_monotonic() {
        // STATUS-STRIP: clients order competing pages by snapshotSeq within one
        // server instance — the sequence must strictly increase per call and
        // must not derive from data (activity timestamps).
        let s1 = next_snapshot_seq();
        let s2 = next_snapshot_seq();
        assert!(s2 > s1, "sequence increases per page build: {s1} < {s2}");
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
        let page = apply_query(items, &q, &[]).unwrap();
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
        let page = apply_query(items, &q, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matchedIn"], json!("title"));
        assert_eq!(arr[0]["snippet"], json!("Test Session 1"));

        // A non-matching query → empty.
        let items2 = list_claude_sessions(&claude_home(&home));
        let q2 = DirQuery {
            include_non_interactive: true,
            query: Some("zzz-not-present".into()),
            ..DirQuery::default()
        };
        let page2 = apply_query(items2, &q2, &[]).unwrap();
        assert_eq!(page2["items"].as_array().unwrap().len(), 0);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn cursor_paging_splits_and_round_trips() {
        // Two synthetic titled interactive items; limit 1 → page + nextCursor.
        let mk = |sid: &str, at: i64| DirItem {
            session_id: sid.into(),
            legacy_session_id: None,
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
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file: None,
            token_usage: None,
        };
        let items = vec![mk("a", 100), mk("b", 200)];
        let q = DirQuery {
            limit: Some(1),
            ..DirQuery::default()
        };
        let page = apply_query(items, &q, &[]).unwrap();
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
        let page2 = apply_query(items2, &q2, &[]).unwrap();
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
        let err = apply_query(Vec::new(), &q, &[]).unwrap_err();
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
        let err = apply_query(Vec::new(), &query, &[]).unwrap_err();
        assert!(err.to_lowercase().contains("cursor"));
    }

    // ── Task 2: sessionOverrides overlay ──────────────────────────────────

    #[test]
    fn overrides_overlay_applies_title_summary_archived_and_filters_deleted() {
        // Two synthetic titled items.
        let mk = |sid: &str| DirItem {
            session_id: sid.into(),
            legacy_session_id: None,
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
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file: None,
            token_usage: None,
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
    fn canonical_identity_prefers_its_own_user_state_and_falls_back_to_a_safe_legacy_identity() {
        let item = DirItem {
            session_id: "canonical-filename".into(),
            legacy_session_id: Some("embedded-before-canonicalization".into()),
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some("parsed".into()),
            summary: None,
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
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file: None,
            token_usage: None,
        };
        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "claude:embedded-before-canonicalization".into(),
            json!({ "titleOverride": "Legacy rename" }),
        );
        let mut metadata = std::collections::HashMap::new();
        metadata.insert(
            "claude:embedded-before-canonicalization".into(),
            json!({ "sessionType": "freshclaude" }),
        );

        let overlaid = apply_session_metadata(
            apply_session_overrides(vec![item.clone()], &overrides),
            &metadata,
        );
        assert_eq!(overlaid[0].title.as_deref(), Some("Legacy rename"));
        assert_eq!(overlaid[0].session_type.as_deref(), Some("freshclaude"));

        overrides.insert(
            "claude:canonical-filename".into(),
            json!({ "titleOverride": "Canonical rename" }),
        );
        metadata.insert(
            "claude:canonical-filename".into(),
            json!({ "sessionType": "freshclaude-canonical" }),
        );
        let canonical =
            apply_session_metadata(apply_session_overrides(vec![item], &overrides), &metadata);
        assert_eq!(canonical[0].title.as_deref(), Some("Canonical rename"));
        assert_eq!(
            canonical[0].session_type.as_deref(),
            Some("freshclaude-canonical")
        );
    }

    #[test]
    fn legacy_user_state_does_not_spill_from_a_present_canonical_original_to_its_copy() {
        let original = DirItem {
            session_id: "embedded-before-canonicalization".into(),
            legacy_session_id: None,
            provider: "claude".into(),
            project_path: "/original".into(),
            title: Some("Original parsed title".into()),
            summary: None,
            first_user_message: None,
            last_activity_at: 100,
            created_at: None,
            cwd: Some("/original".into()),
            is_subagent: false,
            is_non_interactive: false,
            is_running: false,
            archived: false,
            matched_in: None,
            snippet: None,
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file: None,
            token_usage: None,
        };
        let copied = DirItem {
            session_id: "copied-transcript".into(),
            legacy_session_id: Some("embedded-before-canonicalization".into()),
            project_path: "/copy".into(),
            title: Some("Copied parsed title".into()),
            cwd: Some("/copy".into()),
            ..original.clone()
        };
        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "claude:embedded-before-canonicalization".into(),
            json!({ "titleOverride": "Original user rename" }),
        );
        let metadata = std::collections::HashMap::from([(
            "claude:embedded-before-canonicalization".into(),
            json!({ "sessionType": "freshclaude" }),
        )]);

        let overlaid = apply_session_metadata(
            apply_session_overrides(vec![original, copied], &overrides),
            &metadata,
        );
        let original = overlaid
            .iter()
            .find(|item| item.session_id == "embedded-before-canonicalization")
            .unwrap();
        let copied = overlaid
            .iter()
            .find(|item| item.session_id == "copied-transcript")
            .unwrap();

        assert_eq!(original.title.as_deref(), Some("Original user rename"));
        assert_eq!(original.session_type.as_deref(), Some("freshclaude"));
        assert_eq!(copied.title.as_deref(), Some("Copied parsed title"));
        assert_eq!(copied.session_type, None);
    }

    #[test]
    fn overlay_shape_unchanged_when_no_overrides_archived_always_present() {
        let item = DirItem {
            session_id: "x".into(),
            legacy_session_id: None,
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
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file: None,
            token_usage: None,
        };
        let overlaid = apply_session_overrides(vec![item], &serde_json::Map::new());
        let v = overlaid[0].to_value();
        // Oracle-compat: archived is ALWAYS present, defaulted false.
        assert_eq!(v["archived"], json!(false));
        assert_eq!(v["title"], json!("t"));
    }

    // -- Task 5b: the provider-generated read-guard (`applyOverride`,
    // `session-indexer.ts:204-220`) ------------------------------------------
    //
    // The auto-title sweep re-writes a qualifying `dir`/`first-message`
    // override row for any live amplifier session within one 2s tick of the
    // ai-title-shadow-cleanup migration clearing it (write parity with Node,
    // `auto-title.ts:24-46`). Node stays correct because its READ model hides
    // such rows; this matrix pins that suppression, ported here.

    /// One parsed item whose PARSED title source is configurable; the parsed
    /// title is always "Provider Title" so tests can assert whether the
    /// override or the parsed title won.
    fn guard_item(sid: &str, title_source: Option<&str>) -> DirItem {
        DirItem {
            session_id: sid.into(),
            legacy_session_id: None,
            provider: "amplifier".into(),
            project_path: "/p".into(),
            title: Some("Provider Title".into()),
            summary: None,
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
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: title_source.map(str::to_string),
            source_file: None,
            token_usage: None,
        }
    }

    /// Overlay ONE override row onto ONE item; returns the resulting title.
    fn overlaid_title(item: DirItem, row: Value) -> Option<String> {
        let mut overrides = serde_json::Map::new();
        overrides.insert(item.key(), row);
        let out = apply_session_overrides(vec![item], &overrides);
        out[0].title.clone()
    }

    #[test]
    fn provider_generated_session_suppresses_dir_override_row() {
        // The load-bearing case: a provider-generated session with a
        // sweep-written dir row must serve the PARSED provider title.
        let title = overlaid_title(
            guard_item("s1", Some("provider-generated")),
            json!({ "titleOverride": "proj", "titleSource": "dir" }),
        );
        assert_eq!(title.as_deref(), Some("Provider Title"));
    }

    #[test]
    fn provider_generated_session_suppresses_first_message_override_row() {
        let title = overlaid_title(
            guard_item("s1", Some("provider-generated")),
            json!({ "titleOverride": "Fix the flux", "titleSource": "first-message" }),
        );
        assert_eq!(title.as_deref(), Some("Provider Title"));
    }

    #[test]
    fn provider_generated_session_still_applies_ai_override_row() {
        let title = overlaid_title(
            guard_item("s1", Some("provider-generated")),
            json!({ "titleOverride": "AI Title", "titleSource": "ai" }),
        );
        assert_eq!(title.as_deref(), Some("AI Title"));
    }

    #[test]
    fn provider_generated_session_still_applies_user_override_row() {
        let title = overlaid_title(
            guard_item("s1", Some("provider-generated")),
            json!({ "titleOverride": "My Rename", "titleSource": "user" }),
        );
        assert_eq!(title.as_deref(), Some("My Rename"));
    }

    #[test]
    fn provider_generated_session_still_applies_absent_source_override_row() {
        // Node compares strict `===` against exactly 'dir'/'first-message':
        // an ABSENT (or legacy/other) row source fails both comparisons and
        // the override still applies.
        let title = overlaid_title(
            guard_item("s1", Some("provider-generated")),
            json!({ "titleOverride": "Legacy Rename" }),
        );
        assert_eq!(title.as_deref(), Some("Legacy Rename"));
    }

    #[test]
    fn empty_string_title_override_never_applies() {
        // Node `!!ov?.titleOverride`: '' is falsy, for ANY session.
        let provider_generated = overlaid_title(
            guard_item("s1", Some("provider-generated")),
            json!({ "titleOverride": "", "titleSource": "user" }),
        );
        assert_eq!(provider_generated.as_deref(), Some("Provider Title"));
        let plain = overlaid_title(guard_item("s2", None), json!({ "titleOverride": "" }));
        assert_eq!(plain.as_deref(), Some("Provider Title"));
    }

    #[test]
    fn non_provider_generated_session_still_applies_dir_override_row() {
        let title = overlaid_title(
            guard_item("s1", None),
            json!({ "titleOverride": "proj", "titleSource": "dir" }),
        );
        assert_eq!(title.as_deref(), Some("proj"));
    }

    #[test]
    fn suppressed_title_row_still_overlays_summary_and_archived() {
        // applyOverride suppresses ONLY the title clause; summary/archived
        // overlay regardless (session-indexer.ts:215-217).
        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "amplifier:s1".into(),
            json!({
                "titleOverride": "proj", "titleSource": "dir",
                "summaryOverride": "sum", "archived": true
            }),
        );
        let out = apply_session_overrides(
            vec![guard_item("s1", Some("provider-generated"))],
            &overrides,
        );
        assert_eq!(out[0].title.as_deref(), Some("Provider Title"));
        assert_eq!(out[0].summary.as_deref(), Some("sum"));
        assert!(out[0].archived);
    }

    // -- Batch B: the `SessionIndex`-backed production path --
    //
    // RED (this commit, before the wiring existed): `SessionDirectoryState`
    // had no `session_index` field, so these three tests failed to compile.

    use freshell_sessions::directory_index::{ClaudeSource, SessionIndex, SessionSource};

    fn test_session_index(sources: Vec<Arc<dyn SessionSource>>) -> SessionIndex {
        SessionIndex::with_ttl_and_cache_path(sources, Duration::from_millis(1_000), None)
    }

    fn test_session_index_with_ttl(
        sources: Vec<Arc<dyn SessionSource>>,
        ttl: Duration,
    ) -> SessionIndex {
        SessionIndex::with_ttl_and_cache_path(sources, ttl, None)
    }

    struct StaticSessionSource {
        items: Vec<IndexedSession>,
    }

    impl SessionSource for StaticSessionSource {
        fn discover(&self) -> Vec<freshell_sessions::directory_index::FileStat> {
            self.items
                .iter()
                .enumerate()
                .map(
                    |(index, item)| freshell_sessions::directory_index::FileStat {
                        path: item.source_file.clone().unwrap_or_else(|| {
                            PathBuf::from(format!("/static-session-source/{index}.jsonl"))
                        }),
                        mtime_ms: index as i64,
                        size: 1,
                    },
                )
                .collect()
        }

        fn parse(&self, path: &Path) -> Option<IndexedSession> {
            self.items
                .iter()
                .find(|item| item.source_file.as_deref() == Some(path))
                .cloned()
        }
    }

    fn static_indexed_session(
        provider: &str,
        session_id: &str,
        source_file: &str,
        last_activity_at: i64,
    ) -> IndexedSession {
        IndexedSession {
            session_id: session_id.to_string(),
            legacy_session_id: None,
            provider: provider.to_string(),
            project_path: "/p".to_string(),
            title: Some(format!("{provider} {session_id}")),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            title_source: None,
            last_activity_at,
            created_at: None,
            cwd: Some("/p".to_string()),
            git_branch: None,
            is_subagent: false,
            is_non_interactive: false,
            source_file: Some(PathBuf::from(source_file)),
            token_usage: None,
        }
    }

    fn static_directory_app(items: Vec<IndexedSession>, home: &Path) -> Router {
        static_directory_app_with_identity(
            items,
            home,
            freshell_ws::identity::TerminalIdentityRegistry::new(),
        )
    }

    fn static_directory_app_with_identity(
        items: Vec<IndexedSession>,
        home: &Path,
        identity: freshell_ws::identity::TerminalIdentityRegistry,
    ) -> Router {
        let source = StaticSessionSource { items };
        router(SessionDirectoryState {
            auth_token: Arc::new("tok".to_string()),
            settings: crate::settings_store::SettingsStore::load(
                Some(home),
                vec!["claude".into(), "codex".into()],
            ),
            session_index: Some(Arc::new(test_session_index(vec![Arc::new(source)]))),
            identity,
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
        })
    }

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
            std::sync::Arc::new(test_session_index(vec![
                std::sync::Arc::new(ClaudeSource::new(claude_home(&home)))
                    as std::sync::Arc<dyn SessionSource>,
            ]));
        let state = SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
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
        assert_eq!(items[0]["title"], json!("Test Session 1"));
        // Oracle-compat: archived always present.
        assert_eq!(items[0]["archived"], json!(false));
        assert_eq!(page["nextCursor"], Value::Null);
        assert_eq!(page["revision"], json!(1_769_753_759_234i64));
        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn persisted_identity_collision_is_quarantined_before_filtering_or_pagination() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = unique_temp_dir();
        let app = static_directory_app(
            vec![
                static_indexed_session("claude", "unique", "/p/unique.jsonl", 300),
                static_indexed_session("claude", "duplicate", "/p/one.jsonl", 200),
                static_indexed_session("claude", "duplicate", "/p/two.jsonl", 100),
            ],
            &home,
        );

        for uri in [
            "/api/session-directory?priority=visible&query=no-such-title",
            "/api/session-directory?priority=visible&limit=1",
        ] {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("GET")
                        .uri(uri)
                        .header("x-auth-token", "tok")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                axum::http::StatusCode::OK,
                "collisions are an integrity error, but healthy rows stay available"
            );
            let body = axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap();
            let page: Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(page["partial"], json!(true));
            assert!(page.get("partialReason").is_none());
            assert_eq!(
                page["integrityError"],
                json!({
                    "kind": "identity_collision",
                    "collisionCount": 1,
                    "duplicateItemCount": 2,
                }),
                "the response is actionable without exposing local source paths"
            );
            let served_keys: Vec<String> = page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| {
                    format!(
                        "{}:{}",
                        item["provider"].as_str().unwrap(),
                        item["sessionId"].as_str().unwrap()
                    )
                })
                .collect();
            if uri.contains("query=") {
                assert!(served_keys.is_empty());
            } else {
                assert_eq!(served_keys, vec!["claude:unique"]);
            }
            assert!(!serde_json::to_string(&page)
                .unwrap()
                .contains("/p/one.jsonl"));
        }

        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn persisted_identity_collision_keeps_a_matching_live_terminal_as_a_safe_placeholder() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = unique_temp_dir();
        let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
        identity.upsert(
            "term-conflicted",
            Some("claude"),
            Some("duplicate"),
            Some("/live-terminal"),
            400,
        );
        let app = static_directory_app_with_identity(
            vec![
                static_indexed_session("claude", "unique", "/p/unique.jsonl", 300),
                static_indexed_session("claude", "duplicate", "/p/one.jsonl", 200),
                static_indexed_session("claude", "duplicate", "/p/two.jsonl", 100),
            ],
            &home,
            identity,
        );

        let response = app
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
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: Value = serde_json::from_slice(&body).unwrap();
        let items = page["items"].as_array().unwrap();

        assert!(
            items.iter().any(|item| {
                item["provider"] == "claude"
                    && item["sessionId"] == "duplicate"
                    && item["title"] == "Claude CLI"
                    && item["projectPath"] == "/live-terminal"
                    && item["isRunning"] == true
                    && item["runningTerminalId"] == "term-conflicted"
            }),
            "page={page}"
        );
        let placeholder = items
            .iter()
            .find(|item| item["provider"] == "claude" && item["sessionId"] == "duplicate")
            .unwrap();
        assert_ne!(placeholder["liveTerminalOnly"], json!(true));
        assert!(items
            .iter()
            .any(|item| { item["provider"] == "claude" && item["sessionId"] == "unique" }));
        assert!(!serde_json::to_string(&page)
            .unwrap()
            .contains("/p/one.jsonl"));

        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn persisted_identity_collision_context_is_deterministically_sorted() {
        let items: Vec<DirItem> = [
            static_indexed_session("claude", "z", "/p/z-two.jsonl", 1),
            static_indexed_session("claude", "a", "/p/a-two.jsonl", 1),
            static_indexed_session("claude", "z", "/p/z-one.jsonl", 1),
            static_indexed_session("claude", "a", "/p/a-one.jsonl", 1),
        ]
        .iter()
        .map(dir_item_from_indexed)
        .collect();

        let collisions = persisted_identity_collisions(&items);
        assert_eq!(
            collisions
                .iter()
                .map(|collision| collision.key.as_str())
                .collect::<Vec<_>>(),
            vec!["claude:a", "claude:z"]
        );
        assert_eq!(
            collisions[0].source_files,
            vec!["/p/a-one.jsonl", "/p/a-two.jsonl"]
        );
        assert_eq!(
            collisions[1].source_files,
            vec!["/p/z-one.jsonl", "/p/z-two.jsonl"]
        );
    }

    #[test]
    fn persisted_identity_collision_log_summary_is_deterministic_and_bounded() {
        let mut items = Vec::new();
        for collision_index in 0..(IDENTITY_COLLISION_KEY_SAMPLE_LIMIT + 3) {
            for source_index in 0..(IDENTITY_COLLISION_SOURCE_SAMPLE_LIMIT + 2) {
                items.push(static_indexed_session(
                    "claude",
                    &format!("collision-{collision_index:03}"),
                    &format!("/p/{collision_index:03}-{source_index:03}.jsonl"),
                    1,
                ));
            }
        }
        let dir_items: Vec<DirItem> = items.iter().map(dir_item_from_indexed).collect();
        let collisions = persisted_identity_collisions(&dir_items);
        let summary = persisted_identity_collision_log_summary(&collisions);

        assert_eq!(
            summary.collision_count,
            IDENTITY_COLLISION_KEY_SAMPLE_LIMIT + 3
        );
        assert_eq!(
            summary.duplicate_item_count,
            (IDENTITY_COLLISION_KEY_SAMPLE_LIMIT + 3)
                * (IDENTITY_COLLISION_SOURCE_SAMPLE_LIMIT + 2)
        );
        assert_eq!(summary.samples.len(), IDENTITY_COLLISION_KEY_SAMPLE_LIMIT);
        assert_eq!(summary.samples[0].key, "claude:collision-000");
        assert_eq!(summary.samples.last().unwrap().key, "claude:collision-019");
        assert!(summary.collision_samples_truncated);
        for sample in &summary.samples {
            assert_eq!(
                sample.source_file_count,
                IDENTITY_COLLISION_SOURCE_SAMPLE_LIMIT + 2
            );
            assert_eq!(
                sample.source_files.len(),
                IDENTITY_COLLISION_SOURCE_SAMPLE_LIMIT
            );
            assert!(sample.source_files_truncated);
        }
    }

    #[tokio::test]
    async fn same_raw_session_id_from_different_providers_is_legal() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = unique_temp_dir();
        let app = static_directory_app(
            vec![
                static_indexed_session("claude", "shared", "/p/claude.jsonl", 200),
                static_indexed_session("codex", "shared", "/p/codex.jsonl", 100),
            ],
            &home,
        );
        let response = app
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
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: Value = serde_json::from_slice(&body).unwrap();
        let keys: std::collections::BTreeSet<String> = page["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|item| {
                format!(
                    "{}:{}",
                    item["provider"].as_str().unwrap(),
                    item["sessionId"].as_str().unwrap()
                )
            })
            .collect();
        assert_eq!(
            keys,
            std::collections::BTreeSet::from([
                "claude:shared".to_string(),
                "codex:shared".to_string(),
            ])
        );

        std::fs::remove_dir_all(&home).ok();
    }

    #[tokio::test]
    async fn matching_live_terminal_duplicates_are_one_served_row_not_a_persisted_collision() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = unique_temp_dir();
        let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
        identity.upsert(
            "term-one",
            Some("claude"),
            Some("shared-live-session"),
            Some("/p"),
            200,
        );
        identity.upsert(
            "term-two",
            Some("claude"),
            Some("shared-live-session"),
            Some("/p"),
            300,
        );
        let app = static_directory_app_with_identity(
            vec![static_indexed_session(
                "claude",
                "shared-live-session",
                "/p/shared-live-session.jsonl",
                100,
            )],
            &home,
            identity,
        );

        let response = app
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
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: Value = serde_json::from_slice(&body).unwrap();
        let rows = page["items"].as_array().unwrap();
        assert_eq!(
            rows.len(),
            1,
            "live records are join inputs, not persisted rows"
        );
        assert_eq!(rows[0]["provider"], json!("claude"));
        assert_eq!(rows[0]["sessionId"], json!("shared-live-session"));
        assert_eq!(rows[0]["isRunning"], json!(true));
        assert!(matches!(
            rows[0]["runningTerminalId"].as_str(),
            Some("term-one" | "term-two")
        ));

        std::fs::remove_dir_all(&home).ok();
    }

    /// Task 20 (read-join): a `sessionType` tag persisted through the
    /// SESSION-06 `SessionMetadataStore` (`session-metadata.json`) is
    /// overlaid onto the matching served `/api/session-directory` item,
    /// keyed `provider:sessionId` -- mirroring the original indexer's
    /// read-join (`session-indexer.ts:1144-1148`, `const meta =
    /// sessionMetadata[metaKey]; if (meta?.sessionType) merged.sessionType
    /// = meta.sessionType`). Mirrors the harness of
    /// `patch_override_is_visible_through_session_directory_overlay`
    /// (`sessions_tests.rs`): write through the REAL store, assert on the
    /// REAL served JSON.
    #[tokio::test]
    async fn session_metadata_session_type_is_joined_onto_directory_items() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = claude_home_with(&["real-corrupted.jsonl"]);
        std::fs::create_dir_all(home.join(".freshell")).unwrap();
        // Same `.freshell` dir the POST /api/session-metadata route persists
        // to -- the read side must discover the SAME file.
        let metadata = crate::session_metadata::SessionMetadataStore::new(home.join(".freshell"));
        metadata
            .set("claude", "real-corrupted", "kilroy", Some("explicit"))
            .await
            .unwrap();

        let settings =
            crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]);
        let auth_token: std::sync::Arc<String> = std::sync::Arc::new("tok".into());
        let session_index =
            std::sync::Arc::new(test_session_index(vec![
                std::sync::Arc::new(ClaudeSource::new(claude_home(&home)))
                    as std::sync::Arc<dyn SessionSource>,
            ]));
        let state = SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            // A FRESH store instance over the same dir (not the writer above):
            // proves the join reads the persisted file, not shared memory.
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
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
        let item = items
            .iter()
            .find(|i| i["sessionId"] == json!("real-corrupted"))
            .expect("tagged session present in directory");
        assert_eq!(
            item["sessionType"],
            json!("kilroy"),
            "sessionType from the metadata store must be joined onto the served item"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    /// SESSION-05 (project colors, read half): the session-directory PAGE
    /// embeds the config's `projectColors` map verbatim (only when
    /// non-empty) so the shared client's refetch-after-`sessions.changed`
    /// can overlay each project group's color
    /// (`shared/read-models.ts` `SessionDirectoryPageSchema.projectColors`;
    /// legacy mirror: `server/session-directory/service.ts`).
    #[tokio::test]
    async fn session_directory_page_embeds_config_project_colors() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = claude_home_with(&["real-corrupted.jsonl"]);
        // The fixture's every session carries
        // `cwd: D:\Users\Dan\GoogleDrivePersonal\code\freshell`, which is
        // also its projectPath (see b_t7 above).
        std::fs::create_dir_all(home.join(".freshell")).unwrap();
        std::fs::write(
            home.join(".freshell").join("config.json"),
            serde_json::to_string(&json!({
                "version": 1,
                "settings": {},
                "sessionOverrides": {},
                "terminalOverrides": {},
                "projectColors": {
                    "D:\\Users\\Dan\\GoogleDrivePersonal\\code\\freshell": "#ff8800",
                    "/some/unrelated/path": "#112233"
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let settings =
            crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]);
        let auth_token: std::sync::Arc<String> = std::sync::Arc::new("tok".into());
        let session_index =
            std::sync::Arc::new(test_session_index(vec![
                std::sync::Arc::new(ClaudeSource::new(claude_home(&home)))
                    as std::sync::Arc<dyn SessionSource>,
            ]));
        let state = SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
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
        // The WHOLE map rides the page (unrelated path included): the
        // client overlays per-project, and a color for a project not in
        // THIS page is needed by the page it does appear on.
        assert_eq!(
            page["projectColors"]["D:\\Users\\Dan\\GoogleDrivePersonal\\code\\freshell"],
            json!("#ff8800"),
            "the fetched page must carry the project color for header rendering"
        );
        assert_eq!(
            page["projectColors"]["/some/unrelated/path"],
            json!("#112233"),
            "unrelated colors are carried verbatim (unchanged by this fetch)"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    /// SESSION-05: with NO configured colors the page must NOT gain a
    /// `projectColors` key — the field is optional in the wire schema and
    /// stays absent (matching the legacy service, which omits an empty
    /// map).
    #[tokio::test]
    async fn session_directory_page_omits_project_colors_key_when_empty() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = claude_home_with(&["real-corrupted.jsonl"]);
        let settings =
            crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]);
        let auth_token: std::sync::Arc<String> = std::sync::Arc::new("tok".into());
        let session_index =
            std::sync::Arc::new(test_session_index(vec![
                std::sync::Arc::new(ClaudeSource::new(claude_home(&home)))
                    as std::sync::Arc<dyn SessionSource>,
            ]));
        let state = SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
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
        assert!(
            page.get("projectColors").is_none(),
            "an empty colors map must not appear on the wire: {page:?}"
        );
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
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            // No home: a unique, nonexistent dir -- the store tolerates a
            // missing file (empty metadata), matching the no-home page.
            metadata: crate::session_metadata::SessionMetadataStore::new(unique_temp_dir()),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
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
        let session_index = std::sync::Arc::new(test_session_index_with_ttl(
            vec![std::sync::Arc::new(source) as std::sync::Arc<dyn SessionSource>],
            Duration::from_secs(60),
        ));
        let state = SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings: settings.clone(),
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
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
            .patch_session_override("claude:real-corrupted", &[("archived", Some(json!(true)))])
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

    // -- Batch C: CodexSource + OpencodeSource wired into the same
    //    `SessionIndex`-backed handler --

    use freshell_sessions::directory_index::{CodexSource, OpencodeSource};

    /// A codex `session_meta` with `payload.source == "exec"` -- a
    /// non-interactive (`codex exec`) run -- must be HIDDEN by the default
    /// query (no `includeNonInteractive`), exactly like the claude
    /// `include_non_interactive_surfaces_titled_session` test proves for
    /// claude, and must be SURFACED when the flag is set.
    #[tokio::test]
    async fn codex_exec_session_hidden_by_default_surfaced_with_flag() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = unique_temp_dir();
        let codex_home = home.join(".codex");
        let sessions = codex_home.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(
            sessions.join("exec-session.jsonl"),
            "{\"timestamp\":\"2026-03-01T00:00:00.000Z\",\"type\":\"session_meta\",\
             \"payload\":{\"id\":\"exec-1\",\"cwd\":\"/p\",\"source\":\"exec\"}}\n",
        )
        .unwrap();

        let settings =
            crate::settings_store::SettingsStore::load(Some(&home), vec!["codex".into()]);
        let auth_token: Arc<String> = Arc::new("tok".into());
        let session_index = Arc::new(test_session_index(vec![
            Arc::new(CodexSource::new(codex_home)) as Arc<dyn SessionSource>,
        ]));
        let state = SessionDirectoryState {
            auth_token: Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
        };
        let app = router(state);

        let get_page = |app: Router, query: &str| {
            let uri = format!("/api/session-directory?priority=visible{query}");
            async move {
                app.oneshot(
                    Request::builder()
                        .method("GET")
                        .uri(uri)
                        .header("x-auth-token", "tok")
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
            }
        };

        let resp_default = get_page(app.clone(), "").await;
        let bytes = axum::body::to_bytes(resp_default.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(
            page["items"].as_array().unwrap().len(),
            0,
            "an exec (non-interactive) codex session must be hidden by default"
        );

        let resp_flagged = get_page(app, "&includeNonInteractive=1&includeEmpty=1").await;
        let bytes = axum::body::to_bytes(resp_flagged.into_body(), usize::MAX)
            .await
            .unwrap();
        let page: Value = serde_json::from_slice(&bytes).unwrap();
        let items = page["items"].as_array().unwrap();
        assert_eq!(items.len(), 1, "includeNonInteractive must surface it");
        assert_eq!(items[0]["sessionId"], json!("exec-1"));
        assert_eq!(items[0]["provider"], json!("codex"));

        std::fs::remove_dir_all(&home).ok();
    }

    /// Composite `provider:sessionId` keys (`C.3`/`C.4`) mean session
    /// overrides apply to codex/opencode sessions through the SAME overlay
    /// path claude already uses -- no provider-specific override code needed.
    #[tokio::test]
    async fn session_override_applies_to_codex_and_opencode_keys() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = unique_temp_dir();
        let codex_home = home.join(".codex");
        let codex_sessions = codex_home.join("sessions");
        std::fs::create_dir_all(&codex_sessions).unwrap();
        std::fs::write(
            codex_sessions.join("s.jsonl"),
            "{\"timestamp\":\"2026-03-01T00:00:00.000Z\",\"type\":\"session_meta\",\
             \"payload\":{\"id\":\"codex-1\",\"cwd\":\"/p\"}}\n",
        )
        .unwrap();

        let opencode_home = home.join("opencode-data");
        std::fs::create_dir_all(&opencode_home).unwrap();
        {
            let conn = rusqlite::Connection::open(opencode_home.join("opencode.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
                 CREATE TABLE session (
                    id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                    time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                    project_id TEXT, parent_id TEXT
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO session VALUES ('oc-1','/p','OC',1,2,NULL,NULL,NULL)",
                [],
            )
            .unwrap();
        }

        let settings = crate::settings_store::SettingsStore::load(
            Some(&home),
            vec!["codex".into(), "opencode".into()],
        );
        let auth_token: Arc<String> = Arc::new("tok".into());
        let session_index = Arc::new(test_session_index(vec![
            Arc::new(CodexSource::new(codex_home)) as Arc<dyn SessionSource>,
            Arc::new(OpencodeSource::new(opencode_home)) as Arc<dyn SessionSource>,
        ]));
        let state = SessionDirectoryState {
            auth_token: Arc::clone(&auth_token),
            settings: settings.clone(),
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
        };
        let app = router(state);

        settings
            .patch_session_override(
                "codex:codex-1",
                &[("titleOverride", Some(json!("Renamed Codex")))],
            )
            .await;
        settings
            .patch_session_override("opencode:oc-1", &[("archived", Some(json!(true)))])
            .await;

        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/session-directory?priority=visible&includeEmpty=1")
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

        let codex_item = items
            .iter()
            .find(|i| i["sessionId"] == json!("codex-1"))
            .expect("codex-1 present");
        assert_eq!(codex_item["title"], json!("Renamed Codex"));

        let opencode_item = items
            .iter()
            .find(|i| i["sessionId"] == json!("oc-1"))
            .expect("oc-1 present");
        assert_eq!(opencode_item["archived"], json!(true));

        std::fs::remove_dir_all(&home).ok();
    }

    /// Bug 2 wire-level pin: opencode's catch-all "global" project stores
    /// `worktree = '/'` -- a placeholder, not a real checkout -- so the
    /// directory endpoint must report the session's real cwd as
    /// `projectPath`, not `/`.
    #[tokio::test]
    async fn global_project_session_reports_real_directory_as_project_path() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = unique_temp_dir();
        let opencode_home = home.join("opencode-data");
        std::fs::create_dir_all(&opencode_home).unwrap();
        {
            let conn = rusqlite::Connection::open(opencode_home.join("opencode.db")).unwrap();
            conn.execute_batch(
                "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
                 CREATE TABLE session (
                    id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                    time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                    project_id TEXT, parent_id TEXT
                 );",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO project (id, worktree) VALUES ('global', '/')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO session VALUES ('oc-global','/tmp/real/dir','OC Global',1,2,NULL,'global',NULL)",
                [],
            )
            .unwrap();
        }

        let settings =
            crate::settings_store::SettingsStore::load(Some(&home), vec!["opencode".into()]);
        let auth_token: Arc<String> = Arc::new("tok".into());
        let session_index =
            Arc::new(test_session_index(vec![
                Arc::new(OpencodeSource::new(opencode_home)) as Arc<dyn SessionSource>,
            ]));
        let state = SessionDirectoryState {
            auth_token: Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            metadata: crate::session_metadata::SessionMetadataStore::new(home.join(".freshell")),
            server_instance: std::sync::Arc::new("srv-test".to_string()),
        };
        let app = router(state);

        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/session-directory?priority=visible&includeEmpty=1")
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
        let items = page["items"].as_array().expect("items array");
        let item = items
            .iter()
            .find(|i| i["sessionId"] == json!("oc-global"))
            .expect("seeded session present");
        assert_eq!(
            item["projectPath"],
            json!("/tmp/real/dir"),
            "wire projectPath must be the cwd, not '/'"
        );

        std::fs::remove_dir_all(&home).ok();
    }

    // ── SESSION-07: userMessages/fullText tier search + partial ──

    /// Isolated claude home with ONE synthetic session file containing a
    /// distinct user turn and a distinct assistant turn -- lets a test assert
    /// tier scoping (`userMessages` must never match the assistant-only
    /// phrase) precisely.
    fn synthetic_claude_home_with_turns(
        session_uuid: &str,
        user_text: &str,
        assistant_text: &str,
    ) -> PathBuf {
        let home = std::env::temp_dir().join(format!(
            "freshell-s07-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project = home.join(".claude").join("projects").join("-home-dan-proj");
        std::fs::create_dir_all(&project).unwrap();
        let user_uuid = format!("{session_uuid}-u001");
        let asst_uuid = format!("{session_uuid}-a001");
        let content = format!(
            "{{\"parentUuid\":null,\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{session_uuid}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{user_text}\"}},\"uuid\":\"{user_uuid}\",\"timestamp\":\"2026-01-30T06:15:56.713Z\"}}\n\
             {{\"parentUuid\":\"{user_uuid}\",\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{session_uuid}\",\"type\":\"assistant\",\"message\":{{\"model\":\"m\",\"id\":\"msg1\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[{{\"type\":\"text\",\"text\":\"{assistant_text}\"}}]}},\"uuid\":\"{asst_uuid}\",\"timestamp\":\"2026-01-30T06:16:00.000Z\"}}\n\
             {{\"parentUuid\":\"{asst_uuid}\",\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{session_uuid}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"a second user turn so the session isn't single-turn non-interactive\"}},\"uuid\":\"{session_uuid}-u002\",\"timestamp\":\"2026-01-30T06:17:00.000Z\"}}\n"
        );
        std::fs::write(project.join(format!("{session_uuid}.jsonl")), content).unwrap();
        home
    }

    #[test]
    fn tier_user_messages_matches_only_the_user_turn() {
        let home = synthetic_claude_home_with_turns(
            "bbbbbbbb-0000-4000-8000-000000000001",
            "unique-search-term-alpha",
            "unique-search-term-alpha-assistant-only",
        );
        let items = list_claude_sessions(&claude_home(&home));
        assert_eq!(items.len(), 1);
        assert!(
            items[0].source_file.is_some(),
            "a real session file must carry a source_file for tier search"
        );

        // Matches the user turn.
        let q_user_hit = DirQuery {
            include_non_interactive: true,
            tier: Tier::UserMessages,
            query: Some("unique-search-term-alpha".into()),
            ..DirQuery::default()
        };
        let page = apply_query(items.clone(), &q_user_hit, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "userMessages tier must match the user turn");
        assert_eq!(arr[0]["matchedIn"], json!("userMessage"));
        assert_eq!(arr[0]["snippet"], json!("unique-search-term-alpha"));

        // The assistant-only phrase must NOT match under userMessages.
        let q_assistant_only = DirQuery {
            include_non_interactive: true,
            tier: Tier::UserMessages,
            query: Some("assistant-only".into()),
            ..DirQuery::default()
        };
        let page2 = apply_query(items, &q_assistant_only, &[]).unwrap();
        assert_eq!(
            page2["items"].as_array().unwrap().len(),
            0,
            "userMessages tier must never match assistant-only text"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn tier_full_text_matches_assistant_turn_too() {
        let home = synthetic_claude_home_with_turns(
            "bbbbbbbb-0000-4000-8000-000000000002",
            "hello there",
            "unique-fulltext-only-phrase",
        );
        let items = list_claude_sessions(&claude_home(&home));
        let q = DirQuery {
            include_non_interactive: true,
            tier: Tier::FullText,
            query: Some("unique-fulltext-only-phrase".into()),
            ..DirQuery::default()
        };
        let page = apply_query(items, &q, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "fullText tier must match assistant text");
        assert_eq!(arr[0]["matchedIn"], json!("assistantMessage"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn tier_search_is_case_insensitive() {
        let home = synthetic_claude_home_with_turns(
            "bbbbbbbb-0000-4000-8000-000000000003",
            "MixedCase NeedleValue Here",
            "irrelevant",
        );
        let items = list_claude_sessions(&claude_home(&home));
        let q = DirQuery {
            include_non_interactive: true,
            tier: Tier::UserMessages,
            query: Some("needlevalue".into()),
            ..DirQuery::default()
        };
        let page = apply_query(items, &q, &[]).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 1);
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn tier_search_empty_no_match_returns_empty_items_without_partial() {
        let home = synthetic_claude_home_with_turns(
            "bbbbbbbb-0000-4000-8000-000000000004",
            "nothing relevant here at all",
            "still nothing relevant",
        );
        let items = list_claude_sessions(&claude_home(&home));
        let q = DirQuery {
            include_non_interactive: true,
            tier: Tier::FullText,
            query: Some("zzz-absent-query-text".into()),
            ..DirQuery::default()
        };
        let page = apply_query(items, &q, &[]).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 0);
        assert_eq!(page["nextCursor"], Value::Null);
        assert!(
            page.get("partial").is_none(),
            "an exhausted, non-budget-limited scan must not report partial"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn tier_search_combined_with_cursor_pagination() {
        // Three sessions, all matching, distinct lastActivityAt (from
        // distinct timestamps) -> limit 1 must page through all three via
        // nextCursor, newest first, no duplicates, no omissions.
        let home = std::env::temp_dir().join(format!(
            "freshell-s07-page-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project = home.join(".claude").join("projects").join("-home-dan-proj");
        std::fs::create_dir_all(&project).unwrap();
        for (n, ts) in [
            (
                "cccccccc-0000-4000-8000-000000000001",
                "2026-01-30T06:10:00.000Z",
            ),
            (
                "cccccccc-0000-4000-8000-000000000002",
                "2026-01-30T06:20:00.000Z",
            ),
            (
                "cccccccc-0000-4000-8000-000000000003",
                "2026-01-30T06:30:00.000Z",
            ),
        ] {
            let content = format!(
                "{{\"parentUuid\":null,\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{n}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"paginated-search-term\"}},\"uuid\":\"{n}-u001\",\"timestamp\":\"{ts}\"}}\n\
                 {{\"parentUuid\":\"{n}-u001\",\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{n}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"second turn\"}},\"uuid\":\"{n}-u002\",\"timestamp\":\"{ts}\"}}\n"
            );
            std::fs::write(project.join(format!("{n}.jsonl")), content).unwrap();
        }

        let mut seen: Vec<String> = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..3 {
            let items = list_claude_sessions(&claude_home(&home));
            let q = DirQuery {
                include_non_interactive: true,
                tier: Tier::UserMessages,
                query: Some("paginated-search-term".into()),
                limit: Some(1),
                cursor: cursor.clone(),
                ..DirQuery::default()
            };
            let page = apply_query(items, &q, &[]).unwrap();
            let arr = page["items"].as_array().unwrap();
            assert_eq!(arr.len(), 1, "each page must have exactly 1 item");
            seen.push(arr[0]["sessionId"].as_str().unwrap().to_string());
            cursor = page["nextCursor"].as_str().map(str::to_string);
        }
        assert_eq!(cursor, None, "the third page must be the last");
        // Newest first (highest timestamp -> DESC sort), no duplicates.
        assert_eq!(
            seen,
            vec![
                "cccccccc-0000-4000-8000-000000000003",
                "cccccccc-0000-4000-8000-000000000002",
                "cccccccc-0000-4000-8000-000000000001",
            ]
        );
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn tier_search_reports_partial_budget_when_scan_budget_exceeded() {
        // limit=1 -> max_scan = limit*10 = 10; seed 11 NON-matching sessions
        // so the budget is exhausted before `limit + 1` matches are ever
        // found (`service.ts:176,182-186`).
        let home = std::env::temp_dir().join(format!(
            "freshell-s07-budget-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project = home.join(".claude").join("projects").join("-home-dan-proj");
        std::fs::create_dir_all(&project).unwrap();
        for n in 0..11u32 {
            let sid = format!("dddddddd-0000-4000-8000-{n:012}");
            let content = format!(
                "{{\"parentUuid\":null,\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{sid}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"no match here\"}},\"uuid\":\"{sid}-u001\",\"timestamp\":\"2026-01-30T06:{n:02}:00.000Z\"}}\n\
                 {{\"parentUuid\":\"{sid}-u001\",\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{sid}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"second turn\"}},\"uuid\":\"{sid}-u002\",\"timestamp\":\"2026-01-30T06:{n:02}:30.000Z\"}}\n"
            );
            std::fs::write(project.join(format!("{sid}.jsonl")), content).unwrap();
        }

        let items = list_claude_sessions(&claude_home(&home));
        assert_eq!(items.len(), 11);
        let q = DirQuery {
            include_non_interactive: true,
            tier: Tier::UserMessages,
            query: Some("zzz-never-present".into()),
            limit: Some(1),
            ..DirQuery::default()
        };
        let page = apply_query(items, &q, &[]).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 0);
        assert_eq!(page["partial"], json!(true));
        assert_eq!(page["partialReason"], json!("budget"));
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn invalid_tier_value_is_rejected_with_zod_like_400_shape() {
        let mut raw = std::collections::HashMap::new();
        raw.insert("priority".to_string(), "visible".to_string());
        raw.insert("tier".to_string(), "bogus-tier".to_string());
        let err = validate_query(&raw).unwrap_err();
        let details = err.as_array().unwrap();
        assert!(
            details
                .iter()
                .any(|d| d["path"] == json!(["tier"]) && d["code"] == json!("invalid_value")),
            "expected a tier invalid_value issue, got {details:?}"
        );
    }

    #[test]
    fn absent_tier_defaults_to_title() {
        let mut raw = std::collections::HashMap::new();
        raw.insert("priority".to_string(), "visible".to_string());
        let q = validate_query(&raw).unwrap();
        assert_eq!(q.tier, Tier::Title);
    }

    #[test]
    fn title_tier_search_matches_a_renamed_sessions_override_title() {
        // Mirrors the production composition order
        // (`apply_session_overrides` before `apply_query`,
        // `session_directory` handler, main.rs wiring): a session whose
        // PARSED title is unrelated must still be found by searching its
        // OVERRIDE (renamed) title.
        let item = DirItem {
            session_id: "s1".into(),
            legacy_session_id: None,
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some("original parsed title".into()),
            summary: None,
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
            running_terminal_id: None,
            live_terminal_only: false,
            session_type: None,
            title_source: None,
            source_file: None,
            token_usage: None,
        };
        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "claude:s1".into(),
            json!({ "titleOverride": "My Renamed Special Project" }),
        );
        let overlaid = apply_session_overrides(vec![item], &overrides);

        let q = DirQuery {
            query: Some("Renamed Special".into()),
            ..DirQuery::default()
        };
        let page = apply_query(overlaid, &q, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1, "search must match the OVERRIDE title");
        assert_eq!(arr[0]["title"], json!("My Renamed Special Project"));
        assert_eq!(arr[0]["matchedIn"], json!("title"));
    }
}
