//! OpenCode `opencode.db` SQLite listing parser.
//!
//! 1:1 port of `server/coding-cli/providers/opencode-listing-query.ts`
//! (`runOpencodeListingQuery`) + the row-mapping and degradation-class handling from
//! `OpencodeProvider.listSessionsDirect` (`providers/opencode.ts`). `node:sqlite` ->
//! `rusqlite` (bundled). The DB is opened READ-ONLY; the parser never writes.
//!
//! Degradation classes preserved (`missing_db`, `empty_db`, `schema_missing_parent_id`,
//! and the transient `read_error` re-throw that lets the indexer keep previously-listed
//! sessions instead of pruning the sidebar). `sqlite_unavailable` is intentionally
//! dropped: rusqlite is statically linked, so the "Node < 22.5" branch cannot occur.

use std::path::{Path, PathBuf};

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OpenFlags};

pub const THREE_VIEWS_MARKER_SQL_PATTERN: &str = "%<freshell-session-metadata origin=3-views%";
const OPENCODE_DB_BUSY_TIMEOUT_MS: u64 = 5000;

/// opencode's own default titles for sessions it has not yet named,
/// mirroring upstream `Session.isDefaultTitle` (v1.18.16,
/// `packages/opencode/src/session/session.ts:48-55`):
/// `New session - <ISO>` (parent) and `Child session - <ISO>` (subagent),
/// where `<ISO>` is JS `new Date(...).toISOString()` -- always exactly
/// 24 chars, e.g. `2026-08-10T23:47:23.950Z`. Also accepts the legacy
/// capital-S `New Session - ` prefix written by opencode <= v0.3.86
/// (changed in v0.4.0, 2025-08-07): DBs migrated from file storage may
/// still carry those rows, and SQLite's case-insensitive LIKE masks them
/// in ad-hoc queries. A NON-placeholder title is a real opencode session
/// name (opencode retitles parent sessions itself after the first
/// exchange); the directory index surfaces those as provider-generated.
/// Deliberate mainline deviation: the retired Node reference never
/// classified opencode titles at all. Callers reach it through the shared
/// name classifier, `crate::name_evidence::is_provider_placeholder_title`.
pub fn is_opencode_placeholder_title(title: &str) -> bool {
    let rest = ["New session - ", "Child session - ", "New Session - "]
        .iter()
        .find_map(|prefix| title.strip_prefix(prefix));
    let Some(rest) = rest else {
        return false;
    };
    let b = rest.as_bytes();
    const DIGITS: [usize; 17] = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22];
    b.len() == 24
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'.'
        && b[23] == b'Z'
        && DIGITS.iter().all(|&i| b[i].is_ascii_digit())
}

/// The degradation states the listing can report once (mirrors
/// `OpencodeDatabaseMessageClass`, minus `sqlite_unavailable`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpencodeDegrade {
    MissingDb,
    EmptyDb,
    SchemaMissingParentId,
}

/// Transient read failure. The reference `listSessionsDirect` re-throws this so
/// `refreshDirectProvider` returns early WITHOUT pruning — the port surfaces it as `Err`
/// with the same "preserve cached sessions" contract.
#[derive(Debug)]
pub struct OpencodeReadError(pub String);

impl std::fmt::Display for OpencodeReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "opencode read_error: {}", self.0)
    }
}
impl std::error::Error for OpencodeReadError {}

/// Raw row shape (`OpencodeSessionRow` in `opencode-listing-query.ts`).
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeSessionRow {
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub created_at: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub project_path: Option<String>,
    /// 3-views marker flag: the real inline EXISTS value on the candidate
    /// path; a literal-0 placeholder on the listing path, which fills
    /// markers from the provider's row-stamped cache instead.
    pub has_three_views_marker: Option<i64>,
    /// Raw `session.model` JSON text (`{"id","providerID","variant"}`),
    /// `NULL` on older schemas without the column.
    pub model: Option<String>,
}

/// `OpencodeListingResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeListingResult {
    pub rows: Vec<OpencodeSessionRow>,
    pub schema_missing_parent_id: bool,
    /// Marker-table census: which optional marker tables exist, so the
    /// listing path can assemble per-session marker probes with only the
    /// arms that exist (the candidate path keeps its inline EXISTS arms
    /// and ignores the census).
    pub has_part_table: bool,
    pub has_message_table: bool,
}

/// A mapped session (subset of `CodingCliSession` the opencode direct-lister produces).
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeSession {
    pub session_id: String,
    pub project_path: String,
    pub cwd: String,
    pub title: Option<String>,
    pub created_at: Option<i64>,
    pub last_activity_at: i64,
    pub is_subagent: Option<bool>,
    pub is_non_interactive: Option<bool>,
    /// First real (non-synthetic) user-message text, normalized via
    /// `crate::text::normalize_first_user_message`. Populated ONLY for
    /// sessions that still need naming (empty or opencode default
    /// placeholder titles -- see `is_opencode_placeholder_title`) -- a
    /// bounded per-session indexed lookup, never
    /// a full message/part scan (opencode.db can be multi-GB). Feeds the
    /// first-message/AI rungs of freshell's auto-title ladder. Deliberate
    /// mainline deviation from the retired Node reference, which never
    /// read message content for opencode listings.
    pub first_user_message: Option<String>,
    /// `provider/model` composite from the session row's `model` JSON —
    /// the same key the model-capability catalog uses. `None` when the
    /// column is absent (older schema), null, or malformed.
    pub model: Option<String>,
    /// Last `step-finish` token usage — what opencode's own compaction
    /// trigger reads. `None` when the session has no completed model step
    /// yet, has no model, or the bounded lookup degrades.
    pub last_usage: Option<OpencodeStepUsage>,
}

/// Result of a direct listing pass, carrying the (once-)degrade signals for the caller
/// to log — the reference logs these inline via `logDatabaseStateOnce`.
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeListing {
    pub sessions: Vec<OpencodeSession>,
    pub degrade: Vec<OpencodeDegrade>,
}

/// Model context-window limits — the parsed counterpart of opencode's
/// `models[id].limit { context, input?, output }`. The directory-index
/// layer resolves these through an injected resolver (catalog-backed in
/// production freshell-server wiring; `None` in every other construction).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeModelLimits {
    pub context: i64,
    pub input: Option<i64>,
    pub output: Option<i64>,
}

/// Token usage from a session's LAST `step-finish` part — the numbers
/// opencode's own compaction trigger reads (`session/overflow.ts`
/// `isOverflow({ tokens: lastFinished.tokens, ... })`, verified against
/// the v1.18.31 source; `prompt.ts` passes the last finished assistant
/// message's tokens).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeStepUsage {
    /// `tokens.total` — present on every real step-finish; `None` on
    /// hand-trimmed payloads, where the sum fallback applies.
    pub total: Option<i64>,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
}

/// opencode `provider/transform.ts` `OUTPUT_TOKEN_MAX` (v1.18.31).
pub const OPENCODE_OUTPUT_TOKEN_MAX: i64 = 32_000;
/// opencode `session/overflow.ts` `COMPACTION_BUFFER`.
pub const OPENCODE_COMPACTION_BUFFER_TOKENS: i64 = 20_000;

/// `maxOutputTokens(model) = Math.min(model.limit.output, 32000) || 32000`.
/// A missing/zero output limit falls back to the 32k cap (JS `||` on a
/// falsy value); negatives are treated as absent (nonsense input).
pub fn opencode_max_output_tokens(output_limit: Option<i64>) -> i64 {
    match output_limit {
        Some(o) if o > 0 => o.min(OPENCODE_OUTPUT_TOKEN_MAX),
        _ => OPENCODE_OUTPUT_TOKEN_MAX,
    }
}

