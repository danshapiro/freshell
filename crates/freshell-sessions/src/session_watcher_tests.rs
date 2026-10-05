//! Unit tests for `crate::session_watcher`. Kept in a sibling file (the
//! `codex_locator_tests.rs` convention: a `#[path]`-included child module) to
//! respect the repo's <=1K-lines file limit; `use super::*` still reaches
//! the parent's private items (`create_provider_watcher`, `watch_path`,
//! `unwatch_tolerated`, `WatchEvent`).

use super::*;
use crate::directory_index::{ClaudeSource, SessionIndex, SessionSource};
use std::sync::Arc;

#[test]
fn watched_provider_can_be_constructed() {
    let wp = WatchedProvider {
        layout: Box::new(crate::provider_layout::ClaudeLayout),
        home: PathBuf::from("/home/user/.claude"),
    };
    assert_eq!(wp.layout.name(), "claude");
}

fn unique_temp_dir(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "freshell-watcher-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn write_claude_session(claude_home: &Path, session_id: &str, cwd: &str) {
    let project = claude_home.join("projects").join("-p");
    std::fs::create_dir_all(&project).unwrap();
    let line = serde_json::json!({
        "type": "user",
        "sessionId": session_id,
        "cwd": cwd,
        "message": { "role": "user", "content": "hello" },
        "timestamp": "2025-01-30T10:00:00.000Z",
    })
    .to_string();
    std::fs::write(
        project.join(format!("{session_id}.jsonl")),
        format!("{line}\n"),
    )
    .unwrap();
}

#[test]
fn is_relevant_accepts_data_modify_and_create() {
    use notify::event::ModifyKind;
    let data_event = notify::Event::new(notify::EventKind::Modify(ModifyKind::Data(
        notify::event::DataChange::Any,
    )));
    assert!(is_relevant(&data_event));

    let create_event =
        notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::File));
    assert!(is_relevant(&create_event));

    let remove_event =
        notify::Event::new(notify::EventKind::Remove(notify::event::RemoveKind::File));
    assert!(is_relevant(&remove_event));
}

#[test]
fn is_relevant_rejects_access_events() {
    let access_event =
        notify::Event::new(notify::EventKind::Access(notify::event::AccessKind::Read));
    assert!(!is_relevant(&access_event));
}

#[test]
fn is_relevant_accepts_rescan_flag() {
    use notify::event::Flag;
    let mut event = notify::Event::new(notify::EventKind::Other);
    event = event.set_flag(Flag::Rescan);
    assert!(is_relevant(&event));
}

#[test]
fn is_relevant_rejects_flagless_other() {
    let event = notify::Event::new(notify::EventKind::Other);
    assert!(!is_relevant(&event));
}

#[test]
fn nearest_existing_ancestor_returns_existing_parent() {
    let tmp = std::env::temp_dir();
    // tmp exists; tmp/nonexistent/deep does not
    let target = tmp.join("nonexistent-watcher-test-dir").join("deep");
    let result = nearest_existing_ancestor(&target, &tmp);
    assert_eq!(result, tmp);
}

#[test]
fn nearest_existing_ancestor_returns_bound_when_nothing_exists() {
    let bound = PathBuf::from("/nonexistent-bound-for-test");
    let target = bound.join("sub").join("deep");
    let result = nearest_existing_ancestor(&target, &bound);
    assert_eq!(result, bound);
}

#[tokio::test]
async fn watcher_detects_new_file_and_marks_dirty() {
    let claude_home = unique_temp_dir("watcher-detect");
    let project = claude_home.join("projects").join("-p");
    std::fs::create_dir_all(&project).unwrap();

    let sid1 = "550e8400-e29b-41d4-a716-446655440001";
    write_claude_session(&claude_home, sid1, "/p/1");

    let source = ClaudeSource::new(claude_home.clone());
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(source) as Arc<dyn SessionSource>],
        Duration::from_secs(3600),
        None,
    ));

    let snap = index.snapshot().await;
    assert_eq!(snap.len(), 1);

    let mut rx = index.subscribe_changes();

    let mut watcher = SessionWatcher::new(
        Arc::clone(&index),
        vec![WatchedProvider {
            layout: Box::new(crate::provider_layout::ClaudeLayout),
            home: claude_home.clone(),
        }],
    );
    let handle = watcher.start();
    tokio::time::sleep(Duration::from_millis(500)).await;

    let sid2 = "550e8400-e29b-41d4-a716-446655440002";
    write_claude_session(&claude_home, sid2, "/p/2");

    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(
        changed.is_ok(),
        "watcher should detect the new file and trigger a snapshot change"
    );

    let snap2 = index.snapshot().await;
    let mut final_len = snap2.len();
    for _ in 0..20 {
        if final_len >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        final_len = index.snapshot().await.len();
    }
    assert_eq!(final_len, 2, "new session should appear in the index");

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&claude_home).ok();
}

#[tokio::test]
async fn watcher_handles_late_root_appearance() {
    let base = unique_temp_dir("late-root");
    let claude_home = base.join(".claude");
    std::fs::create_dir_all(&claude_home).unwrap();

    let source = ClaudeSource::new(claude_home.clone());
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(source) as Arc<dyn SessionSource>],
        Duration::from_secs(3600),
        None,
    ));

    let snap = index.snapshot().await;
    assert_eq!(snap.len(), 0);

    let mut rx = index.subscribe_changes();
    let _ = *rx.borrow_and_update();

    let mut watcher = SessionWatcher::new(
        Arc::clone(&index),
        vec![WatchedProvider {
            layout: Box::new(crate::provider_layout::ClaudeLayout),
            home: claude_home.clone(),
        }],
    );
    let handle = watcher.start();
    tokio::time::sleep(Duration::from_millis(500)).await;

    let sid = "550e8400-e29b-41d4-a716-446655440003";
    write_claude_session(&claude_home, sid, "/p/late");

    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(
        changed.is_ok(),
        "watcher must detect a late-appearing session (DEV-0002 liveness)"
    );

    let mut found = false;
    for _ in 0..20 {
        let snap = index.snapshot().await;
        if snap.iter().any(|s| s.session_id == sid) {
            found = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(found, "late-appearing session must be visible in the index");

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&base).ok();
}

#[tokio::test]
async fn watcher_rearms_when_absent_provider_appears() {
    let base = unique_temp_dir("rearm");
    let claude_home = base.join(".claude");

    let source = ClaudeSource::new(claude_home.clone());
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(source) as Arc<dyn SessionSource>],
        Duration::from_secs(3600),
        None,
    ));

    let snap = index.snapshot().await;
    assert_eq!(snap.len(), 0);

    let mut rx = index.subscribe_changes();
    let _ = *rx.borrow_and_update();

    let mut watcher = SessionWatcher::new(
        Arc::clone(&index),
        vec![WatchedProvider {
            layout: Box::new(crate::provider_layout::ClaudeLayout),
            home: claude_home.clone(),
        }],
    )
    .with_rearm_interval(1);
    let handle = watcher.start();
    tokio::time::sleep(Duration::from_millis(500)).await;

    let project = claude_home.join("projects").join("-p");
    std::fs::create_dir_all(&project).unwrap();

    tokio::time::sleep(Duration::from_secs(2)).await;

    let sid = "550e8400-e29b-41d4-a716-446655440004";
    write_claude_session(&claude_home, sid, "/p/rearm");

    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(changed.is_ok(), "re-armed watcher must detect the new file");

    let mut found = false;
    for _ in 0..20 {
        let snap = index.snapshot().await;
        if snap.iter().any(|s| s.session_id == sid) {
            found = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        found,
        "session from a re-armed provider must appear in the index"
    );

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&base).ok();
}

/// Drain FileChanged paths into a set until `done` holds or the window
/// closes (ProviderRescan carries no paths and is skipped; a closed
/// channel or the expired deadline ends the drain). Module scope: Task
/// 3's amplifier tests reuse this collector after the test-file move.
async fn collect_file_paths(
    rx: &mut mpsc::UnboundedReceiver<WatchEvent>,
    window: Duration,
    done: impl Fn(&std::collections::HashSet<PathBuf>) -> bool,
) -> std::collections::HashSet<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let until = tokio::time::Instant::now() + window;
    while !done(&seen) {
        match tokio::time::timeout_at(until, rx.recv()).await {
            Ok(Some(WatchEvent::FileChanged { paths, .. })) => seen.extend(paths),
            Ok(Some(WatchEvent::ProviderRescan { .. })) => {}
            Ok(None) | Err(_) => break,
        }
    }
    seen
}

/// The one-fd-per-provider restructure's behavioral contract: one shared
/// `RecommendedWatcher` can arm SEVERAL paths; unwatching one path must
/// not disturb the others; unwatch of a never-armed path is tolerated.
///
/// Events are COLLECTED into a set under a deadline with set-membership
/// assertions — never per-`recv` identity: one `std::fs::write` emits
/// several notifications (commonly Create + Modify), so the recv after
/// a second write can deliver the FIRST write's queued companion.
#[tokio::test]
async fn one_watcher_supports_many_targets_and_tolerated_unwatch() {
    let a = unique_temp_dir("onefd-a");
    let b = unique_temp_dir("onefd-b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "claude", false).expect("create shared watcher");
    watch_path(
        &mut watcher,
        "claude",
        &a,
        notify::RecursiveMode::NonRecursive,
    )
    .unwrap();
    watch_path(
        &mut watcher,
        "claude",
        &b,
        notify::RecursiveMode::NonRecursive,
    )
    .unwrap();

    // Both armed paths deliver events through the ONE watcher (early
    // exit once BOTH prefixes observed; companion events interleave with
    // the second write's, which is exactly why membership — not recv
    // order — is the assertion).
    std::fs::write(a.join("one.txt"), b"x").unwrap();
    std::fs::write(b.join("one.txt"), b"x").unwrap();
    let saw = collect_file_paths(&mut rx, Duration::from_secs(2), |s| {
        s.iter().any(|p| p.starts_with(&a)) && s.iter().any(|p| p.starts_with(&b))
    })
    .await;
    assert!(
        saw.iter().any(|p| p.starts_with(&a)),
        "events for a: {saw:?}"
    );
    assert!(
        saw.iter().any(|p| p.starts_with(&b)),
        "events for b: {saw:?}"
    );

    // Unwatch a (twice: the second proves the tolerated path), then
    // verify a's further writes produce nothing while b still delivers.
    // One fixed 700ms window collects every straggler, so the negative
    // assertion runs over the COMPLETE set.
    unwatch_tolerated(&mut watcher, "claude", &a);
    unwatch_tolerated(&mut watcher, "claude", &a); // tolerated no-op, no panic
    std::fs::write(a.join("two.txt"), b"x").unwrap();
    std::fs::write(b.join("two.txt"), b"x").unwrap();
    let after = collect_file_paths(&mut rx, Duration::from_millis(700), |_| false).await;
    assert!(
        after.iter().any(|p| p.starts_with(&b)),
        "b still delivers: {after:?}"
    );
    assert!(
        !after.iter().any(|p| p.starts_with(&a)),
        "no events from the unwatched path may arrive: {after:?}"
    );
    drop(watcher);
    std::fs::remove_dir_all(&a).ok();
    std::fs::remove_dir_all(&b).ok();
}

// ---------- amplifier managed watch set ----------

/// Mirrors `amplifier.rs::tests::write_session` (private to that module —
/// deliberate duplication per crate convention).
fn write_amplifier_session(home: &Path, slug: &str, id: &str) -> PathBuf {
    let dir = home.join("projects").join(slug).join("sessions").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("metadata.json"),
        format!(
            r#"{{"session_id":"{id}","working_dir":"/p/{slug}","created":"2026-03-01T00:00:00.000Z","name":"t","description":"s","turn_count":1}}"#
        ),
    )
    .unwrap();
    dir
}

fn amplifier_index(home: &Path) -> Arc<SessionIndex> {
    Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![
            Arc::new(crate::amplifier::AmplifierSource::new(home.to_path_buf()))
                as Arc<dyn crate::directory_index::SessionSource>,
        ],
        Duration::from_secs(3600),
        None,
    ))
}

fn amplifier_watcher(index: &Arc<SessionIndex>, home: &Path) -> SessionWatcher {
    SessionWatcher::new(
        Arc::clone(index),
        vec![WatchedProvider {
            layout: Box::new(crate::provider_layout::AmplifierLayout),
            home: home.to_path_buf(),
        }],
    )
}

/// Amplifier index over a `CountingWrapper`, returning the source's call
/// counters next to the index. Negative no-scan tests assert on these
/// counters (OBSERVABLE WORK: an erroneous full/provider discover or
/// scoped stat ALWAYS increments its counter) — never only on
/// `subscribe_changes()`, whose generation bumps only when the published
/// CONTENT changes, so an index-equivalent erroneous sweep would leave
/// the receiver silent while the prohibited CPU work ran anyway. (Only
/// fields a test actually reads live here, or the clippy `-D warnings`
/// gate would flag a dead one.)
struct CountedAmplifierIndex {
    index: Arc<SessionIndex>,
    discover_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    stat_scoped_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

fn counted_amplifier_index(home: &Path) -> CountedAmplifierIndex {
    let amplifier = crate::amplifier::AmplifierSource::new(home.to_path_buf());
    let wrapped = crate::directory_index::tests::CountingWrapper::new(amplifier);
    let (discover_calls, _parse_calls, _direct_list_calls, stat_scoped_calls) =
        crate::directory_index::tests::wrapper_counters(&wrapped);
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(wrapped) as Arc<dyn crate::directory_index::SessionSource>],
        Duration::from_secs(3600),
        None,
    ));
    CountedAmplifierIndex {
        index,
        discover_calls,
        stat_scoped_calls,
    }
}

