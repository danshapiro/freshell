//! The refreshable session-directory index (Batch B, `port/plans/2026-07-14-...` —
//! zen-architect "Batches B & C — Rust Session-Directory Index").
//!
//! `GET /api/session-directory` (`crates/freshell-server/src/session_directory.rs`)
//! previously re-walked + re-parsed every provider transcript file on EVERY
//! request (`list_claude_sessions`): 6,208 real files -> 5-7s per request. This
//! module caches a pre-sorted snapshot behind a short TTL so a warm request is a
//! cheap in-memory read, while a cold/stale refresh still does the full sweep --
//! just once per TTL window, off the async executor thread.
//!
//! **Incremental refresh (Batch B review fix):** the FIRST shipped version of
//! this module rebuilt the snapshot by re-scanning AND re-parsing every file on
//! every TTL expiry. That reintroduces the exact 5-7s cost it was meant to fix
//! for the sporadic-browsing access pattern real users have (any request more
//! than one TTL window -- 1s -- after the last one pays the full re-parse
//! again). The synthetic perf test masked this because it never touched the
//! same files twice with a stale cache in between.
//!
//! The fix: a per-file cache (`FileEntry`, keyed by absolute path) that
//! remembers each file's `(mtime, size)` and parsed result (or a cached
//! EXCLUSION, `item: None`, for a file the parser rejects -- e.g. the R10b
//! cwd-less rule -- so an excluded file is never re-parsed either). A refresh
//! sweep (1) `discover()`s the current `(path, mtime, size)` set per source --
//! stat only, no parsing -- (2) re-`parse()`s ONLY a file that's new or whose
//! mtime/size changed, (3) prunes cache entries for files no longer discovered
//! (deleted), and (4) rebuilds + re-sorts the snapshot from the cache. A sweep
//! over N unchanged files costs N stats, not N parses.
//!
//! Batch B ships **claude only** (`ClaudeSource`); codex/opencode are additive
//! `SessionSource` impls deferred to Batch C.
//!
//! RED (this commit, before the production code existed): none of
//! `IndexedSession` / `SessionSource` / `ClaudeSource` / `SessionIndex` existed,
//! so this test module failed to compile.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use tokio::sync::Mutex as AsyncMutex;

use crate::meta::ParsedSessionMeta;
use crate::{parse_codex_session_content, parse_session_content, ParseSessionOptions};

/// Default snapshot freshness window: a request that lands within this window
/// of the last successful scan reads the cached snapshot; older triggers a
/// refresh. 1s keeps a burst of requests (e.g. a UI poll loop) to one scan
/// while still surfacing new/changed transcripts within a second of an edit.
const DEFAULT_TTL: Duration = Duration::from_millis(1000);

/// One session, enumerated by a [`SessionSource`]. Provider-agnostic — the
/// superset of fields `crates/freshell-server/src/session_directory.rs`'s
/// `DirItem` needs from the parse layer (everything EXCEPT the per-request
/// fields `archived` / `is_running` / the search annotations, which are
/// overlaid after the snapshot, never cached).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct IndexedSession {
    pub session_id: String,
    pub provider: String,
    pub project_path: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub first_user_message: Option<String>,
    pub last_activity_at: i64,
    pub created_at: Option<i64>,
    pub cwd: Option<String>,
    pub is_subagent: bool,
    pub is_non_interactive: bool,
    /// SESSION-07: the on-disk transcript this session was parsed from, when
    /// the source is a discrete per-session file (claude/codex). `None` for
    /// direct-listed sources with no stable per-session file (opencode's
    /// single sqlite db) -- those sessions are simply unsearchable at the
    /// `userMessages`/`fullText` tiers (title-tier metadata search still
    /// works for every provider, since it never reads this field). Consumed
    /// by `crates/freshell-server/src/session_directory.rs`'s file-tier
    /// search to locate the transcript to scan
    /// (`server/session-directory/service.ts`'s `sourceFiles` lookup map,
    /// `service.ts:164-173`).
    pub source_file: Option<PathBuf>,
}

impl IndexedSession {
    /// `provider:sessionId` — the sort/override key (`buildSessionKey`,
    /// `session-directory/service.ts:36-38`; matches `DirItem::key()`).
    pub fn key(&self) -> String {
        format!("{}:{}", self.provider, self.session_id)
    }
}

/// One discovered file: its absolute path plus the stat facts (`mtime`/`size`)
/// [`SessionIndex`]'s incremental cache uses to decide whether it needs
/// re-parsing. Stat-only — no file content is read to produce this.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStat {
    pub path: PathBuf,
    /// Milliseconds since the Unix epoch (`mtime`'s coarsest reliable unit
    /// across platforms). Compared alongside `size` (not alone) because some
    /// filesystems have mtime resolution coarser than a fast test/edit cycle.
    pub mtime_ms: i64,
    pub size: u64,
}

/// A provider's session enumeration source (claude/codex/opencode). Batch B
/// ships [`ClaudeSource`] only; codex/opencode are additive `SessionSource`
/// impls for Batch C — [`SessionIndex`] composes any number of sources
/// without changing shape.
///
/// Split into `discover` (cheap: stat every visible file) + `parse` (expensive:
/// read + parse ONE file) so [`SessionIndex`]'s incremental cache can re-parse
/// only what actually changed, instead of re-parsing everything on every
/// refresh.
pub trait SessionSource: Send + Sync {
    /// Enumerate every file this provider can currently see — stat only
    /// (path/mtime/size), no parsing. Corruption-tolerant (an unreadable
    /// directory yields fewer entries, never panics).
    fn discover(&self) -> Vec<FileStat>;

    /// Parse one file (previously returned by [`Self::discover`]) into a
    /// session. `None` means the file is unreadable OR was parsed and
    /// EXCLUDED (e.g. the R10b cwd-less rule) — [`SessionIndex`] caches an
    /// exclusion the same as a successful parse, so an excluded file is
    /// never re-parsed unless it actually changes. Corruption-tolerant —
    /// never panics.
    fn parse(&self, path: &Path) -> Option<IndexedSession>;

    /// Batch C: direct-listed sources (opencode's single sqlite db, which
    /// enumerates MANY sessions in ONE query rather than one file per
    /// session) can't fit the per-file `discover`/`parse` cache — there's no
    /// stable per-session path to key a [`FileEntry`] by. Instead, a
    /// direct-listed source returns `Some(token)` here: a cheap-to-compute
    /// value (e.g. a file mtime) that changes if-and-only-if the underlying
    /// data might have changed. [`SessionIndex`] calls this every sweep and
    /// only calls [`Self::direct_list`] (the expensive query) when the token
    /// differs from the one cached from the last successful listing.
    ///
    /// `None` (the default) means "this is a file-based source" —
    /// `discover`/`parse` are used instead, and this method/`direct_list` are
    /// never called.
    fn direct_change_token(&self) -> Option<i64> {
        None
    }

    /// The expensive full listing for a direct-listed source, called ONLY
    /// when [`Self::direct_change_token`] changed since the last successful
    /// call. `Err` preserves whatever [`SessionIndex`] cached from the last
    /// successful listing (e.g. a locked/mid-write sqlite db) instead of
    /// dropping that provider's sessions from the snapshot.
    fn direct_list(&self) -> Result<Vec<IndexedSession>, String> {
        Ok(Vec::new())
    }
}

/// Claude source: walks `<claude_home>/projects/*/…*.jsonl` (top-level =
/// sessions, `<project>/<session>/subagents/*.jsonl` = subagents). A faithful
/// lift of `session_directory.rs::list_claude_sessions` — that function is
/// KEPT (unmodified) as the differential-oracle reference B-T1 pins this
/// against, so the two implementations intentionally coexist during the
/// migration.
pub struct ClaudeSource {
    claude_home: PathBuf,
}

impl ClaudeSource {
    pub fn new(claude_home: PathBuf) -> Self {
        Self { claude_home }
    }

    /// Convenience: discover + parse every currently-visible file in one
    /// call, ignoring any incremental cache. Production code never calls
    /// this — it goes through [`SessionIndex`]'s incremental sweep — but it's
    /// the natural shape for the differential-oracle (B-T1) and perf tests
    /// that want a single one-shot full scan.
    pub fn scan(&self) -> Vec<IndexedSession> {
        self.discover()
            .into_iter()
            .filter_map(|stat| self.parse(&stat.path))
            .collect()
    }
}

impl SessionSource for ClaudeSource {
    fn discover(&self) -> Vec<FileStat> {
        discover_claude_home(&self.claude_home)
    }

    fn parse(&self, path: &Path) -> Option<IndexedSession> {
        // A file directly inside a `subagents/` directory is a subagent
        // transcript (mirrors `scan_claude_home`'s walk structure, which
        // KNOWS this from the directory it's currently iterating — here it's
        // re-derived from the path alone since `parse` receives just a path).
        let force_subagent = path
            .parent()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            == Some("subagents");
        parse_claude_file(path, force_subagent)
    }
}

/// Stat (not parse) every `<claude_home>/projects/*/…*.jsonl` file, in the
/// same discovery order `scan_claude_home` used to walk them (sorted
/// directory entries — determinism; readdir order is filesystem-dependent).
fn discover_claude_home(claude_home: &Path) -> Vec<FileStat> {
    let projects_dir = claude_home.join("projects");
    let Ok(project_entries) = std::fs::read_dir(&projects_dir) else {
        return Vec::new();
    };

    let mut stats = Vec::new();
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
                if let Some(stat) = stat_file(&entry_path) {
                    stats.push(stat);
                }
                continue;
            }
            // Subdirectory: discover `<entry>/subagents/*.jsonl`.
            if entry_path.is_dir() {
                let subagents = entry_path.join("subagents");
                if let Ok(subs) = std::fs::read_dir(&subagents) {
                    let mut sub_paths: Vec<PathBuf> =
                        subs.filter_map(|e| e.ok()).map(|e| e.path()).collect();
                    sub_paths.sort();
                    for sub in sub_paths {
                        if sub.extension().and_then(|s| s.to_str()) == Some("jsonl") {
                            if let Some(stat) = stat_file(&sub) {
                                stats.push(stat);
                            }
                        }
                    }
                }
            }
        }
    }
    stats
}

/// `fs::metadata` a single file into a [`FileStat`]. `None` on any stat
/// failure (e.g. a file deleted between `read_dir` and `metadata` — the same
/// tolerance every other discovery step in this module already has).
fn stat_file(path: &Path) -> Option<FileStat> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    Some(FileStat {
        path: path.to_path_buf(),
        mtime_ms,
        size: meta.len(),
    })
}

/// Read + parse one claude transcript file into an [`IndexedSession`].
/// Corruption-tolerant (the parser never panics); an unreadable file is
/// skipped (`None`). Mirrors `session_directory.rs::parse_claude_file`
/// byte-for-byte (lossy-UTF-8 read, R10b cwd-less exclusion).
fn parse_claude_file(path: &Path, force_subagent: bool) -> Option<IndexedSession> {
    let content = String::from_utf8_lossy(&std::fs::read(path).ok()?).into_owned();
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
    // R10b: never index a session with no resolvable `cwd` (the ORIGINAL's
    // discovery-time gate, `session-indexer.ts:756,1124`).
    meta.cwd.as_ref()?;
    Some(item_from_meta(
        &meta,
        "claude",
        &fallback,
        force_subagent,
        Some(path.to_path_buf()),
    ))
}

fn item_from_meta(
    meta: &ParsedSessionMeta,
    provider: &str,
    fallback_session_id: &str,
    force_subagent: bool,
    source_file: Option<PathBuf>,
) -> IndexedSession {
    IndexedSession {
        session_id: meta
            .session_id
            .clone()
            .unwrap_or_else(|| fallback_session_id.to_string()),
        provider: provider.to_string(),
        project_path: meta.cwd.clone().unwrap_or_else(|| "unknown".to_string()),
        title: meta.title.clone(),
        summary: meta.summary.clone(),
        first_user_message: meta.first_user_message.clone(),
        last_activity_at: meta.last_activity_at.unwrap_or(0).max(0),
        created_at: meta.created_at,
        cwd: meta.cwd.clone(),
        is_subagent: force_subagent || meta.is_subagent.unwrap_or(false),
        is_non_interactive: meta.is_non_interactive.unwrap_or(false),
        source_file,
    }
}

/// Codex source: recursively walks `<codex_home>/sessions/**/*.jsonl` — codex
/// nests rollouts under `sessions/YYYY/MM/DD/*.jsonl` (arbitrary depth),
/// unlike claude's fixed two-level `projects/<project>/*.jsonl` layout. A
/// faithful lift of `codexProvider.listSessionFiles()`
/// (`providers/codex.ts:459-462`, `walkJsonlFiles` at :423-436).
/// `codex_home` is the already-resolved codex home (`CODEX_HOME` env else
/// `<home>/.codex`, mirroring `defaultCodexHome()` — resolution lives in
/// `crates/freshell-server/src/session_directory.rs::codex_home`, same
/// pattern as `claude_home`); this source joins `sessions` itself, same as
/// `ClaudeSource` joining `projects`.
pub struct CodexSource {
    codex_home: PathBuf,
}

impl CodexSource {
    pub fn new(codex_home: PathBuf) -> Self {
        Self { codex_home }
    }

    /// Convenience: discover + parse every currently-visible file in one
    /// call, ignoring any incremental cache. Test/perf use only — mirrors
    /// `ClaudeSource::scan()`.
    pub fn scan(&self) -> Vec<IndexedSession> {
        self.discover()
            .into_iter()
            .filter_map(|stat| self.parse(&stat.path))
            .collect()
    }
}

impl SessionSource for CodexSource {
    fn discover(&self) -> Vec<FileStat> {
        let mut stats = Vec::new();
        walk_jsonl_recursive(&self.codex_home.join("sessions"), &mut stats);
        stats
    }

    fn parse(&self, path: &Path) -> Option<IndexedSession> {
        parse_codex_file(path)
    }
}

/// Recursively stat every `.jsonl` under `dir`, sorted (per directory level)
/// for determinism — readdir order is filesystem-dependent. Mirrors
/// `walkJsonlFiles` (`providers/codex.ts:423-436`): unbounded recursion,
/// corruption-tolerant (an unreadable directory yields fewer entries, never
/// panics).
fn walk_jsonl_recursive(dir: &Path, out: &mut Vec<FileStat>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort(); // determinism (readdir order is filesystem-dependent)
    for path in paths {
        if path.is_dir() {
            walk_jsonl_recursive(&path, out);
        } else if path.extension().and_then(|s| s.to_str()) == Some("jsonl") {
            if let Some(stat) = stat_file(&path) {
                out.push(stat);
            }
        }
    }
}