/// opencode `session/overflow.ts` `usable()`: the context-token budget the
/// auto-compaction trigger compares against (`count >= usable`). `context`
/// of 0 returns 0 exactly as upstream (auto-compaction disabled there).
/// The `input` branch mirrors JS truthiness: only a NON-ZERO `input` takes
/// the `input - reserved` branch — `input: 0` is falsy upstream and falls
/// through to the `context - maxOutputTokens` branch.
pub fn opencode_usable_context(limits: &OpencodeModelLimits) -> i64 {
    if limits.context == 0 {
        return 0;
    }
    match limits.input {
        Some(input) if input != 0 => {
            let reserved =
                OPENCODE_COMPACTION_BUFFER_TOKENS.min(opencode_max_output_tokens(limits.output));
            (input - reserved).max(0)
        }
        _ => (limits.context - opencode_max_output_tokens(limits.output)).max(0),
    }
}

/// The compaction count: `tokens.total || (input + output + cache.read +
/// cache.write)` — opencode's `isOverflow` count verbatim (the fallback
/// deliberately omits `reasoning`, mirroring upstream).
pub fn opencode_context_count(usage: &OpencodeStepUsage) -> i64 {
    usage.total.filter(|t| *t > 0).unwrap_or_else(|| {
        usage
            .input
            .saturating_add(usage.output)
            .saturating_add(usage.cache_read)
            .saturating_add(usage.cache_write)
            .max(0)
    })
}

/// Meter percent: `round(count / usable * 100)` (half-up) clamped to
/// 0..=100. `None` when `usable <= 0` — no meter, mirroring upstream
/// disabling auto-compaction at `limit.context === 0`.
pub fn opencode_compact_percent(context_count: i64, usable: i64) -> Option<i64> {
    if usable <= 0 || context_count < 0 {
        return None;
    }
    let pct = context_count.saturating_mul(100).saturating_add(usable / 2) / usable;
    Some(pct.clamp(0, 100))
}

/// Parse the session row's `model` JSON (`{"id","providerID","variant"}`)
/// into the model-capability catalog's `provider/model` composite id
/// (`normalize_enabled_model_catalog` joins the same way — verbatim
/// `provider_id + "/" + model_id`). The id may itself contain slashes
/// (models.dev org/name ids like `moonshotai/Kimi-K3` — 44% of real
/// sessions; the catalog composes those ids verbatim too), so there is NO
/// id-side slash guard; the PROVIDER-side guard mirrors the catalog's own
/// provider-slash skip (catalog.rs:195-200 — such providers never appear in
/// the catalog, so the composite could never match). Degrades to `None` on
/// absent/malformed input — the meter stays unknown, the listing never
/// breaks.
fn opencode_model_composite(raw: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let id = v.get("id")?.as_str()?.trim();
    let provider = v.get("providerID")?.as_str()?.trim();
    if id.is_empty() || provider.is_empty() || provider.contains('/') {
        return None;
    }
    Some(format!("{provider}/{id}"))
}

fn to_opt_string(v: &SqlValue) -> Option<String> {
    match v {
        SqlValue::Text(s) => Some(s.clone()),
        _ => None,
    }
}

fn to_opt_i64(v: &SqlValue) -> Option<i64> {
    match v {
        SqlValue::Integer(i) => Some(*i),
        SqlValue::Real(f) if f.is_finite() => Some(*f as i64),
        _ => None,
    }
}

/// `runOpencodeListingQuery(dbPath, markerPattern)`.
///
/// Inspects whether `session` exposes `parent_id`, reports the marker-table
/// census (which of `part`/`message` exist), and runs the root-session
/// listing. The marker column is a literal-0 placeholder: the listing path
/// fills real markers per row from the provider's row-stamped cache
/// (`probe_session_marker`), probing only stamp-moved and NULL-stamp rows —
/// the inline EXISTS arms measured at ~99.7% of the live listing cost
/// (freshopencode re-list storm fix:
/// docs/plans/2026-09-17-freshopencode-relist-storm.md).
pub fn run_opencode_listing_query(
    conn: &Connection,
    marker_pattern: &str,
) -> rusqlite::Result<OpencodeListingResult> {
    run_opencode_query_inner(conn, marker_pattern, None, None, false)
}

/// `opencode_locator`'s bounded row-diff read
/// (`docs/plans/2026-07-18-opencode-terminal-restore-spec.md` §5, Slice A): the SAME
/// root-session listing as [`run_opencode_listing_query`], additionally bounded to
/// `s.time_created >= floor_ms` with a `LIMIT` — avoids scanning the full (potentially
/// multi-GB, WAL-mode) `session` table on every locator poll tick. Keeps the
/// inline 3-views marker EXISTS arms (byte-identical locator behavior):
/// this path is bounded (floor + LIMIT) and throttled, so it never needs
/// the row-stamped marker cache.
pub fn run_opencode_candidate_query(
    conn: &Connection,
    marker_pattern: &str,
    floor_ms: i64,
    limit: i64,
) -> rusqlite::Result<OpencodeListingResult> {
    run_opencode_query_inner(conn, marker_pattern, Some(floor_ms), Some(limit), true)
}

/// Bounded per-session lookup: the first text part of the earliest
/// user-role message. Uses the live schema's real indexed columns
/// (`message(session_id, time_created, id)` via
/// `message_session_time_created_id_idx`; `part(message_id, id)` via
/// `part_message_id_id_idx`) -- EXPLAIN QUERY PLAN shows index searches,
/// no scans. Measured 2026-08-10 (read-only) on the production 5.4 GB
/// opencode.db (2.9k sessions / 127k messages / 490k parts): all 175
/// placeholder sessions looked up in 69 ms total, ~0.4 ms per session
/// (168 of the 175 had a first user message).
///
/// Filters opencode-synthetic text parts (`$.synthetic = true` --
/// tool-call narration that sorts before the real prompt). Degrades to
/// `None` on ANY schema/query error: older opencode schemas without
/// `message.id`/`part.message_id` columns must not break listing.
///
/// NOTE: as of opencode v1.18.16 the `message`/`part` tables are
/// dual-written projections of the newer v2 event store
/// (`session_message`); the column shape is unchanged since v1.2.0 but
/// should be re-verified on major opencode upgrades.
const FIRST_USER_MESSAGE_SQL: &str = "\
    WITH first_user AS (\
        SELECT m.id FROM message m \
        WHERE m.session_id = ?1 AND json_extract(m.data, '$.role') = 'user' \
        ORDER BY m.time_created, m.id LIMIT 1\
    ) \
    SELECT json_extract(p.data, '$.text') \
    FROM part p JOIN first_user f ON p.message_id = f.id \
    WHERE json_extract(p.data, '$.type') = 'text' \
      AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0 \
      AND json_extract(p.data, '$.text') IS NOT NULL \
    ORDER BY p.id LIMIT 1";

/// The listing path's read: a failed prepare or query degrades to `None`
/// (an older schema must not break listing).
fn first_user_message_for_session(conn: &Connection, session_id: &str) -> Option<String> {
    try_first_user_message_for_session(conn, session_id).unwrap_or_else(|e| {
        tracing::debug!(
            session_id,
            error = %e,
            "opencode first-user-message read failed; degrading to None"
        );
        None
    })
}

/// The read itself: `Ok(None)` when the session has no (non-empty) user
/// message, `Err` when the statement cannot be prepared or the query fails
/// (busy past the timeout, schema mismatch).
fn try_first_user_message_for_session(
    conn: &Connection,
    session_id: &str,
) -> rusqlite::Result<Option<String>> {
    let mut stmt = conn.prepare_cached(FIRST_USER_MESSAGE_SQL)?;
    let text: Option<String> = match stmt.query_row(rusqlite::params![session_id], |row| row.get(0))
    {
        Ok(text) => text,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e),
    };
    Ok(text
        .as_deref()
        .and_then(crate::text::normalize_first_user_message))
}

