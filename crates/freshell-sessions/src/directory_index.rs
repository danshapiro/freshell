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
use crate::{parse_session_content, ParseSessionOptions};

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
#[derive(Debug, Clone, PartialEq)]
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
    Some(item_from_meta(&meta, "claude", &fallback, force_subagent))
}

fn item_from_meta(
    meta: &ParsedSessionMeta,
    provider: &str,
    fallback_session_id: &str,
    force_subagent: bool,
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
    }
}

/// One cached file's parse result, keyed by its absolute path in
/// [`SessionIndex`]'s `file_cache`. `item: None` caches a file that was
/// parsed and EXCLUDED (e.g. the R10b cwd-less rule) — so an excluded file is
/// stat'd every sweep but never re-parsed unless it actually changes.
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
/// * A stale/absent cache serializes its refresh through a `tokio::sync::Mutex`:
///   the first task to arrive does the refresh; every other concurrent caller
///   blocks on that same async lock and then re-checks freshness
///   (double-checked locking) instead of refreshing again — N concurrent
///   misses produce exactly 1 refresh sweep (B-T5).
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
    snapshot: StdMutex<Option<CachedSnapshot>>,
    refresh_lock: AsyncMutex<()>,
    file_cache: Arc<StdMutex<HashMap<PathBuf, FileEntry>>>,
}

struct CachedSnapshot {
    items: Arc<Vec<IndexedSession>>,
    fetched_at: Instant,
}

impl SessionIndex {
    pub fn new(sources: Vec<Arc<dyn SessionSource>>) -> Self {
        Self::with_ttl(sources, DEFAULT_TTL)
    }

    pub fn with_ttl(sources: Vec<Arc<dyn SessionSource>>, ttl: Duration) -> Self {
        Self {
            sources,
            ttl,
            snapshot: StdMutex::new(None),
            refresh_lock: AsyncMutex::new(()),
            file_cache: Arc::new(StdMutex::new(HashMap::new())),
        }
    }

    /// Return a fresh snapshot, pre-sorted `lastActivityAt` DESC then `key()`
    /// DESC (`projection.ts:51-62`'s comparator, applied once here instead of
    /// once per request). Rebuilds via `spawn_blocking` when the cached
    /// snapshot is stale or absent — and that rebuild is incremental (see
    /// [`refresh_snapshot`]), not a full re-parse.
    pub async fn snapshot(&self) -> Arc<Vec<IndexedSession>> {
        if let Some(items) = self.fresh_cached() {
            return items;
        }
        // Serialize refreshes: only one concurrent caller actually sweeps.
        let _guard = self.refresh_lock.lock().await;
        // Double-checked: another task may have refreshed while we waited.
        if let Some(items) = self.fresh_cached() {
            return items;
        }
        let sources = self.sources.clone(); // Vec<Arc<_>>: refcount bumps only.
        let file_cache = Arc::clone(&self.file_cache);
        let items = tokio::task::spawn_blocking(move || {
            let mut cache = file_cache.lock().unwrap();
            refresh_snapshot(&sources, &mut cache)
        })
        .await
        .unwrap_or_default();
        let items = Arc::new(items);
        {
            let mut guard = self.snapshot.lock().unwrap();
            *guard = Some(CachedSnapshot {
                items: Arc::clone(&items),
                fetched_at: Instant::now(),
            });
        } // guard dropped here — never held across an .await.
        items
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

    /// Populate the cache once, eagerly. Call from `main.rs` via
    /// `tokio::spawn` at boot so the first real request never pays the cold
    /// full-sweep cost — cheap for a small home, and the sweep already runs
    /// off the executor thread, so it never delays serving other requests.
    pub async fn warm(&self) {
        let _ = self.snapshot().await;
    }
}

/// One incremental refresh sweep across all sources:
///
/// 1. `discover()` the current `(path, mtime, size)` set per source — stat
///    only, no parsing.
/// 2. Re-`parse()` ONLY a file that's new or whose `mtime`/`size` changed
///    since the cached [`FileEntry`]; reuse the cached entry (including a
///    cached EXCLUSION, `item: None`) for everything else.
/// 3. Prune `cache` entries for paths no longer discovered (deleted files).
/// 4. Rebuild + re-sort the combined snapshot from the (now up-to-date)
///    cache — the ONE sort per sweep (not once per request), over
///    already-parsed data, no disk I/O.
///
/// A sweep over N unchanged files costs N stats, not N parses — this is what
/// fixes the "5s problem returns after 1s TTL" regression the FIRST shipped
/// version of this module had (see the module doc comment).
fn refresh_snapshot(
    sources: &[Arc<dyn SessionSource>],
    cache: &mut HashMap<PathBuf, FileEntry>,
) -> Vec<IndexedSession> {
    let mut discovered: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();

    for source in sources {
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
    items.sort_by(|a, b| {
        b.last_activity_at
            .cmp(&a.last_activity_at)
            .then_with(|| b.key().cmp(&a.key()))
    });
    items
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

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

    /// Wraps any `SessionSource`, counting `discover()` and `parse()` calls
    /// separately. `discover_calls` proves TTL/serialization behavior at the
    /// sweep level (one discover per refresh); `parse_calls` is the
    /// incremental-cache guard -- an unchanged (or cached-excluded) file must
    /// never increment it again after its first sweep.
    struct CountingWrapper<S: SessionSource> {
        inner: S,
        discover_calls: Arc<AtomicUsize>,
        parse_calls: Arc<AtomicUsize>,
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

    // ── B-T4: after TTL expiry, the next snapshot() call rescans ──

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
        let _ = index.snapshot().await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "a stale snapshot must trigger exactly one more scan"
        );
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
            inner: ClaudeSource::new(claude_home.clone()),
            discover_calls: Arc::new(AtomicUsize::new(0)),
            parse_calls: Arc::clone(&parse_calls),
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

        let snap2 = index.snapshot().await;
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
            inner: ClaudeSource::new(claude_home.clone()),
            discover_calls: Arc::new(AtomicUsize::new(0)),
            parse_calls: Arc::clone(&parse_calls),
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
            inner: ClaudeSource::new(claude_home.clone()),
            discover_calls: Arc::new(AtomicUsize::new(0)),
            parse_calls: Arc::clone(&parse_calls),
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

        let snap2 = index.snapshot().await;
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
            inner: ClaudeSource::new(claude_home.clone()),
            discover_calls: Arc::new(AtomicUsize::new(0)),
            parse_calls: Arc::clone(&parse_calls),
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

        let snap2 = index.snapshot().await;
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
            inner: ClaudeSource::new(claude_home.clone()),
            discover_calls: Arc::new(AtomicUsize::new(0)),
            parse_calls: Arc::clone(&parse_calls),
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
}