/// Read + parse one codex rollout file into an [`IndexedSession`].
/// Corruption-tolerant (the parser never panics); an unreadable file is
/// skipped (`None`). Enforces the SAME R10b cwd-less exclusion the claude
/// path does — `session-indexer.ts`'s discovery-time `if (!meta.cwd) continue`
/// gate (:756, :1124) applies to every provider, not just claude.
fn parse_codex_file(path: &Path) -> Option<IndexedSession> {
    let content = String::from_utf8_lossy(&std::fs::read(path).ok()?).into_owned();
    let meta = parse_codex_session_content(&content);
    meta.cwd.as_ref()?;
    let fallback = extract_codex_session_id_from_filename(path);
    Some(item_from_meta(
        &meta,
        "codex",
        &fallback,
        false,
        Some(path.to_path_buf()),
    ))
}

/// `extractSessionIdFromFilename` (`providers/codex.ts:417-420`): the
/// basename minus `.jsonl`, or — if the basename contains one — the embedded
/// canonical-looking UUID substring (codex rollout filenames look like
/// `rollout-2026-03-01T00-00-06-<uuid>.jsonl`).
fn extract_codex_session_id_from_filename(path: &Path) -> String {
    let base = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    find_uuid_substring(&base).unwrap_or(base)
}

/// First substring matching
/// `[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`
/// — no anchoring, no version/variant nibble constraint (unlike
/// `is_canonical_claude_session_id`, this mirrors the codex regex exactly).
fn find_uuid_substring(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let groups = [8usize, 4, 4, 4, 12];
    'start: for start in 0..bytes.len() {
        let mut pos = start;
        for (gi, &len) in groups.iter().enumerate() {
            if pos + len > bytes.len() || !bytes[pos..pos + len].iter().all(u8::is_ascii_hexdigit) {
                continue 'start;
            }
            pos += len;
            if gi + 1 < groups.len() {
                if bytes.get(pos) != Some(&b'-') {
                    continue 'start;
                }
                pos += 1;
            }
        }
        return Some(s[start..pos].to_string());
    }
    None
}

/// OpenCode source: direct-listed from `<data_home>/opencode.db` (one sqlite
/// query enumerates every root session, unlike the file-per-session
/// claude/codex layout) — a thin wrapper over [`OpencodeProvider`]
/// (`crate::parse::opencode`), which is itself the faithful port of
/// `OpencodeProvider.listSessionsDirect`. Implements the
/// `direct_change_token`/`direct_list` hooks instead of `discover`/`parse`
/// (see [`SessionSource`]'s doc comment) — `discover`/`parse` return
/// empty/`None` and are never called in practice.
pub struct OpencodeSource {
    provider: crate::parse::OpencodeProvider,
}

impl OpencodeSource {
    pub fn new(data_home: PathBuf) -> Self {
        Self {
            provider: crate::parse::OpencodeProvider::new(data_home),
        }
    }

    /// Convenience: one-shot listing, ignoring any incremental cache.
    /// Test/perf use only — mirrors `ClaudeSource::scan()`/`CodexSource::scan()`,
    /// but goes through `direct_list()` since this source has no per-file
    /// discover/parse.
    pub fn scan(&self) -> Vec<IndexedSession> {
        self.direct_list().unwrap_or_default()
    }
}

impl SessionSource for OpencodeSource {
    fn discover(&self) -> Vec<FileStat> {
        Vec::new()
    }

    fn parse(&self, _path: &Path) -> Option<IndexedSession> {
        None
    }

    fn direct_change_token(&self) -> Option<i64> {
        // The WAL wrinkle is load-bearing: sqlite in WAL mode (opencode's
        // default) can satisfy a write by appending to `opencode.db-wal`
        // ALONE, leaving `opencode.db`'s own mtime unchanged until the next
        // checkpoint. Taking the max of both files' mtimes (0 for whichever
        // doesn't exist) means a WAL-only write still changes the token.
        let [db, wal] = self.provider.watched_database_paths();
        let db_mtime = file_mtime_ms(&db).unwrap_or(0);
        let wal_mtime = file_mtime_ms(&wal).unwrap_or(0);
        Some(db_mtime.max(wal_mtime))
    }

    fn direct_list(&self) -> Result<Vec<IndexedSession>, String> {
        let listing = self
            .provider
            .list_sessions(now_ms())
            .map_err(|e| e.to_string())?;
        Ok(listing
            .sessions
            .into_iter()
            .map(opencode_session_to_indexed)
            .collect())
    }
}

fn opencode_session_to_indexed(s: crate::parse::OpencodeSession) -> IndexedSession {
    IndexedSession {
        session_id: s.session_id,
        provider: "opencode".to_string(),
        project_path: s.project_path,
        title: s.title,
        // The opencode direct-lister never populates a summary or
        // first-user-message tier (`listSessionsDirect` doesn't read
        // `message`/`part` content for these fields) — faithful, not a gap.
        summary: None,
        first_user_message: None,
        last_activity_at: s.last_activity_at,
        created_at: s.created_at,
        // `OpencodeSession::cwd` is always present (`list_sessions` already
        // skips rows without one) — R10b is a structural non-issue here.
        cwd: Some(s.cwd),
        is_subagent: s.is_subagent.unwrap_or(false),
        is_non_interactive: s.is_non_interactive.unwrap_or(false),
        // SESSION-07: opencode is direct-listed from one sqlite db, not a
        // per-session file -- there is no stable path to scan, so this
        // provider is un-searchable at the `userMessages`/`fullText` tiers
        // (title-tier metadata search is unaffected).
        source_file: None,
    }
}

/// `fs::metadata(path).modified()` in milliseconds, `None` on any stat
/// failure (including "doesn't exist") — used by [`OpencodeSource`]'s change
/// token, which treats a missing file as mtime `0`.
fn file_mtime_ms(path: &Path) -> Option<i64> {
    stat_file(path).map(|s| s.mtime_ms)
}

/// The injected-clock parameter [`OpencodeProvider::list_sessions`] wants
/// (mirrors the reference's `Date.now()` fallback for a row with no
/// `time_updated`).
fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One cached file's parse result, keyed by its absolute path in
/// [`SessionIndex`]'s `file_cache`. `item: None` caches a file that was
/// parsed and EXCLUDED (e.g. the R10b cwd-less rule) — so an excluded file is
/// stat'd every sweep but never re-parsed unless it actually changes.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct FileEntry {
    mtime_ms: i64,
    size: u64,
    item: Option<IndexedSession>,
}

/// The cached, TTL-refreshed session index composed from one or more
/// [`SessionSource`]s.
///
/// * The cheap path (fresh cache) never touches `.await` while holding the
///   `std::sync::Mutex` guard — the guard is dropped before any lock is even
///   contended, so it can never be held across an await point.
/// * **Stale-while-revalidate ("snapshot-swap").** A stale-but-PRESENT cache
///   is served immediately, and the actual re-scan runs DETACHED
///   (`tokio::spawn`) — no foreground caller ever waits on it. Production
///   forensics on a real ~13-15k session corpus measured `snapshot()`
///   sweeps taking up to 283s; the FIRST shipped version of this design
///   held a single `AsyncMutex` guard for a sweep's ENTIRE duration, so
///   every OTHER concurrent `snapshot()` caller (every foreground
///   `GET /api/session-directory` request, and the periodic
///   `spawn_sessions_sweep` poll) blocked on that same mutex for as long as
///   the sweep ran, even though a perfectly servable snapshot already
///   existed. Only a TRULY cold cache (nothing ever published — the very
///   first call, e.g. boot's `warm()`) still waits inline; there is nothing
///   else to serve. `refresh_lock`'s exclusivity (`try_lock_owned`) still
///   guarantees N concurrent stale-misses trigger exactly 1 sweep, matching
///   B-T5's original dedup guarantee — it now ALSO guarantees that sweep
///   never blocks a reader who already has something to read.
/// * The refresh (`refresh_snapshot`) runs inside `spawn_blocking`: `sources`
///   (an `Arc` refcount bump per source, not a deep clone of any scanned
///   data) and `file_cache` (an `Arc` refcount bump) are MOVED into the
///   blocking closure, so a multi-second full sweep never blocks the async
///   executor or any other in-flight request.
/// * The refresh is INCREMENTAL: `file_cache` persists across sweeps (it
///   outlives any single `snapshot()` call), so a sweep re-parses only a file
///   whose `(mtime, size)` changed since the LAST sweep — not every file,
///   every time. The `file_cache`'s own `std::sync::Mutex` is locked only
///   from inside the `spawn_blocking` closure (a fully synchronous context —
///   no `.await` ever runs while it's held).
pub struct SessionIndex {
    sources: Vec<Arc<dyn SessionSource>>,
    ttl: Duration,
    /// `Arc`-wrapped (not just `StdMutex`-wrapped) so a DETACHED background
    /// refresh task (`spawn_background_refresh`) can publish into it without
    /// holding a borrow of `&SessionIndex` for the task's lifetime.
    snapshot: Arc<StdMutex<Option<CachedSnapshot>>>,
    /// Exclusivity gate for "who is currently sweeping" -- `try_lock_owned`
    /// (never blocks the caller) decides who starts a sweep;
    /// `lock_owned().await` (blocks) is used ONLY by a caller racing another
    /// caller on a truly cold (nothing-published-yet) cache, where waiting
    /// for the other's result is correct because there is nothing else to
    /// serve. See the struct doc comment's "Stale-while-revalidate" bullet.
    refresh_lock: Arc<AsyncMutex<()>>,
    file_cache: Arc<StdMutex<HashMap<PathBuf, FileEntry>>>,
    /// Batch C: the per-source cache for direct-listed sources (opencode),
    /// keyed by the source's position in `sources` (fixed at construction, so
    /// an index is a stable, simpler key than source identity). Disjoint from
    /// `file_cache` -- a direct-listed source never touches it.
    direct_cache: Arc<StdMutex<HashMap<usize, DirectEntry>>>,
    /// Persistent parse-cache file path (`rust-session-cache.json`), or
    /// `None` to disable persistence entirely (e.g. no resolvable home).
    /// Read at construction to pre-populate `file_cache`; written back
    /// opportunistically after a sweep (see `Self::take_pending_save`).
    persist_path: Option<PathBuf>,
    /// `Arc`-wrapped for the same reason `snapshot` is: a detached
    /// background refresh needs to update the save-debounce bookkeeping
    /// without borrowing `&SessionIndex`.
    persist_state: Arc<StdMutex<PersistState>>,
}

struct CachedSnapshot {
    items: Arc<Vec<IndexedSession>>,
    fetched_at: Instant,
}

/// Bookkeeping for the persistent parse-cache's opportunistic-save gating
/// (module doc comment's "Persistent parse cache" section).
#[derive(Default)]
struct PersistState {
    /// Files parsed (changed/new) or direct-listed sources re-queried since
    /// the last successful save -- reset to 0 whenever a save happens.
    changed_since_save: u64,
    last_saved_at: Option<Instant>,
    /// Sticky "have we EVER saved" flag: the initial `warm()` build always
    /// persists once, regardless of how few files it touched (a home with
    /// fewer than `SAVE_CHANGED_THRESHOLD` sessions must still get its
    /// first-ever cache file, not wait for the 60s debounce or a 50-file
    /// burst that will never come).
    saved_once: bool,
}

impl SessionIndex {
    pub fn new(sources: Vec<Arc<dyn SessionSource>>) -> Self {
        Self::with_ttl(sources, DEFAULT_TTL)
    }

    pub fn with_ttl(sources: Vec<Arc<dyn SessionSource>>, ttl: Duration) -> Self {
        Self::with_ttl_and_cache_path(sources, ttl, default_persist_path())
    }

    /// Same as `Self::with_ttl`, but with an explicit (or disabled -- `None`)
    /// persistent parse-cache path instead of relying on
    /// `default_persist_path`'s environment-variable resolution. This is the
    /// dependency-injection seam that lets tests point at an isolated
    /// temp-dir cache file (deterministic, no global env var mutation, safe
    /// under the test harness's parallel execution) while `new`/`with_ttl`
    /// -- whose signatures `crates/freshell-server/src/main.rs` depends on
    /// unchanged -- keep today's exact call shape.
    pub fn with_ttl_and_cache_path(
        sources: Vec<Arc<dyn SessionSource>>,
        ttl: Duration,
        persist_path: Option<PathBuf>,
    ) -> Self {
        // Pre-populate the file cache from disk, if a persisted cache exists
        // and is readable/current -- `load_cache_file` is fully tolerant
        // (missing/corrupt/wrong-version all yield an empty map, never a
        // panic). The FIRST `refresh_snapshot` sweep re-validates every
        // loaded entry's (mtime, size) against a fresh `discover()` before
        // trusting it (the same incremental-cache logic that already
        // protects a warm in-memory cache) -- persistence only changes
        // WHERE the starting cache comes from, never how it's trusted.
        let file_cache = persist_path
            .as_deref()
            .map(load_cache_file)
            .unwrap_or_default();
        Self {
            sources,
            ttl,
            snapshot: Arc::new(StdMutex::new(None)),
            refresh_lock: Arc::new(AsyncMutex::new(())),
            file_cache: Arc::new(StdMutex::new(file_cache)),
            direct_cache: Arc::new(StdMutex::new(HashMap::new())),
            persist_path,
            persist_state: Arc::new(StdMutex::new(PersistState::default())),
        }
    }