/// Unified agent names (Task 3): the TARGETED first-user-message lookup for
/// an already-named opencode session — OpenCode names parent sessions itself
/// after the first exchange, so the bounded listing only carries first
/// messages for placeholder-titled rows. This reads the single named
/// session's first real user message on demand (read-only, the same
/// SQL/normalization the listing path uses), never a full-history scan.
///
/// `Ok(None)` means the session has no user message; ANY failed read — the
/// database cannot be opened, the statement cannot be prepared, the query
/// fails or stays busy past the timeout — is an `Err` (name-reliability
/// Task 5 review: the naming sweep remembers answers, so a failure must
/// never read as "no user message").
pub fn opencode_first_user_message_by_id(
    data_home: &Path,
    session_id: &str,
) -> Result<Option<String>, OpencodeByIdError> {
    let db_path = data_home.join("opencode.db");
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(by_id_err)?;
    conn.busy_timeout(std::time::Duration::from_millis(
        OPENCODE_BYID_BUSY_TIMEOUT_MS,
    ))
    .map_err(by_id_err)?;
    try_first_user_message_for_session(&conn, session_id).map_err(by_id_err)
}

/// Assistant messages of a session, newest-first — the usage walk's cursor.
/// EXPLAIN (live, read-only): `SEARCH m USING INDEX
/// message_session_time_created_id_idx (session_id=?)` — pure index walk.
const ASSISTANT_MESSAGES_NEWEST_FIRST_SQL: &str = "\
    SELECT m.id FROM message m \
    WHERE m.session_id = ?1 AND json_extract(m.data, '$.role') = 'assistant' \
    ORDER BY m.time_created DESC, m.id DESC";

/// One message's newest step-finish part — the usage walk's probe. EXPLAIN
/// (live, read-only): `SEARCH p USING INDEX part_message_id_id_idx
/// (message_id=?)`.
const MESSAGE_STEP_FINISH_SQL: &str = "\
    SELECT json_extract(p.data, '$.tokens.total'), \
           json_extract(p.data, '$.tokens.input'), \
           json_extract(p.data, '$.tokens.output'), \
           json_extract(p.data, '$.tokens.cache.read'), \
           json_extract(p.data, '$.tokens.cache.write') \
    FROM part p \
    WHERE p.message_id = ?1 AND json_extract(p.data, '$.type') = 'step-finish' \
    ORDER BY p.id DESC LIMIT 1";

/// Hard bound on the usage walk (fresh-eyes round-2 finding 2): the walk
/// may probe at most this many assistant messages before degrading to
/// `None`. Real sessions hit the step-finish on probe 1-2; a streak of 64
/// consecutive unfinished steps is pathological (flappy interrupts) and
/// the meter degrades there — a LOGGED miss, never a silent one, and
/// always bounded per session.
const USAGE_WALK_MAX_PROBES: u32 = 64;

/// Bounded per-session lookup: the NEWEST finished assistant step's token
/// usage — opencode's `lastFinished`. Walks assistant messages newest-first
/// (index order), probing each for a step-finish part; the FIRST hit is the
/// last finished step, so an in-flight or interrupted trailing step is
/// skipped naturally (live-DB verified: a running session's newest message
/// carries only step-start/reasoning parts). Work is at most
/// [`USAGE_WALK_MAX_PROBES`] message probes, each a pure index search —
/// never a whole-session part scan. Degrades to `None` on ANY
/// schema/query error or on hitting the cap.
fn last_step_finish_usage_for_session(
    conn: &Connection,
    session_id: &str,
) -> Option<OpencodeStepUsage> {
    let mut messages = match conn.prepare_cached(ASSISTANT_MESSAGES_NEWEST_FIRST_SQL) {
        Ok(stmt) => stmt,
        Err(e) => {
            tracing::debug!(
                session_id,
                error = %e,
                "opencode usage walk prepare failed; degrading to None"
            );
            return None;
        }
    };
    let mut probe = match conn.prepare_cached(MESSAGE_STEP_FINISH_SQL) {
        Ok(stmt) => stmt,
        Err(e) => {
            tracing::debug!(
                session_id,
                error = %e,
                "opencode usage probe prepare failed; degrading to None"
            );
            return None;
        }
    };
    let mut rows = match messages.query(rusqlite::params![session_id]) {
        Ok(rows) => rows,
        Err(e) => {
            tracing::debug!(
                session_id,
                error = %e,
                "opencode usage walk query failed; degrading to None"
            );
            return None;
        }
    };
    let mut probes: u32 = 0;
    loop {
        let message_id: Option<String> = match rows.next() {
            Ok(Some(row)) => match row.get(0) {
                Ok(id) => id,
                Err(e) => {
                    tracing::debug!(
                        session_id,
                        error = %e,
                        "opencode usage walk row read failed; degrading to None"
                    );
                    return None;
                }
            },
            Ok(None) => return None,
            Err(e) => {
                tracing::debug!(
                    session_id,
                    error = %e,
                    "opencode usage walk advance failed; degrading to None"
                );
                return None;
            }
        };
        let Some(message_id) = message_id else {
            continue;
        };
        match probe.query_row(rusqlite::params![message_id], |row| {
            Ok(OpencodeStepUsage {
                total: row.get(0)?,
                input: row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                output: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                cache_read: row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                cache_write: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
            })
        }) {
            Ok(usage) => {
                if probes > 8 {
                    // Observability, not truncation: a session with many
                    // trailing unfinished steps pays more probes — still
                    // bounded by the cap below, all index searches.
                    tracing::debug!(
                        session_id,
                        probes,
                        "opencode usage walk probed several messages"
                    );
                }
                return Some(usage);
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                // Count MISSES only after the probe executes
                // (plan-review round-3 finding 3): checking before the
                // query would allow only cap-1 real probes — a finish on
                // the 64th candidate must be found, so the cap bounds
                // consecutive misses, not candidates.
                probes += 1;
                if probes >= USAGE_WALK_MAX_PROBES {
                    // A bounded miss, never a silent one: 64 consecutive
                    // unfinished assistant steps is pathological — degrade
                    // with observability instead of walking the whole
                    // session.
                    tracing::debug!(
                        session_id,
                        probes,
                        "opencode usage walk hit the probe cap; degrading to None"
                    );
                    return None;
                }
            }
            Err(e) => {
                tracing::debug!(
                    session_id,
                    error = %e,
                    "opencode step-finish probe failed; degrading to None"
                );
                return None;
            }
        }
    }
}

/// Cache-or-walk wrapper around [`last_step_finish_usage_for_session`]:
/// consults the row-stamped cache first; only a stamp change (or a NULL
/// stamp, which can never be validated) executes the walk. `None` results
/// are cached like any other — a walk that legitimately found nothing
/// should not re-run per re-list (the pathological 64-probe-cap session is
/// exactly the one this must not re-walk on every WAL move). A poisoned
/// lock recovers rather than breaking the listing (degrade discipline).
fn cached_or_walked_usage(
    cache: &std::sync::Mutex<std::collections::HashMap<String, CachedUsage>>,
    walk_count: &std::sync::atomic::AtomicU64,
    conn: &Connection,
    session_id: &str,
    stamp: Option<i64>,
) -> Option<OpencodeStepUsage> {
    let Some(stamp) = stamp else {
        // NULL time_updated: never cacheable — no stamp to validate
        // against. Always walk, exactly as the pre-cache code did.
        walk_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        return last_step_finish_usage_for_session(conn, session_id);
    };
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(hit) = cache.get(session_id) {
        if hit.stamp == stamp {
            return hit.usage.clone();
        }
    }
    walk_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let usage = last_step_finish_usage_for_session(conn, session_id);
    cache.insert(
        session_id.to_string(),
        CachedUsage {
            stamp,
            usage: usage.clone(),
        },
    );
    usage
}

