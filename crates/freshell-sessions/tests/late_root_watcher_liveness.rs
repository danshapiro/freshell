//! DEV-0002 mandatory liveness pinning test (`port/oracle/DEVIATIONS.md` DEV-0002).
//!
//! The reference session-indexer crashes the WHOLE process when a provider session-root
//! subdir that was absent at boot appears at runtime: chokidar's `close()` runs
//! `removeAllListeners()` during an in-flight `_addToNodeFs`, so an `'error'` fires on a
//! listener-less `FSWatcher` and Node `process.exit(1)`s mid-turn. The T2 message-differ
//! is BLIND to this (the harness pre-creates `…/projects` for env parity), so this
//! liveness test is the SOLE carrier of the fix.
//!
//! Required assertions (DEV-0002 pinning_test):
//!   (a) the process/task does NOT panic or abort;
//!   (b) the watcher error is logged and a rescan is scheduled (degrade, not die);
//!   (c) the new session under the subdir becomes visible (indexing resumed).
//!
//! `late_root_deterministic` drives the exact close-during-add race with an injected
//! watcher-arm failure (deterministic, no FS-timing flake). `late_root_real_notify`
//! repeats the arrange/act against the REAL `notify` backend to prove the production
//! watcher genuinely survives the appearance.

use freshell_sessions::indexer::{
    claude_provider_spec, FsEvent, FsProbe, Indexer, IndexerEvent, NotifyWatcherFactory,
    ProviderSpec, RealFsProbe, WatchError, Watcher, WatcherFactory,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

static COUNTER: AtomicU64 = AtomicU64::new(0);

fn unique_id() -> String {
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{}-{n}-{nanos}", std::process::id())
}

/// A unique path that is NEVER created on disk — the fake-probe tests track existence in
/// memory, so no real filesystem (and no cleanup) is involved.
fn virtual_root() -> PathBuf {
    std::env::temp_dir().join(format!("freshell-virtual-{}", unique_id()))
}

/// A real temp dir that removes itself on drop (used only by the real-notify test).
struct TmpDir(PathBuf);
impl TmpDir {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("freshell-sessions-lr-{}", unique_id()));
        std::fs::create_dir_all(&dir).unwrap();
        TmpDir(dir)
    }
}
impl std::ops::Deref for TmpDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}
impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

// ---------------------------------------------------------------------------
// Deterministic injected FS + watcher backend.
// ---------------------------------------------------------------------------