    /// Return a snapshot, pre-sorted `lastActivityAt` DESC then `key()` DESC
    /// (`projection.ts:51-62`'s comparator, applied once here instead of
    /// once per request).
    ///
    /// Stale-while-revalidate ("snapshot-swap"): if the cache is stale but a
    /// PREVIOUS snapshot exists, that snapshot is returned IMMEDIATELY and a
    /// fresh sweep runs detached in the background (see
    /// `spawn_background_refresh`) — this call never blocks on it. Only a
    /// truly cold cache (nothing ever published) waits for the sweep
    /// inline, via `run_refresh_inline`, since there is nothing else to
    /// serve. Either way, the actual rebuild is incremental (see
    /// [`refresh_snapshot`]), not a full re-parse of unchanged files.
    pub async fn snapshot(&self) -> Arc<Vec<IndexedSession>> {
        if let Some(items) = self.fresh_cached() {
            return items;
        }
        // Stale or absent. Try to become this round's sweeper WITHOUT
        // blocking -- `try_lock_owned` never waits, so a caller that
        // already has something to serve is never delayed by another
        // in-flight sweep.
        match Arc::clone(&self.refresh_lock).try_lock_owned() {
            Ok(guard) => {
                if let Some(stale) = self.any_cached() {
                    // Someone must read fresh data eventually, but not THIS
                    // caller, and not by blocking anyone else either.
                    self.spawn_background_refresh(guard);
                    return stale;
                }
                // Truly cold: nothing to serve, so wait for the (only) sweep.
                self.run_refresh_inline(guard).await
            }
            Err(_) => {
                // Another caller is already sweeping this round.
                if let Some(stale) = self.any_cached() {
                    return stale;
                }
                // Truly cold AND racing another cold-start caller: wait for
                // THEIR sweep instead of starting a second one (preserves
                // B-T5's "N concurrent misses -> 1 sweep" guarantee for the
                // cold-cache case).
                let _guard = self.refresh_lock.lock().await;
                self.fresh_cached()
                    .or_else(|| self.any_cached())
                    .unwrap_or_default()
            }
        }
    }

    /// The cached snapshot, if present and within the TTL window. A brief,
    /// non-async lock: never held across an await point.
    fn fresh_cached(&self) -> Option<Arc<Vec<IndexedSession>>> {
        let guard = self.snapshot.lock().unwrap();
        match guard.as_ref() {
            Some(c) if c.fetched_at.elapsed() < self.ttl => Some(Arc::clone(&c.items)),
            _ => None,
        }
    }

    /// The cached snapshot, if present, regardless of TTL freshness -- the
    /// stale-while-revalidate read: "is there ANYTHING to serve right now."
    fn any_cached(&self) -> Option<Arc<Vec<IndexedSession>>> {
        let guard = self.snapshot.lock().unwrap();
        guard.as_ref().map(|c| Arc::clone(&c.items))
    }

    /// Cold-start path: run the sweep and wait for it (there is nothing else
    /// to serve). `guard` is held for the sweep's full duration -- exactly
    /// the pre-fix behavior, but now reachable ONLY when no snapshot has
    /// ever been published, never for a routine stale-cache refresh.
    async fn run_refresh_inline(
        &self,
        guard: tokio::sync::OwnedMutexGuard<()>,
    ) -> Arc<Vec<IndexedSession>> {
        let items = Self::perform_refresh(
            self.sources.clone(),
            Arc::clone(&self.file_cache),
            Arc::clone(&self.direct_cache),
            Arc::clone(&self.snapshot),
            self.persist_path.clone(),
            Arc::clone(&self.persist_state),
        )
        .await;
        drop(guard);
        items
    }

    /// Warm-cache path: run the sweep DETACHED, so the caller that triggered
    /// it (and every other concurrent caller) can go on serving the stale
    /// snapshot immediately. `guard` moves into the spawned task and is
    /// dropped only once that sweep fully completes, so `try_lock_owned`
    /// correctly rejects any other concurrent sweeper until then.
    fn spawn_background_refresh(&self, guard: tokio::sync::OwnedMutexGuard<()>) {
        let sources = self.sources.clone();
        let file_cache = Arc::clone(&self.file_cache);
        let direct_cache = Arc::clone(&self.direct_cache);
        let snapshot = Arc::clone(&self.snapshot);
        let persist_path = self.persist_path.clone();
        let persist_state = Arc::clone(&self.persist_state);
        tokio::spawn(async move {
            let _ = Self::perform_refresh(
                sources,
                file_cache,
                direct_cache,
                snapshot,
                persist_path,
                persist_state,
            )
            .await;
            drop(guard);
        });
    }

    /// The actual sweep: discover/parse (incremental, off the async
    /// executor thread via `spawn_blocking`), publish the result into
    /// `snapshot`, then opportunistically persist the parse cache. Free of
    /// any `&SessionIndex` borrow -- every input is an owned `Arc`/value --
    /// so it runs identically whether awaited inline (cold start) or inside
    /// a detached `tokio::spawn` (warm, stale-while-revalidate refresh).
    async fn perform_refresh(
        sources: Vec<Arc<dyn SessionSource>>,
        file_cache: Arc<StdMutex<HashMap<PathBuf, FileEntry>>>,
        direct_cache: Arc<StdMutex<HashMap<usize, DirectEntry>>>,
        snapshot: Arc<StdMutex<Option<CachedSnapshot>>>,
        persist_path: Option<PathBuf>,
        persist_state: Arc<StdMutex<PersistState>>,
    ) -> Arc<Vec<IndexedSession>> {
        let sweep_result = tokio::task::spawn_blocking({
            let file_cache = Arc::clone(&file_cache);
            let direct_cache = Arc::clone(&direct_cache);
            move || {
                let mut cache = file_cache.lock().unwrap();
                let mut direct = direct_cache.lock().unwrap();
                refresh_snapshot(&sources, &mut cache, &mut direct)
            }
        })
        .await;
        let (items, changed) = match sweep_result {
            Ok(result) => result,
            Err(join_err) => {
                // `discover`/`parse` are documented never-panic (every
                // `SessionSource` impl is corruption-tolerant), so this is
                // currently unreachable -- but IF that invariant is ever
                // violated, publishing `(vec![], 0)` here (the old
                // `unwrap_or_default()` behavior) would silently overwrite a
                // good, previously-published snapshot with an empty one
                // marked FRESH. Preserve whatever's already published
                // instead, mirroring `refresh_snapshot`'s own
                // `direct_list`-error handling a few lines above
                // (preserve-cached + log) rather than dropping data.
                eprintln!(
                    "session-directory: refresh sweep panicked (preserving cached \
                     snapshot): {join_err}"
                );
                return snapshot
                    .lock()
                    .unwrap()
                    .as_ref()
                    .map(|c| Arc::clone(&c.items))
                    .unwrap_or_default();
            }
        };
        let items = Arc::new(items);
        {
            let mut guard = snapshot.lock().unwrap();
            *guard = Some(CachedSnapshot {
                items: Arc::clone(&items),
                fetched_at: Instant::now(),
            });
        } // guard dropped here — never held across an .await.
          // Opportunistic persistence: gated (threshold/debounce) and, when
          // warranted, saved via a DETACHED task -- never awaited here, so
          // neither an HTTP request handler NOR this refresh itself is
          // delayed by a disk write.
        if let Some((path, cache_snapshot)) = take_pending_save_from_parts(
            &persist_path,
            &persist_state,
            &file_cache,
            changed,
            SAVE_DEBOUNCE,
        ) {
            tokio::spawn(async move {
                let outcome =
                    tokio::task::spawn_blocking(move || save_cache_file(&path, &cache_snapshot))
                        .await;
                match outcome {
                    Ok(Ok(())) => {}
                    Ok(Err(err)) => {
                        eprintln!("session-directory: failed to persist parse cache: {err}")
                    }
                    Err(join_err) => {
                        eprintln!("session-directory: persist task panicked: {join_err}")
                    }
                }
            });
        }
        items
    }

    /// Populate the cache once, eagerly. Call from `main.rs` via
    /// `tokio::spawn` at boot so the first real request never pays the cold
    /// full-sweep cost — cheap for a small home, and the sweep already runs
    /// off the executor thread, so it never delays serving other requests.
    pub async fn warm(&self) {
        let _ = self.snapshot().await;
    }
}

/// Free-function form of the save-decision gate (see
/// `SessionIndex::take_pending_save_with_debounce`'s doc comment for the
/// full rule) -- takes its inputs by reference instead of `&self` so a
/// detached background-refresh task (which owns `Arc`s, not a
/// `&SessionIndex`) can call it directly. Rule: a save is warranted iff at
/// least one file changed since the last save AND (this is the very
/// first-ever sweep, OR the cumulative changed-since-save count has reached
/// `SAVE_CHANGED_THRESHOLD`, OR the debounce window has elapsed since the
/// last save). On a "yes", resets the changed-since-save counter and
/// returns a cloned snapshot of the file cache to write (cloned while still
/// holding the state lock, so two concurrent sweeps can never both decide
/// "yes" for the same window).
fn take_pending_save_from_parts(
    persist_path: &Option<PathBuf>,
    persist_state: &StdMutex<PersistState>,
    file_cache: &StdMutex<HashMap<PathBuf, FileEntry>>,
    changed_this_sweep: usize,
    debounce: Duration,
) -> Option<(PathBuf, HashMap<PathBuf, FileEntry>)> {
    let path = persist_path.clone()?;
    let mut state = persist_state.lock().unwrap();
    state.changed_since_save = state
        .changed_since_save
        .saturating_add(changed_this_sweep as u64);
    if state.changed_since_save == 0 {
        return None;
    }
    let should_save = !state.saved_once
        || state.changed_since_save >= SAVE_CHANGED_THRESHOLD
        || state.last_saved_at.is_none_or(|t| t.elapsed() >= debounce);
    if !should_save {
        return None;
    }
    state.changed_since_save = 0;
    state.last_saved_at = Some(Instant::now());
    state.saved_once = true;
    drop(state);
    let cache_snapshot = file_cache.lock().unwrap().clone();
    Some((path, cache_snapshot))
}

/// One cached direct-listed source's last successful listing, keyed by
/// source index in [`SessionIndex::direct_cache`]. Mirrors [`FileEntry`]'s
/// role for file-based sources, but keyed by change-token instead of
/// `(mtime, size)`, and holding a full `Vec` of sessions instead of one.
struct DirectEntry {
    token: i64,
    items: Vec<IndexedSession>,
}

/// One incremental refresh sweep across all sources:
///
/// 1. File-based sources: `discover()` the current `(path, mtime, size)` set
///    — stat only, no parsing. Re-`parse()` ONLY a file that's new or whose
///    `mtime`/`size` changed since the cached [`FileEntry`]; reuse the cached
///    entry (including a cached EXCLUSION, `item: None`) for everything
///    else. Prune `cache` entries for paths no longer discovered (deleted
///    files).
/// 2. Direct-listed sources (Batch C: opencode): call
///    [`SessionSource::direct_change_token`] — cheap, no query. If the token
///    matches the cached [`DirectEntry`], reuse its `items` unchanged. If it
///    changed (or there's no cached entry yet), call
///    [`SessionSource::direct_list`]: `Ok` replaces the cache entry, `Err`
///    logs once and leaves whatever was cached (never drops that provider's
///    sessions from the snapshot over a transient read failure).
/// 3. Rebuild + re-sort the combined snapshot from both caches — the ONE
///    sort per sweep (not once per request), over already-parsed/listed
///    data, no disk I/O beyond what steps 1-2 already did.
///
/// A sweep over N unchanged files costs N stats, not N parses — this is what
/// fixes the "5s problem returns after 1s TTL" regression the FIRST shipped
/// version of this module had (see the module doc comment). Analogously, a
/// sweep over an unchanged direct-listed source costs 2 stats (db + db-wal),
/// not a query.
fn refresh_snapshot(
    sources: &[Arc<dyn SessionSource>],
    cache: &mut HashMap<PathBuf, FileEntry>,
    direct_cache: &mut HashMap<usize, DirectEntry>,
) -> (Vec<IndexedSession>, usize) {
    let mut discovered: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    // Count of files re-parsed + direct-listed sources re-queried this
    // sweep -- the persistent-parse-cache save gate's "how much changed"
    // signal (`SessionIndex::take_pending_save`). Stats-only unchanged
    // files/tokens don't count; only actual expensive work does.
    let mut changed = 0usize;

    for (idx, source) in sources.iter().enumerate() {
        if let Some(token) = source.direct_change_token() {
            let unchanged = direct_cache.get(&idx).is_some_and(|e| e.token == token);
            if !unchanged {
                match source.direct_list() {
                    Ok(items) => {
                        direct_cache.insert(idx, DirectEntry { token, items });
                        changed += 1;
                    }
                    Err(err) => {
                        // Preserve whatever was cached from the last
                        // successful listing (e.g. a locked/mid-write
                        // sqlite db) -- never drop this provider's sessions
                        // from the snapshot over a transient read error.
                        eprintln!(
                            "session-directory: direct-listed source #{idx} read error \
                             (preserving cached sessions): {err}"
                        );
                    }
                }
            }
            // Direct-listed sources never touch the per-file cache/discovery.
            continue;
        }

        for stat in source.discover() {
            let unchanged = cache
                .get(&stat.path)
                .is_some_and(|entry| entry.mtime_ms == stat.mtime_ms && entry.size == stat.size);
            if !unchanged {
                let item = source.parse(&stat.path);
                cache.insert(
                    stat.path.clone(),
                    FileEntry {
                        mtime_ms: stat.mtime_ms,
                        size: stat.size,
                        item,
                    },
                );
                changed += 1;
            }
            discovered.insert(stat.path);
        }
    }

    // Prune entries for files no longer discovered (deleted since the last sweep).
    cache.retain(|path, _| discovered.contains(path));

    let mut items: Vec<IndexedSession> = cache
        .values()
        .filter_map(|entry| entry.item.clone())
        .collect();
    for entry in direct_cache.values() {
        items.extend(entry.items.iter().cloned());
    }
    items.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| b.key().cmp(&a.key()))
    });
    (items, changed)
}