/// Standalone per-session 3-views marker probe — the SAME two EXISTS
/// predicates the inline marker_expr used, with only the arms whose
/// tables exist; zero arms return 0 without querying (the old inline
/// literal-0 degrade, preserved).
fn probe_session_marker(
    conn: &Connection,
    has_part_table: bool,
    has_message_table: bool,
    marker_pattern: &str,
    session_id: &str,
) -> i64 {
    let mut arms: Vec<&str> = Vec::new();
    if has_part_table {
        arms.push("EXISTS (SELECT 1 FROM part pa WHERE pa.session_id = ?1 AND pa.data LIKE ?2)");
    }
    if has_message_table {
        arms.push("EXISTS (SELECT 1 FROM message m WHERE m.session_id = ?1 AND m.data LIKE ?2)");
    }
    if arms.is_empty() {
        return 0;
    }
    let sql = format!("SELECT {}", arms.join(" OR "));
    match conn.query_row(&sql, rusqlite::params![session_id, marker_pattern], |row| {
        row.get::<_, i64>(0)
    }) {
        Ok(v) => v,
        Err(e) => {
            // Degrade discipline: a failed probe serves unmarked (0) with
            // observability and never breaks the listing.
            tracing::debug!(
                session_id,
                error = %e,
                "opencode marker probe failed; serving unmarked (degrade discipline)"
            );
            0
        }
    }
}

/// Cache-or-probe wrapper around [`probe_session_marker`], mirroring
/// [`cached_or_walked_usage`]: consults the row-stamped cache first; only
/// a stamp change (or a NULL stamp, which can never be validated) executes
/// the probe. A schema with no marker tables skips both cache and probe —
/// the old inline literal-0 degrade, preserved. A poisoned lock recovers
/// rather than breaking the listing (degrade discipline).
///
/// 8 arguments (`clippy::too_many_arguments`): every one is a distinct,
/// independently-owned input — the two cache/counter seams (mirroring
/// `cached_or_walked_usage`'s explicitness), the shared connection, the
/// two census flags, the marker pattern, and the row's id/stamp. The
/// `registry.rs` precedent.
#[allow(clippy::too_many_arguments)]
fn cached_or_probed_marker(
    cache: &std::sync::Mutex<std::collections::HashMap<String, CachedMarker>>,
    probe_count: &std::sync::atomic::AtomicU64,
    conn: &Connection,
    has_part_table: bool,
    has_message_table: bool,
    marker_pattern: &str,
    session_id: &str,
    stamp: Option<i64>,
) -> i64 {
    if !has_part_table && !has_message_table {
        // Degraded schema: neither marker table exists — the old inline
        // marker_expr was the literal 0 with zero marker SQL. No probe,
        // no cache entry, no counter movement.
        return 0;
    }
    let Some(stamp) = stamp else {
        // NULL time_updated: never cacheable — no stamp to validate
        // against. Always probe, exactly as the pre-cache code did.
        probe_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        return probe_session_marker(
            conn,
            has_part_table,
            has_message_table,
            marker_pattern,
            session_id,
        );
    };
    let mut cache = cache
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(hit) = cache.get(session_id) {
        if hit.stamp == stamp {
            return hit.marker;
        }
    }
    probe_count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let marker = probe_session_marker(
        conn,
        has_part_table,
        has_message_table,
        marker_pattern,
        session_id,
    );
    cache.insert(session_id.to_string(), CachedMarker { stamp, marker });
    marker
}

fn run_opencode_query_inner(
    conn: &Connection,
    marker_pattern: &str,
    floor_ms: Option<i64>,
    limit: Option<i64>,
    inline_marker: bool,
) -> rusqlite::Result<OpencodeListingResult> {
    conn.busy_timeout(std::time::Duration::from_millis(
        OPENCODE_DB_BUSY_TIMEOUT_MS,
    ))?;

    // PRAGMA table_info(session) -> hasParentId + hasModel (the schema-
    // tolerance guards below branch on both).
    let (has_parent_id, has_model) = {
        let mut stmt = conn.prepare("PRAGMA table_info(session)")?;
        let names = stmt.query_map([], |row| row.get::<_, String>(1))?;
        let mut has_parent_id = false;
        let mut has_model = false;
        for name in names {
            match name?.as_str() {
                "parent_id" => has_parent_id = true,
                "model" => has_model = true,
                _ => {}
            }
        }
        (has_parent_id, has_model)
    };
    let root_filter = if has_parent_id {
        "AND s.parent_id IS NULL"
    } else {
        ""
    };

    // Which optional tables exist (the marker can live in part.data and/or message.data).
    let table_names: std::collections::HashSet<String> = {
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut set = std::collections::HashSet::new();
        for r in rows {
            set.insert(r?);
        }
        set
    };

    let has_part_table = table_names.contains("part");
    let has_message_table = table_names.contains("message");
    // The listing path (inline_marker = false) fills markers per row from
    // the provider's row-stamped cache instead: its SELECT carries the
    // literal-0 placeholder (positional layout and row-mapping indices
    // untouched) with zero marker SQL. The candidate path
    // (inline_marker = true) keeps the inline EXISTS arms byte-identical.
    let (marker_expr, marker_params) = if inline_marker {
        let mut marker_clauses: Vec<&str> = Vec::new();
        let mut marker_params: Vec<String> = Vec::new();
        if has_part_table {
            marker_clauses.push(
                "EXISTS (SELECT 1 FROM part pa WHERE pa.session_id = s.id AND pa.data LIKE ?)",
            );
            marker_params.push(marker_pattern.to_string());
        }
        if has_message_table {
            marker_clauses.push(
                "EXISTS (SELECT 1 FROM message m WHERE m.session_id = s.id AND m.data LIKE ?)",
            );
            marker_params.push(marker_pattern.to_string());
        }
        if marker_clauses.is_empty() {
            ("0".to_string(), marker_params)
        } else {
            (format!("({})", marker_clauses.join(" OR ")), marker_params)
        }
    } else {
        ("0".to_string(), Vec::new())
    };

    // Schema tolerance (the parent_id discipline): older opencode schemas
    // have no session.model column — a literal s.model would fail the whole
    // listing there. NULL AS model keeps those DBs listable, meter-unknown.
    let model_expr = if has_model {
        "s.model AS model"
    } else {
        "NULL AS model"
    };

    // `floor_ms`/`limit` are internally-produced i64 values (never user/network
    // text), so formatting them directly into the SQL text is safe and keeps the
    // marker parameter list (the only untrusted-shaped input) untouched.
    let floor_clause = match floor_ms {
        Some(f) => format!("AND s.time_created >= {f}"),
        None => String::new(),
    };
    let limit_clause = match limit {
        Some(l) => format!("LIMIT {l}"),
        None => String::new(),
    };

    let sql = format!(
        "SELECT \
            s.id AS sessionId, \
            s.directory AS cwd, \
            s.title AS title, \
            s.time_created AS createdAt, \
            s.time_updated AS lastActivityAt, \
            p.worktree AS projectPath, \
            {marker_expr} AS hasThreeViewsMarker, \
            {model_expr} \
         FROM session s \
         LEFT JOIN project p ON p.id = s.project_id \
         WHERE s.time_archived IS NULL \
            {root_filter} \
            {floor_clause} \
         ORDER BY s.time_updated DESC \
         {limit_clause}"
    );

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::ToSql> = marker_params
        .iter()
        .map(|p| p as &dyn rusqlite::ToSql)
        .collect();
    let rows_iter = stmt.query_map(param_refs.as_slice(), |row| {
        Ok(OpencodeSessionRow {
            session_id: match row.get::<_, SqlValue>(0)? {
                SqlValue::Text(s) => s,
                other => to_opt_string(&other).unwrap_or_default(),
            },
            cwd: to_opt_string(&row.get::<_, SqlValue>(1)?),
            title: to_opt_string(&row.get::<_, SqlValue>(2)?),
            created_at: to_opt_i64(&row.get::<_, SqlValue>(3)?),
            last_activity_at: to_opt_i64(&row.get::<_, SqlValue>(4)?),
            project_path: to_opt_string(&row.get::<_, SqlValue>(5)?),
            has_three_views_marker: to_opt_i64(&row.get::<_, SqlValue>(6)?),
            model: to_opt_string(&row.get::<_, SqlValue>(7)?),
        })
    })?;

    let mut rows = Vec::new();
    for r in rows_iter {
        rows.push(r?);
    }

    Ok(OpencodeListingResult {
        rows,
        schema_missing_parent_id: !has_parent_id,
        has_part_table,
        has_message_table,
    })
}