#[derive(Default)]
struct FakeState {
    existing: HashSet<PathBuf>,
    files: HashMap<String, Vec<PathBuf>>,
    watch_calls: Vec<(&'static str, Vec<PathBuf>)>,
    /// Number of upcoming `watch()` arm calls that should fail (simulating the
    /// close-during-add race the original crashed on).
    fail_next_arms: usize,
}

type Shared = Arc<Mutex<FakeState>>;

struct FakeFsProbe(Shared);
impl FsProbe for FakeFsProbe {
    fn exists(&self, path: &Path) -> bool {
        self.0.lock().unwrap().existing.contains(path)
    }
    fn list_session_files(&self, spec: &ProviderSpec) -> Vec<PathBuf> {
        self.0
            .lock()
            .unwrap()
            .files
            .get(&spec.name)
            .cloned()
            .unwrap_or_default()
    }
}

struct FakeWatcherFactory(Shared);
impl WatcherFactory for FakeWatcherFactory {
    fn create(&self, label: &'static str) -> Box<dyn Watcher> {
        Box::new(FakeWatcher {
            state: self.0.clone(),
            label,
        })
    }
}

struct FakeWatcher {
    state: Shared,
    label: &'static str,
}
impl Watcher for FakeWatcher {
    fn watch(&mut self, paths: &[PathBuf], _recursive: bool) -> Result<(), WatchError> {
        let mut st = self.state.lock().unwrap();
        st.watch_calls.push((self.label, paths.to_vec()));
        if st.fail_next_arms > 0 {
            st.fail_next_arms -= 1;
            return Err(WatchError("simulated close-during-add race".into()));
        }
        Ok(())
    }
}

fn take_watch_calls(shared: &Shared) -> Vec<(&'static str, Vec<PathBuf>)> {
    std::mem::take(&mut shared.lock().unwrap().watch_calls)
}

#[test]
fn late_root_deterministic() {
    let tmp = virtual_root();
    let home = tmp.join(".claude");
    let projects = home.join("projects");
    let project_hash = projects.join("hash");
    let session_file = project_hash.join("00000000-0000-4000-8000-000000000001.jsonl");

    let shared: Shared = Arc::new(Mutex::new(FakeState::default()));
    // Boot state: the provider home exists (creds seeded) but the session-root `projects`
    // subdir is ABSENT — exactly the DEV-0002 precondition.
    {
        let mut st = shared.lock().unwrap();
        st.existing.insert(tmp.clone());
        st.existing.insert(home.clone());
    }

    let spec = claude_provider_spec(&home);
    let mut indexer = Indexer::new(
        vec![spec],
        Box::new(FakeFsProbe(shared.clone())),
        Box::new(FakeWatcherFactory(shared.clone())),
    );

    // --- boot: arms the late-root watcher on the nearest existing ancestor (home) ---
    indexer.start();
    let boot_calls = take_watch_calls(&shared);
    // The glob watcher has no existing root to watch; the root watcher arms on `home`.
    assert!(
        boot_calls
            .iter()
            .any(|(label, paths)| *label == "root" && paths.contains(&home)),
        "boot must arm the late-root watcher on the existing ancestor (home): {boot_calls:?}"
    );
    assert!(
        indexer.snapshot().is_empty(),
        "no sessions before the subdir appears"
    );
    let boot_events = indexer.drain_events();
    assert!(boot_events.contains(&IndexerEvent::Reconfigured {
        key: "claude:0".to_string()
    }));

    // --- runtime: the subdir + a session file appear, AND the re-arm of the glob watcher
    //     transiently fails (the injected close-during-add race). ---
    {
        let mut st = shared.lock().unwrap();
        st.existing.insert(projects.clone());
        st.existing.insert(project_hash.clone());
        st.existing.insert(session_file.clone());
        st.files
            .insert("claude".to_string(), vec![session_file.clone()]);
        st.fail_next_arms = 1; // fail exactly the glob re-arm
    }

    // (a) feeding the root-appeared event must NOT panic/abort.
    indexer.on_event(FsEvent::Created(projects.clone()));

    let events = indexer.drain_events();
    // (b) the watcher error is logged AND a rescan is scheduled (degrade, not die).
    assert!(
        events.contains(&IndexerEvent::RootAppeared(projects.clone())),
        "root appearance detected: {events:?}"
    );
    assert!(
        events.iter().any(|e| matches!(
            e,
            IndexerEvent::WatchArmFailedDegraded { label: "glob", .. }
        )),
        "the failed glob re-arm degrades (logged), not crashes: {events:?}"
    );
    assert!(
        events.contains(&IndexerEvent::RescanScheduled),
        "a rescan is scheduled after the degrade: {events:?}"
    );
    assert!(
        indexer.rescan_pending(),
        "indexer is degraded-but-alive with a pending rescan"
    );

    // The reconfigure still re-armed the root watcher on the now-existing subdir.
    let reconfig_calls = take_watch_calls(&shared);
    assert!(
        reconfig_calls
            .iter()
            .any(|(label, paths)| *label == "root" && paths.contains(&projects)),
        "precise-root watching resumes on the appeared subdir: {reconfig_calls:?}"
    );

    // (c) the new session becomes visible once the rescan runs (indexing resumed).
    indexer.on_event(FsEvent::Created(session_file.clone()));
    let discovered = indexer.run_pending_rescan();
    assert_eq!(discovered, 1, "the rescan rediscovers the new session file");
    assert_eq!(
        indexer.snapshot(),
        vec![session_file],
        "the late session is now indexed"
    );

    // Reaching here at all is the strongest proof of (a): no panic/abort occurred.
}

#[test]
fn backend_error_event_degrades_without_dying() {
    // A watch-backend error surfaced as an event must log + degrade + stay alive
    // (DEV-0002 (b) via the FSWatcher 'error' path).
    let home = virtual_root().join(".claude");
    let shared: Shared = Arc::new(Mutex::new(FakeState::default()));
    shared.lock().unwrap().existing.insert(home.clone());

    let mut indexer = Indexer::new(
        vec![claude_provider_spec(&home)],
        Box::new(FakeFsProbe(shared.clone())),
        Box::new(FakeWatcherFactory(shared.clone())),
    );
    indexer.start();
    indexer.drain_events();

    indexer.on_event(FsEvent::Error("inotify overflow".into()));
    let events = indexer.drain_events();
    assert!(
        events.contains(&IndexerEvent::WatchErrorDegraded("inotify overflow".into())),
        "backend error is logged: {events:?}"
    );
    assert!(
        events.contains(&IndexerEvent::RescanScheduled),
        "and a rescan is scheduled: {events:?}"
    );
    assert!(
        indexer.rescan_pending(),
        "still alive, degraded with a pending rescan"
    );
}

#[test]
fn happy_path_reconfigure_on_appearance_stays_alive() {
    // Even without an injected failure, reconfigure-on-appearance must not tear down
    // liveness or double-fault.
    let tmp = virtual_root();
    let home = tmp.join(".claude");
    let projects = home.join("projects");
    let file = projects
        .join("hash")
        .join("00000000-0000-4000-8000-000000000002.jsonl");

    let shared: Shared = Arc::new(Mutex::new(FakeState::default()));
    {
        let mut st = shared.lock().unwrap();
        st.existing.insert(home.clone());
    }
    let mut indexer = Indexer::new(
        vec![claude_provider_spec(&home)],
        Box::new(FakeFsProbe(shared.clone())),
        Box::new(FakeWatcherFactory(shared.clone())),
    );
    indexer.start();

    {
        let mut st = shared.lock().unwrap();
        st.existing.insert(projects.clone());
        st.files.insert("claude".to_string(), vec![file.clone()]);
    }
    indexer.on_event(FsEvent::Created(projects));
    let discovered = indexer.run_pending_rescan();
    assert_eq!(discovered, 1);
    assert_eq!(indexer.snapshot(), vec![file]);
}

// ---------------------------------------------------------------------------
// Real notify backend: prove the production watcher survives the appearance.
// ---------------------------------------------------------------------------

#[test]
fn late_root_real_notify() {
    let tmp = TmpDir::new();
    let home = tmp.join(".claude");
    // Provider home exists; the session-root `projects` subdir is absent at boot.
    std::fs::create_dir_all(&home).unwrap();

    let (tx, rx) = std::sync::mpsc::channel::<FsEvent>();
    let mut indexer = Indexer::new(
        vec![claude_provider_spec(&home)],
        Box::new(RealFsProbe),
        Box::new(NotifyWatcherFactory::new(tx)),
    );
    indexer.start();
    assert!(
        indexer.snapshot().is_empty(),
        "no sessions before the subdir appears"
    );

    // Runtime: create the previously-absent subdir + a session file (the crash trigger).
    let projects = home.join("projects").join("hash");
    std::fs::create_dir_all(&projects).unwrap();
    let session_file = projects.join("00000000-0000-4000-8000-000000000003.jsonl");
    std::fs::write(&session_file, "{\"type\":\"user\",\"message\":\"hi\"}\n").unwrap();

    // Pump real notify events into the indexer until the new session is indexed (or time
    // out). A full rescan is triggered by the root-appeared event and lists the file
    // regardless of per-file event delivery.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        while let Ok(ev) = rx.try_recv() {
            indexer.on_event(ev);
        }
        indexer.run_pending_rescan();
        if !indexer.snapshot().is_empty() {
            break;
        }
        if std::time::Instant::now() > deadline {
            panic!(
                "real notify indexer did not resume indexing after late-root appearance; events={:?}",
                indexer.events()
            );
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }

    let snapshot = indexer.snapshot();
    assert!(
        snapshot
            .iter()
            .any(|p| p.ends_with("00000000-0000-4000-8000-000000000003.jsonl")),
        "the late session became visible via the real notify backend: {snapshot:?}"
    );
    // Surviving to here proves the real backend did not abort on the late-root appearance.
}