// -- Persistent parse cache (self-hosting-readiness bake-in, "kill the cold
// boot") --------------------------------------------------------------------
//
// The in-memory `FileEntry` cache above makes a WARM request fast (a sweep
// over unchanged files costs stats, not parses), but every server BOOT
// starts that cache empty -- on a real 8.7GB codex + 2.2GB claude corpus,
// the very first `warm()` sweep measured ~4-5 minutes at 99% CPU before the
// sidebar responds. This section adds disk persistence for exactly the same
// `FileEntry` map: `SessionIndex::with_ttl_and_cache_path` loads it at
// construction (pre-populating `file_cache`), and `SessionIndex::snapshot`
// opportunistically writes it back after a sweep. The EXISTING incremental
// logic in `refresh_snapshot` (above) is what makes this safe -- a loaded
// entry is only ever "used as-is" after a fresh `discover()` confirms its
// `(mtime, size)` still match; persistence changes WHERE a sweep's starting
// point comes from, never whether a stale/tampered entry can be trusted.
//
// File location: `<home>/.freshell/rust-session-cache.json` -- honoring
// `FRESHELL_HOME` then `HOME`, matching
// `crates/freshell-server/src/main.rs::resolve_home`'s precedence for the
// `.freshell` config dir this cache file lives beside.
//
// Filename: deliberately `rust-session-cache.json`, NOT `session-cache.json`
// (the legacy Node server's file, `server/session-scanner/cache.ts`). During
// the side-by-side bake-in, both servers can run concurrently against the
// SAME `~/.freshell` home; sharing one file would mean two independent
// writers (each doing its own tmp+rename) racing the same path, and the two
// formats aren't compatible anyway (this stores `FileEntry`/`IndexedSession`;
// the legacy format stores its own `SessionScanResult` shape). A distinct
// filename makes the two caches fully independent: no lock, no format
// coupling, no risk of one server's write corrupting the other's read.

/// Schema version for the persisted parse-cache file. Bump on any format
/// change so an old (or a future, if this ever needs to roll back) file is
/// cleanly discarded -- never partially or incorrectly deserialized into a
/// mismatched shape.
const CACHE_SCHEMA_VERSION: u32 = 1;

/// See "File location"/"Filename" above.
const CACHE_FILENAME: &str = "rust-session-cache.json";

/// After a sweep, save immediately once at least this many files/sources
/// changed since the last save (a cold-boot sweep over thousands of files
/// clears this on its very first sweep). Below this, saves are debounced
/// (see [`SAVE_DEBOUNCE`]) instead of writing on every small trickle of
/// changes.
const SAVE_CHANGED_THRESHOLD: u64 = 50;

/// When fewer than [`SAVE_CHANGED_THRESHOLD`] files changed, save at most
/// this often -- bounds disk-write frequency during active browsing/editing
/// without indefinitely delaying a save that IS warranted.
const SAVE_DEBOUNCE: Duration = Duration::from_secs(60);

/// On-disk shape of the persisted parse cache. `entries` is keyed by the
/// absolute file path as a `String` (not `PathBuf` -- `serde_json` object
/// keys must serialize as strings, and a lossy round-trip through
/// `to_string_lossy` is a non-issue here: a non-UTF-8 path would already be
/// unusable in this codebase's other string-keyed maps/APIs).
#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedCacheFile {
    schema_version: u32,
    entries: HashMap<String, FileEntry>,
}

/// Resolve `<home>/.freshell/rust-session-cache.json`, honoring
/// `FRESHELL_HOME` then `HOME` (see the section doc comment above). `None`
/// if neither is set (or set to an empty string) -- persistence is simply
/// disabled in that case, exactly like any other optional feature with an
/// unresolvable prerequisite, never a hard error.
fn default_persist_path() -> Option<PathBuf> {
    let home = std::env::var("FRESHELL_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .or_else(|| std::env::var("HOME").ok().filter(|v| !v.is_empty()))?;
    Some(PathBuf::from(home).join(".freshell").join(CACHE_FILENAME))
}

/// Load the persisted parse cache from `path`. Tolerant of everything: a
/// missing file, unreadable/corrupt JSON, or a schema-version mismatch all
/// produce an empty cache (logged once to stderr, except for the common
/// "file doesn't exist yet" case) -- NEVER panics, NEVER fails boot. The
/// caller pre-populates `SessionIndex.file_cache` with the result; the
/// existing incremental-sweep logic in `refresh_snapshot` re-validates every
/// entry's `(mtime, size)` against a fresh `discover()` before trusting it,
/// so a stale/tampered file can only ever cause an extra re-parse, never a
/// wrong result.
fn load_cache_file(path: &Path) -> HashMap<PathBuf, FileEntry> {
    let content = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(_) => return HashMap::new(), // missing (the common case) or unreadable
    };
    let parsed: PersistedCacheFile = match serde_json::from_str(&content) {
        Ok(p) => p,
        Err(err) => {
            eprintln!(
                "session-directory: parse cache at {} is corrupt, starting cold ({err})",
                path.display()
            );
            return HashMap::new();
        }
    };
    if parsed.schema_version != CACHE_SCHEMA_VERSION {
        eprintln!(
            "session-directory: parse cache at {} has schema_version {} (expected {}), starting cold",
            path.display(),
            parsed.schema_version,
            CACHE_SCHEMA_VERSION
        );
        return HashMap::new();
    }
    parsed
        .entries
        .into_iter()
        .map(|(k, v)| (PathBuf::from(k), v))
        .collect()
}