/// One cached usage-walk result, keyed by session id and validated by the
/// session row's `time_updated` stamp (the listing already SELECTs it as
/// `lastActivityAt`). `usage: None` is a legitimate cached value — a walk
/// that found no step-finish, a capped miss, or a transient-error degrade
/// — the stamp, not the value, decides freshness (freshopencode re-list
/// storm fix: docs/plans/2026-09-17-freshopencode-relist-storm.md).
#[derive(Debug, Clone)]
struct CachedUsage {
    stamp: i64,
    usage: Option<OpencodeStepUsage>,
}

/// One cached 3-views marker result, keyed by session id and validated by
/// the session row's `time_updated` stamp — the same regime as the usage
/// cache. `marker` is the raw 0/1 the inline EXISTS arms would have
/// produced; a schema with no marker tables yields 0 with no probe (the
/// old inline literal-0 degrade, preserved).
#[derive(Debug, Clone)]
struct CachedMarker {
    stamp: i64,
    marker: i64,
}

/// The read-only opencode provider (path derivation + direct listing).
pub struct OpencodeProvider {
    home_dir: PathBuf,
    /// Row-stamped usage-walk cache: every dirty-mark/WAL-move re-list
    /// re-runs the whole listing (the pinned trigger contract), but the
    /// per-session usage walk only re-executes for rows whose
    /// `time_updated` moved. Pruned to the listed id-set at the end of
    /// each successful listing, so the map stays O(live sessions).
    usage_cache: std::sync::Mutex<std::collections::HashMap<String, CachedUsage>>,
    /// Counts actual usage-walk executions (cache misses) — test/diagnostic
    /// hook mirroring `OpencodeLocator::db_scan_count`
    /// (crates/freshell-sessions/src/opencode_locator.rs:172-177).
    usage_walks: std::sync::atomic::AtomicU64,
    /// Row-stamped marker cache: the same regime for the 3-views marker
    /// EXISTS probes (measured at ~99.7% of the live listing cost) — only
    /// stamp-moved, new, and NULL-stamp rows re-probe. Pruned with the
    /// usage cache to the listed id-set.
    marker_cache: std::sync::Mutex<std::collections::HashMap<String, CachedMarker>>,
    /// Counts actual marker-probe executions (cache misses) — test/
    /// diagnostic hook mirroring `usage_walks`.
    marker_probes: std::sync::atomic::AtomicU64,
}

impl OpencodeProvider {
    pub fn new(home_dir: impl Into<PathBuf>) -> Self {
        Self {
            home_dir: home_dir.into(),
            usage_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            usage_walks: std::sync::atomic::AtomicU64::new(0),
            marker_cache: std::sync::Mutex::new(std::collections::HashMap::new()),
            marker_probes: std::sync::atomic::AtomicU64::new(0),
        }
    }

    /// `getDatabasePath` — `<homeDir>/opencode.db`.
    pub fn database_path(&self) -> PathBuf {
        self.home_dir.join("opencode.db")
    }

    /// How many usage walks have actually executed (cache misses) so far —
    /// test/diagnostic hook mirroring `OpencodeLocator::db_scan_count`:
    /// proves unchanged session rows skip the walk across re-lists.
    pub fn usage_walk_count(&self) -> u64 {
        self.usage_walks.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// How many marker probes have actually executed (cache misses) so
    /// far — test/diagnostic hook mirroring `usage_walk_count`: proves
    /// unchanged session rows skip the marker probe across re-lists.
    pub fn marker_probe_count(&self) -> u64 {
        self.marker_probes.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// `getWatchedDatabasePaths` — `[db, db-wal]`.
    pub fn watched_database_paths(&self) -> [PathBuf; 2] {
        let db = self.database_path();
        let wal = PathBuf::from(format!("{}-wal", db.display()));
        [db, wal]
    }

    /// `getSessionRoots` — `[db]`.
    pub fn session_roots(&self) -> Vec<PathBuf> {
        vec![self.database_path()]
    }

    /// `getSessionWatchBases` — `[dirname(homeDir)]`.
    pub fn session_watch_bases(&self) -> Vec<PathBuf> {
        vec![self
            .home_dir
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| self.home_dir.clone())]
    }

    /// `listSessionsDirect` — missing_db/empty_db/schema_missing_parent_id degrade inline,
    /// row-mapping skips rows without a cwd, and a query failure surfaces as `Err`
    /// (re-throw / preserve-cached semantics). `now_ms` is the injected clock the
    /// reference reads from `Date.now()`.
    /// Cheap per-sweep health probe: is the database still OPENABLE and its
    /// schema page READABLE through the exact open path [`Self::list_sessions`]
    /// uses? A missing db is healthy-absent (matching `list_sessions`'s
    /// `MissingDb` tolerance); a locked, `chmod`ed, or corrupted db errors.
    /// One `sqlite_master` count (a single page read) — never a full listing.
    pub fn health_check(&self) -> Result<(), OpencodeReadError> {
        let db_path = self.database_path();
        if !db_path.exists() {
            return Ok(());
        }
        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| OpencodeReadError(e.to_string()))?;
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
            .map_err(|e| OpencodeReadError(e.to_string()))
    }

    pub fn list_sessions(&self, now_ms: i64) -> Result<OpencodeListing, OpencodeReadError> {
        let db_path = self.database_path();
        let mut degrade = Vec::new();

        if !db_path.exists() {
            degrade.push(OpencodeDegrade::MissingDb);
            return Ok(OpencodeListing {
                sessions: Vec::new(),
                degrade,
            });
        }

        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| OpencodeReadError(e.to_string()))?;

        let result = run_opencode_listing_query(&conn, THREE_VIEWS_MARKER_SQL_PATTERN)
            .map_err(|e| OpencodeReadError(e.to_string()))?;

        if result.schema_missing_parent_id {
            degrade.push(OpencodeDegrade::SchemaMissingParentId);
        }
        if result.rows.is_empty() {
            degrade.push(OpencodeDegrade::EmptyDb);
        }

        let mut sessions = Vec::new();
        for row in result.rows {
            let cwd = match row.cwd {
                Some(ref c) if !c.is_empty() => c.clone(),
                _ => continue,
            };
            // Reference: `row.projectPath || resolveGitRepoRoot(row.cwd)`. The git-root
            // collapse is applied by the indexer's project-path resolver (a later step);
            // when the DB already stores `p.worktree` (the common case) the result is the
            // worktree verbatim, which is what we return here.
            let project_path = meaningful_worktree(row.project_path).unwrap_or_else(|| cwd.clone());
            // The listing SELECT's marker column is the literal-0
            // placeholder — the real marker comes from the row-stamped
            // cache, probing only stamp-moved/new/NULL-stamp rows.
            let has_three_views_marker = cached_or_probed_marker(
                &self.marker_cache,
                &self.marker_probes,
                &conn,
                result.has_part_table,
                result.has_message_table,
                THREE_VIEWS_MARKER_SQL_PATTERN,
                &row.session_id,
                row.last_activity_at,
            );
            let is_three_views = has_three_views_marker == 1;
            // Bounded first-message extraction: ONLY for sessions that still
            // need naming (empty/placeholder title). Named sessions surface
            // opencode's own title (provider-generated) and never need the
            // lookup, so listing cost scales with the small unnamed subset,
            // not with DB size.
            let needs_naming =
                !crate::opencode_row_title::is_opencode_session_name(row.title.as_deref());
            let first_user_message = if needs_naming {
                first_user_message_for_session(&conn, &row.session_id)
            } else {
                None
            };
            let model = row.model.as_deref().and_then(opencode_model_composite);
            // Bounded usage lookup, gated on a resolvable model: usage
            // without a model can never produce meter fields (limits are
            // resolved per model), so those sessions skip the query. The
            // row-stamped cache serves unchanged rows without re-walking.
            let last_usage = if model.is_some() {
                cached_or_walked_usage(
                    &self.usage_cache,
                    &self.usage_walks,
                    &conn,
                    &row.session_id,
                    row.last_activity_at,
                )
            } else {
                None
            };
            sessions.push(OpencodeSession {
                session_id: row.session_id,
                project_path,
                cwd,
                title: row.title,
                created_at: row.created_at,
                last_activity_at: row.last_activity_at.unwrap_or(now_ms),
                is_subagent: if is_three_views { Some(true) } else { None },
                is_non_interactive: if is_three_views { Some(true) } else { None },
                first_user_message,
                model,
                last_usage,
            });
        }

