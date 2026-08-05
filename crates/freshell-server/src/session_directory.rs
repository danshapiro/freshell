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
//! * **live terminal join.** The sidebar join below (`join_live_terminals`)
//!   fuses the live `TerminalIdentityRegistry` set into the parsed items:
//!   a matched item gains `isRunning`/`runningTerminalId`, and each unmatched
//!   live identity gets exactly one synthesized entry (with `sessionType`).

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
use freshell_sessions::{search_session_file, FileSearchTier, SearchFileError};
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
}

/// One directory item, typed for the sort/filter/cursor derivation. Serialized to
/// the `SessionDirectoryItem` shape by [`DirItem::to_value`].
#[derive(Debug, Clone)]
struct DirItem {
    session_id: String,
    provider: String,
    project_path: String,
    title: Option<String>,
    /// Node's cached parse-layer `titleSource === 'provider-generated'`
    /// (`IndexedSession::title_provider_generated`, whose own doc cites
    /// `session-indexer.ts`): gates the title-override suppression in
    /// [`apply_session_overrides`] — a `dir`/`first-message`-sourced stored
    /// `titleOverride` must NOT replace the provider's own generated title
    /// (Node's `shouldApplyTitleOverride`, `session-indexer.ts:210-211`).
    /// Same input the resolve wire already consults
    /// (`resolve.rs::project_session_through_overrides`).
    title_provider_generated: bool,
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
    /// `SessionDirectoryItem.sessionType` (`shared/read-models.ts:53`): only
    /// populated on a synthesized live-terminal item (`service.ts:125`,
    /// `sessionType: meta.provider`) — a real session-file item never sets this
    /// in this port (the original's parsed items don't set it either, see
    /// `toItems`/`joinRunningState`, `service.ts:132-151`).
    session_type: Option<String>,
    /// SESSION-07: the on-disk transcript to scan for the `userMessages`/
    /// `fullText` tiers (`IndexedSession::source_file`). Internal only --
    /// never serialized (`to_value` never reads it), mirroring
    /// `sourceFiles.get(key)` (`session-directory/service.ts:164-173`), which
    /// is looked up server-side and never sent to the client either.
    source_file: Option<PathBuf>,
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
        if let Some(v) = &self.running_terminal_id {
            o.insert("runningTerminalId".into(), json!(v));
        }
        if self.live_terminal_only {
            o.insert("liveTerminalOnly".into(), json!(true));
        }
        if let Some(v) = &self.session_type {
            o.insert("sessionType".into(), json!(v));
        }
        Value::Object(o)
    }
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
    // Fix Spec: Session Naming Cluster (SYMPTOM 1) -- join the LIVE terminal
    // identity set against the parsed session items (`toItems`, `service.ts:132-151`).
    // `.list()` (live-only, excludes retired terminals): an exited terminal is not
    // part of the sidebar's "running" set, matching the original's
    // `TerminalMetadataService.list()` input to `toItems`.
    let identities = state.identity.list();
    let items = join_live_terminals(items, &identities);
    // SESSION-07 stale-query cancellation (request supersession): port of the
    // reference's request-abort plumbing (`read-models/request-abort.ts` --
    // the client aborts its fetch when a newer sidebar query supersedes this
    // one, `sessionsThunks.ts` `abortSurface`). The derivation (which reads
    // transcript files at the file tiers) runs on a blocking worker -- never
    // the async runtime thread -- and is CANCELLED COOPERATIVELY when this
    // handler future is dropped (hyper drops an in-flight handler future
    // when its connection dies): the guard's `Drop` fires the token, and the
    // scan abandons at its next per-item/per-line probe
    // (`service.ts:188,209-210`, `file-search.ts:43,56`). A superseded query
    // therefore stops consuming transcript I/O and never completes a stale
    // page. NB: `_cancel_on_drop` (named) lives to end-of-scope -- a bare
    // `_` binding would drop (and cancel) immediately.
    let cancel = SearchCancel::default();
    let _cancel_on_drop = CancelOnDrop(cancel.clone());
    let derivation = tokio::task::spawn_blocking(move || {
        let probe = || cancel.is_cancelled();
        apply_query_cancellable(items, &query, &identities, Some(&probe))
    });
    match derivation.await {
        Ok(Ok(page)) => Json(page).into_response(),
        // Bad cursor → 400, matching `querySessionDirectory`'s `/cursor/i` → 400.
        Ok(Err(QueryError::BadCursor(msg))) => (
            axum::http::StatusCode::BAD_REQUEST,
            Json(json!({ "error": msg })),
        )
            .into_response(),
        // Unreachable over the wire: the only canceller is this future's own
        // drop, after which no response can be produced. The arm is the
        // closest axum can express the reference's silent swallow of an
        // aborted request (`sessions-router.ts:128-131`): no page payload.
        Ok(Err(QueryError::Cancelled)) => axum::http::StatusCode::NO_CONTENT.into_response(),
        // A panicking derivation task: the reference route's generic 500
        // (`sessions-router.ts:132-138`).
        Err(_join_error) => (
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": "Session directory query failed" })),
        )
            .into_response(),
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
        provider: idx.provider.clone(),
        project_path: idx.project_path.clone(),
        title: idx.title.clone(),
        title_provider_generated: idx.title_provider_generated,
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
        source_file: idx.source_file.clone(),
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
    Some(item_from_meta(
        &meta,
        "claude",
        &fallback,
        force_subagent,
        Some(path.to_path_buf()),
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
    fallback_session_id: &str,
    force_subagent: bool,
    source_file: Option<PathBuf>,
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
        title_provider_generated: meta.title_provider_generated,
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
        source_file,
    }
}

/// Overlay `config.sessionOverrides` onto parsed items — a faithful port of
/// Node's `applyOverride` (`session-indexer.ts:204-220`), which the original's
/// `buildProjectGroups` (:1186) runs on every cached session BEFORE the
/// directory service sorts/pages it:
///
/// * `deleted: true` removes the item (`if (ov?.deleted) return null`).
/// * `title` takes the override only under Node's `shouldApplyTitleOverride`
///   (:210-211): a NON-EMPTY `titleOverride` (`!!ov?.titleOverride` — an empty
///   string is falsy, never applied) AND NOT (`title_provider_generated` —
///   Node's cached parse-layer `titleSource === 'provider-generated'` — while
///   the stored override's recorded `titleSource` is `dir` or `first-message`).
///   The suppressed case is the provider's own generated title outranking a
///   stale auto-derived override; every other override source (`user`, `ai`,
///   `legacy`, absent) still substitutes. Same predicate
///   `resolve.rs::project_session_through_overrides` already enforces on the
///   resolve wire.
/// * `summary` prefers `summaryOverride`; `archived` reflects the override
///   (default false).
/// * `createdAt` takes `createdAtOverride` under Node's `??` (:216): any
///   present non-null value applies — INCLUDING `0` (unlike `||`) — while an
///   absent or explicit-null override keeps the parsed `createdAt`. Stored
///   values are integer epoch-ms
///   (`SessionPatchSchema.createdAtOverride`, `sessions-router.ts:31-63`); a
///   non-integer JSON number (`as_i64` → `None`) falls back like an absent key.
///
/// Keyed by `provider:sessionId` (`buildSessionKey`, `service.ts:36-38`).
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
                // `shouldApplyTitleOverride` (`session-indexer.ts:210-211`).
                let title_override_suppressed = item.title_provider_generated
                    && matches!(
                        ov.get("titleSource").and_then(Value::as_str),
                        Some("dir" | "first-message")
                    );
                if let Some(t) = ov
                    .get("titleOverride")
                    .and_then(Value::as_str)
                    .filter(|t| !t.is_empty() && !title_override_suppressed)
                {
                    item.title = Some(t.to_string());
                }
                if let Some(s) = ov.get("summaryOverride").and_then(Value::as_str) {
                    item.summary = Some(s.to_string());
                }
                if let Some(c) = ov.get("createdAtOverride").and_then(Value::as_i64) {
                    item.created_at = Some(c);
                }
                item.archived = ov.get("archived").and_then(Value::as_bool).unwrap_or(false);
            }
            Some(item)
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
        provider: provider.clone(),
        project_path,
        title: Some(provider_display_name(&provider)),
        // Synthesized live-terminal rows never pass through
        // `applyOverride` in Node (`buildLiveTerminalSessionItem`,
        // `service.ts:110-130`), and here [`apply_session_overrides`]
        // runs BEFORE the live join — the flag is inert on these items.
        title_provider_generated: false,
        summary: None,
        first_user_message: None,
        last_activity_at: identity.updated_at,
        created_at: Some(identity.updated_at),
        cwd: identity.cwd.clone(),
        is_subagent: false,
        is_non_interactive: false,
        is_running: true,
        archived: false,
        matched_in: None,
        snippet: None,
        running_terminal_id: Some(identity.terminal_id.clone()),
        live_terminal_only: identity.session_id.is_none(),
        session_type: Some(provider),
        source_file: None,
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

    fn file_item(provider: &str, session_id: &str, last_activity_at: i64) -> DirItem {
        DirItem {
            session_id: session_id.to_string(),
            provider: provider.to_string(),
            project_path: "/repo".to_string(),
            title: Some("A real session".to_string()),
            title_provider_generated: false,
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
            source_file: None,
        }
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

    // ── SESSION-17: provider-qualified running-state identity ──

    /// SESSION-17: the SAME raw session id indexed under claude, codex, AND
    /// opencode must never share running state. `join_running_state`'s
    /// matcher requires provider AND session_id (`service.ts:77-95`), and
    /// `join_live_terminals`'s dedupe set is keyed `provider:sessionId`
    /// (`buildSessionKey`, `service.ts:36-38`) — so a live claude terminal
    /// for raw id `shared` lights up ONLY the claude item, a live codex
    /// terminal for the same raw id ONLY the codex item, the opencode item
    /// stays dark, and none of the three collides in dedupe (exactly 3
    /// items, no synthesized `liveTerminalOnly` row for either live
    /// terminal — both are matched against their own provider's file item).
    #[test]
    fn join_live_terminals_same_raw_id_across_providers_never_cross_leaks_running_state() {
        let reg = TerminalIdentityRegistry::new();
        reg.upsert("term-cl", Some("claude"), Some("shared"), None, 1000);
        reg.upsert("term-cx", Some("codex"), Some("shared"), None, 2000);

        let items = vec![
            file_item("claude", "shared", 500),
            file_item("codex", "shared", 500),
            file_item("opencode", "shared", 500),
        ];

        let joined = join_live_terminals(items, &reg.list());
        assert_eq!(
            joined.len(),
            3,
            "no dedupe collapse across providers and no synthesized duplicates"
        );

        for item in &joined {
            assert_eq!(item.session_id, "shared");
            assert!(!item.live_terminal_only);
            match item.provider.as_str() {
                "claude" => {
                    assert!(item.is_running, "claude:shared must join term-cl");
                    assert_eq!(item.running_terminal_id.as_deref(), Some("term-cl"));
                }
                "codex" => {
                    assert!(item.is_running, "codex:shared must join term-cx");
                    assert_eq!(item.running_terminal_id.as_deref(), Some("term-cx"));
                }
                other => {
                    assert_eq!(other, "opencode");
                    assert!(
                        !item.is_running,
                        "opencode:shared has no live terminal — must stay dark"
                    );
                    assert_eq!(item.running_terminal_id, None);
                }
            }
        }

        // Sanity at the matcher level too: a codex identity must NOT mark the
        // claude item running even when the raw id is identical.
        let codex_only = TerminalIdentityRegistry::new();
        codex_only.upsert("term-cx", Some("codex"), Some("shared"), None, 2000);
        let claude_item = join_running_state(file_item("claude", "shared", 500), &codex_only.list());
        assert!(!claude_item.is_running);
        assert_eq!(claude_item.running_terminal_id, None);
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

/// `apply_query`'s failure modes. SESSION-07 widened the lone cursor error
/// (a `String` → 400) into an enum to carry the cancellation outcome.
#[derive(Debug)]
enum QueryError {
    /// Bad cursor → 400, matching `querySessionDirectory`'s `/cursor/i` → 400
    /// (`sessions-router.ts:139-141`, pre-existing parity).
    BadCursor(String),
    /// The file-tier scan was cancelled mid-flight (SESSION-07 stale-query
    /// cancellation). The reference SWALLOWS an aborted request without
    /// writing a response (`sessions-router.ts:128-131`'s
    /// `if (signal.aborted || isReadModelAbortError(error)) return`). Over
    /// the wire here this arm is UNREACHABLE -- the only canceller is the
    /// handler future's own drop ([`CancelOnDrop`]), after which no response
    /// can be produced anyway -- but the variant keeps the types total and
    /// the supersession semantics unit-testable at the `apply_query` level.
    Cancelled,
}

impl std::fmt::Display for QueryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            QueryError::BadCursor(msg) => write!(f, "{msg}"),
            QueryError::Cancelled => write!(f, "Session-directory request aborted"),
        }
    }
}

