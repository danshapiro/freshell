//! Antigravity CLI session source: the `SessionSource` behind the
//! `antigravity` provider's native history rows.
//!
//! REAL-BINARY record contract (corrected 2026-11-02 against real agy
//! 1.2.11 + 1.4.12 transcripts; evidence:
//! `.worktrees/.the-usual-logs/antigravity-transcript-validation/reports/
//! real-binary-transcript-evidence.md`): the transcript PATH
//! (`<antigravity_home>/brain/<conversationId>/.system_generated/logs/transcript.jsonl`)
//! and the home resolution (`FRESHELL_ANTIGRAVITY_HOME` else
//! `<home>/.gemini/antigravity-cli`, applied ONLY at the wiring seams —
//! see [`crate::provider_layout::antigravity_home`]) are
//! documented+probe-validated facts, and the on-disk RECORD SCHEMA surfaced by
//! [`crate::parse::parse_antigravity_session_content`] is the corrected
//! real-binary contract. Real records carry no workspace evidence, so real
//! conversations index with cwd `None` (project "unknown") — the cwd GATE is
//! deliberately GONE (it excluded every real conversation); the
//! fake-contract `session_start` anchor supplies cwd for fake-driven tests
//! when present.
//!
//! Own-file module (the [`crate::amplifier`] pattern): the source reuses
//! the `pub` `SessionSource`/`FileStat`/`IndexedSession` contract and the
//! `pub(crate)` checked-root helper [`crate::directory_index::open_root_dir`]
//! — never `directory_index.rs`'s private internals. Deliberately NOT in
//! `directory_index.rs` so this file's history stays disjoint from that
//! file's cache-persistence internals.
//!
//! Store-safety rules pinned here (plan Global Constraints):
//! - READ-ONLY: this module never mutates provider data.
//! - `cache/last_conversations.json` is never a session source: discovery
//!   only accepts the [`crate::provider_layout::AntigravityLayout::qualifies`]
//!   transcript shape, so cache churn can never surface or resurrect a row.
//! - Absence is never silent: every `parse` that yields no row (unreadable
//!   file, a path without the `brain/<id>` conversation directory, no
//!   parseable records) emits a JSONL
//!   `antigravity_parse_failed {path, error}` warn event (the server's
//!   `logging::JsonLayer` renders it as one JSONL line) — a row dropping
//!   out of the index between sweeps is always attributable in the logs.

use std::path::{Path, PathBuf};

use crate::directory_index::{FileStat, IndexedSession, SessionSource};
use crate::parse::parse_antigravity_session_content;
use crate::provider_layout::{AntigravityLayout, ProviderLayout};

/// The `antigravity` provider's session source.
///
/// `antigravity_home` is the ALREADY-RESOLVED antigravity home (the
/// `antigravity-cli` subtree — the composition root applies
/// [`crate::provider_layout::antigravity_home`] at its wiring seams; this
/// source joins `brain` itself, exactly as `CodexSource` joins `sessions`
/// and `AmplifierSource` joins `projects`).
pub struct AntigravitySource {
    antigravity_home: PathBuf,
}

impl AntigravitySource {
    pub fn new(antigravity_home: PathBuf) -> Self {
        Self { antigravity_home }
    }

    /// Convenience: discover + parse every currently-visible transcript in
    /// one call, ignoring any incremental cache. Test/perf use only —
    /// mirrors `ClaudeSource::scan()`/`AmplifierSource::scan()`.
    pub fn scan(&self) -> Vec<IndexedSession> {
        self.discover()
            .into_iter()
            .filter_map(|stat| self.parse(&stat.path))
            .collect()
    }
}

impl SessionSource for AntigravitySource {
    fn discover(&self) -> Vec<FileStat> {
        self.discover_checked().unwrap_or_default()
    }

    fn parse(&self, path: &Path) -> Option<IndexedSession> {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(err) => {
                parse_failed(path, format!("read failed: {err}"));
                return None;
            }
        };
        let content = String::from_utf8_lossy(&bytes).into_owned();
        let Some(conversation_id) = AntigravityLayout::conversation_id_from_path(path) else {
            parse_failed(
                path,
                "transcript path does not carry a brain/<id> conversation directory",
            );
            return None;
        };
        let meta = match parse_antigravity_session_content(&content, &conversation_id) {
            Some(meta) => meta,
            None => {
                parse_failed(path, "no parseable records (real binary vocabulary)");
                return None;
            }
        };
        // No cwd gate: the real record schema carries no workspace
        // evidence (binary v1.4.12), so real conversations index with
        // cwd None (project "unknown"); the fake contract's ownership
        // anchor supplies cwd for fake-driven tests when present.
        Some(indexed_from_meta(&meta, path))
    }

    fn provider_name(&self) -> Option<&'static str> {
        Some("antigravity")
    }

    /// Root-listing failure propagation: an unlistable
    /// `<antigravity_home>/brain` (EACCES/EIO — not a merely-absent one) is
    /// a recorded scan failure, never a silent empty listing. SINGLE-PASS:
    /// the same `read_dir` handle that fails here is the one the traversal
    /// consumes (no disposable preflight, no TOCTOU window), and root
    /// iterator-entry errors propagate too. Nested-directory errors stay
    /// tolerant via [`walk_transcripts_recursive`] (the codex/amplifier
    /// model).
    fn discover_checked(&self) -> Result<Vec<FileStat>, std::io::Error> {
        let root = AntigravityLayout.session_root(&self.antigravity_home);
        let Some(entries) = crate::directory_index::open_root_dir(&root)? else {
            return Ok(Vec::new());
        };
        let mut paths: Vec<PathBuf> = Vec::new();
        for entry in entries {
            paths.push(entry?.path());
        }
        paths.sort(); // determinism (readdir order is filesystem-dependent)
        let mut stats = Vec::new();
        for path in paths {
            walk_transcripts_recursive(&path, &mut stats);
        }
        Ok(stats)
    }
}