        // Prune the caches to the listed id-set: sessions that left the
        // listing (archived, deleted) drop their cached walk/probe so a
        // later re-entry re-executes even under an unchanged stamp.
        {
            let listed: std::collections::HashSet<&str> =
                sessions.iter().map(|s| s.session_id.as_str()).collect();
            self.usage_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .retain(|id, _| listed.contains(id.as_str()));
            self.marker_cache
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .retain(|id, _| listed.contains(id.as_str()));
        }

        Ok(OpencodeListing { sessions, degrade })
    }

    /// `opencode_locator`'s bounded row-diff read (spec §4.5/§5, Slice A): the
    /// raw root-session rows (id/cwd/created_at/marker — everything the locator
    /// needs to confirm/reject a candidate synchronously) filtered to
    /// `time_created >= floor_ms`, bounded by `limit`. Tolerates a missing DB
    /// (returns empty, no error — the locator has no separate degrade-reporting
    /// need the way `list_sessions` does for the sidebar).
    pub fn list_sessions_since(
        &self,
        floor_ms: i64,
        limit: i64,
    ) -> Result<Vec<OpencodeSessionRow>, OpencodeReadError> {
        let db_path = self.database_path();
        if !db_path.exists() {
            return Ok(Vec::new());
        }

        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
        )
        .map_err(|e| OpencodeReadError(e.to_string()))?;

        let result =
            run_opencode_candidate_query(&conn, THREE_VIEWS_MARKER_SQL_PATTERN, floor_ms, limit)
                .map_err(|e| OpencodeReadError(e.to_string()))?;

        Ok(result.rows)
    }
}

/// OpenCode's catch-all "global" project stores `worktree = "/"` — a
/// non-informative placeholder, not a real checkout. Treat it (and empty)
/// as absent so callers fall back to the session's real cwd.
fn meaningful_worktree(p: Option<String>) -> Option<String> {
    p.filter(|p| !p.is_empty() && p != "/")
}

/// Busy timeout for the existence probe's by-id lookup. Deliberately much
/// shorter than `OPENCODE_DB_BUSY_TIMEOUT_MS` (5000ms): `exists()` runs
/// synchronously on the reconcile path, once per pane — N panes x 5s of
/// WAL lock contention would stall every restart. A still-locked DB is a
/// transient read failure (`Err` => the probe answers Unknown and
/// reconcile's bounded deferral retries), not evidence of absence.
const EXISTENCE_BY_ID_BUSY_TIMEOUT_MS: u64 = 250;

/// Existence-probe by-id lookup: does `<data_home>/opencode.db` hold a
/// `session` row with this id?
///
/// Deliberately NO `parent_id` filter — the attach arm
/// (`opencode --session <id>` -> session.get by id) resolves CHILD
/// sessions the root-filtered listing hides — NO `directory` filter
/// (directory-less roots are real, attachable rows the listing drops at
/// mapping) — and NO `time_archived` filter: opencode's `Session.get`
/// has no archived filter and a live attach to an archived session
/// succeeds (validated against v1.18.9), so archived rows answer
/// `Ok(true)`. The query matches the ATTACH arm, not the listing: any
/// filter the attach arm lacks would answer "absent" for an attachable
/// session — the false-dead-session bug class this function removes.
/// Schema note: only `id` is referenced, so legacy schemas lacking
/// `time_archived` answer normally.
///
/// - `Ok(false)` for a missing DB file (opencode never ran here) or no
///   matching row;
/// - `Err` for ANY read failure (lock contention, corruption, io error,
///   schema variance). LOAD-BEARING: callers must treat `Err` as
///   "unknown", never "absent" — an absent-on-error would let WAL lock
///   contention adjudicate live sessions dead.
pub fn session_exists_by_id(data_home: &Path, session_id: &str) -> Result<bool, OpencodeReadError> {
    let db_path = data_home.join("opencode.db");
    if !db_path.exists() {
        return Ok(false);
    }
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| OpencodeReadError(e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_millis(
        EXISTENCE_BY_ID_BUSY_TIMEOUT_MS,
    ))
    .map_err(|e| OpencodeReadError(e.to_string()))?;
    match conn.query_row(
        "SELECT 1 FROM session WHERE id = ?1",
        rusqlite::params![session_id],
        |_| Ok(()),
    ) {
        Ok(()) => Ok(true),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(e) => Err(OpencodeReadError(e.to_string())),
    }
}