/// Regression 3 & the start of the watch-reduction proof: startup arms
/// exactly {projects root, per-project sessions dir (or stand-in),
/// root-named session dirs} — never a subagent dir, never a stray file.
#[tokio::test]
async fn amplifier_startup_arms_exactly_the_managed_set() {
    let home = unique_temp_dir("amp-startup");
    // Project named WITH underscore components (regression 3).
    let root_session =
        write_amplifier_session(&home, "my_proj_x", "012584be-9478-4801-a62d-4e5da428b3a0");
    write_amplifier_session(
        &home,
        "my_proj_x",
        "0000000000000000-014b6af1c2ac4ab5_agent",
    );
    // Stand-in project (no sessions/ dir) and a stray file at project depth.
    std::fs::create_dir_all(home.join("projects").join("no_sessions_proj")).unwrap();
    std::fs::write(home.join("projects").join("repl_history"), b"x").unwrap();

    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().expect("amplifier book");
    let handle = watcher.start();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let b = book.lock().unwrap();
                if b.armed.contains(&root_session) && !book_has_path_named(&b, "repl_history") {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("startup arming completes");

    {
        let b = book.lock().unwrap();
        let armed = &b.armed;
        assert!(armed.contains(&home.join("projects")));
        assert!(armed.contains(&home.join("projects").join("my_proj_x").join("sessions")));
        assert!(armed.contains(&root_session));
        assert!(armed.contains(&home.join("projects").join("no_sessions_proj")));
        // Subagent dirs and stray files: never.
        assert!(!book_has_path_named(
            &b,
            "0000000000000000-014b6af1c2ac4ab5_agent"
        ));
        assert!(!book_has_path_named(&b, "repl_history"));
        // Exact count: root + 1 sessions + 1 stand-in + 1 root session dir.
        assert_eq!(armed.len(), 4);
    } // book guard released before the async stop-and-join
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

fn book_has_path_named(b: &ManagedBook, name: &str) -> bool {
    b.armed.iter().any(|p| p.ends_with(name))
}

/// Delta-review D1-1/D1-2 probe (the Task-10 `/proc/self/fdinfo` idiom,
/// refined): the inode numbers this process CURRENTLY holds inotify
/// watches on, parsed from the `inotify wd:… ino:<hex>` fdinfo lines.
/// Negative event windows can never distinguish "explicitly released" from
/// "kernel auto-dropped" (LB-01's kernel-auto-drop ambiguity), so the
/// watch-release assertions below read the KERNEL state directly. The
/// lookup is keyed by THIS fixture's inodes, so concurrent tests' watcher
/// activity in the same test process can never pollute the assertion.
/// Linux-only by construction (inotify); callers gate on the returned set
/// being non-empty so a stripped /proc degrades to a skip rather than a
/// false pass.
#[cfg(target_os = "linux")]
fn watched_inotify_inos() -> std::collections::HashSet<u64> {
    let mut inos = std::collections::HashSet::new();
    let Ok(entries) = std::fs::read_dir("/proc/self/fdinfo") else {
        return inos;
    };
    for entry in entries.flatten() {
        let Ok(content) = std::fs::read_to_string(entry.path()) else {
            continue;
        };
        for line in content.lines() {
            // "inotify wd:5 ino:1a24001 sdev:800001 mask:fce …"
            let Some(rest) = line.strip_prefix("inotify wd:") else {
                continue;
            };
            let Some(ino_field) = rest.split_whitespace().nth(1) else {
                continue;
            };
            let Some(hex) = ino_field.strip_prefix("ino:") else {
                continue;
            };
            if let Ok(ino) = u64::from_str_radix(hex, 16) {
                inos.insert(ino);
            }
        }
    }
    inos
}

#[cfg(target_os = "linux")]
fn ino_of(path: &Path) -> u64 {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(path).unwrap().ino()
}

/// Delta-review D1-1 (inode-follow on the projects ROOT): `mv` of the root
/// is NOT the `remove_dir_all` shape — the kernel auto-drops nothing, so
/// without explicit descendant unwatches every armed sessions/session dir
/// watch follows its moved inode: still reporting under the stale path,
/// untracked by the ledger, invisible to the budget WARN, and un-tearable
/// when a replacement root is armed. The depth-0 vanish path must unwatch
/// EVERY armed descendant before clearing the bookkeeping — proven here by
/// direct kernel observation (the fixture's inode numbers must leave this
/// process's inotify fdinfo), and a re-created root at the original path
/// must re-arm with the FULL cascade.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn moved_projects_root_releases_every_descendant_watch_and_rearms_on_return() {
    let home = unique_temp_dir("amp-rootmv");
    let s_a = write_amplifier_session(&home, "p1", "aa2584be-9478-4801-a62d-4e5da428b3a0");
    let s_b = write_amplifier_session(&home, "p1", "bb2584be-9478-4801-a62d-4e5da428b3a0");
    let s_c = write_amplifier_session(&home, "p2", "cc2584be-9478-4801-a62d-4e5da428b3a0");
    let projects = home.join("projects");

    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home).with_rearm_interval(1);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();

    // Full expected set: root + 2 sessions dirs + 3 session dirs.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.len() == 6 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("startup arming completes");

    // Record the inode of every armed path. Re-key by the fixture paths
    // rather than the live book (renames do not change inodes, so these
    // remain the identifiers of the moved directories).
    let fixture_dirs = [
        projects.clone(),
        projects.join("p1").join("sessions"),
        s_a.clone(),
        s_b.clone(),
        projects.join("p2").join("sessions"),
        s_c.clone(),
    ];
    let fixture_inos: Vec<u64> = fixture_dirs.iter().map(|p| ino_of(p)).collect();
    let watched_before = watched_inotify_inos();
    if watched_before.is_empty() {
        eprintln!("skipping fdinfo assertions: /proc/self/fdinfo unreadable");
    } else {
        for ino in &fixture_inos {
            assert!(
                watched_before.contains(ino),
                "sanity: armed fixture dir must be kernel-watched (ino {ino})"
            );
        }
    }

    // MOVE the root away (same fs, rename): the depth-0 vanish path must
    // release every descendant's watch — not just the root's own.
    let moved_to = home.join("projects-moved");
    std::fs::rename(&projects, &moved_to).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let cleared = {
                let b = book.lock().unwrap();
                b.absent.contains(&projects) && !b.armed.iter().any(|p| p.starts_with(&projects))
            };
            if cleared {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("moved root enters absent; whole subtree forgotten");

    if !watched_before.is_empty() {
        let watched_after = watched_inotify_inos();
        for ino in &fixture_inos {
            assert!(
                !watched_after.contains(ino),
                "moved descendant watch must be explicitly released, not left \
                 following its inode (ino {ino} still kernel-watched)"
            );
        }
    }

    // Re-create the root at the ORIGINAL path with a session while the root
    // is tracked absent: the ancestor watch armed on the vanish observes
    // the re-creation, and the deferred full return cascade picks it up
    // first-line (the 1s rearm tick stands behind it as the safety net).
    let _ = rx.borrow_and_update();
    let returned = write_amplifier_session(&home, "p3", "dd2584be-9478-4801-a62d-4e5da428b3a0");
    tokio::time::timeout(Duration::from_secs(8), rx.changed())
        .await
        .expect("the return cascade's marks refresh the index promptly (ancestor watch; 1s tick is the safety net)")
        .unwrap();
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let done = {
                let b = book.lock().unwrap();
                b.armed.contains(&projects)
                    && b.armed.contains(&projects.join("p3").join("sessions"))
                    && b.armed.contains(&returned)
                    && !b.absent.contains(&projects)
            };
            if done {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("re-created root re-arms with the full cascade");

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Delta-review D1-2 (inode-follow on a whole sessions/ subtree): `mv` of
/// `<proj>/sessions` must (a) explicitly unwatch EVERY armed session dir
/// under it — they follow their inodes otherwise, (b) scoped-prune-mark
/// each removed session dir so cached rows disappear promptly (never
/// waiting for the reconcile), and (c) keep the stand-in swap for the
/// now-sessions-less project, so a re-created sessions/ is picked up
/// first-line.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn moved_sessions_dir_unwatches_children_prunes_rows_and_reswaps_standin() {
    let home = unique_temp_dir("amp-sessmv");
    let s_a = write_amplifier_session(&home, "p", "aa2584be-9478-4801-a62d-4e5da428b3a0");
    let s_b = write_amplifier_session(&home, "p", "bb2584be-9478-4801-a62d-4e5da428b3a0");
    let project = home.join("projects").join("p");
    let sessions = project.join("sessions");

    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();
    let snap0 = index.snapshot().await;
    assert_eq!(
        snap0.iter().filter(|s| s.provider == "amplifier").count(),
        2
    );
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.len() == 4 {
                break; // root + sessions + 2 session dirs
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("startup arming completes");

    let fixture_inos: Vec<u64> = [sessions.clone(), s_a.clone(), s_b.clone()]
        .iter()
        .map(|p| ino_of(p))
        .collect();
    let fdinfo_live = !watched_inotify_inos().is_empty();

    // MOVE the whole sessions/ tree out of the project (out of the corpus).
    let moved_to = home.join("sessions-moved");
    std::fs::rename(&sessions, &moved_to).unwrap();

    // (c) the stand-in swap still fires for the now-sessions-less project,
    // (a)'s bookkeeping half clears the whole subtree.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let swapped = {
                let b = book.lock().unwrap();
                b.armed.contains(&project) && !b.armed.iter().any(|p| p.starts_with(&sessions))
            };
            if swapped {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("stand-in armed for the project; sessions subtree forgotten");

    // (b) rows prune PROMPTLY via the scoped marks (the 15-minute reconcile
    // can never fire inside a test — a timeout here is the regression).
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if index
                .snapshot()
                .await
                .iter()
                .all(|s| s.provider != "amplifier")
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("moved sessions' rows prune promptly on scoped marks");

    // (a) kernel-side: every descendant watch actually released (not
    // following the moved inodes).
    if fdinfo_live {
        let watched_after = watched_inotify_inos();
        for ino in &fixture_inos {
            assert!(
                !watched_after.contains(ino),
                "moved sessions-tree watch must be explicitly released (ino {ino})"
            );
        }
    }

    // A re-created sessions/ is picked up first-line through the stand-in.
    let returned = write_amplifier_session(&home, "p", "cc2584be-9478-4801-a62d-4e5da428b3a0");
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let done = {
                let b = book.lock().unwrap();
                b.armed.contains(&sessions)
                    && b.armed.contains(&returned)
                    && !b.armed.contains(&project)
            };
            if done {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("re-created sessions/ re-arms (swap) with its new session dir");
    // The swap arm's scoped metadata.json mark flows through the debounced
    // flush — poll instead of asserting on the immediate snapshot.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if index.snapshot().await.iter().any(|s| {
                s.provider == "amplifier" && s.session_id == "cc2584be-9478-4801-a62d-4e5da428b3a0"
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the re-created session row is visible first-line");

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 17b: a deterministic arm failure (path missing by the time
/// the arm runs) leaves the retry set immediately — a reappearance is a
/// fresh structural create anyway.
#[tokio::test]
async fn deterministic_arm_failure_never_enters_retry_set() {
    let home = unique_temp_dir("amp-armerr");
    std::fs::create_dir_all(home.join("projects")).unwrap();

    // The arm helpers are free functions; drive them on a locally-
    // constructed shared watcher + a fresh book + a fresh mark sink — the
    // same helpers the spawned loop calls with ITS watcher/book/sink, but
    // with no loop and no inotify timing at all. (The dropped target here
    // is a SessionDir kind — for the root kind a deterministic failure
    // enters ABSENT instead; see Task 3's Interfaces and Task 4's root
    // lifecycle test.)
    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();
    let ghost = home.join("projects").join("ghost");
    arm_managed_dir(
        &mut book,
        &mut watcher,
        &mut outcome,
        "amplifier",
        &ghost,
        crate::watch_plan::ArmKind::SessionDir,
        false,
    );

    assert!(book.retry.is_empty(), "deterministic failures never retry");
    assert!(!book.armed.contains(&ghost));
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Delta D2-1 (scan→arm window, `SessionsDir` kind): a `<proj>/sessions/`
/// dir that existed at plan time but VANISHED before its arm must NOT be
/// dropped silently — planning saw it, so NO stand-in was armed for the
/// project and the non-recursive root watch cannot observe the grandchild's
/// reappearance (a plain drop orphans the project until the reconcile). The
/// project must be armed as the stand-in — the same object a missing-at-plan
/// sessions dir produces — and the sessions dir absent-tracked, so a later
/// reappearance surfaces as the existing depth-2 `Create(sessions)` → swap
/// path, promptly (never the 60s tick or the 15-minute reconcile). Driven
/// deterministically with the established no-loop idiom (split production
/// startup into its ordered steps and mutate the window), then proven live:
/// the armed stand-in observes the reappearance, and the loop's dispatch +
/// deferred cascade executor arms the sessions dir and its new root session
/// first-line.
#[tokio::test]
async fn sessions_dir_vanishing_between_plan_and_arm_arms_the_project_standin() {
    let home = unique_temp_dir("amp-plan-arm-race");
    let _pre = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let projects_root = home.join("projects");
    let proj = projects_root.join("p");
    let sessions_dir = proj.join("sessions");

    // Production startup step A: the plan scan sees the sessions dir.
    let plan = crate::watch_plan::plan_amplifier_targets(&projects_root).unwrap();
    assert!(plan.sessions_dirs.contains(&sessions_dir));
    // THE WINDOW: sessions/ vanishes after the scan, before the arms.
    std::fs::remove_dir_all(&sessions_dir).unwrap();

    // Production startup step B: the arms (in production inside
    // spawn_blocking; the sync core here is the identical code path).
    let (tx, mut rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();
    apply_amplifier_startup_plan(&mut book, &mut watcher, &mut outcome, &projects_root, plan);

    assert!(
        !book.armed.contains(&sessions_dir),
        "the vanished sessions dir never arms"
    );
    assert!(
        book.armed.contains(&proj),
        "the project MUST be armed as the stand-in (the orphaned corner): {:?}",
        book.armed
    );
    assert!(
        book.absent.contains(&sessions_dir),
        "the vanished sessions dir is absent-tracked"
    );

    // The stand-in is LIVE: re-creating sessions/ surfaces the depth-2
    // `Create(<proj>/sessions)` event through it.
    let recreated = write_amplifier_session(&home, "p", "bb2584be-9478-4801-a62d-4e5da428b3a0");
    let seen = collect_file_paths(&mut rx, Duration::from_secs(2), |s| {
        s.contains(&sessions_dir)
    })
    .await;
    assert!(
        seen.contains(&sessions_dir),
        "the stand-in observes the re-created sessions/ (the depth-2 create): {seen:?}"
    );

    // The loop's depth-2 create route defers the project to the cascade
    // executor — drive exactly that (dispatch → cascades → cascade_new_project).
    let index = amplifier_index(&home);
    let interest = std::sync::atomic::AtomicUsize::new(0);
    let mut pending: HashMap<(PathBuf, String), Instant> = HashMap::new();
    let mut cascades: Vec<PathBuf> = Vec::new();
    let mut root_return = false;
    dispatch_amplifier_path(
        &mut book,
        &mut watcher,
        &mut outcome,
        &projects_root,
        &interest,
        &sessions_dir,
        WatchKind::CreateFolder,
        &mut pending,
        &index,
        &mut cascades,
        &mut root_return,
    );
    assert!(!root_return, "a depth-2 create is not the root's return");
    assert_eq!(
        cascades,
        vec![proj.clone()],
        "the depth-2 create defers the project"
    );
    for project in cascades {
        cascade_new_project(&mut book, &mut watcher, &mut outcome, &project, true);
    }
    assert!(
        book.armed.contains(&sessions_dir),
        "re-created sessions/ armed by the swap"
    );
    assert!(
        !book.absent.contains(&sessions_dir),
        "the successful re-arm clears the absence"
    );
    assert!(
        book.armed.contains(&recreated),
        "the root session created in the window cascades promptly — not the 15-minute reconcile"
    );
    assert!(
        outcome.marks.contains(&recreated.join("metadata.json")),
        "watch-then-scan scoped mark lands first-line: {:?}",
        outcome.marks
    );
    assert!(
        !book.armed.contains(&proj),
        "the stand-in swaps off once the sessions arm lands"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 7 (check→arm window): the stand-in arm IMMEDIATELY re-checks
/// for sessions/ and swaps when it has appeared in the window.
#[tokio::test]
async fn arm_sessions_or_standin_rechecks_sessions_after_arming() {
    let home = unique_temp_dir("amp-toctou");
    let proj = home.join("projects").join("proj");
    std::fs::create_dir_all(&proj).unwrap(); // no sessions/ yet
    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();

    // Phase 1: drive the project arm with NO sessions/ — a stand-in arms.
    arm_sessions_or_standin(&mut book, &mut watcher, &mut outcome, &proj, false);
    assert!(book.armed.contains(&proj));
    assert!(!book.armed.contains(&proj.join("sessions")));

    // Phase 2: sessions/ appears; the armed stand-in must swap to the real
    // sessions dir (the swap path `arm_sessions_or_standin` re-checks after
    // arming AND serves as the recheck on repeat arms), cascading the
    // session child.
    let session = write_amplifier_session(&home, "proj", "012584be-9478-4801-a62d-4e5da428b3a0");
    arm_sessions_or_standin(&mut book, &mut watcher, &mut outcome, &proj, false);
    assert!(
        book.armed.contains(&proj.join("sessions")),
        "sessions/ armed"
    );
    assert!(
        !book.armed.contains(&proj),
        "stale stand-in removed: {:?}",
        book.armed
    );
    assert!(
        book.armed.contains(&session),
        "the post-arm recheck cascades session children"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Startup race regression (watch-then-scan applied AT STARTUP): a root
/// session dir created AFTER the initial plan scan but BEFORE the
/// structural arms is nevertheless armed — the post-arm readdir union, not
/// the stale scan, decides session-dir arms. Driven deterministically by
/// splitting startup into the same ordered steps the production loop runs
/// and creating the dir at the window; no sleeps, no spawned loop.
#[tokio::test]
async fn startup_arms_session_dirs_created_in_the_scan_arm_window() {
    let home = unique_temp_dir("amp-startup-race");
    let pre = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let _ = pre; // one pre-existing session (present in the initial scan)
    let index = amplifier_index(&home);
    let projects_root = home.join("projects");

    // Step A of production startup: the initial plan scan.
    let plan = crate::watch_plan::plan_amplifier_targets(&projects_root).unwrap();
    // THE WINDOW: the dir appears after the scan, before the arms (in
    // production the loop calls apply_amplifier_startup_plan immediately
    // after the plan, in the same order, just wrapped in spawn_blocking).
    let windowed = write_amplifier_session(&home, "p", "bb2584be-9478-4801-a62d-4e5da428b3a0");
    // Step B: the structural arms + post-arm rescans (in production this
    // whole step runs inside `spawn_blocking` with the arm outcome handed
    // back to the async loop; here the sync core is driven directly).
    let (tx, mut rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();
    apply_amplifier_startup_plan(&mut book, &mut watcher, &mut outcome, &projects_root, plan);

    assert!(
        book.armed.contains(&windowed),
        "created between scan and arm ⇒ caught by the post-arm rescan: {:?}",
        book.armed
    );

    // The arm is LIVE: a sidecar write surfaces through the armed watch.
    std::fs::write(windowed.join("transcript.jsonl"), "{\"type\":\"user\"}\n").unwrap();
    let seen = collect_file_paths(&mut rx, Duration::from_secs(2), |s| {
        s.iter().any(|p| p.starts_with(&windowed))
    })
    .await;
    assert!(
        seen.iter().any(|p| p.starts_with(&windowed)),
        "events flow through the window-armed watch: {seen:?}"
    );

    // …and visible in the index once the boot discover runs (startup arms
    // skip file marks by design; the discover covers initial state).
    let snap = index.snapshot().await;
    assert!(
        snap.iter()
            .any(|s| s.provider == "amplifier"
                && s.session_id == "bb2584be-9478-4801-a62d-4e5da428b3a0"),
        "window-created session is visible at the first snapshot"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Startup-barrier race, PRODUCTION ORDER (extends
/// `startup_arms_session_dirs_created_in_the_scan_arm_window`): the real
/// boot race is the detached sweep tasks issued while the watcher arms —
/// the warm spawn (`main.rs:1287`) AND `spawn_sessions_sweep`'s initial
/// signature snapshot (`main.rs:2637`). The cold-start publish gate
/// (`SessionIndex::set_startup_gate`, fed by `SessionWatcher::startup_ready`)
/// must hold the FIRST publish until the startup arms settle, so a metadata
/// write landing in the scan↔arm window is visible in that SAME boot
/// snapshot — never stale until the 15-minute reconcile.
#[tokio::test]
async fn boot_snapshot_gate_covers_window_raced_writes() {
    let home = unique_temp_dir("amp-barrier");
    let _pre = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    // Production order (main.rs): construct → consumers subscribe via
    // `startup_ready()` → `start()`. The accessor clones the retained
    // receiver, so the gate install AND this test's awaiter both subscribe
    // before start — exactly as the main.rs wiring does.
    index.set_startup_gate(watcher.startup_ready());
    let mut ready = watcher.startup_ready();
    let book = watcher.amplifier_book_handle().unwrap();

    // The sessions sweep's boot snapshot (main.rs:2637): issued
    // immediately, pre-start — the task that raced ahead ungated in
    // production.
    let mut early = tokio::spawn({
        let index = Arc::clone(&index);
        async move { index.snapshot().await }
    });

    // The raced write: lands after the sweep's call, before its arm
    // (startup is markless by design).
    let racer = write_amplifier_session(&home, "p", "cc2584be-9478-4801-a62d-4e5da428b3a0");

    // Deterministic gate proof (no sleep-race): `timeout` DRIVES `early` —
    // ungated, the snapshot completes right here (a pre-arm publish, the
    // bug, and the assertion fails); gated, it can only still be pending —
    // the gate cannot open because `start()` has not been called, so the
    // 250ms window's length decides nothing.
    assert!(
        tokio::time::timeout(Duration::from_millis(250), &mut early)
            .await
            .is_err(),
        "the boot sweep's snapshot is gated: no publish before watcher readiness"
    );

    let handle = watcher.start();

    // Readiness fires only AFTER the startup arms settle; the raced dir is
    // provably armed by then.
    tokio::time::timeout(Duration::from_secs(5), ready.wait_for(|done| *done))
        .await
        .expect("startup readiness fires")
        .expect("sender alive");
    assert!(
        book.lock().unwrap().armed.contains(&racer),
        "readiness implies the raced dir is armed"
    );

    // The boot sweep's OWN snapshot — the first post-readiness publish —
    // covers the window-raced write. NO provider-dirty kick: the production
    // boot sequence makes no such call.
    let items = tokio::time::timeout(Duration::from_secs(5), early)
        .await
        .expect("the gated snapshot completes after readiness")
        .unwrap();
    assert!(
        items
            .iter()
            .any(|s| s.provider == "amplifier"
                && s.session_id == "cc2584be-9478-4801-a62d-4e5da428b3a0"),
        "the first post-readiness publish covers the window-raced write"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 7 (event path): a `sessions/` dir created under a stand-in
/// project is observed — the stand-in swaps to the real sessions watch, and
/// existing session dirs under it are armed and scanned.
#[tokio::test]
async fn sessions_dir_created_after_standin_arm_is_picked_up() {
    let home = unique_temp_dir("amp-standin-swap");
    let proj = home.join("projects").join("late_proj");
    std::fs::create_dir_all(&proj).unwrap(); // no sessions/ yet

    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Stand-in armed.
    assert!(book.lock().unwrap().armed.contains(&proj));

    // sessions/ + a root session appear while only the stand-in is armed.
    let session =
        write_amplifier_session(&home, "late_proj", "550e8400-e29b-41d4-a716-4466554400aa");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.contains(&session) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("stand-in swap observed events and armed the session dir");
    // The stand-in itself is gone; the sessions dir is armed.
    {
        let b = book.lock().unwrap();
        assert!(b.armed.contains(&proj.join("sessions")));
        assert!(!b.armed.contains(&proj));
    }
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// New-project cascade: `create_dir_all(proj/sessions/<id>)` surfaces ONE
/// `Create(<proj>)` at the root; the cascade arms sessions + root session
/// and the watch-then-scan marks metadata.json (the row appears).
#[tokio::test]
async fn new_project_cascade_arms_and_scans() {
    let home = unique_temp_dir("amp-cascade");
    std::fs::create_dir_all(home.join("projects")).unwrap();
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let session =
        write_amplifier_session(&home, "brand_new", "550e8400-e29b-41d4-a716-4466554400bb");

    tokio::time::timeout(Duration::from_secs(5), rx.changed())
        .await
        .expect("cascade's watch-then-scan mark refreshes the index")
        .unwrap();

    assert!(book.lock().unwrap().armed.contains(&session));
    let snap = index.snapshot().await;
    assert!(
        snap.iter()
            .any(|s| s.provider == "amplifier"
                && s.session_id == "550e8400-e29b-41d4-a716-4466554400bb"),
        "the cascade's scoped mark made the new session visible immediately"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 14 (first half): with no subagent interest, a subagent-named
/// mkdir under a watched sessions dir is dropped silently (no provider
/// dirty, no arm) — the 15-minute reconcile owns it. The negative phase pins
/// OBSERVABLE WORK (`discover_calls`), not just the generation wait: an
/// erroneous escalation runs a full amplifier discover whose identical
/// content would NOT bump the generation, so a `subscribe_changes()` timeout
/// alone is vacuous for the prohibited CPU work.
#[tokio::test]
async fn subagent_mkdir_dropped_when_no_interest_escalates_when_interested() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let home = unique_temp_dir("amp-subgate");
    let root_session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let _ = root_session;
    let counted = counted_amplifier_index(&home);
    let index = counted.index.clone();
    let interest = Arc::new(AtomicUsize::new(0));
    let mut watcher =
        amplifier_watcher(&index, &home).with_subagent_interest(Arc::clone(&interest));
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);

    // Off: subagent dir creation is ignored — no index traffic AND no
    // discover sweep ran at all (the 700ms window covers the 200ms
    // debounce flush and the fire-and-forget background refresh).
    let sub = home
        .join("projects")
        .join("p")
        .join("sessions")
        .join("0000000000000000-014b6af1c2ac4ab5_new");
    std::fs::create_dir_all(&sub).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(700), rx.changed())
            .await
            .is_err(),
        "no-interest subagent mkdir must not refresh the index"
    );
    assert_eq!(
        counted.discover_calls.load(Ordering::SeqCst),
        baseline_discovers,
        "an erroneous escalation would have run a discover (observable work)"
    );
    assert!(!book.lock().unwrap().armed.contains(&sub));

    // On: provider dirty — a full amplifier discover picks the row up
    // (observable: both the generation bump AND the discover counter).
    interest.store(1, Ordering::SeqCst);
    std::fs::write(
        sub.join("metadata.json"),
        r#"{"session_id":"s","working_dir":"/p/x","parent_id":"par","created":"2026-03-01T00:00:00.000Z"}"#,
    )
    .unwrap();
    let sub2 = sub
        .parent()
        .unwrap()
        .join("0000000000000000-014b6af1c2ac4ab5_second");
    std::fs::create_dir_all(&sub2).unwrap();
    tokio::time::timeout(Duration::from_secs(5), rx.changed())
        .await
        .expect("interested subagent mkdir escalates to provider dirty")
        .unwrap();
    assert!(
        counted.discover_calls.load(Ordering::SeqCst) > baseline_discovers,
        "the interested escalation ran a real discover"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Whole-branch review Finding 2: an INTERESTED subagent-mkdir escalation
/// is the design's provider-dirty lever (design "Subagent-dir mkdir events
/// escalate to provider-dirty (full amplifier discover) ONLY while the
/// subagents-subscribed flag is set") — NOT a strict whole-tree watch-set
/// replan per interested-burst flush. The replan path is reserved for true
/// need_rescan / queue-overflow events. The escalation still runs a REAL
/// discover (observable: `discover_calls` moves — the find-the-row work
/// the toggle is paying for) while `book.replans` (applied replans only)
/// stays put.
#[tokio::test]
async fn interested_subagent_mkdir_escalates_to_provider_dirty_without_replan() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let home = unique_temp_dir("amp-subgate-dirtyonly");
    let _root = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let counted = counted_amplifier_index(&home);
    let index = counted.index.clone();
    let interest = Arc::new(AtomicUsize::new(1)); // interested from the start
    let mut watcher =
        amplifier_watcher(&index, &home).with_subagent_interest(Arc::clone(&interest));
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);
    let baseline_replans = book.lock().unwrap().replans;

    let sub = home
        .join("projects")
        .join("p")
        .join("sessions")
        .join("0000000000000000-014b6af1c2ac4ab5_new");
    std::fs::create_dir_all(&sub).unwrap();

    // The escalation fires as a provider dirty: a real amplifier discover
    // runs (observable work), exactly as designed.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if counted.discover_calls.load(Ordering::SeqCst) > baseline_discovers {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("interested subagent mkdir escalates to provider dirty");

    // ...but it must NOT pay a watch-set replan: a subagent mkdir is not a
    // need_rescan, so the applied-replans counter stays put.
    assert_eq!(
        book.lock().unwrap().replans,
        baseline_replans,
        "the subagent-mkdir escalation is provider-dirty only, not a replan"
    );
    assert!(
        !book.lock().unwrap().armed.contains(&sub),
        "subagent dirs are never armed"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Retry lifecycle (design "Absence/retry"): a transient arm failure lands
/// in `retry`; the rearm tick's drain re-attempts it once `next_attempt`
/// arrives — a STILL-failing attempt re-enters with doubled backoff, and
/// once the dir's access is restored the drain arms it. One transient
/// failure must never suppress the watch indefinitely. Uses the crate's
/// established `with_rearm_interval` short-interval seam so the REAL loop's
/// tick drives the drain.
#[cfg(unix)]
#[tokio::test]
async fn transient_arm_failure_is_retried_by_the_rearm_drain_and_eventually_arms() {
    use std::os::unix::fs::PermissionsExt;
    let home = unique_temp_dir("amp-retry");
    let victim = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);

    // Make the session dir unwatchable: inotify_add_watch needs read
    // permission, so watch() fails EACCES (Transient ⇒ retry, never absent).
    std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read_dir(&victim).is_ok() {
        eprintln!("skipping retry-drain assertions: euid can list a 0o000 dir");
        std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&home).ok();
        return;
    }

    let mut watcher = amplifier_watcher(&index, &home).with_rearm_interval(1); // 1s tick
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();

    // Phase 1: the startup arm fails transiently and the entry sits in
    // `retry` (startup arms run inside the loop; no tick wait needed).
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().retry.contains_key(&victim) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("transient arm failure lands in retry");
    let failures_at_insert = book.lock().unwrap().retry[&victim].failures;

    // Phase 2: a re-attempt while access is STILL denied re-enters with an
    // incremented failure count (backoff doubled). Force due immediacy via
    // the book handle so the 1s tick processes it at once.
    book.lock()
        .unwrap()
        .retry
        .get_mut(&victim)
        .unwrap()
        .next_attempt = std::time::Instant::now() - Duration::from_secs(1);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let grown = {
                let b = book.lock().unwrap();
                !b.armed.contains(&victim)
                    && b.retry
                        .get(&victim)
                        .is_some_and(|e| e.failures > failures_at_insert)
            };
            if grown {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("failed re-attempt re-enters retry with doubled backoff");

    // Phase 3: restore access and force due again — the drain re-arms the
    // dir and clears the retry entry, with no new filesystem event.
    std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o755)).unwrap();
    book.lock()
        .unwrap()
        .retry
        .get_mut(&victim)
        .unwrap()
        .next_attempt = std::time::Instant::now() - Duration::from_secs(1);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let b = book.lock().unwrap();
                if b.armed.contains(&victim) && !b.retry.contains_key(&victim) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("retry drain eventually arms the restored dir");

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Absence lifecycle, startup half (design: the provider root is the ONLY
/// target that re-enters absence tracking): root missing at startup →
/// absent; once it appears, the late-root ancestor watch observes the
/// creation and the deferred return cascade (plan + apply, `emit_marks:
/// true`) re-arms it AND runs the full structural cascade, so sessions
/// created while it was absent are armed AND scanned first-line — no
/// reconcile wait. The 1s rearm tick stands behind the ancestor fast path
/// as the safety net (either mechanism satisfies these prompt-window
/// expectations). Uses the established `with_rearm_interval` idiom. (The
/// deletion half — armed root → depth-0 removal routing → absent — is
/// Task 4's `deleted_projects_root_enters_absence_and_rearms_with_full_cascade_on_return`.)
#[tokio::test]
async fn absent_projects_root_at_startup_rearms_with_full_cascade_on_return() {
    let home = unique_temp_dir("amp-absent-boot");
    std::fs::create_dir_all(&home).unwrap(); // no projects/ yet
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home).with_rearm_interval(1);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    let projects = home.join("projects");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().absent.contains(&projects) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("root missing at startup enters absent tracking");

    // The root appears — WITH a session created underneath it while absent,
    // so only the cascade (not any in-flight event) can see it.
    let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    tokio::time::timeout(Duration::from_secs(8), rx.changed())
        .await
        .expect("the return cascade's marks refresh the index (1s rearm tick)")
        .unwrap();
    {
        let b = book.lock().unwrap();
        assert!(b.armed.contains(&projects), "returned root re-armed");
        assert!(b.armed.contains(&projects.join("p").join("sessions")));
        assert!(b.armed.contains(&session), "cascade armed the session dir");
        assert!(!b.absent.contains(&projects));
    }
    let snap = index.snapshot().await;
    assert!(
        snap.iter()
            .any(|s| s.provider == "amplifier"
                && s.session_id == "012584be-9478-4801-a62d-4e5da428b3a0"),
        "visible first-line — never deferred to the 15-minute reconcile"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Delta D2-2 (late-root latency parity with the pre-managed engine): with
/// the projects root absent at startup, the watcher must observe the root's
/// CREATION via a watch event — the pre-change recursive engine armed the
/// nearest existing ancestor (`~/.amplifier`, bounded at the provider home)
/// for exactly this. The rearm tick is only the safety net, so this test
/// runs with a LONG rearm interval (3600s — the tick cannot fire inside the
/// test window): a prompt return is provably the ancestor-watch fast path,
/// not the tick. The root appears WITH a session underneath it in the same
/// step, so only the full return cascade (not an in-flight child event) can
/// see it.
#[tokio::test]
async fn absent_projects_root_creation_is_observed_via_the_ancestor_watch_not_the_tick() {
    let home = unique_temp_dir("amp-ancestor-fastpath");
    std::fs::create_dir_all(&home).unwrap(); // no projects/ yet
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home).with_rearm_interval(3600);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    let projects = home.join("projects");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().absent.contains(&projects) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("root missing at startup enters absent tracking");

    // The explicit Ancestor role: while the root sits absent the nearest
    // EXISTING ancestor (the provider home, bounded there exactly as the
    // pre-change late-root rule bounded it) is armed.
    assert_eq!(
        book.lock().unwrap().ancestor.as_deref(),
        Some(home.as_path()),
        "the ancestor fast path is armed while the root is absent"
    );

    // Depth-corrected routing: a sibling of the root observed through the
    // ancestor watch is NOT a structural depth below the root — it must not
    // cascade, arm, or publish (one fixed negative window collects every
    // straggler, the established idiom).
    std::fs::write(home.join("keys.env"), b"x").unwrap();
    tokio::time::sleep(Duration::from_millis(700)).await;
    {
        let b = book.lock().unwrap();
        assert!(b.absent.contains(&projects));
        assert!(b.armed.is_empty(), "nothing misroutes: {:?}", b.armed);
    }

    // The root appears — with a session created underneath it in the same
    // step. The 3600s tick cannot fire inside this test.
    let returned = write_amplifier_session(&home, "p", "cc2584be-9478-4801-a62d-4e5da428b3a0");
    tokio::time::timeout(Duration::from_secs(5), rx.changed())
        .await
        .expect("the root's return is observed promptly via the ancestor watch, not the rearm tick")
        .unwrap();
    {
        let b = book.lock().unwrap();
        assert!(b.armed.contains(&projects), "returned root re-armed");
        assert!(b.armed.contains(&projects.join("p").join("sessions")));
        assert!(
            b.armed.contains(&returned),
            "the return cascade armed the session created while absent"
        );
        assert!(!b.absent.contains(&projects));
        assert!(
            b.ancestor.is_none(),
            "the ancestor watch unwatches once the root stands"
        );
    }
    let snap = index.snapshot().await;
    assert!(
        snap.iter()
            .any(|s| s.provider == "amplifier"
                && s.session_id == "cc2584be-9478-4801-a62d-4e5da428b3a0"),
        "visible first-line — the pre-change zero-latency parity"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// The ancestor-watch convergence itself, driven without a loop: absent ⇒
/// armed, live (a `Create(<projects>)` surfaces through it), never the root
/// itself as its own ancestor, never a path below nothing, and dropped once
/// the root stands — with the absence bookkeeping intact throughout. D3-1:
/// a root PRESENT at sync time (it appeared while no ancestor watch was
/// live, so its creation queued no event) is NEVER left tick-owned — the
/// sync hands the caller the full root-return application, which arms root
/// + descendants immediately.
#[tokio::test]
async fn ancestor_watch_converges_with_absence_state() {
    let home = unique_temp_dir("amp-ancestor-sync");
    std::fs::create_dir_all(&home).unwrap();
    let projects = home.join("projects");
    let (tx, mut rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();

    // Absent + nothing armed ⇒ the nearest existing ancestor arms; no
    // root-return handoff while the root is genuinely missing.
    book.absent.insert(projects.clone());
    assert!(!sync_ancestor_watch(
        &mut book,
        &mut watcher,
        "amplifier",
        &projects
    ));
    assert_eq!(
        book.ancestor.as_deref(),
        Some(home.as_path()),
        "the provider home (the bound) arms as the ancestor"
    );
    assert!(book.absent.contains(&projects), "the absence stays");

    // Idempotent while converged (the fs state has not moved).
    assert!(!sync_ancestor_watch(
        &mut book,
        &mut watcher,
        "amplifier",
        &projects
    ));
    assert_eq!(book.ancestor.as_deref(), Some(home.as_path()));

    // The arm is LIVE: creating the root surfaces through it.
    let session = write_amplifier_session(&home, "p", "bb2584be-9478-4801-a62d-4e5da428b3a0");
    let seen = collect_file_paths(&mut rx, Duration::from_secs(2), |s| s.contains(&projects)).await;
    assert!(
        seen.contains(&projects),
        "the ancestor observes the root's creation: {seen:?}"
    );

    // D3-1 immediate recovery: with the root on disk but absent-booked and
    // not yet armed (here the create event is merely in flight — but the
    // SAME state arises when the creation happened with NO ancestor watch
    // live, and then no event could ever arrive), the sync does not leave
    // arming to the rearm tick: it reports the return, and the caller runs
    // the full root-return application (plan + kind-correct apply, marks
    // on) — root + structural descendants armed NOW.
    assert!(
        sync_ancestor_watch(&mut book, &mut watcher, "amplifier", &projects),
        "a root present while absent-booked and unarmed is handed to the caller, not the tick"
    );
    assert!(book.ancestor.is_none());
    assert!(book.absent.contains(&projects), "the absence is honest");
    let plan = plan_amplifier_targets(&projects).unwrap();
    apply_amplifier_return_plan(&mut book, &mut watcher, &mut outcome, &projects, &plan);
    assert!(book.armed.contains(&projects), "root armed immediately");
    assert!(
        book.armed.contains(&projects.join("p").join("sessions")),
        "the returned tree's sessions dir armed immediately"
    );
    assert!(
        book.armed.contains(&session),
        "the returned tree's session dir armed immediately"
    );
    assert!(!book.absent.contains(&projects));
    assert!(
        outcome.marks.contains(&session.join("metadata.json")),
        "the return application runs with marks on"
    );

    // The root stands (armed — a real ProjectsRoot arm also clears the
    // absence on success) ⇒ no ancestor watch, no handoff.
    arm_managed_dir(
        &mut book,
        &mut watcher,
        &mut outcome,
        "amplifier",
        &projects,
        crate::watch_plan::ArmKind::ProjectsRoot,
        false,
    );
    assert!(!book.absent.contains(&projects));
    assert!(!sync_ancestor_watch(
        &mut book,
        &mut watcher,
        "amplifier",
        &projects
    ));
    assert!(book.ancestor.is_none(), "armed root ⇒ no ancestor watch");

    // The ghost corner: nothing above the root exists ⇒ no arm, absence
    // stays (the tick owns the return — the pre-change absent-list parity).
    let ghost = unique_temp_dir("amp-ancestor-ghost").join("projects");
    book.absent.insert(ghost.clone());
    assert!(!sync_ancestor_watch(
        &mut book,
        &mut watcher,
        "amplifier",
        &ghost
    ));
    assert!(
        book.ancestor.is_none(),
        "nothing existing above the root ⇒ nothing armed"
    );
    assert!(book.absent.contains(&ghost));

    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Delta D3-1 (the ancestor sync's check→arm windows): a projects root
/// created while NO ancestor watch is live queues NO return event, so a
/// sync that merely declines (or re-arms blind) would leave the root and
/// its structural descendants unwatched until the rearm tick. The sync
/// must instead close both windows itself, the same way the stand-in swap
/// closes its check→arm TOCTOU: (a) the root present at sync ENTRY ⇒
/// hand the caller the full root-return application — never arm the root
/// as its own ancestor; (b) the root appearing between the ancestor-SELECT
/// existence walk and the ancestor ARM ⇒ the arm-then-recheck swaps to the
/// same handoff. Driven without a spawned loop by splitting the sync into
/// its production steps (select → interleave the creation → arm) — so no
/// rearm tick can be the mechanism here (no loop exists to tick; the
/// loop-level pin for the event path,
/// `absent_projects_root_creation_is_observed_via_the_ancestor_watch_not_the_tick`,
/// runs its rearm interval at 3600s for the same reason). The tick stays
/// the safety net behind both.
#[tokio::test]
async fn ancestor_sync_recovers_a_root_created_inside_the_check_to_arm_window() {
    // Window (a): the root (with a full session tree) is present at sync
    // ENTRY — it appeared between a missing-root plan and the sync, while
    // no ancestor watch was armed yet.
    let home = unique_temp_dir("amp-ancestor-window-a");
    std::fs::create_dir_all(&home).unwrap();
    let projects = home.join("projects");
    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();
    book.absent.insert(projects.clone());
    let session = write_amplifier_session(&home, "p", "aa2584be-9478-4801-a62d-4e5da428b3a0");
    assert!(
        sync_ancestor_watch(&mut book, &mut watcher, "amplifier", &projects),
        "window (a): the sync reports the present root instead of declining"
    );
    assert!(
        book.ancestor.is_none(),
        "window (a): no ancestor is armed for a creation that already happened"
    );
    assert!(book.absent.contains(&projects), "the absence is honest");
    // The caller's production recovery: the full root-return application
    // (plan + kind-correct apply, marks on — the rearm tick's own shape).
    let plan = plan_amplifier_targets(&projects).unwrap();
    apply_amplifier_return_plan(&mut book, &mut watcher, &mut outcome, &projects, &plan);
    assert!(book.armed.contains(&projects), "root armed immediately");
    assert!(
        book.armed.contains(&projects.join("p").join("sessions")),
        "sessions dir armed immediately"
    );
    assert!(
        book.armed.contains(&session),
        "session dir armed immediately"
    );
    assert!(!book.absent.contains(&projects));
    assert!(
        outcome.marks.contains(&session.join("metadata.json")),
        "the recovery runs with marks on"
    );

    // Window (b): the root appears between the SELECT and the ARM halves of
    // the sync — driven deterministically through the production steps with
    // the creation interleaved in the gap.
    let home_b = unique_temp_dir("amp-ancestor-window-b");
    std::fs::create_dir_all(&home_b).unwrap();
    let projects_b = home_b.join("projects");
    let mut book_b = ManagedBook::default();
    let mut outcome_b = ArmOutcome::default();
    book_b.absent.insert(projects_b.clone());
    // SELECT (production step 1): the root is missing ⇒ the provider home
    // (the bound) is selected as the ancestor.
    let selection = select_ancestor_watch(&book_b, &projects_b);
    assert!(
        matches!(&selection, AncestorSelection::Watch(target) if *target == home_b),
        "the still-missing root selects its nearest existing ancestor"
    );
    // INTERLEAVE: the root (with a full session tree) is created INSIDE the
    // check→arm window — no ancestor was armed when the creation happened.
    let session_b = write_amplifier_session(&home_b, "q", "dd2584be-9478-4801-a62d-4e5da428b3a0");
    // ARM (production step 2): the arm-then-recheck must catch the root in
    // the window and swap the just-armed ancestor for the return handoff.
    assert!(
        apply_ancestor_selection(
            &mut book_b,
            &mut watcher,
            "amplifier",
            &projects_b,
            selection
        ),
        "window (b): the arm-then-recheck reports the root that appeared in the gap"
    );
    assert!(
        book_b.ancestor.is_none(),
        "window (b): the ancestor is swapped away, not left watching blind"
    );
    // The caller's production recovery arms root + descendants immediately.
    let plan_b = plan_amplifier_targets(&projects_b).unwrap();
    apply_amplifier_return_plan(
        &mut book_b,
        &mut watcher,
        &mut outcome_b,
        &projects_b,
        &plan_b,
    );
    assert!(book_b.armed.contains(&projects_b), "root armed immediately");
    assert!(
        book_b
            .armed
            .contains(&projects_b.join("q").join("sessions")),
        "sessions dir armed immediately"
    );
    assert!(
        book_b.armed.contains(&session_b),
        "session dir armed immediately"
    );
    assert!(!book_b.absent.contains(&projects_b));
    assert!(
        outcome_b.marks.contains(&session_b.join("metadata.json")),
        "the recovery runs with marks on"
    );

    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
    std::fs::remove_dir_all(&home_b).ok();
}

/// The retry schedule is bounded exponential: 1, 2, 4, … 60s cap, no
/// overflow — asserted against the pure fn without sleeping.
#[test]
fn retry_backoff_doubles_to_a_sixty_second_cap() {
    assert_eq!(retry_backoff(0), Duration::from_secs(1));
    assert_eq!(retry_backoff(1), Duration::from_secs(2));
    assert_eq!(retry_backoff(2), Duration::from_secs(4));
    assert_eq!(retry_backoff(4), Duration::from_secs(16));
    assert_eq!(retry_backoff(6), Duration::from_secs(60), "hits the cap");
    assert_eq!(retry_backoff(7), Duration::from_secs(60), "capped");
    assert_eq!(retry_backoff(100), Duration::from_secs(60), "no overflow");
}

// ---------- removes / renames / resource alarms ----------

/// Regression 13: `mv` of a root session dir within the same sessions/ dir
/// shows up as Name(Both) (or From+To); the new basename is re-armed
/// first-line and its files keep producing events.
#[tokio::test]
async fn renamed_root_session_dir_is_rearmed_immediately() {
    let home = unique_temp_dir("amp-rename");
    let old = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(book.lock().unwrap().armed.contains(&old));

    let new = old
        .parent()
        .unwrap()
        .join("aa2584be-9478-4801-a62d-4e5da428b3a0");
    std::fs::rename(&old, &new).unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let b = book.lock().unwrap();
                if b.armed.contains(&new) && !b.armed.contains(&old) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("renamed session dir re-armed first-line, old entry forgotten");

    // Keep proving the new watch is live: a transcript append refreshes
    // the index without a provider discover.
    std::fs::write(
        new.join("transcript.jsonl"),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
    )
    .unwrap();
    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(changed.is_ok(), "events flow through the re-armed watch");
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// LB-01 probe (notify 6.1.1): renaming an ARMED session dir emits the
/// tracked From/To/Both trio AND a 4th, UNTRACKED duplicate `Name(From)`
/// on the old path (notify's mapping of the child watch's IN_MOVE_SELF),
/// arriving after the trio. Structural-remove handling must be idempotent:
/// the duplicate re-processes a path already removed from every
/// bookkeeping set.
#[tokio::test]
async fn armed_child_rename_duplicate_name_from_is_idempotent() {
    let home = unique_temp_dir("amp-rename-idem");
    let old = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(book.lock().unwrap().armed.contains(&old));

    let new = old
        .parent()
        .unwrap()
        .join("aa2584be-9478-4801-a62d-4e5da428b3a0");
    std::fs::rename(&old, &new).unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let b = book.lock().unwrap();
                if b.armed.contains(&new) && !b.armed.contains(&old) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("renamed dir re-armed under the new path, old forgotten");
    // Settle past the 4th, untracked duplicate Name(From) (it arrives
    // after the trio), then re-assert the settled bookkeeping.
    tokio::time::sleep(Duration::from_millis(300)).await;
    {
        let b = book.lock().unwrap();
        assert_eq!(
            b.armed.iter().filter(|p| **p == new).count(),
            1,
            "exactly one armed entry for the new path"
        );
        assert!(
            !b.armed.contains(&old),
            "duplicate From re-removal is a no-op"
        );
        assert!(!b.absent.contains(&old) && !b.retry.contains_key(&old));
        // No double-WARN is structural on this path: re-processing the
        // duplicate From hits only the book-miss no-op and
        // `unwatch_tolerated`'s debug-tier tolerated arm (the managed-set
        // auto-drop makes unwatch of the moved path return WatchNotFound)
        // — no warn site is reachable, so there is no log to count.
    }

    // Events from the renamed dir keep flowing (the duplicate From did not
    // tear down the fresh arm).
    let _ = rx.borrow_and_update();
    std::fs::write(
        new.join("transcript.jsonl"),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
    )
    .unwrap();
    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(changed.is_ok(), "events flow through the re-armed watch");
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 8 (first half): removing a watched session dir prunes its row
/// promptly (scoped metadata.json mark → stat None → prune) and forgets all
/// bookkeeping.
#[tokio::test]
async fn session_dir_removal_prunes_rows_and_forgets_bookkeeping() {
    let home = unique_temp_dir("amp-sessrm");
    let victim = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();
    let snap0 = index.snapshot().await;
    assert_eq!(
        snap0.iter().filter(|s| s.provider == "amplifier").count(),
        1
    );
    tokio::time::sleep(Duration::from_millis(300)).await;

    std::fs::remove_dir_all(&victim).unwrap();

    let mut pruned = false;
    for _ in 0..50 {
        if index
            .snapshot()
            .await
            .iter()
            .filter(|s| s.provider == "amplifier")
            .count()
            == 0
            && !book.lock().unwrap().armed.contains(&victim)
        {
            pruned = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(pruned, "row pruned AND watch bookkeeping forgotten");
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 16: structural removal of a whole project cleans armed/absent/
/// retry bookkeeping (no forever-retrying entries after project deletion).
#[tokio::test]
async fn project_move_or_remove_cleans_all_bookkeeping() {
    let home = unique_temp_dir("amp-projrm");
    let proj = home.join("projects").join("doomed");
    let sess = write_amplifier_session(&home, "doomed", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Seed a retry entry under the project to prove cleanup reaches it.
    book.lock().unwrap().retry.insert(
        proj.join("should_never_exist"),
        RetryEntry {
            failures: 1,
            next_attempt: std::time::Instant::now(),
            kind: crate::watch_plan::ArmKind::SessionDir,
        },
    );
    assert!(book.lock().unwrap().armed.contains(&sess));

    std::fs::remove_dir_all(&proj).unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let b = book.lock().unwrap();
                let proj_prefix = proj.to_path_buf();
                let clean = !b.armed.iter().any(|p| p.starts_with(&proj_prefix))
                    && !b.absent.iter().any(|p| p.starts_with(&proj_prefix))
                    && !b.retry.keys().any(|p| p.starts_with(&proj_prefix));
                if clean {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("project subtree dropped from armed/absent/retry");
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 16 second clause: a session dir `mv`'d OUT of the watched
/// tree is explicitly unwatched (inotify watches follow inodes — without
/// this, events keep arriving under the stale old path forever).
/// Caveat (LB-01 sub-claim 3 nuance): in the managed-set shape the parent
/// arm's MOVED_FROM auto-drops the old-path watch, so the negative window
/// below cannot catch a MISSING explicit-unwatch regression (post-move
/// writes would be silent either way); the explicit unwatch stays as
/// belt-and-braces for the unowned-parent (inode-follow) shape.
#[tokio::test]
async fn moved_away_session_dir_is_explicitly_unwatched() {
    let home = unique_temp_dir("amp-mvout");
    let sess = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let outside = home.join("outside-escaped-session");
    std::fs::rename(&sess, &outside).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !book
                .lock()
                .unwrap()
                .armed
                .iter()
                .any(|p| p.ends_with("012584be-9478-4801-a62d-4e5da428b3a0"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("moved-away dir forgotten");

    // Writing where the dir moved to must produce NO further index traffic
    // (the watch would still fire under the stale path if it leaked).
    let _ = rx.borrow_and_update(); // clear any pending
    std::fs::write(outside.join("transcript.jsonl"), "{\"type\":\"user\"}\n").unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(700), rx.changed())
            .await
            .is_err(),
        "no events from an unwatched inode"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// 25% watch-budget WARN: pure verdict + real procfs probe.
#[test]
fn watch_budget_warn_needed_trips_only_above_a_quarter_of_the_limit() {
    assert!(!watch_budget_warn_needed(524_288 / 4, 524_288));
    assert!(watch_budget_warn_needed(524_288 / 4 + 1, 524_288));
    assert!(!watch_budget_warn_needed(2, 524_288));
    // Real machine (Linux/WSL always has procfs here): parser sanity.
    if std::path::Path::new("/proc/sys/fs/inotify/max_user_watches").exists() {
        let max = read_max_user_watches().expect("parse the kernel limit");
        assert!(max > 1_000);
    }
}

/// Delta-review D1-4: the drift alarm counts unknown-format dirs that were
/// actually ARMED — never arm ATTEMPTS. An unknown-format dir whose arm
/// fails transiently (EACCES here: the replan-abort test's chmod-000 idiom)
/// retries on the capped-backoff drain; if each attempt counted, ONE dir
/// that never acquires a watch would eventually trip the "50 unknown-format
/// dirs armed" WARN without a single watch existing. Count only successful
/// arms.
#[test]
fn unknown_format_transient_arm_failures_never_count_as_drift() {
    use std::os::unix::fs::PermissionsExt;
    let home = unique_temp_dir("amp-drift-transient");
    let sessions = home.join("projects").join("p").join("sessions");
    let oddball = sessions.join("oddball-format"); // neither UUID nor subagent-pattern ⇒ Unknown
    std::fs::create_dir_all(&oddball).unwrap();
    std::fs::set_permissions(&oddball, std::fs::Permissions::from_mode(0o000)).unwrap();

    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();

    // Same euid guard as `replan_aborts_and_keeps_armed_set_on_planner_error`:
    // root can watch a 0o000 dir, voiding the transient-error simulation.
    if watch_path(
        &mut watcher,
        "amplifier",
        &oddball,
        notify::RecursiveMode::NonRecursive,
    )
    .is_ok()
    {
        eprintln!("skipping: euid can watch a 0o000 dir");
        unwatch_tolerated(&mut watcher, "amplifier", &oddball);
        std::fs::set_permissions(&oddball, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&home).ok();
        return;
    }

    // Three repeated attempts (the retry drain re-arms through this same
    // first-line helper): each fails transiently and re-enters retry.
    for _ in 0..3 {
        arm_managed_dir(
            &mut book,
            &mut watcher,
            &mut outcome,
            "amplifier",
            &oddball,
            ArmKind::SessionDir,
            true,
        );
    }
    assert!(
        !book.armed.contains(&oddball) && book.retry.contains_key(&oddball),
        "transient failures never arm, always re-enter retry"
    );
    assert_eq!(
        book.drift.count, 0,
        "a dir that never acquired a watch must NOT count toward the drift alarm"
    );

    // The success half: once it DOES arm, the unknown-format arm counts
    // exactly once (the threshold test's semantics stay on real arms).
    std::fs::set_permissions(&oddball, std::fs::Permissions::from_mode(0o755)).unwrap();
    arm_managed_dir(
        &mut book,
        &mut watcher,
        &mut outcome,
        "amplifier",
        &oddball,
        ArmKind::SessionDir,
        true,
    );
    assert!(book.armed.contains(&oddball));
    assert_eq!(
        book.drift.count, 1,
        "a SUCCESSFUL unknown-format arm counts exactly once"
    );
    std::fs::remove_dir_all(&home).ok();
}

/// Drift alarm: daily-bucketed, warns once per day on crossing.
#[test]
fn unknown_format_drift_alarm_is_daily_bucketed() {
    let mut counter = DailyCounter::default();
    let day0 = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000u64);
    // Below the threshold: quiet.
    for _ in 0..DRIFT_DAILY_WARN_THRESHOLD - 1 {
        assert!(counter.note_unknown_arm(day0).is_none());
    }
    // Crossing: exactly one WARN.
    assert!(counter.note_unknown_arm(day0).is_some());
    assert!(
        counter.note_unknown_arm(day0).is_none(),
        "warn once per day"
    );
    // Next day: fresh budget.
    let day1 = day0 + Duration::from_secs(86_400);
    assert!(counter.note_unknown_arm(day1).is_none());
}

/// Projects-root absence lifecycle (design: "Only the provider root itself
/// re-enters absence tracking when it disappears"): deleting the ARMED
/// projects root routes it from `armed` to `absent` via the DEPTH-0
/// self-removal (the kernel surfaces it tagless — LB-01 `Remove(File)`),
/// with the subtree's bookkeeping wiped AND the late-root ancestor fast
/// path armed (delta D2-2); re-creating the root re-arms it — observed via
/// the ancestor watch, with the rearm tick as the safety net — and the FULL
/// structural cascade (plan + apply, `emit_marks: true`) arms sessions
/// created while the root was absent — first-line, without waiting for the
/// 15-minute reconcile.
#[tokio::test]
async fn deleted_projects_root_enters_absence_and_rearms_with_full_cascade_on_return() {
    let home = unique_temp_dir("amp-rootabsent");
    let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let _ = session;
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home).with_rearm_interval(1);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    let projects = home.join("projects");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.contains(&projects) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("projects root armed at startup");

    // Delete the whole root: the depth-0 self-removal routes it to absent
    // and wipes the subtree bookkeeping.
    std::fs::remove_dir_all(&projects).unwrap();
    // The teardown's provider-dirty publish lands first (generation bump);
    // consume it so the later `changed()` await is the RETURN's publish.
    let _ = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let gone = {
                let b = book.lock().unwrap();
                b.absent.contains(&projects)
                    && !b.armed.iter().any(|p| p.starts_with(&projects))
                    && !b.retry.keys().any(|p| p.starts_with(&projects))
            };
            if gone {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("deleted root enters absent; whole subtree forgotten");
    assert_eq!(
        book.lock().unwrap().ancestor.as_deref(),
        Some(home.as_path()),
        "the late-root ancestor fast path arms the moment the root vanishes (the tick is only the backstop)"
    );

    // Re-create the root WITH a session while it is tracked absent — this
    // session was created while NO watch covered it, so only the
    // absent → re-arm full cascade can pick it up first-line.
    let _ = rx.borrow_and_update();
    let returned = write_amplifier_session(&home, "p", "bb2584be-9478-4801-a62d-4e5da428b3a0");
    tokio::time::timeout(Duration::from_secs(8), rx.changed())
        .await
        .expect("the return cascade's marks refresh the index promptly (1s rearm tick)")
        .unwrap();
    {
        let b = book.lock().unwrap();
        assert!(b.armed.contains(&projects), "returned root re-armed");
        assert!(b.armed.contains(&projects.join("p").join("sessions")));
        assert!(
            b.armed.contains(&returned),
            "session created during the absence armed by the cascade"
        );
        assert!(!b.absent.contains(&projects));
    }
    let snap = index.snapshot().await;
    assert!(
        snap.iter()
            .any(|s| s.provider == "amplifier"
                && s.session_id == "bb2584be-9478-4801-a62d-4e5da428b3a0"),
        "the returned session is visible without waiting for the reconcile"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// The 25% watch-budget WARN is edge-triggered and re-evaluated after
/// EVERY arm batch (startup apply, cascade, retry drain, replan,
/// absent-return), not only at startup: crossing ≤25% → >25% warns exactly
/// once, staying above stays quiet, and falling back below re-arms the
/// edge so the NEXT crossing warns again. The kernel limit is injected —
/// no procfs dependency and no real 4.4K-arm corpus needed.
#[test]
fn watch_budget_warn_fires_once_per_crossing_and_rearms_below() {
    let max = 100usize; // injected max_user_watches (test-only injection)
    let mut warned = false;
    // Exactly 1/4 (25 of 100): NOT above the quarter — no warn.
    let (w, emit) = watch_budget_edge(warned, 25, max);
    assert!(!emit, "at exactly the quarter: silent");
    warned = w;
    // Cross above: the edge fires exactly once.
    let (w, emit) = watch_budget_edge(warned, 26, max);
    assert!(emit, "crossing above 25% warns");
    warned = w;
    // More arms while already warned: no per-arm spam.
    let (w, emit) = watch_budget_edge(warned, 40, max);
    assert!(!emit, "already warned: silent");
    warned = w;
    // Falling back below re-arms the edge silently...
    let (w, emit) = watch_budget_edge(warned, 20, max);
    assert!(!emit, "falling back below: silent");
    warned = w;
    // ...and the next crossing warns again.
    let (_, emit) = watch_budget_edge(warned, 27, max);
    assert!(emit, "re-armed edge warns on the next crossing");
}

// ---------- file-depth routing ----------

/// Regression 5: sidecar/tmp/backup churn inside a watched root session dir
/// produces scoped metadata.json marks — never provider-dirty; steady
/// activity triggers no repeated full discovers.
#[tokio::test]
async fn amplify_file_depth_events_route_to_scoped_metadata_marks_and_never_escalate() {
    use std::sync::atomic::Ordering;
    let home = unique_temp_dir("amp-filedepth");
    let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let amplifier = crate::amplifier::AmplifierSource::new(home.clone());
    let wrapped = crate::directory_index::tests::CountingWrapper::new(amplifier);
    let (discover_calls, _, _, _) = crate::directory_index::tests::wrapper_counters(&wrapped);
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(wrapped) as Arc<dyn crate::directory_index::SessionSource>],
        Duration::from_secs(3600),
        None,
    ));
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(book.lock().unwrap().armed.contains(&session));
    let baseline_discovers = discover_calls.load(Ordering::SeqCst);

    // Steady heavy activity: sidecar append + tmp+rename metadata (VALID
    // content, so the row stays) + backup + the other sidecar.
    std::fs::write(session.join("transcript.jsonl"), "{\"type\":\"user\"}\n").unwrap();
    std::fs::write(
        session.join("metadata.json.tmp"),
        r#"{"session_id":"s1","working_dir":"/p/p","created":"2026-03-01T00:00:00.000Z","name":"t2"}"#,
    )
    .unwrap();
    std::fs::rename(
        session.join("metadata.json.tmp"),
        session.join("metadata.json"),
    )
    .unwrap();
    std::fs::write(session.join("metadata.json.backup"), b"{}").unwrap();
    std::fs::write(session.join("events.jsonl"), "{}\n").unwrap();

    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(changed.is_ok(), "scoped marks refresh the index");
    let mut settles = 0;
    for _ in 0..20 {
        if !index.has_dirty() {
            settles += 1;
            if settles >= 2 {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        discover_calls.load(Ordering::SeqCst) == baseline_discovers,
        "no repeated full discovers: baseline {baseline_discovers}, now {}",
        discover_calls.load(Ordering::SeqCst)
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 6: a `context-intelligence/` mkdir inside a session dir
/// results in NO index activity at all (dropped at depth 4). The pins are
/// OBSERVABLE WORK, not just the generation wait: a directory created at
/// depth 4 must produce NO scoped mark (`stat_scoped_calls` never moves —
/// had the mkdir been rewritten to a metadata.json mark, the background
/// refresh would have stat'ed it) AND no provider-scan work
/// (`discover_calls` never moves — an erroneous escalation's discover over
/// identical content would not bump the generation, so the receiver timeout
/// alone would be vacuous). The `WatchKind::CreateFolder` distinction
/// (Task 2) is what lets this routing exist.
#[tokio::test]
async fn mkdir_inside_watched_session_dir_is_dropped_no_discover() {
    use std::sync::atomic::Ordering;
    let home = unique_temp_dir("amp-mkdir-drop");
    let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let counted = counted_amplifier_index(&home);
    let index = counted.index.clone();
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(book.lock().unwrap().armed.contains(&session));
    let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);
    let baseline_scoped_stats = counted.stat_scoped_calls.load(Ordering::SeqCst);

    std::fs::create_dir_all(session.join("context-intelligence")).unwrap();
    std::fs::write(
        session.join("context-intelligence").join("index.json"),
        b"{}",
    )
    .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(800), rx.changed())
            .await
            .is_err(),
        "folder mkdir + its contents never reach the index"
    );
    // Past the 200ms debounce flush and the fire-and-forget refresh: the
    // mkdir produced no mark and no sweep.
    assert_eq!(
        counted.discover_calls.load(Ordering::SeqCst),
        baseline_discovers,
        "no discover ran for the depth-4 mkdir"
    );
    assert_eq!(
        counted.stat_scoped_calls.load(Ordering::SeqCst),
        baseline_scoped_stats,
        "no scoped stat ran — the mkdir created NO mark either"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 14b: events under a stand-in watch that aren't `sessions/`
/// (the real `{project}/recipe-sessions/` tree) are dropped by default.
/// Same observable-work pins as the other negative tests: neither a
/// discover nor a scoped stat may run for the dropped tree.
#[tokio::test]
async fn standin_project_children_other_than_sessions_are_dropped() {
    use std::sync::atomic::Ordering;
    let home = unique_temp_dir("amp-standin-drop");
    let proj = home.join("projects").join("{project}");
    std::fs::create_dir_all(&proj).unwrap(); // stand-in target
    let counted = counted_amplifier_index(&home);
    let index = counted.index.clone();
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(book.lock().unwrap().armed.contains(&proj));
    let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);
    let baseline_scoped_stats = counted.stat_scoped_calls.load(Ordering::SeqCst);

    let odd = proj.join("recipe-sessions").join("nested");
    std::fs::create_dir_all(&odd).unwrap();
    std::fs::write(odd.join("data.json"), b"{}").unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(800), rx.changed())
            .await
            .is_err(),
        "recipes tree is dropped"
    );
    assert_eq!(
        counted.discover_calls.load(Ordering::SeqCst),
        baseline_discovers,
        "no discover ran for dropped stand-in children"
    );
    assert_eq!(
        counted.stat_scoped_calls.load(Ordering::SeqCst),
        baseline_scoped_stats,
        "no scoped mark was created for dropped stand-in children"
    );
    // And nothing under it got armed.
    {
        let b = book.lock().unwrap();
        assert!(!b
            .armed
            .iter()
            .any(|p| p.to_string_lossy().contains("recipe-sessions")));
    } // guard released before the async stop-and-join
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

// ---------- debounce cap + rescan replan ----------

/// Regression 10: a sustained sub-200ms event stream can no longer starve
/// the flush — it fires within the 2s max-deferral cap even while events
/// keep arriving. Timing discipline (the crate's real-time idiom, with
/// margins so a CORRECT implementation can never flake this): measure from
/// the stream's start (the first write lands ~immediately after spawn,
/// milliseconds before the first event is processed); the outer timeout is
/// 5s — comfortably larger than the 2s cap, so it can only trip on a
/// genuinely starved flush, never on a correct cap-limited one; the cap
/// assertion itself carries 500ms of notify/scheduling slack.
#[tokio::test]
async fn sustained_sub_gap_event_stream_flushes_within_max_deferral() {
    let home = unique_temp_dir("amp-debounce-cap");
    let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Producer: 100ms-spaced sidecar writes; spans ~3s of continuous input.
    let transcript = session.join("transcript.jsonl");
    let stream_started = tokio::time::Instant::now();
    let producer = tokio::spawn(async move {
        for i in 0..28u32 {
            std::fs::write(&transcript, format!("{{\"i\":{i}}}\n")).unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    // Without the cap the flush lands at producer-end (~2.8s) + 200ms quiet
    // gap ≈ 3.0s from stream start; with it, ≈2s after the first event.
    tokio::time::timeout(Duration::from_secs(5), rx.changed())
        .await
        .expect("flush never starves past 5s (outer timeout ≫ 2s cap)")
        .unwrap();
    let elapsed = stream_started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(150),
        "the 200ms quiet gap is still respected (asserted with 50ms slack): {elapsed:?}"
    );
    assert!(
        elapsed <= Duration::from_millis(2_500),
        "flush within cap + 500ms slack of the stream start (first event ≈ start): {elapsed:?}"
    );
    producer.abort();
    let _ = producer.await;
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// need_rescan (IN_Q_OVERFLOW) on amplifier = full watch-set replan AND
/// provider dirty; on claude it stays provider-dirty only.
#[tokio::test]
async fn need_rescan_on_amplifier_replans_the_watch_set() {
    let home = unique_temp_dir("amp-replan");
    let _s1 = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    // The event channel is allocated at construction (Interfaces), so the
    // sender is valid BEFORE start() — this ordering is intentional.
    let tx = watcher.test_event_tx().expect("test event seam");
    let handle = watcher.start();
    let _ = index.snapshot().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let initial_replans = book.lock().unwrap().replans;

    // Inject a synthetic queue-overflow rescan for amplifier.
    tx.send(WatchEvent::ProviderRescan {
        provider: "amplifier".to_string(),
    })
    .unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().replans > initial_replans {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("rescan triggered a replan");
    // Bookkeeping is still consistent afterwards.
    assert!(book.lock().unwrap().armed.contains(&_s1));
    // The permanent projects-root watch survives the replan — the desired
    // kind-map includes `{ projects_root → ProjectsRoot }` whenever the
    // root exists, so the diff can never classify the structural root
    // watch as stale and unwatch it.
    assert!(
        book.lock().unwrap().armed.contains(&home.join("projects")),
        "the structural projects-root watch is never replanned away"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Replan abort discipline, two phases: (1) a chmod-000 projects root
/// propagates EACCES from `open_root_dir`; (2) the NESTED partial-scan
/// case — root and project listable, `p/sessions` unreadable, which Task
/// 1's strict planner turns into a whole-plan `Err` rather than a partial
/// plan. In both, the replan ABORTS — no arm/unwatch diff is applied, the
/// armed set and all bookkeeping stay untouched, `book.replans` (APPLIED
/// replans only) does not move — while the provider-dirty mark STILL
/// fires, observable in phase 1 as a recorded `amplifier` scan failure via
/// discover's own root-listing protection.
#[cfg(unix)]
#[tokio::test]
async fn replan_aborts_and_keeps_armed_set_on_planner_error() {
    use std::os::unix::fs::PermissionsExt;
    let home = unique_temp_dir("amp-replan-abort");
    let s1 = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    // Construction-time channel: the sender is valid before start().
    let tx = watcher.test_event_tx().expect("test event seam");
    let handle = watcher.start();
    let _ = index.snapshot().await;
    assert!(index.scan_failures().is_empty());
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut armed_before: Vec<PathBuf> = book.lock().unwrap().armed.iter().cloned().collect();
    armed_before.sort();
    let replans_before = book.lock().unwrap().replans;
    assert!(armed_before.iter().any(|p| p == &s1));

    // Transient planner failure: the projects root becomes UNLISTABLE.
    // (stat still succeeds — only read_dir fails — so the rearm tick sees
    // `exists() == true` and does not churn the armed set.)
    let projects = home.join("projects");
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read_dir(&projects).is_ok() {
        eprintln!("skipping planner-error assertions: euid can list a 0o000 dir");
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
        watcher.stop();
        let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        std::fs::remove_dir_all(&home).ok();
        return;
    }

    tx.send(WatchEvent::ProviderRescan {
        provider: "amplifier".to_string(),
    })
    .unwrap();

    // The provider-dirty mark STILL fired: discover's root-listing
    // protection records a scan failure instead of gutting the snapshot
    // (data plane recovers through discover's own protection).
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if index.scan_failures().iter().any(|n| n == "amplifier") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("provider dirty still fired (amplifier scan failure recorded)");

    // The ABORT left every watch-set facet untouched: no arm/unwatch diff
    // was applied, bookkeeping is unchanged, and the applied-only replan
    // counter did not increment.
    {
        let b = book.lock().unwrap();
        let mut armed_after: Vec<PathBuf> = b.armed.iter().cloned().collect();
        armed_after.sort();
        assert_eq!(armed_after, armed_before, "aborted replan applies no diff");
        assert!(b.absent.is_empty() && b.retry.is_empty());
        assert_eq!(
            b.replans, replans_before,
            "book.replans counts APPLIED replans only"
        );
    }

    // Phase 2 — the NESTED partial-scan case: the projects root lists fine
    // and project `p` lists fine, but `p/sessions` is unreadable. Task 1's
    // strict planner fails the WHOLE plan on this (no partial plan), so the
    // replan must abort identically — before the strict-everywhere contract
    // this shape silently produced a partial plan whose unwatch diff would
    // tear down p's healthy root-session watch.
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
    let sessions = projects.join("p").join("sessions");
    std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o000)).unwrap();
    tx.send(WatchEvent::ProviderRescan {
        provider: "amplifier".to_string(),
    })
    .unwrap();
    // Bounded settle (the suite's negative-window idiom): long enough for a
    // buggy diff-applying replan to have run, then assert nothing changed.
    tokio::time::sleep(Duration::from_millis(700)).await;
    {
        let b = book.lock().unwrap();
        let mut armed_nested: Vec<PathBuf> = b.armed.iter().cloned().collect();
        armed_nested.sort();
        assert_eq!(
            armed_nested, armed_before,
            "nested scan error also aborts: the armed set is untouched"
        );
        assert!(b.absent.is_empty() && b.retry.is_empty());
        assert_eq!(b.replans, replans_before, "still no applied replan");
    }
    std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o755)).unwrap();

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// The replan applies arm diffs KIND-CORRECTLY (never flattened): a
/// `sessions/` dir first discovered by the REPLAN (not startup, not an
/// event cascade — its create events were lost) is armed as
/// `ArmKind::SessionsDir`, so the arm CASCADES: its root-session children
/// are armed first-line and their scoped metadata.json marks are emitted.
/// A flattened bare-path arm would leave those children unwatched —
/// silent staleness against the hard zero-latency requirement. Driven
/// through the sync core with the established no-loop idiom.
#[tokio::test]
async fn replan_arms_newly_appeared_sessions_dir_kind_correctly_with_cascade() {
    let home = unique_temp_dir("amp-replan-kind");
    let session = write_amplifier_session(&home, "late", "550e8400-e29b-41d4-a716-4466554400aa");
    let metadata = session.join("metadata.json");
    let projects_root = home.join("projects");
    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    // Seed the book as if startup armed ONLY the projects root (the `late`
    // project appeared later and its events were lost — the replan is the
    // recovery path, so nothing below the root is armed yet).
    book.armed.insert(projects_root.clone());
    let mut outcome = ArmOutcome::default();

    let applied = replan_amplifier_watch_set(
        &mut book,
        &mut watcher,
        &mut outcome,
        &projects_root,
        "amplifier",
    );

    let sessions_dir = projects_root.join("late").join("sessions");
    assert!(applied, "a clean plan applies");
    assert!(book.armed.contains(&sessions_dir), "sessions dir armed");
    assert!(
        book.armed.contains(&session),
        "the kind-correct arm CASCADED: the root-session child is armed"
    );
    assert!(
        outcome.marks.contains(&metadata),
        "watch-then-scan: the cascaded session's scoped mark was emitted"
    );
    assert!(
        outcome.provider_dirty,
        "the replan escalates provider dirty"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Whole-branch review Finding 1: the replan's unwatch cleanup must SPARE
/// the entries it armed (or retained) in the same apply. The arm loop runs
/// before the unwatch loop, and a prefix wipe of a stale stand-in would
/// otherwise drop the freshly-armed `<proj>/sessions` (and its cascaded
/// root session) out of the book while their KERNEL watches stay live —
/// an unwatch of the parent drops nothing else — desyncing the ledger
/// from the kernel (the depth-2 swap-back gate misfires, project teardown
/// misses the live watches, the budget WARN undercounts). The corner is
/// the replan's own purpose made concrete: `<proj>` sits armed as a
/// STAND-IN while on disk `<proj>/sessions` + a root session already
/// exist (the depth-2 create event was lost).
#[tokio::test]
async fn replan_unwatch_cleanup_spares_desired_armed_descendants() {
    let home = unique_temp_dir("amp-replan-spare");
    let projects_root = home.join("projects");
    let project = projects_root.join("p");
    std::fs::create_dir_all(&project).unwrap();
    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();
    // Pre-arm `<proj>` as a REAL stand-in (no `sessions/` yet): the kernel
    // watch is live, exactly as in the lost-event corner.
    arm_sessions_or_standin(&mut book, &mut watcher, &mut outcome, &project, false);
    assert!(book.armed.contains(&project), "stand-in pre-armed");
    // The lost depth-2 event: `sessions/` + a root session appear silently.
    let session = write_amplifier_session(&home, "p", "550e8400-e29b-41d4-a716-4466554400aa");
    let sessions_dir = project.join("sessions");

    let applied = replan_amplifier_watch_set(
        &mut book,
        &mut watcher,
        &mut outcome,
        &projects_root,
        "amplifier",
    );

    assert!(applied, "a clean plan applies");
    assert!(
        !book.armed.contains(&project),
        "the stale stand-in IS unwatched (it is not desired)"
    );
    assert!(
        book.armed.contains(&sessions_dir),
        "the sessions dir the replan JUST armed (kernel-live) must stay in the book"
    );
    assert!(
        book.armed.contains(&session),
        "the cascaded root session (kernel-live) must stay in the book"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Finding 1, retry corner: the same prefix wipe also silently DROPPED a
/// retry entry under the stale stand-in — breaching the "backoff never
/// bypassed" design letter on the replan path. Here `<proj>/sessions`
/// sits in `retry` (a transient arm failure — reachable when the depth-2
/// create's swap arm failed transiently, which leaves the stand-in armed)
/// while `<proj>` is still armed as a stand-in and `sessions/` + a root
/// session exist on disk. The replan must NOT arm the backed-off sessions
/// dir (backoff is never bypassed) and must NOT wipe its retry entry
/// either: the desired-aware cleanup spares every book entry that is a
/// key of the desired map, whichever set it lives in.
#[tokio::test]
async fn replan_unwatch_cleanup_spares_desired_retry_entries() {
    let home = unique_temp_dir("amp-replan-spare-retry");
    let session = write_amplifier_session(&home, "p", "550e8400-e29b-41d4-a716-4466554400aa");
    let projects_root = home.join("projects");
    let project = projects_root.join("p");
    let sessions_dir = project.join("sessions");
    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    book.armed.insert(project.clone());
    book.retry.insert(
        sessions_dir.clone(),
        RetryEntry {
            failures: 1,
            next_attempt: Instant::now() + Duration::from_secs(60),
            kind: ArmKind::SessionsDir,
        },
    );
    let mut outcome = ArmOutcome::default();

    let applied = replan_amplifier_watch_set(
        &mut book,
        &mut watcher,
        &mut outcome,
        &projects_root,
        "amplifier",
    );

    assert!(applied, "a clean plan applies");
    assert!(
        !book.armed.contains(&project),
        "the stale stand-in IS unwatched (it is not desired)"
    );
    assert!(
        !book.armed.contains(&sessions_dir),
        "backoff is never bypassed: the retrying sessions dir is NOT re-armed"
    );
    assert!(
        book.retry.contains_key(&sessions_dir),
        "backoff is never silently dropped: the retry entry survives the unwatch cleanup"
    );
    assert!(
        book.armed.contains(&session),
        "the root session dir (desired, armed this apply) stays in the book"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

// ---------- refresh→watcher self-correction channel (misnamed-root recovery) ----------

// Regression 4 (round trip): a subagent-NAMED dir holding root CONTENT
// (parent_id absent) is name-classified as subagent → never armed at
// startup — and is recovered by the refresh→watcher report. The
// not-armed-then-armed sequence is observed WITHOUT sleeps or races:
// phase 1 asserts the startup classification BEFORE any discover/snapshot
// has run (so no report can exist yet — the sink only fires from a full
// refresh, and startup itself is markless for an existing root); phase 2
// triggers the discover and awaits the arm.
#[tokio::test]
async fn misnamed_subagent_named_root_is_armed_via_refresh_report() {
    let home = unique_temp_dir("amp-misname");
    let dir = home
        .join("projects")
        .join("p")
        .join("sessions")
        .join("0000000000000000-014b6af1c2ac4ab5_actually_a_root");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("metadata.json"),
        r#"{"session_id":"mis","working_dir":"/p/x","created":"2026-03-01T00:00:00.000Z"}"#,
    )
    .unwrap();
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();

    // Phase 1 (no report can exist yet — `index.snapshot()` has not been
    // called): wait for the startup structural arm pass to complete (the
    // `p/sessions` watch is the deepest structural arm in this fixture),
    // then assert the misnamed dir is UNARMED — name classification, with
    // no report in flight to race it.
    let sessions = home.join("projects").join("p").join("sessions");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.contains(&sessions) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("startup structural arm pass completes");
    assert!(
        !book.lock().unwrap().armed.contains(&dir),
        "at startup the name says subagent ⇒ unarmed"
    );

    // Phase 2: NOW the first full discover runs — the root report fires
    // and the self-correction channel arms the misnamed root.
    let _ = index.snapshot().await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.contains(&dir) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("misnamed root armed via the refresh report");
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

// Regression 9: the diff never bypasses arm-failure backoff.
#[test]
fn roots_needing_arm_respects_retry_backoff() {
    let ghost = PathBuf::from("/tmp/amplifier-retry-ghost");
    let reported = vec![ghost.clone(), PathBuf::from("/tmp/fresh")];
    let mut armed: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut retry: std::collections::HashMap<PathBuf, RetryEntry> =
        std::collections::HashMap::new();
    retry.insert(
        ghost.clone(),
        RetryEntry {
            failures: 2,
            next_attempt: std::time::Instant::now() + Duration::from_secs(60),
            kind: crate::watch_plan::ArmKind::SessionDir,
        },
    );
    let to_arm = roots_needing_arm(&reported, &armed, &retry);
    assert_eq!(to_arm, vec![PathBuf::from("/tmp/fresh")]);

    // Rust: a dir that's already armed is also skipped.
    let report2 = vec![ghost.clone()];
    armed.insert(ghost.clone());
    assert!(roots_needing_arm(&report2, &armed, &retry).is_empty());
}

/// Companion corner the channel itself creates: a transient arm failure of
/// a channel-reported misnamed root lands in `retry` (kind `SessionDir`),
/// where first-line re-arming through `arm_managed_dir` would refuse the
/// subagent-pattern basename FOREVER (the name gate exists precisely so
/// first-line paths never arm subagent dirs). The retry drain must route
/// such entries through the channel's content-verified arm — only the
/// channel can insert a subagent-named `SessionDir` entry, so this
/// classification-free re-arm can never leak onto a real subagent dir.
#[tokio::test]
async fn retry_drain_recovers_reported_misnamed_root() {
    let home = unique_temp_dir("amp-retry-misname");
    let dir = home
        .join("projects")
        .join("p")
        .join("sessions")
        .join("0000000000000000-014b6af1c2ac4ab5_misnamed_root");
    std::fs::create_dir_all(&dir).unwrap();

    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    book.retry.insert(
        dir.clone(),
        RetryEntry {
            failures: 1,
            next_attempt: Instant::now(), // due now
            kind: crate::watch_plan::ArmKind::SessionDir,
        },
    );

    let mut outcome = ArmOutcome::default();
    arm_retry_entry(
        &mut book,
        &mut watcher,
        &mut outcome,
        "amplifier",
        &dir,
        crate::watch_plan::ArmKind::SessionDir,
    );

    assert!(
        book.armed.contains(&dir),
        "the channel-reported misnamed root is re-armed: {:?}",
        book.armed
    );
    assert!(
        book.retry.is_empty(),
        "a successful re-arm clears the retry entry"
    );
    // The kind-correct file-state watch-then-scan mark was emitted.
    assert!(outcome.marks.contains(&dir.join("metadata.json")));
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

// ---------- delta D4-1: prompt content probe for subagent-NAMED mkdirs (drift rescue) ----------

/// D4-1 corner 1 (RED at reviewed HEAD): a subagent-NAMED session dir whose
/// metadata.json is ALREADY on disk and parses with `parent_id` ABSENT is a
/// drift-case true root. Its depth-3 mkdir event must answer the name gate's
/// refusal with a prompt, single-target content probe: stat+read the one
/// metadata.json and, on positive root content, arm the dir via the
/// self-correction channel's own content-verified helper (name gate bypassed
/// exactly as the channel does) with the file-state watch-then-scan mark.
/// Drives `dispatch_amplifier_path` directly so the mkdir event's dispatch is
/// deterministic — no event-loop race can let the probe (or its absence)
/// hide behind a channel report.
#[test]
fn subagent_named_mkdir_with_root_content_arms_via_prompt_probe() {
    let home = unique_temp_dir("amp-drift-prompt");
    let projects_root = home.join("projects");
    let dir = projects_root
        .join("p")
        .join("sessions")
        .join("0000000000000000-014b6af1c2ac4ab5_drift_root");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("metadata.json"),
        r#"{"session_id":"drift-root","working_dir":"/p/x","created":"2026-03-01T00:00:00.000Z"}"#,
    )
    .unwrap();

    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();
    let interest = std::sync::atomic::AtomicUsize::new(0);
    let index = SessionIndex::with_ttl_and_cache_path(Vec::new(), Duration::from_secs(3600), None);
    let mut pending = HashMap::new();
    let mut cascades = Vec::new();
    let mut root_return = false;

    dispatch_amplifier_path(
        &mut book,
        &mut watcher,
        &mut outcome,
        &projects_root,
        &interest,
        &dir,
        WatchKind::CreateFolder,
        &mut pending,
        &index,
        &mut cascades,
        &mut root_return,
    );

    assert!(
        book.armed.contains(&dir),
        "name says subagent but content says root: the prompt content probe must arm it"
    );
    assert!(
        outcome.marks.contains(&dir.join("metadata.json")),
        "the arm carries the file-state watch-then-scan scoped mark"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// D4-1 corner 2 (RED at reviewed HEAD, metadata-LATE variant): amplifier
/// creates the session dir BEFORE writing metadata.json (the design's known
/// emit order). A drift-case root created this way must still win the prompt
/// arm: the mkdir-time probe finds no metadata and parks the dir in the
/// BOUNDED deferred set, re-probed on each flush, and the recheck that
/// observes the landed metadata.json arms it — seconds, not the 15-minute
/// reconcile. The pinned side condition is the D4-1 budget line: NO full
/// amplifier discover is paid for the mkdir (the arm's scoped
/// metadata.json mark is the only index work).
#[tokio::test]
async fn metadata_late_subagent_named_mkdir_arms_via_deferred_recheck_without_a_discover() {
    use std::sync::atomic::Ordering;
    let home = unique_temp_dir("amp-drift-late");
    // A pre-existing root session guarantees the sessions dir is armed at
    // startup, so the drift mkdir's depth-3 event is observed at all.
    let _root = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let counted = counted_amplifier_index(&home);
    let index = counted.index.clone();
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();
    let sessions = home.join("projects").join("p").join("sessions");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.contains(&sessions) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("startup structural arm pass completes");

    // Warm the index BEFORE the drift mkdir: the self-correction report
    // (fired only by a full discover) reflects this pre-mkdir world, so it
    // can never arm the dir under test — only the mkdir's own event path
    // can. The warm also means the pinned "no discover" side condition is
    // observable against a real baseline.
    let _ = index.snapshot().await;
    let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);

    let dir = sessions.join("0000000000000000-014b6af1c2ac4ab5_late_drift_root");
    std::fs::create_dir_all(&dir).unwrap();
    // The metadata lands ~350ms after the mkdir (creation precedes the
    // write), modeled on a plain thread so no session stays half-written.
    let writer = {
        let dir = dir.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(350));
            std::fs::write(
                dir.join("metadata.json"),
                r#"{"session_id":"late-drift-root","working_dir":"/p/x","created":"2026-03-01T00:00:00.000Z"}"#,
            )
            .unwrap();
        })
    };

    // Well under the deferred set's TTL: the arm must land within a couple
    // of seconds of the metadata write, not at the 15-minute reconcile.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.contains(&dir) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("the deferred probe recheck arms the drift root within seconds of its metadata");
    writer.join().unwrap();
    assert_eq!(
        counted.discover_calls.load(Ordering::SeqCst),
        baseline_discovers,
        "the mkdir must never pay a full provider discover (scoped marks only)"
    );
    // And the row is promptly visible — the watch-then-scan scoped mark
    // drove a scoped re-parse, end to end.
    let snap = index.snapshot().await;
    assert!(
        snap.iter()
            .any(|s| s.provider == "amplifier" && s.session_id == "late-drift-root"),
        "the drift root's scoped mark made the row visible without a discover"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// D4-1 corner 3 (preservation pin — the probe must never WATCH a true
/// subagent): a subagent-named mkdir whose metadata.json parses with
/// `parent_id` PRESENT is declined by the content probe and, with subagent
/// interest off, produces NO arm, NO mark, NO provider-dirty — per the
/// accepted residuals the cadence/reconcile own it.
#[test]
fn subagent_named_mkdir_with_subagent_content_is_never_armed_never_marked() {
    let home = unique_temp_dir("amp-drift-true-sub");
    let projects_root = home.join("projects");
    let dir = projects_root
        .join("p")
        .join("sessions")
        .join("0000000000000000-014b6af1c2ac4ab5_true_subagent");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("metadata.json"),
        r#"{"session_id":"true-sub","working_dir":"/p/x","parent_id":"par","created":"2026-03-01T00:00:00.000Z"}"#,
    )
    .unwrap();

    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();
    let interest = std::sync::atomic::AtomicUsize::new(0);
    let index = SessionIndex::with_ttl_and_cache_path(Vec::new(), Duration::from_secs(3600), None);
    let mut pending = HashMap::new();
    let mut cascades = Vec::new();
    let mut root_return = false;

    dispatch_amplifier_path(
        &mut book,
        &mut watcher,
        &mut outcome,
        &projects_root,
        &interest,
        &dir,
        WatchKind::CreateFolder,
        &mut pending,
        &index,
        &mut cascades,
        &mut root_return,
    );

    assert!(
        !book.armed.contains(&dir),
        "a TRUE subagent dir must never be armed — even by the drift-rescue probe"
    );
    assert!(!index.has_dirty(), "no provider dirty, no scoped marks");
    assert!(outcome.marks.is_empty() && !outcome.provider_dirty);
    assert!(pending.is_empty() && cascades.is_empty() && !root_return);
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// D4-1 corner 4a (the bound): the deferred probe set is CAPPED — a
/// subagent mkdir storm past `DEFERRED_ROOT_PROBE_CAP` drops the overflow
/// candidates rather than growing the per-flush re-probe cost unboundedly
/// (dropped-to-channel per the accepted residuals).
#[test]
fn deferred_root_probe_set_overflow_is_dropped() {
    let mut book = ManagedBook::default();
    for i in 0..DEFERRED_ROOT_PROBE_CAP {
        defer_root_probe(&mut book, &PathBuf::from(format!("/tmp/d4-cap/{i}")));
    }
    assert_eq!(book.deferred.len(), DEFERRED_ROOT_PROBE_CAP);
    defer_root_probe(&mut book, &PathBuf::from("/tmp/d4-cap/overflow"));
    assert_eq!(
        book.deferred.len(),
        DEFERRED_ROOT_PROBE_CAP,
        "an overflow candidate must NOT grow the bounded set"
    );
    assert!(!book
        .deferred
        .contains_key(Path::new("/tmp/d4-cap/overflow")));
}

/// D4-1 corner 4b (drain semantics per the bound): the per-flush recheck
/// (i) arms a candidate whose metadata.json has landed with `parent_id`
/// absent — the verdict switch covers an entry deferred as Absent while
/// content arrived as Root — and evicts it; (ii) evicts a candidate
/// declined as a true subagent; (iii) keeps a still-absent candidate
/// inside its TTL; (iv) evicts a TTL-EXPIRED absent candidate to the
/// channel WITHOUT ever arming it.
#[test]
fn deferred_root_probe_recheck_drains_per_its_bounds() {
    let home = unique_temp_dir("amp-drift-drain");
    let armed_at_recheck = home.join("armed_at_recheck");
    let true_sub = home.join("true_sub");
    let still_late = home.join("still_late");
    let expired_late = home.join("expired_late");
    for d in [&armed_at_recheck, &true_sub, &still_late, &expired_late] {
        std::fs::create_dir_all(d).unwrap();
    }
    // metadata landed, parent_id absent ⇒ Root verdict at the recheck.
    std::fs::write(
        armed_at_recheck.join("metadata.json"),
        r#"{"session_id":"a","working_dir":"/p/x","created":"2026-03-01T00:00:00.000Z"}"#,
    )
    .unwrap();
    // parent_id present ⇒ Declined.
    std::fs::write(
        true_sub.join("metadata.json"),
        r#"{"session_id":"s","working_dir":"/p/x","parent_id":"par","created":"2026-03-01T00:00:00.000Z"}"#,
    )
    .unwrap();
    // still_late + expired_late: no metadata.json at all ⇒ Absent.

    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    for d in [&armed_at_recheck, &true_sub, &still_late] {
        defer_root_probe(&mut book, d);
    }
    // Backdate one candidate past the TTL (const-declared ~5s).
    book.deferred.insert(
        expired_late.clone(),
        Instant::now() - (DEFERRED_ROOT_PROBE_TTL + Duration::from_secs(1)),
    );
    assert_eq!(book.deferred.len(), 4);

    let mut outcome = ArmOutcome::default();
    recheck_deferred_root_probes(&mut book, &mut watcher, &mut outcome);

    assert!(
        book.armed.contains(&armed_at_recheck),
        "landed root content arms at the recheck (channel helper, watch-then-scan)"
    );
    assert!(
        outcome
            .marks
            .contains(&armed_at_recheck.join("metadata.json")),
        "the recheck arm carries the scoped watch-then-scan mark"
    );
    assert!(
        !book.armed.contains(&true_sub) && !book.armed.contains(&expired_late),
        "declined/expired candidates are never armed"
    );
    assert_eq!(
        book.deferred.len(),
        1,
        "armed, declined, and expired candidates all drain — only the still-late one remains"
    );
    assert!(book.deferred.contains_key(&still_late));
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

// ---------- watch-reduction proof (kata target) ----------

/// THE proof: a 12-project corpus arms EXACTLY
/// 1 (projects root) + 12 (sessions dirs) + 4 (stand-ins) + 12×3 (root session dirs) = 53
/// watches — never a subagent dir, never context-intelligence — while every
/// root session (incl. one old+externally-resumed) updates instantly through
/// the real watcher path and all 72 rows (36 of them subagent rows) still index.
#[tokio::test]
async fn amplifier_managed_watch_set_proof_of_reduction_and_root_liveness() {
    let home = unique_temp_dir("amp-proof");
    let projects_with_sessions = 12usize;
    let roots_per = [
        "012584be-9478-4801-a62d-4e5da428b3a0",
        "aa2584be-9478-4801-a62d-4e5da428b3a0",
    ];
    let subagents_per = [
        "0000000000000000-014b6af1c2ac4ab5_a",
        "1111111111111111-2222222222222222_b",
        "3333333333333333-4444444444444444_c",
    ];
    // Twelve with sessions/, four stand-ins.
    for i in 0..projects_with_sessions {
        let slug = format!("proj_{i}");
        for id in roots_per {
            let dir = write_amplifier_session(&home, &slug, id);
            std::fs::write(
                dir.join("metadata.json"),
                format!(
                    r#"{{"session_id":"{id}-{i}","working_dir":"/p/{slug}","created":"2026-03-01T00:00:00.000Z","name":"t","description":"d","turn_count":1}}"#
                ),
            )
            .unwrap();
        }
        for id in subagents_per {
            let dir = write_amplifier_session(&home, &slug, id);
            // parent_id present ⇒ subagent row content (rows still index).
            std::fs::write(
                dir.join("metadata.json"),
                format!(
                    r#"{{"session_id":"{id}-{i}","working_dir":"/p/{slug}","parent_id":"x","created":"2026-03-01T00:00:00.000Z"}}"#
                ),
            )
            .unwrap();
        }
        // One oddball root per project (drift alarm input) + a CI subtree.
        write_amplifier_session(&home, &slug, &format!("oddball-{i}"));
        std::fs::create_dir_all(
            projects_with_sessions_path(&home, &slug, roots_per[0]).join("context-intelligence"),
        )
        .unwrap();
    }
    for i in 0..4usize {
        std::fs::create_dir_all(home.join("projects").join(format!("standin_{i}"))).unwrap();
    }

    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if book.lock().unwrap().armed.len() >= 53 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("full arm pass");

    // 1 root + 12 sessions + 4 stand-ins + 36 root session dirs = 53.
    let expected = 1 + projects_with_sessions + 4 + projects_with_sessions * 3;
    {
        let b = book.lock().unwrap();
        assert_eq!(b.armed.len(), expected, "exact planned watch count");
        // Never watched: any subagent-pattern dir or anything below a
        // session dir (context-intelligence).
        for p in &b.armed {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            assert!(
                crate::watch_plan::classify_basename(name)
                    != crate::watch_plan::BasenameClass::Subagent,
                "armed a subagent dir: {}",
                p.display()
            );
            assert!(!name.starts_with("context-intelligence"));
        }
        drop(b);
    }

    // Subagent rows still exist (discover covers the whole corpus).
    let snap = index.snapshot().await;
    let amps = snap.iter().filter(|s| s.provider == "amplifier").count();
    assert_eq!(
        amps,
        projects_with_sessions * (2 + 3 + 1),
        "every row indexed (roots + subagents + oddball)"
    );

    // Zero-latency-regression pin: an OLD root session (created at startup,
    // never touched since) gets an external-resume write and still updates
    // instantly through the real watched path.
    let _ = rx.borrow_and_update();
    let old_root = projects_with_sessions_path(&home, "proj_3", roots_per[0]);
    std::fs::write(
        old_root.join("transcript.jsonl"),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"resumed\"}}\n",
    )
    .unwrap();
    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(changed.is_ok(), "old root session stays instantly fresh");

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

fn projects_with_sessions_path(home: &Path, slug: &str, id: &str) -> PathBuf {
    home.join("projects").join(slug).join("sessions").join(id)
}

/// Delta-review D1-5: moving an ALREADY-POPULATED project (multiple root
/// sessions with metadata) into the watched corpus must arm every staged
/// root session dir FIRST-LINE through the event-time cascade (never a
/// replan / reconcile), and events from its sessions must flow promptly.
/// This is the cascade-class event path the design's spawn_blocking bulk
/// rule targets: one depth-1 `Name(To)` whose handling expands to a
/// readdir + a batch of arms.
#[tokio::test]
async fn moved_in_populated_project_is_cascaded_immediately_and_events_flow() {
    let home = unique_temp_dir("amp-mvin");
    // One initial project so the watcher starts with a live armed set.
    write_amplifier_session(&home, "p0", "002584be-9478-4801-a62d-4e5da428b3a0");

    // The populated project, staged OUTSIDE the corpus (its eventual name
    // classifies every session dir as a root session).
    let ids = [
        "112584be-9478-4801-a62d-4e5da428b3a0",
        "122584be-9478-4801-a62d-4e5da428b3a0",
        "132584be-9478-4801-a62d-4e5da428b3a0",
    ];
    let staging = home.join("staging").join("pop_proj");
    for id in ids {
        let dir = staging.join("sessions").join(id);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("metadata.json"),
            format!(
                r#"{{"session_id":"{id}","working_dir":"/p/pop_proj","created":"2026-03-01T00:00:00.000Z","name":"t","description":"s","turn_count":1}}"#
            ),
        )
        .unwrap();
    }

    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.len() == 3 {
                break; // root + p0/sessions + p0 session dir
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("startup arming completes");

    // ONE mv into the watched corpus.
    let projects = home.join("projects");
    std::fs::rename(&staging, projects.join("pop_proj")).unwrap();

    // First-line cascade: the sessions dir AND every staged root session
    // dir arm off the single depth-1 event.
    let pop = projects.join("pop_proj");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let done = {
                let b = book.lock().unwrap();
                b.armed.contains(&pop.join("sessions"))
                    && ids
                        .iter()
                        .all(|id| b.armed.contains(&pop.join("sessions").join(id)))
            };
            if done {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("moved-in project's sessions + root session dirs armed first-line");

    // Events from its sessions flow promptly: a transcript write inside one
    // armed dir reaches the index quickly (the scoped fold-aware stat lands
    // the change — same shape as the proof test's old-root write).
    let _ = rx.borrow_and_update();
    std::fs::write(
        pop.join("sessions").join(ids[0]).join("transcript.jsonl"),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
    )
    .unwrap();
    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(
        changed.is_ok(),
        "events from the moved-in project's sessions flow promptly"
    );

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

const REFERENCED_THREAD: &str = "b7936c10-4935-441c-837c-c1f33cafec2d";

fn referenced_history_fixture(home: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let fixtures =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../test/fixtures/coding-cli/codex");
    let older =
        std::fs::read_to_string(fixtures.join("multi-file-continuation-older.sanitized.jsonl"))
            .unwrap();
    let mut older_records: Vec<serde_json::Value> = older
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    older_records[0]["ordinal"] = serde_json::json!(0);
    for record in &mut older_records[1..] {
        record["ordinal"] = serde_json::json!(record["ordinal"].as_u64().unwrap() + 1);
    }
    older_records[3]["type"] = serde_json::json!("response_item");
    older_records[3]["payload"] = serde_json::json!({
        "type": "message", "role": "assistant",
        "content": [{"type": "output_text", "text": "Archive mutable detail A"}]
    });
    let encode = |records: &[serde_json::Value]| {
        records
            .iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>()
    };
    let prefix_length = encode(&older_records[..4]).len() as u64;
    let older = encode(&older_records);
    let newer =
        std::fs::read_to_string(fixtures.join("multi-file-continuation-newer.sanitized.jsonl"))
            .unwrap();
    let mut newer_records: Vec<serde_json::Value> = newer
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    newer_records[0]["payload"]["history_base"] = serde_json::json!({
        "thread_id": REFERENCED_THREAD,
        "end_byte_offset": prefix_length, "end_ordinal_exclusive": 4,
    });
    newer_records[0]["ordinal"] = serde_json::json!(4);
    newer_records[0]["payload"]["cli_version"] = serde_json::json!("0.160.0");
    for record in &mut newer_records[1..] {
        record["ordinal"] = serde_json::json!(record["ordinal"].as_u64().unwrap() + 5);
    }
    let sessions = home.join("sessions");
    std::fs::create_dir_all(&sessions).unwrap();
    let root = sessions.join(format!(
        "rollout-2026-10-03T00-00-00-{REFERENCED_THREAD}.jsonl"
    ));
    let left = sessions.join(format!("rollout-2026-10-03T00-00-10-{REFERENCED_THREAD}_00000000-0000-4000-8000-000000000001.jsonl"));
    let right = sessions.join(format!("rollout-2026-10-03T00-00-11-{REFERENCED_THREAD}_00000000-0000-4000-8000-000000000002.jsonl"));
    std::fs::write(&root, older).unwrap();
    std::fs::write(
        &left,
        encode(&newer_records).replace("Continuation title", "Left continuation title"),
    )
    .unwrap();
    std::fs::write(
        &right,
        encode(&newer_records).replace("Continuation title", "Right continuation title"),
    )
    .unwrap();
    (root, left, right)
}

fn active_history_db(home: &Path, selected: &Path) -> rusqlite::Connection {
    let connection = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
    connection.execute_batch("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, history_mode TEXT, archived INTEGER DEFAULT 0);").unwrap();
    connection
        .execute(
            "INSERT INTO threads VALUES (?1, ?2, 'paginated', 0)",
            rusqlite::params![REFERENCED_THREAD, selected.to_str().unwrap()],
        )
        .unwrap();
    connection
}

async fn start_codex_history_watcher(
    home: &Path,
) -> (
    Arc<SessionIndex>,
    SessionWatcher,
    tokio::task::JoinHandle<()>,
) {
    let source = Arc::new(crate::directory_index::CodexSource::new(home.to_path_buf()));
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![source],
        Duration::from_secs(3600),
        None,
    ));
    let mut watcher = SessionWatcher::new(
        Arc::clone(&index),
        vec![WatchedProvider {
            layout: Box::new(crate::provider_layout::CodexLayout),
            home: home.to_path_buf(),
        }],
    );
    let mut ready = watcher.startup_ready();
    index.set_startup_gate(ready.clone());
    let handle = watcher.start();
    tokio::time::timeout(Duration::from_secs(5), ready.wait_for(|ready| *ready))
        .await
        .unwrap()
        .unwrap();
    index.snapshot().await;
    (index, watcher, handle)
}

#[tokio::test]
async fn codex_history_watcher_refreshes_a_wal_only_selected_pointer_change() {
    let home = unique_temp_dir("codex-history-wal");
    let (_, left, right) = referenced_history_fixture(&home);
    let connection = active_history_db(&home, &left);
    let (index, mut watcher, handle) = start_codex_history_watcher(&home).await;
    let initial = index.snapshot().await;
    assert_eq!(initial.len(), 1);
    assert_eq!(initial[0].source_file.as_ref(), Some(&left));
    let unchanged_db = std::fs::read(home.join("state_5.sqlite")).unwrap();
    let mut changes = index.subscribe_changes();
    changes.borrow_and_update();

    connection
        .execute(
            "UPDATE threads SET rollout_path=?1 WHERE id=?2",
            rusqlite::params![right.to_str().unwrap(), REFERENCED_THREAD],
        )
        .unwrap();
    assert_eq!(
        std::fs::read(home.join("state_5.sqlite")).unwrap(),
        unchanged_db
    );
    tokio::time::timeout(Duration::from_secs(5), changes.changed())
        .await
        .unwrap()
        .unwrap();
    let selected = index
        .snapshot_with_failures_and_unresolved_codex_identities()
        .await;
    assert_eq!(selected.sessions.len(), 1);
    assert_eq!(selected.sessions[0].source_file.as_ref(), Some(&right));
    assert_eq!(selected.sessions[0].title, initial[0].title);
    assert_eq!(
        selected.sessions[0].last_activity_at,
        initial[0].last_activity_at
    );
    assert_eq!(
        selected.codex_history_segments[REFERENCED_THREAD]
            .last()
            .unwrap()
            .path,
        right
    );
    assert!(selected.unresolved_codex_identities.is_empty());

    watcher.stop();
    handle.await.unwrap();
    drop(connection);
    std::fs::remove_dir_all(&home).unwrap();
}

#[tokio::test]
async fn codex_history_watcher_relocates_and_refreshes_archived_prefix_without_metadata_changes() {
    let home = unique_temp_dir("codex-history-archive");
    let (root, left, _) = referenced_history_fixture(&home);
    let connection = active_history_db(&home, &left);
    let (index, mut watcher, handle) = start_codex_history_watcher(&home).await;
    let initial = index
        .snapshot_with_failures_and_unresolved_codex_identities()
        .await;
    assert_eq!(initial.sessions.len(), 1);
    let mut changes = index.subscribe_changes();
    changes.borrow_and_update();
    let archive = home.join("archived_sessions");
    std::fs::create_dir_all(&archive).unwrap();
    let archived = archive.join(root.file_name().unwrap());
    std::fs::rename(&root, &archived).unwrap();
    tokio::time::timeout(Duration::from_secs(5), changes.changed())
        .await
        .unwrap()
        .unwrap();
    let relocated = index
        .snapshot_with_failures_and_unresolved_codex_identities()
        .await;
    assert_eq!(relocated.sessions, initial.sessions);
    assert_eq!(
        relocated.codex_history_segments[REFERENCED_THREAD][0].path,
        archived
    );

    changes.borrow_and_update();
    let before_revision = relocated.codex_history_revisions[REFERENCED_THREAD];
    let content = std::fs::read_to_string(&archived).unwrap();
    std::fs::write(
        &archived,
        content.replace("Archive mutable detail A", "Archive mutable detail B"),
    )
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), changes.changed())
        .await
        .unwrap()
        .unwrap();
    let changed = index
        .snapshot_with_failures_and_unresolved_codex_identities()
        .await;
    assert_eq!(changed.sessions, relocated.sessions);
    assert_eq!(
        changed.codex_history_segments,
        relocated.codex_history_segments
    );
    assert_ne!(
        changed.codex_history_revisions[REFERENCED_THREAD],
        before_revision
    );
    // Archived dependencies are references, never ordinary discovery rows.
    assert!(index
        .peek()
        .unwrap()
        .iter()
        .all(|item| item.source_file.as_ref() == Some(&left)));

    watcher.stop();
    handle.await.unwrap();
    drop(connection);
    std::fs::remove_dir_all(&home).unwrap();
}

fn write_ordinary_codex_history(home: &Path, id: &str) {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex/multi-file-continuation-older.sanitized.jsonl");
    let content = std::fs::read_to_string(fixture)
        .unwrap()
        .replace(REFERENCED_THREAD, id);
    let directory = home.join("sessions/2026/10/03");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::write(
        directory.join(format!("rollout-2026-10-03T00-00-00-{id}.jsonl")),
        content,
    )
    .unwrap();
}

async fn wait_for_codex_history_rows(index: &SessionIndex, ids: &[&str]) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let mut found = index
                .snapshot()
                .await
                .iter()
                .map(|row| row.session_id.clone())
                .collect::<Vec<_>>();
            let mut expected = ids.iter().map(|id| (*id).to_owned()).collect::<Vec<_>>();
            found.sort();
            expected.sort();
            if found == expected {
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("native Codex watch must update the index before its hour-long TTL");
}

#[tokio::test]
async fn codex_history_watcher_observes_a_late_home_and_keeps_the_home_watch() {
    let base = unique_temp_dir("codex-late-home");
    std::fs::create_dir_all(&base).unwrap();
    let home = base.join(".codex");
    let (index, mut watcher, handle) = start_codex_history_watcher(&home).await;
    assert!(index.snapshot().await.is_empty());
    let first = "00000000-0000-4000-8000-000000000011";
    write_ordinary_codex_history(&home, first);
    wait_for_codex_history_rows(&index, &[first]).await;

    // Removing and replacing a child root must not retire the permanent
    // nonrecursive home watch as though it were a temporary ancestor arm.
    std::fs::rename(home.join("sessions"), base.join("retired-sessions")).unwrap();
    wait_for_codex_history_rows(&index, &[]).await;
    let second = "00000000-0000-4000-8000-000000000012";
    write_ordinary_codex_history(&home, second);
    wait_for_codex_history_rows(&index, &[second]).await;
    let third = "00000000-0000-4000-8000-000000000013";
    write_ordinary_codex_history(&home, third);
    wait_for_codex_history_rows(&index, &[second, third]).await;

    watcher.stop();
    handle.await.unwrap();
    std::fs::remove_dir_all(base).unwrap();
}

#[tokio::test]
async fn codex_history_watcher_rearms_a_session_root_replaced_between_probes() {
    let base = unique_temp_dir("codex-replaced-root");
    let home = base.join(".codex");
    let first = "00000000-0000-4000-8000-000000000021";
    write_ordinary_codex_history(&home, first);
    let (index, mut watcher, handle) = start_codex_history_watcher(&home).await;
    wait_for_codex_history_rows(&index, &[first]).await;
    // Both operations happen before the normal periodic re-arm stat sees
    // a missing path. The replacement has a different inode at the same path.
    std::fs::rename(home.join("sessions"), base.join("retired-sessions")).unwrap();
    let second = "00000000-0000-4000-8000-000000000022";
    write_ordinary_codex_history(&home, second);
    wait_for_codex_history_rows(&index, &[second]).await;
    // The home watch only observes its immediate children. Seeing this
    // later deep file proves the new recursive root arm actually survived.
    let third = "00000000-0000-4000-8000-000000000023";
    write_ordinary_codex_history(&home, third);
    wait_for_codex_history_rows(&index, &[second, third]).await;

    watcher.stop();
    handle.await.unwrap();
    std::fs::remove_dir_all(base).unwrap();
}

struct CountingCodexDiscovery {
    inner: crate::directory_index::CodexSource,
    discoveries: Arc<std::sync::atomic::AtomicUsize>,
}

impl SessionSource for CountingCodexDiscovery {
    fn discover(&self) -> Vec<crate::directory_index::FileStat> {
        self.discoveries
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.discover()
    }
    fn discover_checked(&self) -> std::io::Result<Vec<crate::directory_index::FileStat>> {
        self.discoveries
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.inner.discover_checked()
    }
    fn parse(&self, path: &Path) -> Option<crate::directory_index::IndexedSession> {
        self.inner.parse(path)
    }
    fn parse_with_codex_evidence(
        &self,
        path: &Path,
    ) -> (
        Option<crate::directory_index::IndexedSession>,
        Option<crate::codex_segments::CodexFileEvidence>,
    ) {
        self.inner.parse_with_codex_evidence(path)
    }
    fn compose_codex_segments(
        &self,
        entries: Vec<crate::codex_segments::CodexSegmentEntry>,
    ) -> crate::codex_segments::CodexComposition {
        self.inner.compose_codex_segments(entries)
    }
    fn provider_name(&self) -> Option<&'static str> {
        Some("codex")
    }
}

#[tokio::test]
async fn codex_history_watcher_ignores_unrelated_home_writes_but_observes_database_replacement() {
    let home = unique_temp_dir("codex-narrow-home-watch");
    write_ordinary_codex_history(&home, "00000000-0000-4000-8000-000000000031");
    let discoveries = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let source = CountingCodexDiscovery {
        inner: crate::directory_index::CodexSource::new(home.clone()),
        discoveries: Arc::clone(&discoveries),
    };
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(source)],
        Duration::from_secs(3600),
        None,
    ));
    let mut watcher = SessionWatcher::new(
        Arc::clone(&index),
        vec![WatchedProvider {
            layout: Box::new(crate::provider_layout::CodexLayout),
            home: home.clone(),
        }],
    );
    let mut ready = watcher.startup_ready();
    index.set_startup_gate(ready.clone());
    let handle = watcher.start();
    tokio::time::timeout(Duration::from_secs(5), ready.wait_for(|ready| *ready))
        .await
        .unwrap()
        .unwrap();
    index.snapshot().await;
    index.wait_for_refresh_idle_for_test().await;
    let initial = discoveries.load(std::sync::atomic::Ordering::SeqCst);
    std::fs::write(home.join("config.toml"), "model = 'test'\n").unwrap();
    std::fs::write(home.join("history.jsonl"), "{}\n").unwrap();
    std::fs::create_dir_all(home.join("log")).unwrap();
    std::fs::write(home.join("log/codex-tui.log"), "ordinary activity\n").unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    index.wait_for_refresh_idle_for_test().await;
    assert_eq!(
        discoveries.load(std::sync::atomic::Ordering::SeqCst),
        initial,
        "unrelated home writes must not trigger provider discovery"
    );

    // A newly renamed SQLite inode must still invalidate selected history.
    // This ordinary legacy row needs no usable DB, so corrupt content here
    // isolates watcher invalidation from resolver selection behavior.
    std::fs::write(home.join("replacement.tmp"), "not a database").unwrap();
    std::fs::rename(home.join("replacement.tmp"), home.join("state_5.sqlite")).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        while discoveries.load(std::sync::atomic::Ordering::SeqCst) == initial {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("matching database rename must trigger provider discovery");
    assert_eq!(index.snapshot().await.len(), 1);
    watcher.stop();
    handle.await.unwrap();
    std::fs::remove_dir_all(home).unwrap();
}