/// Cooperative cancellation token for the file-tier transcript scan — the
/// port of the reference's `AbortSignal` plumbing
/// (`read-models/request-abort.ts` → `service.ts:188,209-210` →
/// `file-search.ts:43,56`). In the original, the CLIENT aborts its fetch
/// when a newer sidebar query supersedes the in-flight one
/// (`sessionsThunks.ts` `abortSurface(surface)`); `req.once('aborted')`
/// fires the signal and the scan throws mid-item/mid-line.
///
/// This port wires the same lifecycle: the request handler future owns a
/// [`CancelOnDrop`] guard; hyper drops an in-flight handler future when its
/// connection dies, the guard's `Drop` cancels this token, and the scan —
/// running on a `spawn_blocking` worker — abandons the query at its next
/// probe point instead of scanning stale work to completion. (A blocking
/// task cannot be killed; it is abandoned cooperatively — the same
/// containment `resolve.rs::bounded_fallback` documents.)
#[derive(Clone, Default)]
struct SearchCancel {
    flag: Arc<std::sync::atomic::AtomicBool>,
}

impl SearchCancel {
    fn cancel(&self) {
        self.flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    fn is_cancelled(&self) -> bool {
        self.flag.load(std::sync::atomic::Ordering::Relaxed)
    }
}

/// `Drop` ⇒ [`SearchCancel::cancel`]. Held by the request handler future
/// across the scan's `JoinHandle` await, so a client-aborted (superseded)
/// request cancels its own scan. NB: must be bound to a NAMED binding
/// (`_cancel_on_drop`, never bare `_`) so it lives to end-of-scope.
struct CancelOnDrop(SearchCancel);

impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

/// `querySessionDirectory` (`service.ts:228-298`), title tier: sort, visibility
/// pre-filter, cursor page, revision. Returns the `SessionDirectoryPage` value, or
/// an error string when the cursor is invalid (→ 400).
///
/// SESSION-07: the cancellation-aware core is [`apply_query_cancellable`];
/// this adapter preserves the original 3-argument/`String`-error contract
/// for the (extensive) pre-existing test suite below (cancellation can never
/// fire without a probe, so the `Cancelled` arm is structurally unreachable
/// here). The production handler uses [`apply_query_cancellable`] directly.
#[cfg(test)]
fn apply_query(
    items: Vec<DirItem>,
    q: &DirQuery,
    identities: &[freshell_ws::identity::TerminalIdentity],
) -> Result<Value, String> {
    apply_query_cancellable(items, q, identities, None).map_err(|e| e.to_string())
}

/// The cancellation-aware query core (`service.ts:228-298` with its
/// `throwIfAborted` checks at :238/:261 and the abort-propagating
/// `applyFileSearch` at :153-226). `should_cancel` is the ported
/// `AbortSignal`: consulted before any search work and inside the per-item
/// scan loop; a fired probe aborts the WHOLE query ([`QueryError::Cancelled`]),
/// never a degraded page -- matching the reference's abort rethrow
/// (`service.ts:209-210`).
fn apply_query_cancellable(
    mut items: Vec<DirItem>,
    q: &DirQuery,
    identities: &[freshell_ws::identity::TerminalIdentity],
    should_cancel: Option<&(dyn Fn() -> bool)>,
) -> Result<Value, QueryError> {
    let limit = q
        .limit
        .unwrap_or(MAX_DIRECTORY_PAGE_ITEMS)
        .min(MAX_DIRECTORY_PAGE_ITEMS);
    let cursor = match &q.cursor {
        Some(c) => Some(decode_cursor(c).map_err(QueryError::BadCursor)?),
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
                // `throwIfAborted(input.signal)` (`service.ts:261`), checked
                // before the search work starts.
                if should_cancel.is_some_and(|probe| probe()) {
                    return Err(QueryError::Cancelled);
                }
                let file_tier = if q.tier == Tier::UserMessages {
                    FileSearchTier::UserMessages
                } else {
                    FileSearchTier::FullText
                };
                let result = apply_file_search(items, query_text, file_tier, limit, should_cancel)?;
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
/// [`apply_query_cancellable`]'s existing `items.len() > limit` next-cursor
/// check detect "more exist" without this function ever scanning the entire
/// remaining list (unlike the title tier, which does).
///
/// An item with no [`DirItem::source_file`] (a live-terminal-only item, an
/// opencode session -- direct-listed from one sqlite db, no per-session
/// file -- or an amplifier session whose transcript was never written) or an
/// unsupported `provider` is skipped WITHOUT counting against the scan
/// budget, mirroring `service.ts:191-195`'s `if (!sourceFile) continue` /
/// `if (!provider) continue` (both `continue` before the `scanned++` at :197).
///
/// Cancellation (SESSION-07): `should_cancel` is the ported `AbortSignal`,
/// consulted per ITEM (`throwIfAborted(input.signal)`, `service.ts:188`) and
/// threaded into the per-line scan. A fired probe aborts the WHOLE query
/// with [`QueryError::Cancelled`] -- the reference re-throws the abort error
/// instead of degrading (`service.ts:209-210`'s
/// `if (input.signal?.aborted) throw error`), so a superseded query must
/// never surface as a stale partial page.
fn apply_file_search(
    items: Vec<DirItem>,
    query_text: &str,
    tier: FileSearchTier,
    limit: usize,
    should_cancel: Option<&(dyn Fn() -> bool)>,
) -> Result<FileSearchOutcome, QueryError> {
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
        if should_cancel.is_some_and(|probe| probe()) {
            return Err(QueryError::Cancelled);
        }
        let Some(source_file) = item.source_file.clone() else {
            continue;
        };
        if !matches!(item.provider.as_str(), "claude" | "codex" | "amplifier") {
            continue;
        }
        scanned += 1;

        match search_session_file(
            &source_file,
            &item.provider,
            query_text,
            tier,
            should_cancel,
        ) {
            Ok(Some(m)) => {
                let mut matched = item;
                matched.matched_in = Some(m.matched_in.to_string());
                matched.snippet = Some(m.snippet);
                results.push(matched);
            }
            Ok(None) => {}
            // The abort RE-THROW (`service.ts:209-210`), kept distinct from
            // the degradable I/O arm.
            Err(SearchFileError::Cancelled) => return Err(QueryError::Cancelled),
            Err(SearchFileError::Io(_)) => {
                partial = true;
                if partial_reason.is_none() {
                    partial_reason = Some("io_error");
                }
            }
        }
    }

    Ok(FileSearchOutcome {
        items: results,
        partial,
        partial_reason,
    })
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
        let item = item_from_meta(&meta, "claude", "real-corrupted", false, None);
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
        let item = item_from_meta(&meta, "claude", "healthy", false, None);
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
        let page = apply_query(items, &q, &[]).unwrap();
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
        assert_eq!(arr[0]["snippet"], json!("Test session 1"));

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
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some(format!("t-{sid}")),
            title_provider_generated: false,
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
            source_file: None,
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

    // SESSION-14: timestamps reach the projection already normalized to
    // integer epoch-ms (`freshell_sessions::time::parse_timestamp_ms` floors
    // fractional numeric passthroughs like Node's `Math.floor`; ISO fractions
    // drop digits beyond the third). The directory page therefore carries
    // integer `lastActivityAt`/`createdAt`/`revision` only, and a rebuild
    // from identical index state (the refresh/restart cycle) reproduces the
    // exact same ordering + cursor — no millisecond-boundary oscillation.
    #[test]
    fn projected_timestamps_are_integers_and_paging_is_stable_across_rebuilds() {
        let mk = |sid: &str, at: i64, created: Option<i64>| DirItem {
            session_id: sid.into(),
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some(format!("t-{sid}")),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            last_activity_at: at,
            created_at: created,
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
            source_file: None,
        };
        // Boundary integers a fractional provider value floors INTO
        // (e.g. `1769753756713.9` → `1769753756713`); `a` and `b` tie on
        // `lastActivityAt` so the key-DESC tiebreak is exercised.
        let build = || {
            vec![
                mk("a", 1_769_753_756_713, Some(1_738_231_200_000)),
                mk("b", 1_769_753_756_713, Some(1_738_231_200_000)),
                mk("c", 1_738_231_200_000, None),
            ]
        };

        let q = DirQuery {
            limit: Some(2),
            ..DirQuery::default()
        };
        let page1 = apply_query(build(), &q, &[]).unwrap();
        // Identical rebuild → identical page (the refresh/restart pin).
        let page1_rebuilt = apply_query(build(), &q, &[]).unwrap();
        assert_eq!(page1, page1_rebuilt);

        let arr = page1["items"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
        // lastActivityAt DESC, then session-key DESC: "claude:b" before "claude:a".
        assert_eq!(arr[0]["sessionId"], json!("b"));
        assert_eq!(arr[1]["sessionId"], json!("a"));
        // Projected timestamps are plain JSON integers, never fractional.
        assert_eq!(arr[0]["lastActivityAt"], json!(1_769_753_756_713i64));
        assert!(arr[0]["lastActivityAt"].is_i64());
        assert_eq!(arr[0]["createdAt"], json!(1_738_231_200_000i64));
        assert!(arr[0]["createdAt"].is_i64());
        assert_eq!(page1["revision"], json!(1_769_753_756_713i64));
        assert!(page1["revision"].is_i64());

        // The cursor payload embeds the same integer boundary timestamp +
        // the tiebreak key, and paging with it is itself rebuild-stable.
        let cursor = page1["nextCursor"].as_str().expect("paged");
        let (c_last, c_key) = decode_cursor(cursor).unwrap();
        assert_eq!(c_last, 1_769_753_756_713);
        assert_eq!(c_key, "claude:a");
        let q2 = DirQuery {
            limit: Some(2),
            cursor: Some(cursor.to_string()),
            ..DirQuery::default()
        };
        let page2 = apply_query(build(), &q2, &[]).unwrap();
        let page2_rebuilt = apply_query(build(), &q2, &[]).unwrap();
        assert_eq!(page2, page2_rebuilt);
        let arr2 = page2["items"].as_array().unwrap();
        assert_eq!(arr2.len(), 1);
        assert_eq!(arr2[0]["sessionId"], json!("c"));
        assert_eq!(arr2[0]["lastActivityAt"], json!(1_738_231_200_000i64));
        // `createdAt` omitted when absent (matching the zod `.optional()`s).
        assert_eq!(arr2[0]["createdAt"], Value::Null);
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
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some("parsed".into()),
            title_provider_generated: false,
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
            source_file: None,
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

    /// SESSION-17: `provider:sessionId` keys (`buildSessionKey`,
    /// `service.ts:36-38`) mean a rename/archive/delete stored against one
    /// provider's raw id must NEVER touch a sibling provider's session that
    /// happens to share the SAME raw id. Seeds `shared` under all three
    /// providers, then: codex gets renamed+archived, opencode gets deleted,
    /// claude gets nothing — and asserts each outcome lands on exactly its
    /// own row.
    #[test]
    fn overrides_overlay_same_raw_id_is_scoped_by_provider_rename_archive_delete() {
        let mk = |provider: &str| DirItem {
            session_id: "shared".into(),
            provider: provider.into(),
            project_path: "/p".into(),
            title: Some("parsed".into()),
            title_provider_generated: false,
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
            source_file: None,
        };
        let items = vec![mk("claude"), mk("codex"), mk("opencode")];

        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "codex:shared".into(),
            json!({ "titleOverride": "Codex Rename", "archived": true }),
        );
        overrides.insert("opencode:shared".into(), json!({ "deleted": true }));

        let overlaid = apply_session_overrides(items, &overrides);
        assert_eq!(
            overlaid.len(),
            2,
            "only opencode:shared is deleted — the other providers' rows survive"
        );

        let claude = overlaid
            .iter()
            .find(|i| i.provider == "claude")
            .expect("claude row untouched by sibling overrides");
        assert_eq!(claude.title.as_deref(), Some("parsed"));
        assert!(!claude.archived);
        // The wire projection agrees.
        let v = claude.to_value();
        assert_eq!(v["title"], json!("parsed"));
        assert_eq!(v["archived"], json!(false));

        let codex = overlaid
            .iter()
            .find(|i| i.provider == "codex")
            .expect("codex row present");
        assert_eq!(codex.title.as_deref(), Some("Codex Rename"));
        assert!(codex.archived);

        assert!(
            overlaid.iter().all(|i| i.provider != "opencode"),
            "deleted:true on opencode:shared must filter ONLY the opencode row"
        );
    }

    #[test]
    fn overlay_shape_unchanged_when_no_overrides_archived_always_present() {
        let item = DirItem {
            session_id: "x".into(),
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some("t".into()),
            title_provider_generated: false,
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
            source_file: None,
        };
        let overlaid = apply_session_overrides(vec![item], &serde_json::Map::new());
        let v = overlaid[0].to_value();
        // Oracle-compat: archived is ALWAYS present, defaulted false.
        assert_eq!(v["archived"], json!(false));
        assert_eq!(v["title"], json!("t"));
    }

    // ── SESSION-02: full `applyOverride` parity (`session-indexer.ts:204-220`) ──

    /// Test-local `DirItem` factory; per-field tweaks via `provider_generated`
    /// and the default `created_at`, mirroring the literal-style factories above.
    fn session02_item(sid: &str, title: &str, provider_generated: bool, created_at: Option<i64>) -> DirItem {
        DirItem {
            session_id: sid.into(),
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some(title.into()),
            title_provider_generated: provider_generated,
            summary: None,
            first_user_message: None,
            last_activity_at: 100,
            created_at,
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
            source_file: None,
        }
    }

    /// `createdAt: ov?.createdAtOverride ?? session.createdAt`
    /// (`session-indexer.ts:216`): a present override REPLACES the parsed
    /// createdAt — including `0` (nullish coalescing, not `||`) — while an
    /// absent or explicit-null override keeps the parsed value; the replaced
    /// value reaches the wire `createdAt` (the field the sidebar orders by).
    #[test]
    fn overrides_overlay_applies_created_at_override_nullish_semantics() {
        let items = vec![
            session02_item("keep", "t", false, Some(500)),
            session02_item("zero", "t", false, Some(500)),
            session02_item("absent", "t", false, None),
        ];
        let mut overrides = serde_json::Map::new();
        overrides.insert("claude:keep".into(), json!({ "createdAtOverride": 123_456_789_000i64 }));
        overrides.insert("claude:zero".into(), json!({ "createdAtOverride": 0 }));
        overrides.insert("claude:absent".into(), json!({ "createdAtOverride": Value::Null }));

        let overlaid = apply_session_overrides(items, &overrides);
        assert_eq!(overlaid.len(), 3);

        let keep = &overlaid[0];
        assert_eq!(keep.created_at, Some(123_456_789_000));
        assert_eq!(keep.to_value()["createdAt"], json!(123_456_789_000i64));

        // `0` is NOT null — Node's `??` applies it (a falsy `||` would drop it).
        assert_eq!(overlaid[1].created_at, Some(0));

        // Explicit null behaves like absence: the parsed value is kept.
        assert_eq!(overlaid[2].created_at, None);
        assert_eq!(overlaid[2].to_value()["createdAt"], Value::Null);
    }

    /// A session with NO override at all keeps its parsed createdAt (the
    /// baseline the `createdAtOverride` cases above compare against).
    #[test]
    fn overrides_overlay_without_created_at_override_keeps_parsed_value() {
        let items = vec![session02_item("plain", "t", false, Some(777))];
        let overlaid = apply_session_overrides(items, &serde_json::Map::new());
        assert_eq!(overlaid[0].created_at, Some(777));
    }

    /// `shouldApplyTitleOverride` (`session-indexer.ts:210-211`): when the
    /// CURRENT parsed title is provider-generated, a stored override recorded
    /// under the `dir` or `first-message` source is SUPPRESSED — the provider's
    /// own title survives on the wire. (Pre-SESSION-02 this never ran here:
    /// `title_provider_generated` was read only by the resolve wire.)
    #[test]
    fn overrides_overlay_suppresses_dir_and_first_message_overrides_for_provider_generated_titles() {
        for ov in [
            json!({ "titleOverride": "Stale Guess", "titleSource": "dir" }),
            json!({ "titleOverride": "Stale Guess", "titleSource": "first-message" }),
        ] {
            let items = vec![session02_item("s", "Provider Title", true, None)];
            let mut overrides = serde_json::Map::new();
            overrides.insert("claude:s".into(), ov);
            let source = overrides["claude:s"]["titleSource"].clone();

            let overlaid = apply_session_overrides(items, &overrides);
            assert_eq!(
                overlaid[0].title.as_deref(),
                Some("Provider Title"),
                "titleSource {source} must NOT replace a provider-generated title"
            );
            assert_eq!(overlaid[0].to_value()["title"], json!("Provider Title"));
        }
    }

    /// The suppression is narrow (`session-indexer.ts:210-211`): it requires
    /// BOTH a provider-generated current title AND a `dir`/`first-message`
    /// recorded source. Every other combination substitutes the override:
    /// `user`/`ai`/`legacy`/absent sources always win, and a `dir`-sourced
    /// override still lands on a session whose current title is NOT
    /// provider-generated (nothing authoritative to protect).
    #[test]
    fn overrides_overlay_still_applies_title_override_outside_the_suppressed_pair() {
        // Provider-generated current title + non-suppressed sources.
        for source in ["user", "ai", "legacy"] {
            let items = vec![session02_item("s", "Provider Title", true, None)];
            let mut overrides = serde_json::Map::new();
            overrides.insert(
                "claude:s".into(),
                json!({ "titleOverride": "Renamed", "titleSource": source }),
            );
            let overlaid = apply_session_overrides(items, &overrides);
            assert_eq!(
                overlaid[0].title.as_deref(),
                Some("Renamed"),
                "titleSource {source} must win even against a provider-generated title"
            );
        }

        // Provider-generated current title + NO recorded titleSource.
        let items = vec![session02_item("s", "Provider Title", true, None)];
        let mut overrides = serde_json::Map::new();
        overrides.insert("claude:s".into(), json!({ "titleOverride": "Renamed" }));
        let overlaid = apply_session_overrides(items, &overrides);
        assert_eq!(overlaid[0].title.as_deref(), Some("Renamed"));

        // NOT provider-generated + a `dir`-sourced override: applied.
        let items = vec![session02_item("s", "Parsed Title", false, None)];
        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "claude:s".into(),
            json!({ "titleOverride": "Renamed", "titleSource": "dir" }),
        );
        let overlaid = apply_session_overrides(items, &overrides);
        assert_eq!(overlaid[0].title.as_deref(), Some("Renamed"));
    }

    /// `!!ov?.titleOverride` (`session-indexer.ts:210`): an EMPTY-string
    /// override is falsy in JS and never applied — verified here against both
    /// a provider-generated and a parsed title (mirrors the resolve wire's
    /// existing `!t.is_empty()` guard, `resolve.rs:541`).
    #[test]
    fn overrides_overlay_ignores_empty_title_override() {
        for provider_generated in [true, false] {
            let items = vec![session02_item("s", "Parsed Title", provider_generated, None)];
            let mut overrides = serde_json::Map::new();
            overrides.insert("claude:s".into(), json!({ "titleOverride": "" }));
            let overlaid = apply_session_overrides(items, &overrides);
            assert_eq!(
                overlaid[0].title.as_deref(),
                Some("Parsed Title"),
                "empty titleOverride applied (provider_generated={provider_generated})"
            );
        }
    }

    /// The production mapping carries the parse-layer flag:
    /// `dir_item_from_indexed` must copy `IndexedSession::title_provider_generated`
    /// into the `DirItem` so the suppression above can see it, and the
    /// `createdAt` suppression/override combo composes on one item (both
    /// regressions in ONE object — the real `applyOverride` merge shape).
    #[test]
    fn dir_item_from_indexed_preserves_title_provider_generated_and_composes_with_created_at_override() {
        for flag in [true, false] {
            let idx = IndexedSession {
                session_id: "s".into(),
                provider: "claude".into(),
                project_path: "/p".into(),
                title: Some("t".into()),
                title_provider_generated: flag,
                summary: None,
                first_user_message: None,
                last_activity_at: 7,
                created_at: Some(3),
                cwd: Some("/p".into()),
                is_subagent: false,
                is_non_interactive: false,
                source_file: None,
            };
            let item = dir_item_from_indexed(&idx);
            assert_eq!(item.title_provider_generated, flag);
        }

        // End-to-end on one item: provider-generated title + dir-sourced
        // titleOverride SUPPRESSED while createdAtOverride still applies.
        let idx = IndexedSession {
            session_id: "s".into(),
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some("Provider Title".into()),
            title_provider_generated: true,
            summary: None,
            first_user_message: None,
            last_activity_at: 7,
            created_at: Some(3),
            cwd: Some("/p".into()),
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        };
        let item = dir_item_from_indexed(&idx);
        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "claude:s".into(),
            json!({
                "titleOverride": "Stale Guess",
                "titleSource": "dir",
                "createdAtOverride": 999_000_000i64,
            }),
        );
        let overlaid = apply_session_overrides(vec![item], &overrides);
        assert_eq!(overlaid[0].title.as_deref(), Some("Provider Title"));
        assert_eq!(overlaid[0].created_at, Some(999_000_000));
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
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
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
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
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
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
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
        let session_index = Arc::new(SessionIndex::new(vec![
            Arc::new(CodexSource::new(codex_home)) as Arc<dyn SessionSource>,
        ]));
        let state = SessionDirectoryState {
            auth_token: Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
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
        let session_index = Arc::new(SessionIndex::new(vec![
            Arc::new(CodexSource::new(codex_home)) as Arc<dyn SessionSource>,
            Arc::new(OpencodeSource::new(opencode_home)) as Arc<dyn SessionSource>,
        ]));
        let state = SessionDirectoryState {
            auth_token: Arc::clone(&auth_token),
            settings: settings.clone(),
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
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

    // ── SESSION-07: stale-query cancellation (request supersession) ──

    /// The handler-side lifecycle hook: dropping the guard (which the
    /// handler owns across the scan await) must fire the token -- this is
    /// what makes hyper dropping a superseded/disconnected request's future
    /// cancel its blocking scan.
    #[test]
    fn cancel_on_drop_fires_the_search_token() {
        let cancel = SearchCancel::default();
        assert!(!cancel.is_cancelled());
        {
            let _guard = CancelOnDrop(cancel.clone());
            assert!(!cancel.is_cancelled());
        }
        assert!(
            cancel.is_cancelled(),
            "dropping the guard must cancel the token"
        );
    }

    /// Supersession mid-scan: the per-item probe (`throwIfAborted`,
    /// `service.ts:188`) must abandon the query BEFORE the next session's
    /// transcript is read -- even though a LATER session would have matched.
    /// Deterministic probe: the per-item/per-line checks fire in a fixed
    /// order; the probe turns true exactly at the second item's loop-top
    /// check, so session B's file is never opened.
    #[test]
    fn file_tier_scan_abandons_at_the_per_item_probe_before_reading_the_late_match() {
        let home = std::env::temp_dir().join(format!(
            "freshell-s07-cancel-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let project = home.join(".claude").join("projects").join("-home-dan-proj");
        std::fs::create_dir_all(&project).unwrap();
        // Session A (NEWER, scanned first): ONE non-matching user line, NO
        // trailing newline, so its scan consults the probe exactly: pre-read
        // + one line check.
        let sid_a = "eeeeeeee-0000-4000-8000-00000000000a";
        std::fs::write(
            project.join(format!("{sid_a}.jsonl")),
            format!(
                "{{\"parentUuid\":null,\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{sid_a}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"no match in A\"}},\"uuid\":\"{sid_a}-u001\",\"timestamp\":\"2026-01-30T06:20:00.000Z\"}}"
            ),
        )
        .unwrap();
        // Session B (older, scanned second): the ONLY match.
        let sid_b = "eeeeeeee-0000-4000-8000-00000000000b";
        std::fs::write(
            project.join(format!("{sid_b}.jsonl")),
            format!(
                "{{\"parentUuid\":null,\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{sid_b}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"needle-late-user-turn\"}},\"uuid\":\"{sid_b}-u001\",\"timestamp\":\"2026-01-30T06:10:00.000Z\"}}\n\
                 {{\"parentUuid\":\"{sid_b}-u001\",\"cwd\":\"/home/dan/proj\",\"sessionId\":\"{sid_b}\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"second turn for B\"}},\"uuid\":\"{sid_b}-u002\",\"timestamp\":\"2026-01-30T06:10:30.000Z\"}}\n"
            ),
        )
        .unwrap();

        let items = list_claude_sessions(&claude_home(&home));
        assert_eq!(items.len(), 2);
        let q = DirQuery {
            include_non_interactive: true,
            tier: Tier::UserMessages,
            query: Some("needle-late-user-turn".into()),
            ..DirQuery::default()
        };

        // Probe consult order: (1) pre-search check, (2) item-A loop top,
        // (3) A pre-read, (4) A's single line, then (5) item-B loop top.
        // `n >= 4` (n = calls BEFORE this one) makes call 5 the first true.
        let calls = std::cell::Cell::new(0usize);
        let probe = || {
            let n = calls.get();
            calls.set(n + 1);
            n >= 4
        };
        let outcome = apply_query_cancellable(items.clone(), &q, &[], Some(&probe));
        assert!(
            matches!(outcome, Err(QueryError::Cancelled)),
            "a superseded query must abort with Cancelled, never a stale page, got {outcome:?}"
        );

        // Control: an un-cancelled scan DOES reach session B's match,
        // proving the cancelled run abandoned EARLY (before B was read),
        // not merely failed to match.
        let page = apply_query_cancellable(items, &q, &[], Some(&|| false)).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["sessionId"], json!(sid_b));
        assert_eq!(arr[0]["matchedIn"], json!("userMessage"));
        std::fs::remove_dir_all(&home).ok();
    }

    /// A pre-cancelled probe yields NO page at all (`QueryError::Cancelled`)
    /// -- the port of the reference swallowing an aborted request without
    /// writing a response (`sessions-router.ts:128-131`). In particular it
    /// must NOT collapse into a degraded `partial`/`partialReason: io_error`
    /// page.
    #[test]
    fn pre_cancelled_file_tier_query_yields_no_page_and_no_partial() {
        let home = synthetic_claude_home_with_turns(
            "eeeeeeee-0000-4000-8000-00000000000c",
            "pre-cancelled-needle",
            "irrelevant assistant",
        );
        let items = list_claude_sessions(&claude_home(&home));
        let q = DirQuery {
            include_non_interactive: true,
            tier: Tier::UserMessages,
            query: Some("pre-cancelled-needle".into()),
            ..DirQuery::default()
        };
        let outcome = apply_query_cancellable(items, &q, &[], Some(&|| true));
        assert!(
            matches!(outcome, Err(QueryError::Cancelled)),
            "got {outcome:?}"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    /// End-to-end through the route: the file tier still serves matches now
    /// that the derivation runs on a blocking worker behind the cancellation
    /// wiring (the guard lives across the await; the probe never fires for a
    /// live request).
    #[tokio::test]
    async fn router_file_tier_query_is_served_through_the_cancellable_worker() {
        use axum::http::Request;
        use tower::ServiceExt;

        let home = synthetic_claude_home_with_turns(
            "eeeeeeee-0000-4000-8000-00000000000d",
            "router-tier-needle",
            "irrelevant assistant",
        );
        let settings =
            crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]);
        let auth_token: std::sync::Arc<String> = std::sync::Arc::new("tok".into());
        let session_index = std::sync::Arc::new(SessionIndex::new(vec![std::sync::Arc::new(
            freshell_sessions::directory_index::ClaudeSource::new(claude_home(&home)),
        )
            as std::sync::Arc<dyn SessionSource>]));
        let state = SessionDirectoryState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings,
            session_index: Some(session_index),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
        };
        let app = router(state);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/session-directory?priority=visible&includeNonInteractive=1&query=router-tier-needle&tier=userMessages")
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
        assert_eq!(items.len(), 1, "the file tier must still find the match");
        assert_eq!(items[0]["matchedIn"], json!("userMessage"));
        assert_eq!(page["nextCursor"], Value::Null);
        std::fs::remove_dir_all(&home).ok();
    }

    // ── SESSION-07: amplifier file-tier search (transcript.jsonl) ──

    /// Seed `<amp_home>/projects/proj/sessions/<id>/{metadata.json,
    /// transcript.jsonl}` via the REAL `AmplifierSource` so the test
    /// exercises the production `source_file` wiring end to end.
    fn synthetic_amplifier_home_with_turns(
        session_id: &str,
        user_text: &str,
        assistant_text: &str,
        thinking_text: &str,
    ) -> PathBuf {
        let home = std::env::temp_dir().join(format!(
            "freshell-s07-amp-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let dir = home
            .join("projects")
            .join("proj")
            .join("sessions")
            .join(session_id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            format!(
                "{{\"session_id\":\"{session_id}\",\"working_dir\":\"/p\",\"created\":1000,\"description_updated_at\":2000,\"name\":\"Amp Session\"}}"
            ),
        )
        .unwrap();
        std::fs::write(
            dir.join("transcript.jsonl"),
            format!(
                "{{\"role\":\"user\",\"content\":\"{user_text}\"}}\n\
                 {{\"role\":\"assistant\",\"content\":[{{\"type\":\"thinking\",\"thinking\":\"{thinking_text}\"}},{{\"type\":\"text\",\"text\":\"{assistant_text}\"}}]}}\n"
            ),
        )
        .unwrap();
        home
    }

    #[test]
    fn amplifier_file_tier_search_scans_the_transcript_with_tier_scoping() {
        let home = synthetic_amplifier_home_with_turns(
            "amp-sess-1",
            "amplifier-user-needle",
            "amplifier-assistant-needle",
            "amplifier-thinking-secret",
        );
        let items: Vec<DirItem> = freshell_sessions::amplifier::AmplifierSource::new(home.clone())
            .scan()
            .iter()
            .map(dir_item_from_indexed)
            .collect();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].provider, "amplifier");
        assert!(
            items[0].source_file.is_some(),
            "an amplifier session with a transcript must carry a source_file"
        );

        // userMessages: matches the user turn only.
        let q_user = DirQuery {
            tier: Tier::UserMessages,
            query: Some("amplifier-user-needle".into()),
            ..DirQuery::default()
        };
        let page = apply_query(items.clone(), &q_user, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(
            arr.len(),
            1,
            "userMessages must match the amplifier user turn"
        );
        assert_eq!(arr[0]["matchedIn"], json!("userMessage"));
        assert!(arr[0]["snippet"]
            .as_str()
            .unwrap()
            .contains("amplifier-user-needle"));

        // userMessages: the assistant-only phrase must NOT match.
        let q_asst_user_tier = DirQuery {
            tier: Tier::UserMessages,
            query: Some("amplifier-assistant-needle".into()),
            ..DirQuery::default()
        };
        let page = apply_query(items.clone(), &q_asst_user_tier, &[]).unwrap();
        assert_eq!(
            page["items"].as_array().unwrap().len(),
            0,
            "userMessages must never match amplifier assistant-only text"
        );

        // fullText: the assistant turn matches.
        let q_asst_full = DirQuery {
            tier: Tier::FullText,
            query: Some("amplifier-assistant-needle".into()),
            ..DirQuery::default()
        };
        let page = apply_query(items.clone(), &q_asst_full, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(
            arr.len(),
            1,
            "fullText must match the amplifier assistant turn"
        );
        assert_eq!(arr[0]["matchedIn"], json!("assistantMessage"));

        // fullText: thinking-block text (a `reasoning` event in the
        // reference, never searched) must NOT match.
        let q_thinking = DirQuery {
            tier: Tier::FullText,
            query: Some("amplifier-thinking-secret".into()),
            ..DirQuery::default()
        };
        let page = apply_query(items, &q_thinking, &[]).unwrap();
        assert_eq!(
            page["items"].as_array().unwrap().len(),
            0,
            "thinking-block content must stay unsearchable (reasoning events are filtered)"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    /// An amplifier session killed before its first `prompt:complete` has NO
    /// `transcript.jsonl`: it must be SKIPPED without consuming scan budget
    /// and without degrading the page to `partial` -- the file-tier analogue
    /// of the reference's `if (!sourceFile) continue` (`service.ts:191-192`).
    #[test]
    fn amplifier_session_without_transcript_is_skipped_cleanly_at_file_tiers() {
        let home = std::env::temp_dir().join(format!(
            "freshell-s07-amp-no-transcript-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let dir = home
            .join("projects")
            .join("proj")
            .join("sessions")
            .join("amp-sess-no-transcript");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            "{\"session_id\":\"amp-sess-no-transcript\",\"working_dir\":\"/p\",\"created\":1000,\"description_updated_at\":2000,\"name\":\"Amp No Transcript\"}",
        )
        .unwrap();
        let items: Vec<DirItem> = freshell_sessions::amplifier::AmplifierSource::new(home.clone())
            .scan()
            .iter()
            .map(dir_item_from_indexed)
            .collect();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source_file, None);

        let q = DirQuery {
            tier: Tier::FullText,
            query: Some("anything".into()),
            ..DirQuery::default()
        };
        let page = apply_query(items, &q, &[]).unwrap();
        assert_eq!(page["items"].as_array().unwrap().len(), 0);
        assert!(
            page.get("partial").is_none(),
            "skipping a transcript-less session must not degrade the page"
        );
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
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some("original parsed title".into()),
            title_provider_generated: false,
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
            source_file: None,
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

    // ── SESSION-19: accurate match tier + safe, bounded, isolated snippets ──

    /// SESSION-19 (title tier): the snippet is the MATCHED FIELD's first 140
    /// chars returned as literal data -- the server neither HTML-encodes nor
    /// strips markup (the client renders snippets as text; escaping is the
    /// JSON transport layer, matching the reference's `applySearch` +
    /// `JSON.stringify`, `service.ts:66-75`). The serialized wire page must
    /// carry the snippet byte-exactly through a JSON round-trip.
    #[test]
    fn title_tier_snippet_is_bounded_verbatim_and_wire_safe() {
        let long_html_title = format!(
            "<img src=x onerror=alert(1)> needle-title {}",
            "z".repeat(200)
        );
        let item = DirItem {
            session_id: "html1".into(),
            provider: "claude".into(),
            project_path: "/p".into(),
            title: Some(long_html_title.clone()),
            title_provider_generated: false,
            summary: None,
            first_user_message: None,
            last_activity_at: 100,
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
            source_file: None,
        };
        let q = DirQuery {
            query: Some("needle-title".into()),
            ..DirQuery::default()
        };
        let page = apply_query(vec![item], &q, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matchedIn"], json!("title"));
        let snippet = arr[0]["snippet"].as_str().unwrap();
        assert_eq!(
            snippet.chars().count(),
            140,
            "title-tier snippet is the matched field truncated to 140 chars"
        );
        assert_eq!(
            snippet,
            long_html_title.chars().take(140).collect::<String>()
        );
        assert!(
            snippet.contains("<img src=x onerror=alert(1)>"),
            "HTML is data and must be returned verbatim, got {snippet:?}"
        );
        assert!(
            !snippet.contains("&lt;") && !snippet.contains("&gt;"),
            "the server must not HTML-encode the snippet, got {snippet:?}"
        );

        // The wire form is valid JSON and round-trips the snippet exactly.
        let wire = serde_json::to_string(&page).unwrap();
        let round: Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(round["items"][0]["snippet"], json!(snippet));
        assert_eq!(round["items"][0]["matchedIn"], json!("title"));
    }

    /// SESSION-19 (title tier) -- neighbor-secret isolation across metadata
    /// FIELDS: the snippet is drawn ONLY from the matched field
    /// (title → summary → firstUserMessage precedence, `service.ts:66-75`),
    /// never spliced with the other fields' text, even though those fields
    /// are returned alongside it on the same item.
    #[test]
    fn title_tier_snippet_comes_only_from_the_matched_field() {
        let mk = |title: Option<&str>, summary: Option<&str>, fum: Option<&str>| DirItem {
            session_id: "iso1".into(),
            provider: "claude".into(),
            project_path: "/p".into(),
            title: title.map(str::to_string),
            title_provider_generated: false,
            summary: summary.map(str::to_string),
            first_user_message: fum.map(str::to_string),
            last_activity_at: 100,
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
            source_file: None,
        };

        // Query matching BOTH title and summary: title wins the tier label
        // and the snippet; the summary's sentinel stays out.
        let item = mk(
            Some("shared-needle in the title"),
            Some("shared-needle SUMMARY-SECRET-SENTINEL"),
            None,
        );
        let q = DirQuery {
            query: Some("shared-needle".into()),
            ..DirQuery::default()
        };
        let page = apply_query(vec![item], &q, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matchedIn"], json!("title"));
        assert_eq!(arr[0]["snippet"], json!("shared-needle in the title"));
        assert!(
            !arr[0]["snippet"].as_str().unwrap().contains("SUMMARY-SECRET-SENTINEL"),
            "a non-matched field's text must never leak into the snippet"
        );

        // Query matching only the summary: field-accurate tier label and an
        // exact, un-padded snippet despite sentinels in the other fields.
        let item = mk(
            Some("TITLE-SECRET-SENTINEL"),
            Some("summary holds needle-two here"),
            Some("FIRST-USER-SECRET-SENTINEL"),
        );
        let q = DirQuery {
            query: Some("needle-two".into()),
            ..DirQuery::default()
        };
        let page = apply_query(vec![item], &q, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matchedIn"], json!("summary"));
        assert_eq!(arr[0]["snippet"], json!("summary holds needle-two here"));
        let snippet = arr[0]["snippet"].as_str().unwrap();
        assert!(!snippet.contains("TITLE-SECRET-SENTINEL"));
        assert!(!snippet.contains("FIRST-USER-SECRET-SENTINEL"));

        // Query matching only firstUserMessage (title/summary absent):
        // matchedIn is "firstUserMessage" and the snippet is that field.
        let item = mk(None, None, Some("first user needle-three message"));
        let q = DirQuery {
            query: Some("needle-three".into()),
            include_empty: true,
            ..DirQuery::default()
        };
        let page = apply_query(vec![item], &q, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matchedIn"], json!("firstUserMessage"));
        assert_eq!(arr[0]["snippet"], json!("first user needle-three message"));
    }

    /// SESSION-19 (file tiers), end-to-end through `apply_query`: a
    /// transcript line storing JSON-escaped control characters and HTML
    /// markup is decoded, matched with the correct tier label, and snippeted
    /// verbatim-but-bounded -- the same-message secret beyond the 50-char
    /// context window and the neighboring assistant turn's secret both stay
    /// out, and the serialized page carries no raw control bytes.
    #[test]
    fn file_tier_snippet_escapes_control_chars_and_isolates_neighbor_secrets() {
        // `user_text` is embedded verbatim into a JSONL line by the helper,
        // so ESC must arrive as the 6-char `\u001b` JSON escape (a literal
        // ESC byte would make the line unparseable) -- mirroring how real
        // transcripts store control characters.
        let user_text = format!(
            "\\u001b[31m red \\u001b[0m ctrl-needle <script>alert(1)</script> {} SAME-FILE-SECRET",
            "p".repeat(200)
        );
        let home = synthetic_claude_home_with_turns(
            "eeeeeeee-0000-4000-8000-000000000001",
            &user_text,
            "ASSISTANT-NEIGHBOR-SECRET",
        );
        let items = list_claude_sessions(&claude_home(&home));
        assert_eq!(items.len(), 1);

        let q = DirQuery {
            include_non_interactive: true,
            tier: Tier::UserMessages,
            query: Some("ctrl-needle".into()),
            ..DirQuery::default()
        };
        let page = apply_query(items, &q, &[]).unwrap();
        let arr = page["items"].as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["matchedIn"], json!("userMessage"));
        let snippet = arr[0]["snippet"].as_str().unwrap();
        assert!(snippet.contains("ctrl-needle"));
        assert!(
            snippet.contains('\u{1b}'),
            "decoded control characters are snippet data, preserved verbatim"
        );
        assert!(
            snippet.contains("<script>alert(1)</script>"),
            "HTML within the context window is returned verbatim, got {snippet:?}"
        );
        assert!(
            !snippet.contains("SAME-FILE-SECRET"),
            "same-message text beyond the context window must not leak, got {snippet:?}"
        );
        assert!(
            !snippet.contains("ASSISTANT-NEIGHBOR-SECRET"),
            "a neighboring message must not leak into the snippet, got {snippet:?}"
        );

        let wire = serde_json::to_string(&page).unwrap();
        assert!(
            !wire.chars().any(|c| (c as u32) < 0x20),
            "the wire page must carry no raw control bytes: {wire:?}"
        );
        assert!(
            wire.contains("\\u001b"),
            "ESC must reach the wire as a \\u escape"
        );
        let round: Value = serde_json::from_str(&wire).unwrap();
        assert_eq!(round["items"][0]["snippet"], json!(snippet));
        std::fs::remove_dir_all(&home).ok();
    }
}