/// Classify a session id as SUBAGENT (`parent_id IS NOT NULL`) via a single
/// indexed row lookup — the classification behind the sidebar rail's
/// subagent-terminal filtering (never used for association decisions; the
/// locator's candidate SQL keeps its own `parent_id IS NULL` refusal).
///
/// - `Ok(None)`: DB file missing (opencode never ran here) or no matching row;
/// - `Ok(Some(true))`: row exists with a parent (subagent/child session);
/// - `Ok(Some(false))`: root row, or a legacy schema without `parent_id`
///   (every session is a root there);
/// - `Err`: ANY read failure — callers must treat as "unknown", never
///   "subagent" (a lock-contention misclassification would hide a real
///   user session from the rail).
pub fn session_is_subagent_by_id(
    data_home: &Path,
    session_id: &str,
) -> Result<Option<bool>, OpencodeReadError> {
    let db_path = data_home.join("opencode.db");
    if !db_path.exists() {
        return Ok(None);
    }
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| OpencodeReadError(e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_millis(
        OPENCODE_BYID_BUSY_TIMEOUT_MS,
    ))
    .map_err(|e| OpencodeReadError(e.to_string()))?;

    // PRAGMA table_info(session) -> hasParentId (same guard as run_opencode_query_inner).
    let has_parent_id = {
        let mut stmt = conn
            .prepare("PRAGMA table_info(session)")
            .map_err(|e| OpencodeReadError(e.to_string()))?;
        let names = stmt
            .query_map([], |row| row.get::<_, String>(1))
            .map_err(|e| OpencodeReadError(e.to_string()))?;
        let mut found = false;
        for name in names {
            if name.map_err(|e| OpencodeReadError(e.to_string()))? == "parent_id" {
                found = true;
            }
        }
        found
    };

    if !has_parent_id {
        return match conn.query_row(
            "SELECT 1 FROM session WHERE id = ?1",
            rusqlite::params![session_id],
            |_| Ok(()),
        ) {
            Ok(()) => Ok(Some(false)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(OpencodeReadError(e.to_string())),
        };
    }

    match conn.query_row(
        "SELECT parent_id FROM session WHERE id = ?1",
        rusqlite::params![session_id],
        |row| row.get::<_, Option<String>>(0),
    ) {
        Ok(parent) => Ok(Some(parent.is_some())),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(OpencodeReadError(e.to_string())),
    }
}

/// SHORT busy timeout (`opencode-by-id-query.ts:12`): a locked DB must fail
/// FAST — the failure surfaces as provider-unavailable, never "not found".
/// Shared by the by-id row lookup and `session_is_subagent_by_id`.
const OPENCODE_BYID_BUSY_TIMEOUT_MS: u64 = 500;

/// Code-PRESERVING error for the by-id query (the plain `OpencodeReadError`
/// stays for its other consumers). Node's thrown sqlite errors carry a
/// `.code` like `SQLITE_CANTOPEN` at the QUERY layer — but Node's production
/// worker boundary then STRIPS it (`opencode-by-id.worker.ts:41-42`
/// serializes only `{name, message}`; `opencode-by-id-runner.ts:103-106`
/// rebuilds the Error without `.code`), so the code never reaches the wire.
/// We keep the code HERE for structured logging and precise messages; the
/// production closure (Task 6 Step 3b) deliberately maps it to
/// `ProviderFailure { code: None, .. }` — wire parity is message-only for
/// opencode.
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeByIdError {
    pub code: Option<String>,
    pub message: String,
}

/// Map a rusqlite error to the Node-style `SQLITE_*` code name via
/// `rusqlite::Error::sqlite_error_code()` (available in the pinned 0.31.0).
fn by_id_err(e: rusqlite::Error) -> OpencodeByIdError {
    use rusqlite::ffi::ErrorCode as C;
    let code = e.sqlite_error_code().and_then(|c| match c {
        C::CannotOpen => Some("SQLITE_CANTOPEN"),
        C::DatabaseBusy => Some("SQLITE_BUSY"),
        C::DatabaseLocked => Some("SQLITE_LOCKED"),
        C::NotADatabase => Some("SQLITE_NOTADB"),
        C::PermissionDenied => Some("SQLITE_PERM"),
        C::ReadOnly => Some("SQLITE_READONLY"),
        _ => None,
    });
    OpencodeByIdError {
        code: code.map(str::to_string),
        message: e.to_string(),
    }
}

/// The hardened exact-id row (`OpencodeSessionRow` subset the by-id query
/// selects). `last_activity_at` floored to integer ms (REAL columns possible).
#[derive(Debug, Clone, PartialEq)]
pub struct OpencodeByIdRow {
    pub session_id: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub created_at: Option<i64>,
    pub last_activity_at: Option<i64>,
    pub project_path: Option<String>,
}

/// Hardened (#586) exact-id lookup — 1:1 port of
/// `runOpencodeSessionByIdQuery` (`opencode-by-id-query.ts`). Deliberately
/// includes ARCHIVED and CHILD sessions: an exact id pasted by the user must
/// resolve even when the listing hides it. Errors PROPAGATE (a missing or
/// unreadable DB file is `Err`, matching Node's throwing `DatabaseSync`
/// open — provider unavailable ≠ not found).
pub fn opencode_session_row_by_id(
    data_home: &Path,
    session_id: &str,
) -> Result<Option<OpencodeByIdRow>, OpencodeByIdError> {
    let db_path = data_home.join("opencode.db");
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(by_id_err)?;
    conn.busy_timeout(std::time::Duration::from_millis(
        OPENCODE_BYID_BUSY_TIMEOUT_MS,
    ))
    .map_err(by_id_err)?;

    let table_names: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .map_err(by_id_err)?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(by_id_err)?;
        let mut set = std::collections::HashSet::new();
        for r in rows {
            set.insert(r.map_err(by_id_err)?);
        }
        set
    };
    if !table_names.contains("session") {
        return Ok(None);
    }
    let has_project = table_names.contains("project");
    let project_select = if has_project { "p.worktree" } else { "NULL" };
    let project_join = if has_project {
        "LEFT JOIN project p ON p.id = s.project_id"
    } else {
        ""
    };
    let sql = format!(
        "SELECT s.id, s.directory, s.title, s.time_created, s.time_updated, \
         {project_select} FROM session s {project_join} WHERE s.id = ?1 LIMIT 1"
    );
    match conn.query_row(&sql, rusqlite::params![session_id], |row| {
        Ok(OpencodeByIdRow {
            session_id: match row.get::<_, SqlValue>(0)? {
                SqlValue::Text(s) => s,
                other => to_opt_string(&other).unwrap_or_default(),
            },
            cwd: to_opt_string(&row.get::<_, SqlValue>(1)?),
            title: to_opt_string(&row.get::<_, SqlValue>(2)?),
            created_at: to_opt_i64(&row.get::<_, SqlValue>(3)?),
            last_activity_at: to_opt_i64(&row.get::<_, SqlValue>(4)?),
            project_path: meaningful_worktree(to_opt_string(&row.get::<_, SqlValue>(5)?)),
        })
    }) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(by_id_err(e)),
    }
}

/// `defaultOpencodeDataHome` — `$XDG_DATA_HOME/opencode` -> win `LOCALAPPDATA/opencode`
/// -> `~/.local/share/opencode`.
pub fn default_opencode_data_home() -> PathBuf {
    if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
        if !xdg.is_empty() {
            return PathBuf::from(xdg).join("opencode");
        }
    }
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.is_empty() {
                return PathBuf::from(local).join("opencode");
            }
        }
        if let Some(home) = home_dir() {
            return home.join("AppData").join("Local").join("opencode");
        }
    }
    home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".local")
        .join("share")
        .join("opencode")
}

/// Node `os.homedir()` platform semantics (libuv `uv_os_homedir`): Windows
/// reads `USERPROFILE` (HOME is NEVER consulted); POSIX reads `HOME` when
/// set and non-empty, else the effective user's passwd-entry home
/// (`getpwuid_r`). Rust's `std::env::home_dir()` (un-deprecated since 1.87,
/// MSRV here is 1.96) implements exactly these platform rules, so this
/// delegates to it — same contract as `session_directory::provider_home()`
/// in `freshell-server`. An earlier interim version approximated this as
/// HOME-then-USERPROFILE on ALL platforms.
fn home_dir() -> Option<PathBuf> {
    std::env::home_dir()
}

#[cfg(test)]
mod placeholder_title_tests {
    use super::is_opencode_placeholder_title;

    #[test]
    fn matches_opencode_default_placeholder() {
        assert!(is_opencode_placeholder_title(
            "New session - 2026-08-10T23:47:23.950Z"
        ));
        assert!(is_opencode_placeholder_title(
            "New session - 1970-01-01T00:00:00.000Z"
        ));
        // subagent placeholder (upstream session.ts parentID branch)
        assert!(is_opencode_placeholder_title(
            "Child session - 2026-08-10T23:47:23.950Z"
        ));
        // legacy capital-S prefix (opencode <= v0.3.86, pre-2025-08-07;
        // survives in DBs migrated from file storage)
        assert!(is_opencode_placeholder_title(
            "New Session - 2025-07-30T12:00:00.000Z"
        ));
    }