/// Recursively stat every qualifying transcript under `dir`, sorted (per
/// directory level) for determinism. The [`AntigravityLayout::qualifies`]
/// shape check is the single path authority — the same predicate the
/// watcher routes events through — so a stray `transcript.jsonl` at the
/// wrong depth, a `notes.md` sidecar, or `cache/last_conversations.json`
/// is never discovered. Corruption-tolerant (an unreadable directory
/// yields fewer entries, never panics).
///
/// Local sibling of `directory_index.rs`'s private `walk_jsonl_recursive`
/// (codex's `.jsonl` walk): that helper is file-private and
/// `directory_index.rs` is deliberately not edited by the antigravity
/// addition (the amplifier.rs precedent duplicates its stat helper for the
/// same reason); the difference here is the qualifies filter, which the
/// codex walk does not need.
fn walk_transcripts_recursive(dir: &Path, out: &mut Vec<FileStat>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort(); // determinism (readdir order is filesystem-dependent)
    for path in paths {
        if path.is_dir() {
            walk_transcripts_recursive(&path, out);
        } else if AntigravityLayout.qualifies(&path) {
            if let Some(stat) = stat_transcript(&path) {
                out.push(stat);
            }
        }
    }
}

/// `fs::metadata` a single transcript into a [`FileStat`], `None` on any
/// stat failure — same tolerance as `directory_index.rs`'s private
/// `stat_file`, duplicated here (not imported) since that helper isn't
/// `pub(crate)` (the `amplifier.rs::stat_metadata_file` precedent).
fn stat_transcript(path: &Path) -> Option<FileStat> {
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

/// The JSONL `antigravity_parse_failed {path, error}` warn event: absence is
/// never silent. Emitted on EVERY `parse` that yields no row — an
/// unreadable file, a path without the `brain/<id>` conversation
/// directory, or a transcript with no parseable records — so a
/// discovered conversation dropping out of the index between sweeps is
/// always attributable in the server's JSONL log. Bounded by the
/// incremental cache (a cached exclusion is never re-parsed), so this
/// fires per change, never per sweep.
fn parse_failed(path: &Path, error: impl std::fmt::Display) {
    tracing::warn!(
        event = "antigravity_parse_failed",
        path = %path.display(),
        error = %error,
        "antigravity transcript yielded no session row; it is excluded until the next successful sweep"
    );
}

/// Map the parser's [`crate::meta::ParsedSessionMeta`] into the
/// `antigravity` provider's [`IndexedSession`].
///
/// Local mirror of `directory_index.rs`'s private `item_from_meta` (the
/// claude/codex mapper — git-root-resolved `project_path`, raw `cwd`
/// retained for display/resume): that helper is file-private and
/// `directory_index.rs` is deliberately not edited by the antigravity
/// addition, the same reason `amplifier.rs` keeps its own
/// `indexed_from_meta`.
///
/// Reachability note: `meta.session_id` is `Some` here by the parser's
/// contract (it returns `None` when no recognized record parses — pinned
/// by `parse::antigravity`'s tests); the `unwrap_or_default` is a
/// defensive fallback, never a reachable path.
fn indexed_from_meta(meta: &crate::meta::ParsedSessionMeta, path: &Path) -> IndexedSession {
    // Session transcripts record the checkout as `cwd` when the format
    // carries one (the fake contract's ownership anchor). The REAL binary
    // format carries no workspace evidence (binary v1.4.12), so real rows
    // group under "unknown". For a linked git
    // worktree, the sidebar's project grouping follows the common
    // repository root (the same resolver `item_from_meta` uses).
    let project_path = meta
        .cwd
        .as_deref()
        .and_then(freshell_platform::git_meta::resolve_git_repo_root)
        .unwrap_or_else(|| meta.cwd.clone().unwrap_or_else(|| "unknown".to_string()));
    IndexedSession {
        session_id: meta.session_id.clone().unwrap_or_default(),
        legacy_session_id: None,
        provider: "antigravity".to_string(),
        project_path,
        title: meta.title.clone(),
        title_provider_generated: meta.title_provider_generated,
        summary: meta.summary.clone(),
        first_user_message: meta.first_user_message.clone(),
        title_source: meta.title_source.clone(),
        last_activity_at: meta.last_activity_at.unwrap_or(0).max(0),
        created_at: meta.created_at,
        cwd: meta.cwd.clone(),
        git_branch: meta.git_branch.clone(),
        is_subagent: meta.is_subagent.unwrap_or(false),
        is_non_interactive: meta.is_non_interactive.unwrap_or(false),
        // The transcript path rides on the row so the file-tier search
        // (`search_session_file` through the `antigravity` arm) can read
        // it; `None` would make the row un-searchable at the
        // userMessages/fullText tiers with no error.
        source_file: Some(path.to_path_buf()),
        token_usage: meta.token_usage.clone(),
    }
}

#[cfg(test)]
mod tests {
    use crate::antigravity::AntigravitySource;
    use crate::directory_index::{IndexedSession, SessionIndex, SessionSource};
    use crate::meta::TokenSummary;
    use crate::session_watcher::{SessionWatcher, WatchEvent, WatchKind, WatchedProvider};
    use std::collections::BTreeMap;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::Duration;

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    fn unique_temp_dir(label: &str) -> PathBuf {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let dir = std::env::temp_dir().join(format!(
            "freshell-antigravity-test-{label}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn fixture_content(name: &str) -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/coding-cli/antigravity")
            .join(name);
        std::fs::read_to_string(&path).unwrap()
    }

    /// Write `<home>/brain/<conv_id>/.system_generated/logs/transcript.jsonl`
    /// and return the transcript path (the canonical store shape).
    fn write_transcript(home: &Path, conv_id: &str, content: &str) -> PathBuf {
        let dir = home
            .join("brain")
            .join(conv_id)
            .join(".system_generated")
            .join("logs");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("transcript.jsonl");
        std::fs::write(&path, content).unwrap();
        path
    }

    fn test_index(source: AntigravitySource) -> Arc<SessionIndex> {
        Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(source) as Arc<dyn SessionSource>],
            // A long TTL: only the dirty-mark (the watcher's entry point)
            // drives the refreshes below, never TTL expiry.
            Duration::from_secs(3600),
            None, // no persistence: isolated, deterministic
        ))
    }

    /// Poll the index's (stale-while-revalidate) snapshot until `predicate`
    /// holds over the materialized rows, bounded by `deadline_secs` — the
    /// fresh generation lands on a later snapshot after the detached sweep.
    async fn wait_for_rows(
        index: &Arc<SessionIndex>,
        deadline_secs: u64,
        predicate: impl Fn(&[IndexedSession]) -> bool,
    ) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(deadline_secs);
        loop {
            let snapshot = index.snapshot().await;
            if predicate(&snapshot) {
                return true;
            }
            if std::time::Instant::now() > deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }

    const FRESH_CONV: &str = "11111111-2222-3333-4444-555555555555";
    const RESUMED_CONV: &str = "22222222-3333-4444-5555-666666666666";

    // ── discover/parse: the canonical store shape ──

    #[test]
    fn antigravity_source_discovers_and_parses_transcripts() {
        let home = unique_temp_dir("discover-parse");
        let fresh_path =
            write_transcript(&home, FRESH_CONV, &fixture_content("fresh.sanitized.jsonl"));
        let resumed_path = write_transcript(
            &home,
            RESUMED_CONV,
            &fixture_content("resumed.sanitized.jsonl"),
        );
        let source = AntigravitySource::new(home.clone());

        let discovered = source.discover();
        assert_eq!(
            discovered
                .iter()
                .map(|stat| stat.path.clone())
                .collect::<Vec<_>>(),
            vec![fresh_path.clone(), resumed_path.clone()],
            "both transcripts discovered, sorted for determinism"
        );
        assert_eq!(
            discovered[0].size,
            fixture_content("fresh.sanitized.jsonl").len() as u64
        );

        let fresh = source.parse(&fresh_path).expect("fresh fixture parses");
        assert_eq!(fresh.provider, "antigravity");
        // The DIRECTORY id is the row's identity (real records carry no
        // id field — binary v1.4.12); real records carry no workspace
        // evidence, so cwd is None and the row groups under "unknown".
        assert_eq!(fresh.session_id, FRESH_CONV);
        assert_eq!(fresh.cwd, None);
        assert_eq!(fresh.project_path, "unknown");
        assert_eq!(fresh.title.as_deref(), Some("Fix the flaky test"));
        assert!(!fresh.title_provider_generated);
        assert_eq!(fresh.title_source, None);
        assert_eq!(
            fresh.first_user_message.as_deref(),
            Some("Fix the flaky test")
        );
        assert_eq!(fresh.summary.as_deref(), Some("Fixed the test."));
        assert_eq!(fresh.created_at, Some(1_793_304_001_000));
        assert_eq!(fresh.last_activity_at, 1_793_304_005_000);
        assert_eq!(
            fresh.token_usage,
            Some(TokenSummary {
                input_tokens: 10,
                output_tokens: 20,
                cached_tokens: 0,
                total_tokens: 30,
                context_tokens: None,
                model_context_window: None,
                compact_threshold_tokens: None,
                compact_percent: None,
            })
        );
        assert_eq!(fresh.source_file.as_deref(), Some(fresh_path.as_path()));
        assert_eq!(fresh.key(), format!("antigravity:{FRESH_CONV}"));
        assert!(!fresh.is_subagent);
        assert!(!fresh.is_non_interactive);
        assert_eq!(fresh.legacy_session_id, None);
        assert_eq!(fresh.git_branch, None);

        // The resumed conversation keeps its OWN directory identity and
        // the FIRST user message (never the post-restart one), with the
        // LAST token-bearing record's usage (turn 2's — the documented
        // per-turn reading; turn 1's 15/25 never survives).
        let resumed = source.parse(&resumed_path).expect("resumed fixture parses");
        assert_eq!(resumed.session_id, RESUMED_CONV);
        assert_eq!(resumed.cwd, None);
        assert_eq!(
            resumed.first_user_message.as_deref(),
            Some("First prompt before exit")
        );
        assert_eq!(
            resumed.token_usage,
            Some(TokenSummary {
                input_tokens: 40,
                output_tokens: 5,
                cached_tokens: 2,
                total_tokens: 45,
                context_tokens: None,
                model_context_window: None,
                compact_threshold_tokens: None,
                compact_percent: None,
            })
        );
        assert_eq!(resumed.created_at, Some(1_793_307_601_000));
        assert_eq!(resumed.last_activity_at, 1_793_469_604_000);

        assert_eq!(source.scan().len(), 2, "scan composes the two rows");
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn antigravity_source_ignores_cache_and_wrong_depth_transcripts() {
        let home = unique_temp_dir("non-qualifying");
        let valid = write_transcript(&home, FRESH_CONV, &fixture_content("fresh.sanitized.jsonl"));
        // The cache file is NEVER a session source (plan Global
        // Constraint: neither complete nor identity evidence).
        std::fs::create_dir_all(home.join("cache")).unwrap();
        std::fs::write(
            home.join("cache/last_conversations.json"),
            r#"{"11111111-2222-3333-4444-555555555555":{}}"#,
        )
        .unwrap();
        // Wrong-depth transcripts and sidecars never qualify.
        std::fs::create_dir_all(
            home.join("brain")
                .join("conv-x")
                .join(".system_generated")
                .join("logs")
                .join("sub"),
        )
        .unwrap();
        std::fs::write(
            home.join("brain/conv-x/.system_generated/logs/sub/transcript.jsonl"),
            fixture_content("fresh.sanitized.jsonl"),
        )
        .unwrap();
        std::fs::write(home.join("brain/conv-x/transcript.jsonl"), "irrelevant").unwrap();
        std::fs::write(home.join("brain/conv-x/notes.md"), "irrelevant").unwrap();

        let source = AntigravitySource::new(home.clone());
        let discovered = source.discover();
        assert_eq!(
            discovered.iter().map(|stat| stat.path.clone()).collect::<Vec<_>>(),
            vec![valid],
            "only the canonical brain/<id>/.system_generated/logs/transcript.jsonl shape is discovered"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn zero_record_transcripts_are_excluded_but_a_system_only_transcript_stays() {
        let home = unique_temp_dir("zero-turn");
        let _empty = write_transcript(&home, "conv-empty", "");
        let _garbage = write_transcript(&home, "conv-garbage", "not json\n{oops");
        // The zero-turn fixture: a SYSTEM_MESSAGE-only real-shaped
        // transcript (no user record yet) — the row STAYS with an empty
        // first message and no cwd (real records carry no workspace
        // evidence — the fake-contract anchor supplies one only when
        // present, and this fixture carries none).
        let _zero = write_transcript(
            &home,
            "55555555-6666-7777-8888-999999999999",
            &fixture_content("zero-turn.sanitized.jsonl"),
        );

        let source = AntigravitySource::new(home.clone());
        let items = source.scan();
        assert_eq!(items.len(), 1, "only the parseable transcript is indexed");
        let row = &items[0];
        assert_eq!(row.session_id, "55555555-6666-7777-8888-999999999999");
        assert_eq!(row.cwd, None);
        assert_eq!(row.project_path, "unknown");
        assert_eq!(
            row.first_user_message, None,
            "no user message yet — stays indexed"
        );
        assert_eq!(row.title, None, "no user message ⇒ no derived title");
        assert_eq!(row.token_usage, None);
        let _ = std::fs::remove_dir_all(&home);
    }

    // ── discover_checked: honest emptiness vs scan failure ──

    #[test]
    fn missing_root_is_genuinely_empty_and_unlistable_root_is_a_scan_failure() {
        let source = AntigravitySource::new(unique_temp_dir("missing-home"));
        assert!(source
            .discover_checked()
            .expect("a missing antigravity home is a genuine empty")
            .is_empty());

        let home = unique_temp_dir("missing-brain");
        std::fs::create_dir_all(&home).unwrap(); // home exists, brain does not
        let source = AntigravitySource::new(home.clone());
        assert!(source
            .discover_checked()
            .expect("a missing brain root is a genuine empty")
            .is_empty());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let brain = home.join("brain");
            std::fs::create_dir_all(&brain).unwrap();
            std::fs::set_permissions(&brain, std::fs::Permissions::from_mode(0o000)).unwrap();
            if std::fs::read_dir(&brain).is_ok() {
                // Privileged euid fallback (directory_index.rs's unlistable
                // tests share this guard): a 0o000 dir IS listable as root.
                eprintln!("skipping unlistable-root assertions: euid can list a 0o000 dir");
            } else {
                let err = source
                    .discover_checked()
                    .expect_err("an unlistable brain root must propagate as a scan failure");
                assert!(
                    matches!(err.kind(), std::io::ErrorKind::PermissionDenied),
                    "unexpected error kind: {err:?}"
                );
            }
            std::fs::set_permissions(&brain, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    // ── store-root resolution through the wiring seam (round 7, Major 2) ──

    /// A HOME whose ONLY antigravity store is the SNAP layout root
    /// (`<home>/snap/antigravity-cli/common/.gemini/antigravity-cli` —
    /// the probed real-snap-install layout: snap confinement pins the
    /// CLI's HOME to `~/snap/antigravity-cli/common`, receipts in the
    /// plan's Provider Contract Record) still yields discovered
    /// sessions: the source is constructed exactly the way the server's
    /// wiring seam constructs it (`AntigravitySource::new(
    /// antigravity_home(home))`), so the snap fallback inside the
    /// resolution is what makes the rows appear. Pre-round-7 the seam
    /// resolved only `<home>/.gemini/antigravity-cli` and a snap-only
    /// machine silently listed NOTHING.
    #[test]
    fn snap_layout_store_is_discovered_through_the_home_seam() {
        let home = unique_temp_dir("snap-seam");
        let snap_store = home
            .join("snap")
            .join("antigravity-cli")
            .join("common")
            .join(".gemini")
            .join("antigravity-cli");
        let transcript = write_transcript(
            &snap_store,
            FRESH_CONV,
            &fixture_content("fresh.sanitized.jsonl"),
        );
        // The wiring seam's exact composition — the resolution decides
        // the root, the source only joins `brain`.
        let resolved = crate::provider_layout::antigravity_home(&home);
        assert_eq!(
            resolved, snap_store,
            "the seam resolves the snap store when it is the only conversation-bearing root"
        );
        let source = AntigravitySource::new(resolved);
        let items = source.scan();
        assert_eq!(
            items.len(),
            1,
            "the snap-layout store's conversation is discovered through the seam"
        );
        assert_eq!(
            items[0].session_id, FRESH_CONV,
            "the snap store's own conversation id is the row's identity"
        );
        assert_eq!(items[0].source_file.as_deref(), Some(transcript.as_path()));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Both candidate roots absent → the seam resolves the DEFAULT root
    /// (where a non-snap CLI writes) and discovery is an HONEST empty —
    /// and the resolved root is announced/logged (the absence warn is
    /// pinned in `provider_layout::antigravity_home_tests`).
    #[test]
    fn both_roots_absent_resolves_the_default_root_and_discovers_an_honest_empty() {
        let home = unique_temp_dir("both-absent-seam");
        let resolved = crate::provider_layout::antigravity_home(&home);
        assert_eq!(
            resolved,
            home.join(".gemini").join("antigravity-cli"),
            "both roots absent resolves the default path"
        );
        let source = AntigravitySource::new(resolved);
        assert!(
            source
                .discover_checked()
                .expect("a missing antigravity home is a genuine empty")
                .is_empty(),
            "an absent store is an honest empty, never an error"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // ── SessionIndex integration: prune, truncated tail, honest drop ──

    #[tokio::test]
    async fn session_index_lists_antigravity_rows_and_prunes_on_delete() {
        let home = unique_temp_dir("index-prune");
        let path_a = write_transcript(&home, FRESH_CONV, &fixture_content("fresh.sanitized.jsonl"));
        let _path_b = write_transcript(
            &home,
            RESUMED_CONV,
            &fixture_content("resumed.sanitized.jsonl"),
        );
        let index = test_index(AntigravitySource::new(home.clone()));
        assert_eq!(index.snapshot().await.len(), 2);

        // The watcher's delete/rename entry point: mark_dirty on the gone
        // path → the scoped sweep's stat_scoped answers None → the cached
        // entry is pruned.
        std::fs::remove_file(&path_a).unwrap();
        index.mark_dirty(&[(path_a.clone(), "antigravity".to_string())]);
        assert!(
            wait_for_rows(&index, 5, |rows| rows.len() == 1).await,
            "the deleted transcript's row must be pruned; snapshot len stayed {}",
            index.snapshot().await.len()
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn mid_write_truncated_tail_keeps_the_last_valid_row() {
        let home = unique_temp_dir("truncated-tail");
        let path = write_transcript(&home, FRESH_CONV, &fixture_content("fresh.sanitized.jsonl"));
        let index = test_index(AntigravitySource::new(home.clone()));
        assert_eq!(index.snapshot().await.len(), 1);

        // A mid-write: a COMPLETE new turn lands, then the writer is cut
        // off mid-line. The re-parse must SUCCEED on the intact prefix
        // (the parser skips the truncated tail) — the row survives with
        // FRESH content, not via any preserve-on-error rule. The appended
        // records are real-shaped (binary v1.4.12 vocabulary: step_index
        // + second-granularity created_at).
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(
            br#"{"type":"USER_INPUT","source":"USER_EXPLICIT","status":"DONE","step_index":2,"created_at":"2026-10-29T20:30:00Z","content":"Mid-write addition"}
"#,
        )
        .unwrap();
        file.write_all(
            br#"{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":3,"created_at":"2026-10-29T20:30:01Z","content":"Mid-write reply."}
"#,
        )
        .unwrap();
        file.write_all(
            br#"{"type":"PLANNER_RESPONSE","source":"MODEL","status":"DONE","step_index":4,"#,
        )
        .unwrap(); // truncated mid-write tail, no closing quote/brace
        drop(file);

        index.mark_dirty(&[(path.clone(), "antigravity".to_string())]);
        let refreshed = wait_for_rows(&index, 5, |rows| {
            rows.iter().any(|row| {
                row.session_id == FRESH_CONV && row.last_activity_at == 1_793_305_801_000
            })
        })
        .await;
        assert!(
            refreshed,
            "the truncated tail must not drop the row: the intact prefix re-parses \
             (row: {:?})",
            index
                .snapshot()
                .await
                .iter()
                .map(|r| (r.session_id.clone(), r.last_activity_at))
                .collect::<Vec<_>>()
        );
        let snapshot = index.snapshot().await;
        let row = snapshot
            .iter()
            .find(|row| row.session_id == FRESH_CONV)
            .expect("the row survived the mid-write tail");
        assert_eq!(
            row.first_user_message.as_deref(),
            Some("Fix the flaky test")
        );
        assert_eq!(row.last_activity_at, 1_793_305_801_000);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn unparseable_transcript_drops_the_row_but_a_real_shaped_one_without_cwd_stays() {
        let home = unique_temp_dir("honest-drop");
        let path_a = write_transcript(&home, FRESH_CONV, &fixture_content("fresh.sanitized.jsonl"));
        write_transcript(
            &home,
            RESUMED_CONV,
            &fixture_content("resumed.sanitized.jsonl"),
        );
        let index = test_index(AntigravitySource::new(home.clone()));
        assert_eq!(index.snapshot().await.len(), 2);

        // A rewrite with NO parseable records (garbage only — nothing in
        // the real binary vocabulary): the parse yields None and the row
        // DOES drop — the same honest behavior class as claude/codex,
        // never a silent stale ghost.
        std::fs::write(&path_a, "totally not json garbage\n{oops\n").unwrap();
        index.mark_dirty(&[(path_a.clone(), "antigravity".to_string())]);
        assert!(
            wait_for_rows(&index, 5, |rows| rows.len() == 1).await,
            "an unparseable transcript must drop its row; snapshot len stayed {}",
            index.snapshot().await.len()
        );

        // The cwd gate is GONE (real records carry no workspace evidence
        // — binary v1.4.12): a real-shaped transcript with NO ownership
        // record indexes with cwd None and project_path "unknown".
        let snapshot = index.snapshot().await;
        let row = snapshot
            .iter()
            .find(|row| row.session_id == RESUMED_CONV)
            .expect("the cwd-less real-shaped row stays indexed");
        assert_eq!(row.cwd, None);
        assert_eq!(row.project_path, "unknown");
        let _ = std::fs::remove_dir_all(&home);
    }

    // ── absence is never silent: the antigravity_parse_failed event ──

    /// Every `parse` that yields no row must emit a JSONL
    /// `antigravity_parse_failed {path, error}` warn event — and a
    /// mid-write truncated tail (whose intact prefix parses) must NOT.
    ///
    /// The tracing callsite interest cache is process-wide, and this
    /// crate's other tests fire the same parse callsite without a
    /// subscriber; isolate the capture in a child process exactly like
    /// `codex_history_tests::warns_once_for_a_failure_and_rearms_after_recovery`.
    #[test]
    fn parse_failures_emit_antigravity_parse_failed_events() {
        const CHILD_ENV: &str = "FRESHELL_ANTIGRAVITY_LOG_CAPTURE_CHILD";
        if std::env::var_os(CHILD_ENV).is_none() {
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "antigravity::tests::parse_failures_emit_antigravity_parse_failed_events",
                    "--nocapture",
                ])
                .env(CHILD_ENV, "1")
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "isolated parse-failure capture failed: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            return;
        }

        use tracing_subscriber::layer::SubscriberExt;
        #[derive(Clone)]
        struct Capture(Arc<StdMutex<Vec<BTreeMap<String, String>>>>);
        impl<S: tracing::Subscriber> tracing_subscriber::layer::Layer<S> for Capture {
            fn on_event(
                &self,
                event: &tracing::Event<'_>,
                _: tracing_subscriber::layer::Context<'_, S>,
            ) {
                struct Fields(BTreeMap<String, String>);
                impl tracing::field::Visit for Fields {
                    fn record_debug(
                        &mut self,
                        field: &tracing::field::Field,
                        value: &dyn std::fmt::Debug,
                    ) {
                        self.0.insert(field.name().into(), format!("{value:?}"));
                    }
                    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                        self.0.insert(field.name().into(), value.into());
                    }
                }
                let mut fields = Fields(BTreeMap::new());
                event.record(&mut fields);
                if event.metadata().level() == &tracing::Level::WARN
                    && fields.0.get("event").map(String::as_str) == Some("antigravity_parse_failed")
                {
                    self.0.lock().unwrap().push(fields.0);
                }
            }
        }
        let events = Arc::new(StdMutex::new(Vec::new()));
        let subscriber = tracing_subscriber::registry().with(Capture(events.clone()));
        let _guard = tracing::subscriber::set_default(subscriber);

        let home = unique_temp_dir("parse-failed-events");
        let source = AntigravitySource::new(home.clone());

        // (1) Unreadable transcript: a directory now sits at the transcript
        // path — `fs::read` fails deterministically for ANY euid (the
        // stand-in for EACCES, which a privileged euid cannot trigger).
        let unreadable = write_transcript(&home, "conv-unreadable", "irrelevant");
        std::fs::remove_file(&unreadable).unwrap();
        std::fs::create_dir(&unreadable).unwrap();
        assert!(
            source.parse(&unreadable).is_none(),
            "an unreadable transcript yields no row"
        );

        // (2) No parseable records: content outside the real binary
        // vocabulary (the old candidate record shape) parses to nothing.
        let unparseable = write_transcript(
            &home,
            "conv-unparseable",
            r#"{"type":"user_message","text":"Hi","at":"2026-10-29T20:00:01.000Z"}"#,
        );
        assert!(source.parse(&unparseable).is_none());

        // (3) A path that does not carry the brain/<id> conversation
        // directory (wrong depth): the id cannot be derived, so the row is
        // excluded before any content parse.
        let wrong_depth = home.join("brain/conv-wrong-depth/transcript.jsonl");
        std::fs::create_dir_all(wrong_depth.parent().unwrap()).unwrap();
        std::fs::write(&wrong_depth, fixture_content("fresh.sanitized.jsonl")).unwrap();
        assert!(source.parse(&wrong_depth).is_none());

        // (4) A mid-write truncated tail is NOT a parse failure: the
        // intact prefix parses and the row survives.
        let truncated = write_transcript(
            &home,
            "77777777-8888-4999-aaaa-111111111111",
            &fixture_content("malformed-tail.sanitized.jsonl"),
        );
        assert!(
            source.parse(&truncated).is_some(),
            "the malformed-tail fixture's intact prefix must parse"
        );

        let captured = events.lock().unwrap();
        assert_eq!(
            captured.len(),
            3,
            "exactly one antigravity_parse_failed event per failing parse, none for the truncated tail: {captured:?}"
        );
        for (i, event) in captured.iter().enumerate() {
            assert_eq!(event["event"], "antigravity_parse_failed");
            assert!(
                event.contains_key("path") && !event["path"].is_empty(),
                "event {i} must carry the failing path: {event:?}"
            );
            assert!(
                event.contains_key("error") && !event["error"].is_empty(),
                "event {i} must carry a non-empty error: {event:?}"
            );
        }
        assert!(captured[0]["path"].contains("conv-unreadable"));
        assert!(captured[0]["error"].contains("read failed"));
        assert!(captured[1]["path"].contains("conv-unparseable"));
        assert!(
            captured[1]["error"].contains("no parseable records"),
            "the no-parseable-records reason: {captured:?}"
        );
        assert!(captured[2]["path"].contains("conv-wrong-depth"));
        assert!(
            captured[2]["error"].contains("brain/<id> conversation directory"),
            "the conversation-directory reason: {captured:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    // ── watcher integration (session_watcher_tests.rs style) ──

    #[tokio::test]
    async fn watcher_detects_new_antigravity_transcripts_and_marks_them_dirty() {
        let home = unique_temp_dir("watcher-antigravity");
        let _first = write_transcript(&home, FRESH_CONV, &fixture_content("fresh.sanitized.jsonl"));
        // Pre-create the SECOND conversation's directory chain BEFORE the
        // watcher starts (the claude watcher-test model writes new files
        // into an already-watched directory): a directory cascade created
        // milliseconds before its file is a documented inotify miss (the
        // TTL sweep is the safety net), not this provider's machinery.
        let second_logs = home
            .join("brain")
            .join(RESUMED_CONV)
            .join(".system_generated")
            .join("logs");
        std::fs::create_dir_all(&second_logs).unwrap();
        let index = test_index(AntigravitySource::new(home.clone()));
        assert_eq!(index.snapshot().await.len(), 1);

        let mut rx = index.subscribe_changes();

        let mut watcher = SessionWatcher::new(
            Arc::clone(&index),
            vec![WatchedProvider {
                layout: Box::new(crate::provider_layout::AntigravityLayout),
                home: home.clone(),
            }],
        );
        let handle = watcher.start();
        tokio::time::sleep(Duration::from_millis(500)).await;

        let _second = write_transcript(
            &home,
            RESUMED_CONV,
            &fixture_content("resumed.sanitized.jsonl"),
        );

        let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
        assert!(
            changed.is_ok(),
            "the watcher should detect the new antigravity transcript and trigger a snapshot change"
        );

        let mut len = index.snapshot().await.len();
        for _ in 0..50 {
            if len >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
            len = index.snapshot().await.len();
        }
        assert_eq!(
            len, 2,
            "the new antigravity conversation must reach the index"
        );

        watcher.stop();
        let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Whole-delta review round 5, Major 2: a fresh conversation creates
    /// its nested directory chain and writes `transcript.jsonl` in one
    /// burst — the documented inotify cascade miss (see the test above)
    /// suppresses the FILE event, because the deepest directories are not
    /// armed yet when the write lands. The DIRECTORY event under the
    /// brain root is the guaranteed-observable signal (the armed `brain`
    /// watch always delivers the top directory's creation), so it must
    /// mark the provider dirty and let reconciliation rescan promptly —
    /// fresh conversations may not wait out the 15-minute index TTL.
    ///
    /// Deterministic reproduction: the chain + transcript land on disk
    /// BEFORE the watcher exists (no watch can observe the write — the
    /// file event is suppressed BY CONSTRUCTION, never by timing), and
    /// the cascade's top directory event — exactly the one inotify
    /// delivers in the worst case — is injected through the
    /// construction-time event seam.
    #[tokio::test]
    async fn watcher_directory_events_recover_the_cascade_missed_transcript() {
        let home = unique_temp_dir("watcher-cascade-miss");
        let _first = write_transcript(&home, FRESH_CONV, &fixture_content("fresh.sanitized.jsonl"));
        let index = test_index(AntigravitySource::new(home.clone()));
        // The first discover runs while the second conversation does NOT
        // exist, and the TTL (3600 s) can never resurface it — only the
        // provider-dirty path can.
        assert_eq!(index.snapshot().await.len(), 1);

        // The cascade: directories created + transcript written, with the
        // file event suppressed (nothing is armed yet).
        let _second = write_transcript(
            &home,
            RESUMED_CONV,
            &fixture_content("resumed.sanitized.jsonl"),
        );

        let mut watcher = SessionWatcher::new(
            Arc::clone(&index),
            vec![WatchedProvider {
                layout: Box::new(crate::provider_layout::AntigravityLayout),
                home: home.clone(),
            }],
        );
        // The event channel is allocated at construction, so the seam can
        // queue the directory event ahead of the spawned loop (the
        // `need_rescan_on_amplifier_replans_the_watch_set` model).
        let tx = watcher.test_event_tx().expect("test event seam");
        tx.send(WatchEvent::FileChanged {
            paths: vec![home.join("brain").join(RESUMED_CONV)],
            kind: WatchKind::CreateFolder,
            provider: "antigravity".to_string(),
        })
        .unwrap();
        let handle = watcher.start();

        let appeared = wait_for_rows(&index, 5, |rows| rows.len() == 2).await;
        assert!(
            appeared,
            "the brain-root directory event must provider-dirty the index and \
             surface the cascade-missed conversation without waiting out the TTL; \
             snapshot len stayed {}",
            index.snapshot().await.len()
        );

        watcher.stop();
        let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        let _ = std::fs::remove_dir_all(&home);
    }
}
