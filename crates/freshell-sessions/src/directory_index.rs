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
//! Batch B ships **claude only** (`ClaudeSource`); codex/opencode are additive
//! `SessionSource` impls deferred to Batch C.
//!
//! RED (this commit, before the production code existed): none of
//! `IndexedSession` / `SessionSource` / `ClaudeSource` / `SessionIndex` existed,
//! so this test module failed to compile.

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

/// A provider's session enumeration source (claude/codex/opencode). Batch B
/// ships [`ClaudeSource`] only; codex/opencode are additive `SessionSource`
/// impls for Batch C — [`SessionIndex`] composes any number of sources
/// without changing shape.
pub trait SessionSource: Send + Sync {
    /// Enumerate every session this provider can currently see.
    /// Corruption-tolerant (mirrors each provider's per-file
    /// skip-on-unreadable-or-cwd-less discovery rule) — never panics.
    fn scan(&self) -> Vec<IndexedSession>;
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
}

impl SessionSource for ClaudeSource {
    fn scan(&self) -> Vec<IndexedSession> {
        scan_claude_home(&self.claude_home)
    }
}

fn scan_claude_home(claude_home: &Path) -> Vec<IndexedSession> {
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

/// The cached, TTL-refreshed session index composed from one or more
/// [`SessionSource`]s.
///
/// * The cheap path (fresh cache) never touches `.await` while holding the
///   `std::sync::Mutex` guard — the guard is dropped before any lock is even
///   contended, so it can never be held across an await point.
/// * A stale/absent cache serializes its refresh through a `tokio::sync::Mutex`:
///   the first task to arrive does the scan; every other concurrent caller
///   blocks on that same async lock and then re-checks freshness
///   (double-checked locking) instead of scanning again — N concurrent misses
///   produce exactly 1 scan (B-T5).
/// * The scan itself (`build_snapshot`) runs inside `spawn_blocking`: the
///   `Vec<Arc<dyn SessionSource>>` handle is MOVED into the blocking closure
///   (an `Arc` refcount bump, not a deep clone of any scanned data — the
///   scanned `Vec<IndexedSession>` itself is never cloned, only moved back out
///   as the task's return value), so a multi-second full sweep never blocks
///   the async executor or any other in-flight request.
pub struct SessionIndex {
    sources: Vec<Arc<dyn SessionSource>>,
    ttl: Duration,
    snapshot: StdMutex<Option<CachedSnapshot>>,
    refresh_lock: AsyncMutex<()>,
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
        }
    }

    /// Return a fresh snapshot, pre-sorted `lastActivityAt` DESC then `key()`
    /// DESC (`projection.ts:51-62`'s comparator, applied once here instead of
    /// once per request). Rebuilds via `spawn_blocking` when the cached
    /// snapshot is stale or absent.
    pub async fn snapshot(&self) -> Arc<Vec<IndexedSession>> {
        if let Some(items) = self.fresh_cached() {
            return items;
        }
        // Serialize refreshes: only one concurrent caller actually scans.
        let _guard = self.refresh_lock.lock().await;
        // Double-checked: another task may have refreshed while we waited.
        if let Some(items) = self.fresh_cached() {
            return items;
        }
        let sources = self.sources.clone(); // Vec<Arc<_>>: refcount bumps only.
        let items = tokio::task::spawn_blocking(move || build_snapshot(&sources))
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

/// Scan every source and sort the combined result — the ONE sort per
/// snapshot rebuild (not once per request).
fn build_snapshot(sources: &[Arc<dyn SessionSource>]) -> Vec<IndexedSession> {
    let mut items: Vec<IndexedSession> = sources.iter().flat_map(|s| s.scan()).collect();
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

    /// A `SessionSource` that counts how many times `scan()` actually ran (the
    /// TTL/serialization tests assert on this count, never on wall-clock timing
    /// -- deterministic, no flakiness).
    struct CountingSource {
        calls: Arc<AtomicUsize>,
        items: Vec<IndexedSession>,
    }

    impl SessionSource for CountingSource {
        fn scan(&self) -> Vec<IndexedSession> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.items.clone()
        }
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

    // ── B-T9 (perf, ignored by default): warm sweep of 6k synthetic claude
    // session files completes in <500ms. Run explicitly:
    //   cargo test -p freshell-sessions -- --ignored --nocapture directory_index
    // The cold build of the 6k-file synthetic home is deliberately UNTIMED
    // (the assertion is on the scan, not on `mkfs`); the FIRST `scan()` call
    // warms the OS page/dentry cache (also untimed) and the SECOND is what's
    // measured, matching how a long-running server sees repeat requests.

    #[test]
    #[ignore]
    fn claude_source_warm_sweep_of_6k_files_completes_under_500ms() {
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

        let source = ClaudeSource::new(claude_home.clone());
        let warm_up = source.scan();
        assert_eq!(warm_up.len(), 6000, "sanity: every synthetic file indexed");

        let start = std::time::Instant::now();
        let items = source.scan();
        let elapsed = start.elapsed();
        assert_eq!(items.len(), 6000);
        eprintln!("B-T9: warm sweep of 6000 claude files took {elapsed:?}");
        assert!(
            elapsed < Duration::from_millis(500),
            "warm sweep of 6000 files took {elapsed:?}, expected <500ms"
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