    #[test]
    fn rejects_real_titles_and_near_misses() {
        assert!(!is_opencode_placeholder_title(
            "Syncing repos with remote main"
        ));
        assert!(!is_opencode_placeholder_title("darkforge-plan-review"));
        assert!(!is_opencode_placeholder_title(""));
        // prefix alone is not enough -- a user could name a session this way
        assert!(!is_opencode_placeholder_title("New session - my notes"));
        assert!(!is_opencode_placeholder_title("Child session - my notes"));
        assert!(!is_opencode_placeholder_title("New session - 2026-08-10"));
        // seconds precision / no ms / no Z -- not toISOString() output
        assert!(!is_opencode_placeholder_title(
            "New session - 2026-08-10T23:47:23Z"
        ));
        // wrong case in prefix
        assert!(!is_opencode_placeholder_title(
            "new session - 2026-08-10T23:47:23.950Z"
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opencode_math_mirrors_upstream_overflow_semantics() {
        // maxOutputTokens: min(limit.output, 32000) || 32000
        assert_eq!(opencode_max_output_tokens(Some(131_072)), 32_000);
        assert_eq!(opencode_max_output_tokens(Some(8_192)), 8_192);
        assert_eq!(opencode_max_output_tokens(None), 32_000);
        assert_eq!(opencode_max_output_tokens(Some(0)), 32_000);
        // lunaroute case: context 524288, output 131072, no input limit
        let limits = OpencodeModelLimits {
            context: 524_288,
            input: None,
            output: Some(131_072),
        };
        assert_eq!(opencode_usable_context(&limits), 524_288 - 32_000);
        // input branch: reserved = min(20000, maxOutputTokens); input: 0 is
        // JS-falsy upstream and must take the CONTEXT branch, not yield 0
        let input_limited = OpencodeModelLimits {
            context: 1_000_000,
            input: Some(100_000),
            output: Some(131_072),
        };
        assert_eq!(opencode_usable_context(&input_limited), 100_000 - 20_000);
        let small_output = OpencodeModelLimits {
            context: 1_000_000,
            input: Some(100_000),
            output: Some(8_192),
        };
        assert_eq!(opencode_usable_context(&small_output), 100_000 - 8_192);
        let zero_input = OpencodeModelLimits {
            context: 524_288,
            input: Some(0),
            output: Some(131_072),
        };
        assert_eq!(opencode_usable_context(&zero_input), 524_288 - 32_000);
        // context 0 disables (upstream returns 0, never a threshold)
        assert_eq!(
            opencode_usable_context(&OpencodeModelLimits {
                context: 0,
                input: None,
                output: None
            }),
            0
        );
        // count: total wins; fallback omits reasoning
        let usage = OpencodeStepUsage {
            total: Some(215_242),
            input: 215,
            output: 434,
            cache_read: 214_592,
            cache_write: 0,
        };
        assert_eq!(opencode_context_count(&usage), 215_242);
        let no_total = OpencodeStepUsage {
            total: None,
            input: 100,
            output: 50,
            cache_read: 900,
            cache_write: 10,
        };
        assert_eq!(opencode_context_count(&no_total), 1_060);
        let zero_total = OpencodeStepUsage {
            total: Some(0),
            input: 100,
            output: 50,
            cache_read: 900,
            cache_write: 10,
        };
        assert_eq!(opencode_context_count(&zero_total), 1_060);
        // percent: round-half-up, clamped
        assert_eq!(opencode_compact_percent(395_980, 492_288), Some(80));
        assert_eq!(opencode_compact_percent(492_288, 492_288), Some(100));
        assert_eq!(opencode_compact_percent(600_000, 492_288), Some(100));
        assert_eq!(opencode_compact_percent(0, 492_288), Some(0));
        assert_eq!(opencode_compact_percent(10, 0), None);
        assert_eq!(opencode_compact_percent(10, -1), None);
    }

    #[test]
    fn opencode_model_composite_joins_provider_and_id() {
        assert_eq!(
            opencode_model_composite(
                r#"{"id":"glm-5.3","providerID":"lunaroute","variant":"default"}"#
            ),
            Some("lunaroute/glm-5.3".to_string())
        );
        // org/name ids (44% of real sessions, e.g. Kimi-K3) compose verbatim —
        // the catalog builds the same triple-slash ids from its models-map keys
        assert_eq!(
            opencode_model_composite(r#"{"id":"moonshotai/Kimi-K3","providerID":"ms-runpod"}"#),
            Some("ms-runpod/moonshotai/Kimi-K3".to_string())
        );
        // id-side slashes are legal (no id guard; live-verified join contract)
        assert_eq!(
            opencode_model_composite(r#"{"id":"a/b","providerID":"p"}"#),
            Some("p/a/b".to_string())
        );
        assert_eq!(opencode_model_composite(r#"{"id":"x"}"#), None); // no providerID
        assert_eq!(opencode_model_composite(r#"not json"#), None);
        // provider-side slash stays guarded (mirrors the catalog's provider skip)
        assert_eq!(
            opencode_model_composite(r#"{"id":"m","providerID":"p/x"}"#),
            None
        );
    }
}

#[cfg(test)]
mod home_dir_tests {
    use super::home_dir;
    use crate::HOME_ENV_TEST_LOCK;
    use std::path::PathBuf;

    // This helper feeds `default_opencode_data_home()`, which the resolve
    // route's opencode exact-id fallback resolves PER CALL — the same Node
    // `os.homedir()` platform contract as
    // `session_directory::provider_home()` in `freshell-server`: Windows
    // reads USERPROFILE (HOME never consulted); POSIX reads HOME when set
    // and non-empty, else the passwd-entry home (USERPROFILE never
    // consulted). Tests mutate real process env, so they serialize on the
    // crate-wide `HOME_ENV_TEST_LOCK` and save/restore each var.

    /// Save-and-restore guard for one env var; restores on drop, panic
    /// included (same shape as `main.rs`'s `EnvVarGuard` in
    /// `freshell-server`).
    struct EnvVarGuard {
        name: &'static str,
        saved: Option<std::ffi::OsString>,
    }

    impl EnvVarGuard {
        fn unset(name: &'static str) -> Self {
            let saved = std::env::var_os(name);
            std::env::remove_var(name);
            Self { name, saved }
        }

        fn set(name: &'static str, value: &str) -> Self {
            let saved = std::env::var_os(name);
            std::env::set_var(name, value);
            Self { name, saved }
        }
    }

    impl Drop for EnvVarGuard {
        fn drop(&mut self) {
            match self.saved.take() {
                Some(v) => std::env::set_var(self.name, v),
                None => std::env::remove_var(self.name),
            }
        }
    }

    /// The effective user's passwd-entry home (`getpwuid_r`) — the Node
    /// `os.homedir()` POSIX fallback when `HOME` is unset or empty.
    #[cfg(unix)]
    fn passwd_entry_home() -> PathBuf {
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

    #[cfg(unix)]
    #[test]
    fn unix_empty_home_uses_passwd_entry_never_userprofile() {
        let _lock = HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _home = EnvVarGuard::set("HOME", "");
        let _userprofile = EnvVarGuard::set("USERPROFILE", "/Users/win-fixture");
        assert_eq!(
            home_dir(),
            Some(passwd_entry_home()),
            "an EMPTY HOME must behave like unset HOME: passwd-entry fallback, never USERPROFILE"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_unset_home_ignores_userprofile_using_passwd_entry() {
        let _lock = HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _home = EnvVarGuard::unset("HOME");
        let _userprofile = EnvVarGuard::set("USERPROFILE", "/Users/win-fixture");
        let resolved = home_dir();
        assert_ne!(
            resolved,
            Some(PathBuf::from("/Users/win-fixture")),
            "POSIX must NEVER consult USERPROFILE (Node os.homedir() reads it on Windows only)"
        );
        assert_eq!(
            resolved,
            Some(passwd_entry_home()),
            "with HOME unset, POSIX must resolve the passwd-entry home"
        );
    }

    #[cfg(unix)]
    #[test]
    fn unix_home_wins_when_both_are_set() {
        let _lock = HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _home = EnvVarGuard::set("HOME", "/home/real");
        let _userprofile = EnvVarGuard::set("USERPROFILE", "/Users/win-fixture");
        assert_eq!(
            home_dir(),
            Some(PathBuf::from("/home/real")),
            "a set, non-empty HOME must win on POSIX (USERPROFILE is never consulted)"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_uses_userprofile_never_home() {
        let _lock = HOME_ENV_TEST_LOCK
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let _home = EnvVarGuard::set("HOME", "C:\\never-consulted");
        let _userprofile = EnvVarGuard::set("USERPROFILE", "C:\\Users\\win-fixture");
        assert_eq!(
            home_dir(),
            Some(PathBuf::from("C:\\Users\\win-fixture")),
            "Windows must read USERPROFILE and never consult HOME (Node os.homedir() parity)"
        );
    }
}