/// Atomically persist `cache` to `path`: write the full JSON payload to a
/// sibling temp file, then `rename` it into place. A reader (or a process
/// that crashes mid-write) never observes a partially-written cache file --
/// `path` itself is untouched until the `rename`, which POSIX/most
/// filesystems perform as a single atomic directory-entry update. Creates
/// `path`'s parent directory if it doesn't exist yet (mirrors `mkdir -p
/// ~/.freshell` the legacy server's cache does at startup). Errors are
/// returned (not swallowed) so the caller can log them, but a save failure
/// NEVER propagates to any request path -- see
/// `SessionIndex::take_pending_save`'s caller in `snapshot()`.
fn save_cache_file(path: &Path, cache: &HashMap<PathBuf, FileEntry>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let entries: HashMap<String, FileEntry> = cache
        .iter()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), v.clone()))
        .collect();
    let payload = PersistedCacheFile {
        schema_version: CACHE_SCHEMA_VERSION,
        entries,
    };
    let json = serde_json::to_string(&payload)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let mut tmp_os = path.as_os_str().to_os_string();
    tmp_os.push(".tmp");
    let tmp_path = PathBuf::from(tmp_os);
    std::fs::write(&tmp_path, json)?;
    std::fs::rename(&tmp_path, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// Poll `predicate` every 10ms until it's true or `timeout` elapses.
    /// Returns whether it became true -- used to observe a detached
    /// background refresh (stale-while-revalidate) settling, since that
    /// refresh is deliberately NOT awaited by the `snapshot()` call that
    /// triggers it.
    async fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) -> bool {
        let start = std::time::Instant::now();
        loop {
            if predicate() {
                return true;
            }
            if start.elapsed() >= timeout {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    fn unique_temp_dir(label: &str) -> std::path::PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "freshell-{label}-{}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ))
    }

    fn fixtures_dir() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/sessions")
    }

    /// A `<home>/.claude/projects/<project>/<name>.jsonl` layout seeded with the
    /// named committed fixtures. Returns the `.claude` home dir (the
    /// `ClaudeSource` root), not the outer temp home.
    fn claude_home_with(label: &str, fixtures: &[&str]) -> std::path::PathBuf {
        let home = unique_temp_dir(label);
        let claude_home = home.join(".claude");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        for (i, name) in fixtures.iter().enumerate() {
            let content = std::fs::read_to_string(fixtures_dir().join(name)).unwrap();
            // Distinct filenames even for repeated fixture names.
            std::fs::write(project.join(format!("{i}-{name}")), content).unwrap();
        }
        claude_home
    }

    /// A `SessionSource` that counts how many times `discover()` actually ran
    /// (the TTL/serialization tests assert on this count, never on
    /// wall-clock timing -- deterministic, no flakiness). Synthetic,
    /// in-memory items each get a stable fake path so the incremental cache
    /// still has something to key on; the `mtime`/`size` never change across
    /// calls, so a `SessionIndex` backed by this source never re-`parse`s
    /// after the first sweep -- these tests are about the index's
    /// TTL/warm/concurrency behavior, not about per-file change detection
    /// (that's covered by the `ClaudeSource`-backed tests below).
    struct CountingSource {
        calls: Arc<AtomicUsize>,
        items: Vec<IndexedSession>,
    }

    impl CountingSource {
        fn fake_path(item: &IndexedSession) -> PathBuf {
            PathBuf::from(format!("mem://{}", item.key()))
        }
    }

    impl SessionSource for CountingSource {
        fn discover(&self) -> Vec<FileStat> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.items
                .iter()
                .map(|item| FileStat {
                    path: Self::fake_path(item),
                    mtime_ms: 0,
                    size: 0,
                })
                .collect()
        }

        fn parse(&self, path: &Path) -> Option<IndexedSession> {
            self.items
                .iter()
                .find(|item| Self::fake_path(item) == path)
                .cloned()
        }
    }

    /// Wraps any `SessionSource`, counting `discover()`/`parse()` (file-based)
    /// and `direct_list()` (direct-listed, Batch C) calls separately.
    /// `discover_calls` proves TTL/serialization behavior at the sweep level
    /// (one discover per refresh); `parse_calls` is the incremental-cache
    /// guard -- an unchanged (or cached-excluded) file must never increment
    /// it again after its first sweep; `direct_list_calls` is the
    /// change-token-gating guard for direct-listed sources (opencode) -- an
    /// unchanged token must never increment it again after the first sweep.
    struct CountingWrapper<S: SessionSource> {
        inner: S,
        discover_calls: Arc<AtomicUsize>,
        parse_calls: Arc<AtomicUsize>,
        direct_list_calls: Arc<AtomicUsize>,
    }

    impl<S: SessionSource> CountingWrapper<S> {
        /// Construct with fresh (zeroed) counters -- the common case, so call
        /// sites that only care about one counter don't need to spell out
        /// all three fields.
        fn new(inner: S) -> Self {
            Self {
                inner,
                discover_calls: Arc::new(AtomicUsize::new(0)),
                parse_calls: Arc::new(AtomicUsize::new(0)),
                direct_list_calls: Arc::new(AtomicUsize::new(0)),
            }
        }
    }

    impl<S: SessionSource> SessionSource for CountingWrapper<S> {
        fn discover(&self) -> Vec<FileStat> {
            self.discover_calls.fetch_add(1, Ordering::SeqCst);
            self.inner.discover()
        }

        fn parse(&self, path: &Path) -> Option<IndexedSession> {
            self.parse_calls.fetch_add(1, Ordering::SeqCst);
            self.inner.parse(path)
        }

        fn direct_change_token(&self) -> Option<i64> {
            // NOT counted: this is the cheap per-sweep check, analogous to
            // `discover()` for file-based sources -- the gating guard is
            // `direct_list_calls`, the expensive query.
            self.inner.direct_change_token()
        }

        fn direct_list(&self) -> Result<Vec<IndexedSession>, String> {
            self.direct_list_calls.fetch_add(1, Ordering::SeqCst);
            self.inner.direct_list()
        }
    }

    /// Write one minimal, valid claude session file directly (not via a
    /// committed fixture) so the incremental-cache tests can control
    /// `cwd`/`session_id`/content precisely and touch/modify individual
    /// files independently of their siblings. `session_id` must look like a
    /// canonical UUID (`is_canonical_claude_session_id`) to be picked up as
    /// the session's own id rather than falling back to the filename.
    fn write_session_file(
        project: &Path,
        filename: &str,
        session_id: &str,
        cwd: &str,
        timestamp: &str,
        message: &str,
    ) {
        let line = format!(
            "{{\"parentUuid\":null,\"isSidechain\":false,\"userType\":\"external\",\"cwd\":\"{cwd}\",\"sessionId\":\"{session_id}\",\"version\":\"1.0.0\",\"gitBranch\":\"main\",\"type\":\"user\",\"message\":{{\"role\":\"user\",\"content\":\"{message}\"}},\"uuid\":\"{session_id}\",\"timestamp\":\"{timestamp}\"}}\n"
        );
        std::fs::write(project.join(filename), line).unwrap();
    }

    /// A canonical-looking claude session id, distinct per `n` (same pattern
    /// the B-T9 perf test already used for its 6,000 synthetic files).
    fn synthetic_session_id(n: usize) -> String {
        format!("{n:08x}-0000-4000-8000-000000000000")
    }

    fn mk(session_id: &str, provider: &str, last_activity_at: i64) -> IndexedSession {
        IndexedSession {
            session_id: session_id.to_string(),
            provider: provider.to_string(),
            project_path: "/p".to_string(),
            title: Some(format!("t-{session_id}")),
            summary: None,
            first_user_message: None,
            last_activity_at,
            created_at: None,
            cwd: Some("/p".to_string()),
            is_subagent: false,
            is_non_interactive: false,
            source_file: None,
        }
    }

    // ── B-T2: snapshot is sorted lastActivityAt DESC, then key() DESC ──

    #[tokio::test]
    async fn snapshot_is_sorted_last_activity_desc_then_key_desc() {
        let calls = Arc::new(AtomicUsize::new(0));
        let source = CountingSource {
            calls: Arc::clone(&calls),
            items: vec![
                mk("a", "claude", 100),
                mk("z", "claude", 300),
                mk("b", "claude", 300), // same lastActivityAt as "z" -> key DESC breaks the tie
                mk("m", "claude", 200),
            ],
        };
        let index = SessionIndex::new(vec![Arc::new(source)]);
        let snap = index.snapshot().await;
        let ids: Vec<&str> = snap.iter().map(|s| s.session_id.as_str()).collect();
        // 300s first (key DESC: "claude:z" > "claude:b"), then 200, then 100.
        assert_eq!(ids, vec!["z", "b", "m", "a"]);
    }

    // ── B-T3: within TTL, a second snapshot() call does not rescan ──

    #[tokio::test]
    async fn within_ttl_a_second_snapshot_call_does_not_rescan() {
        let calls = Arc::new(AtomicUsize::new(0));
        let source = CountingSource {
            calls: Arc::clone(&calls),
            items: vec![mk("a", "claude", 1)],
        };
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_secs(60));
        let _ = index.snapshot().await;
        let _ = index.snapshot().await;
        let _ = index.snapshot().await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "cached snapshot must be reused within the TTL window"
        );
    }

    // ── B-T4: after TTL expiry, a stale snapshot triggers exactly one more
    // scan -- stale-while-revalidate means that scan runs DETACHED, so the
    // triggering `snapshot()` call itself returns immediately with the OLD
    // (still valid) data; poll for the background sweep to settle instead of
    // asserting on the immediate return value. ──

    #[tokio::test]
    async fn after_ttl_expiry_the_next_snapshot_call_rescans() {
        let calls = Arc::new(AtomicUsize::new(0));
        let source = CountingSource {
            calls: Arc::clone(&calls),
            items: vec![mk("a", "claude", 1)],
        };
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_millis(20));
        let _ = index.snapshot().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        tokio::time::sleep(Duration::from_millis(60)).await;
        let _ = index.snapshot().await; // triggers (but does not wait for) the sweep
        assert!(
            wait_until(Duration::from_secs(2), || calls.load(Ordering::SeqCst) >= 2).await,
            "a stale snapshot must trigger exactly one more (background) scan"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    // ── B-T5: concurrent snapshot() calls on a cold cache scan exactly once ──

    #[tokio::test]
    async fn concurrent_snapshot_calls_on_cold_cache_scan_exactly_once() {
        let calls = Arc::new(AtomicUsize::new(0));
        let source = CountingSource {
            calls: Arc::clone(&calls),
            items: vec![mk("a", "claude", 1)],
        };
        let index = Arc::new(SessionIndex::with_ttl(
            vec![Arc::new(source)],
            Duration::from_secs(60),
        ));
        let mut handles = Vec::new();
        for _ in 0..8 {
            let index = Arc::clone(&index);
            handles.push(tokio::spawn(async move { index.snapshot().await }));
        }
        for h in handles {
            h.await.unwrap();
        }
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "the serialized refresh must not stampede: 8 concurrent misses -> 1 scan"
        );
    }

    // ── B-T6: warm() populates the cache so the first real request never scans ──

    #[tokio::test]
    async fn warm_populates_the_cache_so_a_subsequent_snapshot_does_not_rescan() {
        let calls = Arc::new(AtomicUsize::new(0));
        let source = CountingSource {
            calls: Arc::clone(&calls),
            items: vec![mk("a", "claude", 1)],
        };
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_secs(60));
        index.warm().await;
        assert_eq!(calls.load(Ordering::SeqCst), 1, "warm() performs one scan");
        let _ = index.snapshot().await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "snapshot() after warm() must reuse the warmed cache, not rescan"
        );
    }

    // ── Incremental cache (Batch B review fix): a refresh sweep must re-parse
    // ONLY new/changed files, never everything, on every TTL expiry ──

    /// Only the touched file gets re-parsed; its two unchanged siblings don't.
    #[tokio::test]
    async fn changed_file_single_reparse() {
        let claude_home = unique_temp_dir("changed-file");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        write_session_file(
            &project,
            "a.jsonl",
            &synthetic_session_id(1),
            "/p/a",
            "2025-01-30T10:00:00.000Z",
            "hello a",
        );
        write_session_file(
            &project,
            "b.jsonl",
            &synthetic_session_id(2),
            "/p/b",
            "2025-01-30T10:00:01.000Z",
            "hello b",
        );
        write_session_file(
            &project,
            "c.jsonl",
            &synthetic_session_id(3),
            "/p/c",
            "2025-01-30T10:00:02.000Z",
            "hello c",
        );

        let parse_calls = Arc::new(AtomicUsize::new(0));
        let source = CountingWrapper {
            parse_calls: Arc::clone(&parse_calls),
            ..CountingWrapper::new(ClaudeSource::new(claude_home.clone()))
        };
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_millis(10));

        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 3);
        assert_eq!(
            parse_calls.load(Ordering::SeqCst),
            3,
            "cold sweep parses every file once"
        );

        // Rewrite exactly one file with different (longer) content -- changes
        // its size, robust to coarse filesystem mtime resolution.
        write_session_file(
            &project,
            "b.jsonl",
            &synthetic_session_id(2),
            "/p/b",
            "2025-01-30T10:05:00.000Z",
            "hello b, now with a much longer message body to force a size change",
        );

        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL

        // Stale-while-revalidate: poll until the background sweep settles.
        let mut snap2 = index.snapshot().await;
        for _ in 0..50 {
            if parse_calls.load(Ordering::SeqCst) >= 4 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
            snap2 = index.snapshot().await;
        }
        assert_eq!(snap2.len(), 3);
        assert_eq!(
            parse_calls.load(Ordering::SeqCst),
            4,
            "post-TTL refresh must re-parse ONLY the one changed file"
        );

        std::fs::remove_dir_all(&claude_home).ok();
    }

    /// THE TRUE PERF GUARD: a post-TTL refresh sweep over unchanged files must
    /// re-parse ZERO of them (only re-stat). Deliberately fast/un-ignored --
    /// small fixture files, not the 6k-file perf test below -- so it runs on
    /// every `cargo test` and can never regress silently.
    #[tokio::test]
    async fn unchanged_warm_sweep_reparses_zero() {
        let claude_home = unique_temp_dir("unchanged-warm-sweep");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        for i in 1..=3 {
            write_session_file(
                &project,
                &format!("{i}.jsonl"),
                &synthetic_session_id(i),
                &format!("/p/{i}"),
                "2025-01-30T10:00:00.000Z",
                "hello",
            );
        }

        let parse_calls = Arc::new(AtomicUsize::new(0));
        let source = CountingWrapper {
            parse_calls: Arc::clone(&parse_calls),
            ..CountingWrapper::new(ClaudeSource::new(claude_home.clone()))
        };
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_millis(10));

        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 3);
        assert_eq!(parse_calls.load(Ordering::SeqCst), 3);

        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL, nothing changed

        let snap2 = index.snapshot().await;
        assert_eq!(snap2.len(), 3);
        assert_eq!(
            parse_calls.load(Ordering::SeqCst),
            3,
            "a post-TTL sweep of unchanged files must not re-parse ANY file"
        );

        std::fs::remove_dir_all(&claude_home).ok();
    }

    /// A cwd-less file is parsed once, cached as an EXCLUSION (absent from
    /// the snapshot), and never re-parsed on a subsequent unchanged sweep.
    #[tokio::test]
    async fn excluded_file_cached() {
        let claude_home = unique_temp_dir("excluded-file-cached");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        // `healthy.jsonl` has no `cwd` anywhere -> excluded at discovery (R10b).
        let content = std::fs::read_to_string(fixtures_dir().join("healthy.jsonl")).unwrap();
        std::fs::write(project.join("healthy.jsonl"), &content).unwrap();
        write_session_file(
            &project,
            "included.jsonl",
            &synthetic_session_id(9),
            "/p/9",
            "2025-01-30T10:00:00.000Z",
            "hello",
        );

        let parse_calls = Arc::new(AtomicUsize::new(0));
        let source = CountingWrapper {
            parse_calls: Arc::clone(&parse_calls),
            ..CountingWrapper::new(ClaudeSource::new(claude_home.clone()))
        };
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_millis(10));

        let snap = index.snapshot().await;
        // Only the included file is in the snapshot -- the cwd-less file is excluded.
        assert_eq!(snap.len(), 1);
        assert_eq!(
            parse_calls.load(Ordering::SeqCst),
            2,
            "both files parsed once (one excluded)"
        );

        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL, nothing changed

        let snap2 = index.snapshot().await;
        assert_eq!(snap2.len(), 1, "the excluded file must still be absent");
        assert_eq!(
            parse_calls.load(Ordering::SeqCst),
            2,
            "the cached exclusion must not be re-parsed when the file hasn't changed"
        );

        std::fs::remove_dir_all(&claude_home).ok();
    }

    /// A deleted file is pruned from the cache and vanishes from the snapshot.
    #[tokio::test]
    async fn deleted_file_pruned() {
        let claude_home = unique_temp_dir("deleted-file-pruned");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        write_session_file(
            &project,
            "keep.jsonl",
            &synthetic_session_id(1),
            "/p/1",
            "2025-01-30T10:00:00.000Z",
            "hello",
        );
        write_session_file(
            &project,
            "remove.jsonl",
            &synthetic_session_id(2),
            "/p/2",
            "2025-01-30T10:00:01.000Z",
            "hello",
        );

        let source = ClaudeSource::new(claude_home.clone());
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_millis(10));

        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 2);

        std::fs::remove_file(project.join("remove.jsonl")).unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL

        // Stale-while-revalidate: the triggering call may still return the
        // OLD (2-item) snapshot while the background sweep re-validates the
        // corpus -- poll until it settles.
        let mut snap2 = index.snapshot().await;
        for _ in 0..50 {
            if snap2.len() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
            snap2 = index.snapshot().await;
        }
        assert_eq!(snap2.len(), 1, "the deleted file's session must be gone");
        assert_eq!(snap2[0].session_id, synthetic_session_id(1));

        std::fs::remove_dir_all(&claude_home).ok();
    }

    /// A newly-added file is discovered and parsed on the next sweep; the
    /// pre-existing file isn't re-parsed.
    #[tokio::test]
    async fn new_file_added() {
        let claude_home = unique_temp_dir("new-file-added");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        write_session_file(
            &project,
            "first.jsonl",
            &synthetic_session_id(1),
            "/p/1",
            "2025-01-30T10:00:00.000Z",
            "hello",
        );

        let parse_calls = Arc::new(AtomicUsize::new(0));
        let source = CountingWrapper {
            parse_calls: Arc::clone(&parse_calls),
            ..CountingWrapper::new(ClaudeSource::new(claude_home.clone()))
        };
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_millis(10));

        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 1);
        assert_eq!(parse_calls.load(Ordering::SeqCst), 1);

        write_session_file(
            &project,
            "second.jsonl",
            &synthetic_session_id(2),
            "/p/2",
            "2025-01-30T10:00:01.000Z",
            "hello",
        );
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL

        // Stale-while-revalidate: poll until the background sweep settles.
        let mut snap2 = index.snapshot().await;
        for _ in 0..50 {
            if snap2.len() == 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
            snap2 = index.snapshot().await;
        }
        assert_eq!(snap2.len(), 2);
        assert_eq!(
            parse_calls.load(Ordering::SeqCst),
            2,
            "only the new file should be parsed -- the pre-existing file is unchanged"
        );

        std::fs::remove_dir_all(&claude_home).ok();
    }

    // ── B-T9 (perf, ignored by default): a post-TTL refresh sweep over 6k
    // synthetic, UNCHANGED claude session files re-parses ZERO of them and
    // completes in <500ms. Run explicitly:
    //   cargo test -p freshell-sessions -- --ignored --nocapture directory_index
    //
    // This replaces the original version of this test, which called
    // `ClaudeSource::scan()` directly (bypassing the incremental cache
    // entirely) and so could not have caught the Batch B review finding: a
    // synthetic-file "warm sweep" that never re-touches the SAME files with a
    // stale cache in between proves nothing about the incremental cache's
    // actual behavior. The cold sweep (via `SessionIndex`, populating the
    // file cache) is deliberately UNTIMED (the assertion is on the SECOND,
    // post-TTL sweep, not on `mkfs` or cold-cache population); the parse
    // counter on that second sweep is the defense against exactly this kind
    // of masking.

    #[tokio::test]
    #[ignore]
    async fn claude_source_warm_sweep_of_6k_files_reparses_zero_and_completes_under_500ms() {
        let claude_home = unique_temp_dir("b-t9-perf");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        let content = std::fs::read_to_string(fixtures_dir().join("real-corrupted.jsonl")).unwrap();
        for i in 0..6000 {
            // Distinct canonical-looking session ids so each file is a distinct
            // session (mirrors 6,208 real transcripts, not 6,208 copies of one).
            let sid = format!("{i:08x}-0000-4000-8000-000000000000");
            let file_content = content.replace("b7936c10-4935-441c-837c-c1f33cafec2d", &sid);
            std::fs::write(project.join(format!("{sid}.jsonl")), file_content).unwrap();
        }

        let parse_calls = Arc::new(AtomicUsize::new(0));
        let source = CountingWrapper {
            parse_calls: Arc::clone(&parse_calls),
            ..CountingWrapper::new(ClaudeSource::new(claude_home.clone()))
        };
        // Short TTL so a `sleep` past it forces a real refresh sweep, exactly
        // like a user browsing more than 1s (the production TTL) apart.
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_millis(10));

        // Cold sweep: untimed (warms the OS page/dentry cache AND populates
        // this index's own FileEntry cache for every file).
        let warm_up = index.snapshot().await;
        assert_eq!(warm_up.len(), 6000, "sanity: every synthetic file indexed");
        assert_eq!(parse_calls.load(Ordering::SeqCst), 6000);

        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL, nothing changed

        let start = std::time::Instant::now();
        let items = index.snapshot().await;
        let elapsed = start.elapsed();
        assert_eq!(items.len(), 6000);
        eprintln!("B-T9: post-TTL warm sweep of 6000 unchanged claude files took {elapsed:?}");
        assert!(
            elapsed < Duration::from_millis(500),
            "post-TTL warm sweep of 6000 unchanged files took {elapsed:?}, expected <500ms"
        );
        assert_eq!(
            parse_calls.load(Ordering::SeqCst),
            6000,
            "post-TTL sweep of 6000 UNCHANGED files must not re-parse ANY of them -- only re-stat"
        );

        std::fs::remove_dir_all(&claude_home).ok();
    }

    // ── Bounded warm sweep (rust-tauri-port perf fix): production forensics on
    // a real 12,745-15,324 session corpus measured `session_index_warm` sweeps
    // taking 75s-283s, during which the first post-reconnect
    // `GET /api/session-directory` took 990ms (vs the usual ~40ms). Root
    // cause: the ORIGINAL `snapshot()` held a single `AsyncMutex` guard for
    // the sweep's ENTIRE duration (discover + parse of every source), so any
    // OTHER concurrent `snapshot()` caller blocked on that same mutex for as
    // long as the sweep ran -- even though a perfectly servable (if slightly
    // stale) snapshot already existed. The fix is stale-while-revalidate
    // ("snapshot-swap"): once ANY snapshot has ever been published, a stale
    // cache is served immediately and the actual sweep runs DETACHED
    // (`tokio::spawn`), never held behind a lock a foreground reader waits
    // on. Only a truly cold cache (nothing published yet, e.g. the very
    // first call at boot) still waits inline -- there is nothing else to
    // serve. See `SessionIndex::snapshot`'s doc comment. ─────────────────

    /// A `SessionSource` whose `discover()` sleeps for a configurable delay,
    /// simulating an in-flight sweep over a large real corpus long enough to
    /// deterministically observe (not race) a concurrent `snapshot()` call
    /// landing WHILE that sweep is still running.
    struct SlowSource {
        delay: Duration,
        items: Vec<IndexedSession>,
        discover_calls: Arc<AtomicUsize>,
    }

    impl SlowSource {
        fn fake_path(item: &IndexedSession) -> PathBuf {
            PathBuf::from(format!("mem://{}", item.key()))
        }
    }

    impl SessionSource for SlowSource {
        fn discover(&self) -> Vec<FileStat> {
            self.discover_calls.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(self.delay);
            self.items
                .iter()
                .map(|item| FileStat {
                    path: Self::fake_path(item),
                    mtime_ms: 0,
                    size: 0,
                })
                .collect()
        }

        fn parse(&self, path: &Path) -> Option<IndexedSession> {
            self.items
                .iter()
                .find(|item| Self::fake_path(item) == path)
                .cloned()
        }
    }

    /// RED (before the stale-while-revalidate fix): a `snapshot()` call
    /// issued while another sweep is mid-flight blocked on the shared
    /// refresh mutex for the sweep's full duration (500ms here, 283s in
    /// production) -- this assertion failed with an elapsed time close to
    /// the sweep's delay, not under the 100ms SLA.
    #[tokio::test]
    async fn foreground_snapshot_never_blocks_on_an_inflight_sweep() {
        let discover_calls = Arc::new(AtomicUsize::new(0));
        let source = SlowSource {
            delay: Duration::from_millis(500),
            items: vec![mk("a", "claude", 1)],
            discover_calls: Arc::clone(&discover_calls),
        };
        let index = Arc::new(SessionIndex::with_ttl(
            vec![Arc::new(source)],
            Duration::from_millis(10),
        ));

        // Cold start: nothing published yet, so this call legitimately waits
        // for the (only) sweep -- matches `warm()`'s documented semantics.
        let first = index.snapshot().await;
        assert_eq!(first.len(), 1);
        assert_eq!(discover_calls.load(Ordering::SeqCst), 1);

        tokio::time::sleep(Duration::from_millis(30)).await; // past the 10ms TTL

        // A stale cache now exists. Trigger a sweep from a background task,
        // give it long enough to actually be mid-`discover()` (the 500ms
        // sleep), then make a SECOND, independent `snapshot()` call and time
        // it -- it must be served from the stale cache, not wait on the
        // in-flight sweep.
        let sweep_index = Arc::clone(&index);
        let sweep_handle = tokio::spawn(async move { sweep_index.snapshot().await });
        tokio::time::sleep(Duration::from_millis(100)).await; // sweep is now mid-`discover()`

        let start = std::time::Instant::now();
        let foreground = index.snapshot().await;
        let elapsed = start.elapsed();
        assert_eq!(
            foreground.len(),
            1,
            "must still serve the stale-but-valid snapshot"
        );
        assert!(
            elapsed < Duration::from_millis(100),
            "foreground snapshot() took {elapsed:?} while a sweep was in flight -- \
             it must never block on an in-flight sweep (production: 283s sweeps \
             blocked foreground /api/session-directory requests for their full duration)"
        );

        sweep_handle.await.unwrap();
        // Let any detached background refresh finish before asserting the
        // final call count: exactly one MORE sweep (the stale-triggered
        // one), never two -- concurrent stale-misses must still dedup to a
        // single sweep, same guarantee B-T5 proves for the cold-cache case.
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert_eq!(
            discover_calls.load(Ordering::SeqCst),
            2,
            "concurrent stale-misses must dedup to exactly one background sweep"
        );
        // No filesystem cleanup needed: `SlowSource` uses only synthetic
        // `mem://` paths and never touches the real filesystem.
    }

    /// A `SessionSource` whose `discover()` unconditionally panics --
    /// simulates the blocking sweep closure panicking inside
    /// `spawn_blocking` (documented as never happening today -- `discover`
    /// and `parse` are both corruption-tolerant -- but this test guards
    /// what happens if that invariant is ever violated).
    struct PanicSource;

    impl SessionSource for PanicSource {
        fn discover(&self) -> Vec<FileStat> {
            panic!("synthetic panic to exercise spawn_blocking JoinError handling");
        }

        fn parse(&self, _path: &Path) -> Option<IndexedSession> {
            None
        }
    }

    /// RED (before the fix): `perform_refresh`'s
    /// `spawn_blocking(...).await.unwrap_or_default()` turns a `JoinError`
    /// (the blocking closure panicked) into `(vec![], 0)`, which is then
    /// unconditionally published as the new snapshot -- silently
    /// overwriting a good, previously-published snapshot with an empty one
    /// marked FRESH. A panicked sweep must instead be treated the same way
    /// `direct_list`'s error path already is (`refresh_snapshot`, a few
    /// lines above): preserve whatever was cached and log, never publish
    /// empty-and-fresh over good data.
    #[tokio::test]
    async fn perform_refresh_preserves_cached_snapshot_when_blocking_sweep_panics() {
        // Seed `snapshot` as if a previous, successful sweep had already
        // published a good result -- exactly the state a real warm cache is
        // in when a LATER refresh sweep panics.
        let good_snapshot = Arc::new(vec![mk("a", "claude", 1)]);
        let snapshot = Arc::new(StdMutex::new(Some(CachedSnapshot {
            items: Arc::clone(&good_snapshot),
            fetched_at: Instant::now(),
        })));
        let file_cache = Arc::new(StdMutex::new(HashMap::new()));
        let direct_cache = Arc::new(StdMutex::new(HashMap::new()));
        let persist_state = Arc::new(StdMutex::new(PersistState::default()));

        let panicking_source: Arc<dyn SessionSource> = Arc::new(PanicSource);

        let result = SessionIndex::perform_refresh(
            vec![panicking_source],
            Arc::clone(&file_cache),
            Arc::clone(&direct_cache),
            Arc::clone(&snapshot),
            None,
            Arc::clone(&persist_state),
        )
        .await;

        assert_eq!(
            result.len(),
            1,
            "a panicked blocking sweep must return the last-known-good snapshot, \
             not an empty one"
        );

        let published = snapshot.lock().unwrap();
        assert_eq!(
            published.as_ref().map(|c| c.items.len()),
            Some(1),
            "the published snapshot must be preserved (not overwritten with an \
             empty-but-fresh one) after the blocking sweep panics"
        );
    }

    /// A post-TTL refresh sweep over a synthetic 3,000-file claude corpus
    /// (smaller than B-T9's 6,000 -- kept fast for routine CI runs while
    /// still representative) re-parses ZERO unchanged files, using a probe
    /// counter (`CountingWrapper::parse_calls`) as the correctness oracle --
    /// mtime/size-gating so an unchanged session file costs a stat, not a
    /// parse.
    #[tokio::test]
    async fn mtime_gate_second_sweep_over_synthetic_3k_corpus_reparses_nothing() {
        let claude_home = unique_temp_dir("mtime-gate-3k");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        let content = std::fs::read_to_string(fixtures_dir().join("real-corrupted.jsonl")).unwrap();
        const N: usize = 3000;
        for i in 0..N {
            let sid = format!("{i:08x}-0000-4000-8000-000000000000");
            let file_content = content.replace("b7936c10-4935-441c-837c-c1f33cafec2d", &sid);
            std::fs::write(project.join(format!("{sid}.jsonl")), file_content).unwrap();
        }

        let parse_calls = Arc::new(AtomicUsize::new(0));
        let source = CountingWrapper {
            parse_calls: Arc::clone(&parse_calls),
            ..CountingWrapper::new(ClaudeSource::new(claude_home.clone()))
        };
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_millis(10));

        let warm_up = index.snapshot().await;
        assert_eq!(warm_up.len(), N, "sanity: every synthetic file indexed");
        assert_eq!(parse_calls.load(Ordering::SeqCst), N);

        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL, nothing changed

        // Under the stale-while-revalidate design, the post-TTL call itself
        // returns the (still-correct) stale snapshot immediately and the
        // re-validation sweep runs detached -- poll until it settles instead
        // of asserting on the immediate return value.
        let _ = index.snapshot().await;
        let mut settled = false;
        for _ in 0..50 {
            tokio::time::sleep(Duration::from_millis(50)).await;
            if parse_calls.load(Ordering::SeqCst) >= N {
                settled = true;
                break;
            }
        }
        assert!(settled, "background re-validation sweep never completed");
        assert_eq!(
            parse_calls.load(Ordering::SeqCst),
            N,
            "post-TTL sweep of {N} UNCHANGED files must not re-parse ANY of them -- only re-stat"
        );
        let items = index.snapshot().await;
        assert_eq!(items.len(), N);

        std::fs::remove_dir_all(&claude_home).ok();
    }

    /// Golden-compare correctness guard: the stale-while-revalidate
    /// optimization must never change WHAT is indexed, only WHEN a caller
    /// sees the update. The final, settled `SessionIndex` snapshot must be
    /// byte-for-byte identical (same items, same sort order) to a direct
    /// one-shot `ClaudeSource::scan()` (which bypasses the index/cache
    /// entirely) over the same corpus, both on the very first (cold) sweep
    /// and again after a file changes and the background re-validation sweep
    /// has settled.
    #[tokio::test]
    async fn index_content_matches_direct_scan_before_and_after_background_refresh() {
        let claude_home = unique_temp_dir("golden-compare");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        write_session_file(
            &project,
            "a.jsonl",
            &synthetic_session_id(1),
            "/p/a",
            "2025-01-30T10:00:00.000Z",
            "hello a",
        );
        write_session_file(
            &project,
            "b.jsonl",
            &synthetic_session_id(2),
            "/p/b",
            "2025-01-30T10:00:01.000Z",
            "hello b",
        );

        let index = SessionIndex::with_ttl(
            vec![Arc::new(ClaudeSource::new(claude_home.clone()))],
            Duration::from_millis(10),
        );

        // Cold sweep: must match a direct scan exactly.
        let indexed = index.snapshot().await;
        let mut direct = ClaudeSource::new(claude_home.clone()).scan();
        direct.sort_by(|a, b| {
            b.last_activity_at
                .cmp(&a.last_activity_at)
                .then_with(|| b.key().cmp(&a.key()))
        });
        assert_eq!(*indexed, direct, "cold sweep must match a direct scan");

        // Add a THIRD session file, wait past TTL, and let the background
        // re-validation sweep settle -- the eventually-consistent snapshot
        // must again match a direct scan exactly.
        write_session_file(
            &project,
            "c.jsonl",
            &synthetic_session_id(3),
            "/p/c",
            "2025-01-30T10:00:02.000Z",
            "hello c",
        );
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL
        let _ = index.snapshot().await; // triggers the background sweep

        let mut settled_items = index.snapshot().await;
        for _ in 0..50 {
            if settled_items.len() == 3 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
            settled_items = index.snapshot().await;
        }
        let mut direct_after = ClaudeSource::new(claude_home.clone()).scan();
        direct_after.sort_by(|a, b| {
            b.last_activity_at
                .cmp(&a.last_activity_at)
                .then_with(|| b.key().cmp(&a.key()))
        });
        assert_eq!(
            *settled_items, direct_after,
            "settled post-refresh snapshot must match a direct scan"
        );
        assert_eq!(settled_items.len(), 3);

        std::fs::remove_dir_all(&claude_home).ok();
    }

    // ── ClaudeSource sanity (function-level, mirrors session_directory.rs's
    // own `list_claude_sessions` unit tests; the differential proof that the
    // two agree lives in `session_directory.rs` as B-T1) ──

    #[test]
    fn claude_source_scans_fixture_home_and_skips_cwdless_files() {
        let claude_home = claude_home_with(
            "claudesrc-sanity",
            &["real-corrupted.jsonl", "healthy.jsonl"],
        );
        let items = ClaudeSource::new(claude_home.clone()).scan();
        // `healthy.jsonl` has no `cwd` anywhere -> excluded at discovery (R10b),
        // same rule `list_claude_sessions` enforces.
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].session_id, "b7936c10-4935-441c-837c-c1f33cafec2d");
        std::fs::remove_dir_all(claude_home.parent().unwrap()).ok();
    }

    // ── Batch C: CodexSource ─────────────────────────────────────────────

    fn codex_fixture() -> String {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/coding-cli/codex/task-events.sanitized.jsonl");
        std::fs::read_to_string(path).unwrap()
    }

    /// A `<home>/.codex/sessions/…` layout. `nested` controls whether the
    /// fixture is placed directly in `sessions/` or several levels deep
    /// (codex's real `sessions/YYYY/MM/DD/*.jsonl` layout) — proving
    /// `CodexSource::discover` recurses arbitrarily, unlike claude's
    /// fixed-depth walk.
    fn codex_home_with_fixture(label: &str, nested: bool) -> std::path::PathBuf {
        let home = unique_temp_dir(label);
        let codex_home = home.join(".codex");
        let sessions = if nested {
            codex_home
                .join("sessions")
                .join("2026")
                .join("03")
                .join("01")
        } else {
            codex_home.join("sessions")
        };
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::write(sessions.join("rollout-task-events.jsonl"), codex_fixture()).unwrap();
        codex_home
    }

    #[test]
    fn codex_source_scans_fixture_and_uses_parsed_session_id() {
        let codex_home = codex_home_with_fixture("codexsrc-sanity", false);
        let items = CodexSource::new(codex_home.clone()).scan();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].session_id, "session-activity");
        assert_eq!(items[0].provider, "codex");
        assert_eq!(items[0].cwd.as_deref(), Some("/project/codex"));
        std::fs::remove_dir_all(codex_home.parent().unwrap()).ok();
    }

    #[test]
    fn codex_source_discovers_nested_yyyy_mm_dd_sessions() {
        let codex_home = codex_home_with_fixture("codexsrc-nested", true);
        let items = CodexSource::new(codex_home.clone()).scan();
        assert_eq!(
            items.len(),
            1,
            "the deeply-nested sessions/2026/03/01/*.jsonl file must be discovered"
        );
        std::fs::remove_dir_all(codex_home.parent().unwrap()).ok();
    }

    /// R10b applies to codex too, not just claude (`session-indexer.ts`'s
    /// discovery-time `if (!meta.cwd) continue` gates ALL providers).
    #[test]
    fn codex_source_skips_cwdless_sessions() {
        let home = unique_temp_dir("codexsrc-cwdless");
        let sessions = home.join(".codex").join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        // No `cwd` anywhere in this session_meta payload.
        std::fs::write(
            sessions.join("no-cwd.jsonl"),
            "{\"timestamp\":\"2026-03-01T00:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"id\":\"s1\"}}\n",
        )
        .unwrap();
        let items = CodexSource::new(home.join(".codex")).scan();
        assert_eq!(items.len(), 0);
        std::fs::remove_dir_all(&home).ok();
    }

    /// When the parser finds no `session_meta.id`, the session id falls back
    /// to `extractSessionIdFromFilename`: the embedded UUID substring if the
    /// basename has one, else the bare basename.
    #[test]
    fn codex_source_fallback_session_id_uses_embedded_uuid_in_filename() {
        let home = unique_temp_dir("codexsrc-fallback-id");
        let sessions = home.join(".codex").join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        // session_meta has no `id`, so the filename's embedded UUID wins.
        std::fs::write(
            sessions.join("rollout-2026-03-01T00-00-06-b7936c10-4935-441c-837c-c1f33cafec2d.jsonl"),
            "{\"timestamp\":\"2026-03-01T00:00:00.000Z\",\"type\":\"session_meta\",\"payload\":{\"cwd\":\"/p\"}}\n",
        )
        .unwrap();
        let items = CodexSource::new(home.join(".codex")).scan();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].session_id, "b7936c10-4935-441c-837c-c1f33cafec2d");
        std::fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn find_uuid_substring_extracts_embedded_uuid_or_none() {
        assert_eq!(
            find_uuid_substring("rollout-2026-03-01T00-00-06-b7936c10-4935-441c-837c-c1f33cafec2d"),
            Some("b7936c10-4935-441c-837c-c1f33cafec2d".to_string())
        );
        assert_eq!(find_uuid_substring("plain-basename-no-uuid"), None);
    }

    // ── Batch C: OpencodeSource ──────────────────────────────────────────

    /// A writable sqlite db at `<data_home>/opencode.db`, seeded with the
    /// same schema/shape `tests/opencode_sqlite.rs` uses.
    fn opencode_data_home_with_sessions(
        label: &str,
        rows: &[(&str, &str, &str, i64, i64)], // (id, cwd, title, created, updated)
    ) -> std::path::PathBuf {
        let data_home = unique_temp_dir(label);
        std::fs::create_dir_all(&data_home).unwrap();
        let db = data_home.join("opencode.db");
        let conn = rusqlite::Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                project_id TEXT, parent_id TEXT
             );",
        )
        .unwrap();
        for (id, cwd, title, created, updated) in rows {
            conn.execute(
                "INSERT INTO session VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL)",
                rusqlite::params![id, cwd, title, created, updated],
            )
            .unwrap();
        }
        drop(conn);
        data_home
    }

    #[test]
    fn opencode_source_direct_lists_and_maps_fields() {
        let data_home = opencode_data_home_with_sessions(
            "opencodesrc-basic",
            &[("ses_a", "/repo/a", "Session A", 1000, 5000)],
        );
        let items = OpencodeSource::new(data_home.clone()).scan();
        assert_eq!(items.len(), 1);
        let item = &items[0];
        assert_eq!(item.session_id, "ses_a");
        assert_eq!(item.provider, "opencode");
        assert_eq!(item.project_path, "/repo/a"); // no project row -> falls back to cwd
        assert_eq!(item.cwd.as_deref(), Some("/repo/a"));
        assert_eq!(item.title.as_deref(), Some("Session A"));
        assert_eq!(item.created_at, Some(1000));
        assert_eq!(item.last_activity_at, 5000);
        assert_eq!(item.summary, None);
        assert_eq!(item.first_user_message, None);
        assert!(!item.is_subagent);
        assert!(!item.is_non_interactive);
        std::fs::remove_dir_all(&data_home).ok();
    }

    #[test]
    fn opencode_source_missing_db_scans_empty_without_panicking() {
        let data_home = unique_temp_dir("opencodesrc-missing");
        std::fs::create_dir_all(&data_home).unwrap();
        let items = OpencodeSource::new(data_home.clone()).scan();
        assert_eq!(items.len(), 0);
        std::fs::remove_dir_all(&data_home).ok();
    }

    /// The change-token-gating contract: an unchanged db (and db-wal) must
    /// not trigger a re-query; touching `opencode.db-wal` (the WAL wrinkle —
    /// a write may touch ONLY the wal file, never the main db) must.
    #[tokio::test]
    async fn opencode_change_token_gating_unchanged_no_requery_wal_touch_requeries() {
        let data_home = opencode_data_home_with_sessions(
            "opencodesrc-gating",
            &[("ses_a", "/repo/a", "Session A", 1000, 5000)],
        );
        let source = CountingWrapper::new(OpencodeSource::new(data_home.clone()));
        let direct_list_calls = Arc::clone(&source.direct_list_calls);
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_millis(10));

        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 1);
        assert_eq!(direct_list_calls.load(Ordering::SeqCst), 1);

        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL, db untouched
        let snap2 = index.snapshot().await;
        assert_eq!(snap2.len(), 1);
        assert_eq!(
            direct_list_calls.load(Ordering::SeqCst),
            1,
            "an unchanged db (and db-wal) must not trigger a re-query"
        );

        // Touch ONLY the -wal file (the load-bearing WAL wrinkle): a write
        // that never touches the main db's own mtime.
        let wal = data_home.join("opencode.db-wal");
        std::fs::write(&wal, b"wal-bytes-changed").unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL

        let snap3 = index.snapshot().await;
        assert_eq!(snap3.len(), 1);
        assert_eq!(
            direct_list_calls.load(Ordering::SeqCst),
            2,
            "a wal-only mtime change must trigger exactly one more query"
        );

        std::fs::remove_dir_all(&data_home).ok();
    }

    /// A read error (e.g. a locked/corrupted db) must preserve whatever was
    /// cached from the last successful listing -- never drop opencode
    /// history over a transient failure.
    #[tokio::test]
    async fn opencode_read_error_preserves_previously_cached_sessions() {
        let data_home = opencode_data_home_with_sessions(
            "opencodesrc-readerror",
            &[("ses_a", "/repo/a", "Session A", 1000, 5000)],
        );
        let db = data_home.join("opencode.db");
        let source = OpencodeSource::new(data_home.clone());
        let index = SessionIndex::with_ttl(vec![Arc::new(source)], Duration::from_millis(10));

        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 1, "sanity: the good db is listed successfully");

        // RED-demo proof this guard is load-bearing: verified by temporarily
        // making `direct_list` always return `Err` regardless of the
        // underlying provider (see PR description) -- the assertion below
        // failed (`snap2.len() == 0`) before the preserve-on-error handling
        // existed, confirming this test catches a real regression.
        //
        // Corrupt the db file (garbage, non-sqlite bytes) -- changes its
        // mtime/size, so the change-token gate WILL attempt a re-query, and
        // that re-query WILL fail.
        std::fs::write(&db, b"not a sqlite database, deliberately corrupted").unwrap();
        tokio::time::sleep(Duration::from_millis(30)).await; // past TTL

        let snap2 = index.snapshot().await;
        assert_eq!(
            snap2.len(),
            1,
            "a read error on the corrupted db must preserve the previously cached session"
        );
        assert_eq!(snap2[0].session_id, "ses_a");

        std::fs::remove_dir_all(&data_home).ok();
    }

    // ── Batch C: cross-provider merge/sort ───────────────────────────────

    /// Three providers merged from three separate sources sort correctly as
    /// one snapshot, and a `lastActivityAt` tie breaks by the
    /// provider-qualified `key()` (`provider:sessionId`) DESC, exactly like
    /// the single-provider B-T2 test -- proving the tie-break is genuinely
    /// cross-provider, not just cross-session-id-within-one-provider.
    #[tokio::test]
    async fn three_provider_snapshot_merges_and_tie_breaks_by_qualified_key() {
        let claude = CountingSource {
            calls: Arc::new(AtomicUsize::new(0)),
            items: vec![mk("z", "claude", 300)],
        };
        let codex = CountingSource {
            calls: Arc::new(AtomicUsize::new(0)),
            items: vec![mk("z", "codex", 300), mk("a", "codex", 100)],
        };
        let opencode = CountingSource {
            calls: Arc::new(AtomicUsize::new(0)),
            items: vec![mk("z", "opencode", 300)],
        };
        let index = SessionIndex::new(vec![Arc::new(claude), Arc::new(codex), Arc::new(opencode)]);
        let snap = index.snapshot().await;
        let keys: Vec<String> = snap.iter().map(|s| s.key()).collect();
        // All three "z" sessions tie on lastActivityAt=300 -> key() DESC:
        // "opencode:z" > "codex:z" > "claude:z" (lexicographic). "codex:a"
        // (lastActivityAt=100) sorts last.
        assert_eq!(keys, vec!["opencode:z", "codex:z", "claude:z", "codex:a"]);
    }

    // ── Persistent parse cache (Batch 1B, self-hosting-readiness bake-in):
    // disk persistence for `FileEntry` so a server restart doesn't pay the
    // full cold-scan cost again (measured ~4-5min at 99% CPU on a real
    // 8.7GB codex + 2.2GB claude corpus before this change). `SessionIndex`
    // loads a persisted cache at construction (pre-populating `file_cache`
    // -- the EXISTING incremental-sweep logic above re-validates every
    // entry's (mtime, size) against a fresh `discover()`, so a stale/corrupt
    // file can only ever cause an extra re-parse, never a wrong result) and
    // opportunistically saves it back (threshold/debounce-gated, detached --
    // never on the request path) after a sweep. `with_ttl_and_cache_path`
    // exists so tests (and any other caller) can inject an explicit cache
    // path instead of relying on `default_persist_path()`'s environment
    // resolution, which would otherwise require mutating global env vars
    // across parallel test threads.
    //
    // RED (this commit, before the production code existed): none of
    // `load_cache_file` / `save_cache_file` / `default_persist_path` /
    // `SessionIndex::with_ttl_and_cache_path` / `FileEntry` (test-visible)
    // existed, so this test module failed to compile.

    fn cache_path_in(dir: &Path) -> PathBuf {
        dir.join("rust-session-cache.json")
    }

    /// A. Cache round-trip: build an index over real fixtures, persist it,
    /// then build a SECOND index (fresh parse-call counter) pointed at the
    /// same directory + cache file -- its first sweep must re-parse ZERO
    /// files (only re-stat), proving the persisted entries were trusted.
    #[tokio::test]
    async fn persisted_cache_round_trip_avoids_reparse_on_reload() {
        let claude_home = unique_temp_dir("persist-round-trip");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        write_session_file(
            &project,
            "a.jsonl",
            &synthetic_session_id(1),
            "/p/a",
            "2025-01-30T10:00:00.000Z",
            "hello a",
        );
        write_session_file(
            &project,
            "b.jsonl",
            &synthetic_session_id(2),
            "/p/b",
            "2025-01-30T10:00:01.000Z",
            "hello b",
        );

        let cache_dir = unique_temp_dir("persist-round-trip-cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let cache_path = cache_path_in(&cache_dir);

        // First index: cold sweep, parses both files, then we persist its
        // resulting file_cache directly (white-box -- same module -- so the
        // test doesn't depend on the fire-and-forget background save's
        // timing).
        let index1 = SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(claude_home.clone()))],
            Duration::from_millis(10),
            Some(cache_path.clone()),
        );
        let snap1 = index1.snapshot().await;
        assert_eq!(snap1.len(), 2);
        save_cache_file(&cache_path, &index1.file_cache.lock().unwrap()).unwrap();

        // Second index, same directory + cache file, FRESH parse counter.
        let parse_calls = Arc::new(AtomicUsize::new(0));
        let source2 = CountingWrapper {
            parse_calls: Arc::clone(&parse_calls),
            ..CountingWrapper::new(ClaudeSource::new(claude_home.clone()))
        };
        let index2 = SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(source2)],
            Duration::from_millis(10),
            Some(cache_path.clone()),
        );
        let snap2 = index2.snapshot().await;
        assert_eq!(
            snap2.len(),
            2,
            "the reloaded index must see the same sessions"
        );
        assert_eq!(
            parse_calls.load(Ordering::SeqCst),
            0,
            "a freshly-constructed index loading a persisted cache must not re-parse any unchanged file"
        );

        std::fs::remove_dir_all(&claude_home).ok();
        std::fs::remove_dir_all(&cache_dir).ok();
    }

    /// B. Stale entry: after persisting, one file changes size on disk
    /// (bypassing the first index entirely) before a second index loads the
    /// cache -- only that file must be re-parsed.
    #[tokio::test]
    async fn persisted_cache_stale_entry_reparses_only_changed_file() {
        let claude_home = unique_temp_dir("persist-stale-entry");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        write_session_file(
            &project,
            "a.jsonl",
            &synthetic_session_id(1),
            "/p/a",
            "2025-01-30T10:00:00.000Z",
            "hello a",
        );
        write_session_file(
            &project,
            "b.jsonl",
            &synthetic_session_id(2),
            "/p/b",
            "2025-01-30T10:00:01.000Z",
            "hello b",
        );

        let cache_dir = unique_temp_dir("persist-stale-entry-cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let cache_path = cache_path_in(&cache_dir);

        let index1 = SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(claude_home.clone()))],
            Duration::from_millis(10),
            Some(cache_path.clone()),
        );
        let _ = index1.snapshot().await;
        save_cache_file(&cache_path, &index1.file_cache.lock().unwrap()).unwrap();

        // Rewrite "b" with different (longer) content -- changes size,
        // robust to coarse filesystem mtime resolution (same technique the
        // pre-existing `changed_file_single_reparse` test above uses).
        write_session_file(
            &project,
            "b.jsonl",
            &synthetic_session_id(2),
            "/p/b",
            "2025-01-30T10:05:00.000Z",
            "hello b, now with a much longer message body to force a size change",
        );

        let parse_calls = Arc::new(AtomicUsize::new(0));
        let source2 = CountingWrapper {
            parse_calls: Arc::clone(&parse_calls),
            ..CountingWrapper::new(ClaudeSource::new(claude_home.clone()))
        };
        let index2 = SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(source2)],
            Duration::from_millis(10),
            Some(cache_path.clone()),
        );
        let snap2 = index2.snapshot().await;
        assert_eq!(snap2.len(), 2);
        assert_eq!(
            parse_calls.load(Ordering::SeqCst),
            1,
            "only the changed file must be re-parsed; the untouched sibling is trusted from the persisted cache"
        );

        std::fs::remove_dir_all(&claude_home).ok();
        std::fs::remove_dir_all(&cache_dir).ok();
    }

    /// C1. A missing cache file loads as an empty cache -- no panic.
    #[test]
    fn load_cache_file_missing_path_returns_empty_cache() {
        let dir = unique_temp_dir("persist-missing");
        std::fs::create_dir_all(&dir).unwrap();
        let path = cache_path_in(&dir); // parent dir exists, file itself doesn't
        let cache = load_cache_file(&path);
        assert!(cache.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// C2. A corrupt (non-JSON) cache file loads as an empty cache -- no panic.
    #[test]
    fn load_cache_file_corrupt_json_returns_empty_cache() {
        let dir = unique_temp_dir("persist-corrupt");
        std::fs::create_dir_all(&dir).unwrap();
        let path = cache_path_in(&dir);
        std::fs::write(&path, b"not valid json { at all").unwrap();
        let cache = load_cache_file(&path);
        assert!(cache.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// C3. A valid-JSON cache file with a schema_version that doesn't match
    /// the current format loads as an empty cache -- clean invalidation
    /// instead of misinterpreting an old/future format.
    #[test]
    fn load_cache_file_wrong_schema_version_returns_empty_cache() {
        let dir = unique_temp_dir("persist-wrong-version");
        std::fs::create_dir_all(&dir).unwrap();
        let path = cache_path_in(&dir);
        std::fs::write(&path, r#"{"schema_version":999,"entries":{}}"#).unwrap();
        let cache = load_cache_file(&path);
        assert!(cache.is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    /// C4. End-to-end: a `SessionIndex` constructed against a corrupt cache
    /// file boots cold (empty file_cache) without panicking, and still
    /// indexes real sessions normally.
    #[tokio::test]
    async fn session_index_with_corrupt_cache_file_boots_cold_without_panic() {
        let claude_home = unique_temp_dir("persist-boot-corrupt");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        write_session_file(
            &project,
            "a.jsonl",
            &synthetic_session_id(1),
            "/p/a",
            "2025-01-30T10:00:00.000Z",
            "hello a",
        );

        let cache_dir = unique_temp_dir("persist-boot-corrupt-cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let cache_path = cache_path_in(&cache_dir);
        std::fs::write(&cache_path, b"{ garbage").unwrap();

        let index = SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(claude_home.clone()))],
            Duration::from_millis(10),
            Some(cache_path.clone()),
        );
        let snap = index.snapshot().await;
        assert_eq!(
            snap.len(),
            1,
            "indexing must proceed normally despite the corrupt cache file"
        );

        std::fs::remove_dir_all(&claude_home).ok();
        std::fs::remove_dir_all(&cache_dir).ok();
    }

    /// D. A file present when the cache was persisted, then deleted before a
    /// second index loads it, is pruned -- the existing discovery-based
    /// prune (`cache.retain`) already handles this; persistence just
    /// pre-populates the map with a since-deleted entry.
    #[tokio::test]
    async fn persisted_cache_deleted_file_pruned_after_reload() {
        let claude_home = unique_temp_dir("persist-deleted-pruned");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        write_session_file(
            &project,
            "keep.jsonl",
            &synthetic_session_id(1),
            "/p/1",
            "2025-01-30T10:00:00.000Z",
            "hello",
        );
        write_session_file(
            &project,
            "remove.jsonl",
            &synthetic_session_id(2),
            "/p/2",
            "2025-01-30T10:00:01.000Z",
            "hello",
        );

        let cache_dir = unique_temp_dir("persist-deleted-pruned-cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let cache_path = cache_path_in(&cache_dir);

        let index1 = SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(claude_home.clone()))],
            Duration::from_millis(10),
            Some(cache_path.clone()),
        );
        let snap1 = index1.snapshot().await;
        assert_eq!(snap1.len(), 2);
        save_cache_file(&cache_path, &index1.file_cache.lock().unwrap()).unwrap();

        std::fs::remove_file(project.join("remove.jsonl")).unwrap();

        let index2 = SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(claude_home.clone()))],
            Duration::from_millis(10),
            Some(cache_path.clone()),
        );
        let snap2 = index2.snapshot().await;
        assert_eq!(
            snap2.len(),
            1,
            "the deleted file's session must be gone after reload"
        );
        assert_eq!(snap2[0].session_id, synthetic_session_id(1));

        std::fs::remove_dir_all(&claude_home).ok();
        std::fs::remove_dir_all(&cache_dir).ok();
    }

    /// E1. A successful save leaves no stray `.tmp` file behind (proving
    /// the tmp-then-rename sequence completed and cleaned up after itself).
    #[test]
    fn save_cache_file_leaves_no_stray_tmp_file_on_success() {
        let dir = unique_temp_dir("persist-atomic-success");
        std::fs::create_dir_all(&dir).unwrap();
        let path = cache_path_in(&dir);
        let cache = HashMap::new();
        save_cache_file(&path, &cache).unwrap();
        assert!(path.exists());
        let mut tmp = path.as_os_str().to_os_string();
        tmp.push(".tmp");
        assert!(
            !Path::new(&tmp).exists(),
            "no leftover temp file after a successful save"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// E2. Atomicity under failure: if the write to the temp file fails
    /// (simulated by making the target directory read-only), any
    /// PRE-EXISTING cache file at the target path is left completely
    /// untouched -- a reader never observes a half-written file.
    ///
    /// (A crash mid-`fs::write` to the tmp file itself cannot be simulated
    /// deterministically from a unit test -- that's an OS/fault-injection
    /// concern, not something achievable by calling `std::fs::write`'s safe
    /// Rust API on purpose. What IS provable at this level, and what this
    /// test proves, is that a write-path FAILURE never corrupts or removes
    /// the existing target file: `save_cache_file` never touches `path`
    /// itself until the final `rename`, and `rename` is never reached if
    /// the write to the tmp path errors.)
    #[cfg(unix)]
    #[test]
    fn save_cache_file_leaves_original_untouched_when_write_fails() {
        use std::os::unix::fs::PermissionsExt;

        let dir = unique_temp_dir("persist-atomic-failure");
        std::fs::create_dir_all(&dir).unwrap();
        let path = cache_path_in(&dir);
        std::fs::write(&path, r#"{"schema_version":1,"entries":{}}"#).unwrap();
        let original = std::fs::read_to_string(&path).unwrap();

        // Read-only directory -> the tmp-file write inside it fails with a
        // permission error, before any rename is attempted.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

        let mut cache = HashMap::new();
        cache.insert(
            PathBuf::from("/fake/path.jsonl"),
            FileEntry {
                mtime_ms: 1,
                size: 2,
                item: None,
            },
        );
        let result = save_cache_file(&path, &cache);

        // Restore write permission before cleanup.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();

        assert!(
            result.is_err(),
            "the write into a read-only directory must fail"
        );
        let after = std::fs::read_to_string(&path).unwrap();
        assert_eq!(
            after, original,
            "the original cache file must be untouched by a failed save"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// F. An excluded (cwd-less) file's cached EXCLUSION (`item: None`)
    /// survives persistence -- a reloaded index must not re-parse it either.
    #[tokio::test]
    async fn persisted_cache_excluded_marker_survives_reload() {
        let claude_home = unique_temp_dir("persist-excluded-survives");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        let content = std::fs::read_to_string(fixtures_dir().join("healthy.jsonl")).unwrap();
        std::fs::write(project.join("healthy.jsonl"), &content).unwrap();
        write_session_file(
            &project,
            "included.jsonl",
            &synthetic_session_id(9),
            "/p/9",
            "2025-01-30T10:00:00.000Z",
            "hello",
        );

        let cache_dir = unique_temp_dir("persist-excluded-survives-cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let cache_path = cache_path_in(&cache_dir);

        let index1 = SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(claude_home.clone()))],
            Duration::from_millis(10),
            Some(cache_path.clone()),
        );
        let snap1 = index1.snapshot().await;
        assert_eq!(snap1.len(), 1, "sanity: the cwd-less file is excluded");
        save_cache_file(&cache_path, &index1.file_cache.lock().unwrap()).unwrap();

        let parse_calls = Arc::new(AtomicUsize::new(0));
        let source2 = CountingWrapper {
            parse_calls: Arc::clone(&parse_calls),
            ..CountingWrapper::new(ClaudeSource::new(claude_home.clone()))
        };
        let index2 = SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(source2)],
            Duration::from_millis(10),
            Some(cache_path.clone()),
        );
        let snap2 = index2.snapshot().await;
        assert_eq!(
            snap2.len(),
            1,
            "the excluded file must still be absent after reload"
        );
        assert_eq!(
            parse_calls.load(Ordering::SeqCst),
            0,
            "neither the included nor the excluded file should be re-parsed -- both were cached"
        );

        std::fs::remove_dir_all(&claude_home).ok();
        std::fs::remove_dir_all(&cache_dir).ok();
    }

    /// G. Automatic wiring sanity: `warm()` (the boot-time call, `main.rs`)
    /// triggers persistence WITHOUT any manual `save_cache_file` call --
    /// proving `SessionIndex` actually wires the opportunistic save into its
    /// own sweep, not just that the standalone save/load functions work in
    /// isolation. The save is fire-and-forget (never blocks a request
    /// path), so this polls for the file to appear rather than asserting
    /// immediately -- bounded (2s total), and a write this small completes
    /// in low single-digit milliseconds on any local disk, so this is a
    /// generous margin, not a race.
    #[tokio::test]
    async fn warm_automatically_persists_cache_to_disk() {
        let claude_home = unique_temp_dir("persist-auto-warm");
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        write_session_file(
            &project,
            "a.jsonl",
            &synthetic_session_id(1),
            "/p/a",
            "2025-01-30T10:00:00.000Z",
            "hello a",
        );

        let cache_dir = unique_temp_dir("persist-auto-warm-cache");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let cache_path = cache_path_in(&cache_dir);

        let index = SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(claude_home.clone()))],
            Duration::from_secs(60),
            Some(cache_path.clone()),
        );
        index.warm().await;

        let mut found = false;
        for _ in 0..40 {
            if cache_path.exists() {
                found = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(
            found,
            "warm() must automatically persist the cache to disk within 2s"
        );
        let cache = load_cache_file(&cache_path);
        assert_eq!(
            cache.len(),
            1,
            "the persisted cache must contain the one indexed file"
        );

        std::fs::remove_dir_all(&claude_home).ok();
        std::fs::remove_dir_all(&cache_dir).ok();
    }

    /// H. Save-decision gating: the very first sweep always saves
    /// (regardless of how few files changed); a subsequent sweep with few
    /// changes does NOT save again until the debounce window elapses; a
    /// change at/above the threshold saves immediately regardless of
    /// debounce; zero changes never saves.
    #[tokio::test]
    async fn take_pending_save_gates_by_threshold_and_debounce() {
        let cache_dir = unique_temp_dir("persist-gating");
        std::fs::create_dir_all(&cache_dir).unwrap();
        let cache_path = cache_path_in(&cache_dir);
        let index = SessionIndex::with_ttl_and_cache_path(
            Vec::new(),
            Duration::from_secs(60),
            Some(cache_path.clone()),
        );

        // `take_pending_save_from_parts` is the free-function form of the
        // save-decision gate (extracted so a detached background-refresh
        // task can call it without a `&SessionIndex` borrow) -- exercised
        // here directly against the index's own (crate-private, same-module
        // accessible) fields.
        let gate = |changed: usize, debounce: Duration| {
            take_pending_save_from_parts(
                &index.persist_path,
                &index.persist_state,
                &index.file_cache,
                changed,
                debounce,
            )
        };

        let first = gate(1, Duration::from_millis(30));
        assert!(first.is_some(), "the first-ever sweep must always persist");

        let second = gate(1, Duration::from_millis(30));
        assert!(
            second.is_none(),
            "a small change within the debounce window must not re-save"
        );

        let third = gate(SAVE_CHANGED_THRESHOLD as usize, Duration::from_millis(30));
        assert!(
            third.is_some(),
            "a change at/above the threshold must save immediately"
        );

        tokio::time::sleep(Duration::from_millis(40)).await;
        let fourth = gate(1, Duration::from_millis(30));
        assert!(
            fourth.is_some(),
            "any change after the debounce window elapses must save"
        );

        tokio::time::sleep(Duration::from_millis(40)).await;
        let fifth = gate(0, Duration::from_millis(30));
        assert!(fifth.is_none(), "zero changes must never trigger a save");

        std::fs::remove_dir_all(&cache_dir).ok();
    }

    /// I. `default_persist_path()` resolves `FRESHELL_HOME` then `HOME` (the
    /// same precedence `main.rs::resolve_home` uses for the `.freshell`
    /// config dir this cache file lives beside), and returns `None` when
    /// neither is set -- disabling persistence rather than erroring.
    #[test]
    fn default_persist_path_resolves_freshell_home_then_home_then_none() {
        // Serialize env-var mutation: this is the ONLY test in this crate
        // that touches FRESHELL_HOME/HOME, so no cross-test interference is
        // possible even under the default parallel test harness.
        let prior_freshell_home = std::env::var("FRESHELL_HOME").ok();
        let prior_home = std::env::var("HOME").ok();

        std::env::set_var("FRESHELL_HOME", "/fh-home");
        std::env::set_var("HOME", "/plain-home");
        assert_eq!(
            default_persist_path(),
            Some(PathBuf::from("/fh-home/.freshell/rust-session-cache.json")),
            "FRESHELL_HOME must take precedence over HOME"
        );

        std::env::remove_var("FRESHELL_HOME");
        assert_eq!(
            default_persist_path(),
            Some(PathBuf::from(
                "/plain-home/.freshell/rust-session-cache.json"
            )),
            "HOME must be used when FRESHELL_HOME is unset"
        );

        std::env::remove_var("HOME");
        assert_eq!(
            default_persist_path(),
            None,
            "no home resolved -> persistence disabled, not an error"
        );

        match prior_freshell_home {
            Some(v) => std::env::set_var("FRESHELL_HOME", v),
            None => std::env::remove_var("FRESHELL_HOME"),
        }
        match prior_home {
            Some(v) => std::env::set_var("HOME", v),
            None => std::env::remove_var("HOME"),
        }
    }
}
