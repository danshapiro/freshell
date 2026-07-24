//! Session-indexer: the file-watcher that discovers provider transcript roots and emits
//! change events, ported from `server/coding-cli/session-indexer.ts` (the watcher-arming
//! + `reconfigureWatchers` + late-root-watcher subset).
//!
//! # DEV-0002 (the whole reason this is injectable)
//!
//! The reference arms a *late-root watcher* on the nearest existing ancestor of a
//! provider session-root that is absent at boot. When the root subdir later appears
//! mid-run, chokidar's `close()` does a synchronous `removeAllListeners()` during the
//! in-flight `_addToNodeFs`, so an `'error'` fires on a now-listener-less `FSWatcher` and
//! Node `process.exit(1)`s mid-turn (see `port/oracle/DEVIATIONS.md` DEV-0002).
//!
//! The port is **structurally immune**: a watcher is a plain RAII value — dropping it on
//! reconfigure cannot deliver an error to a destroyed handler. Any watcher/arming failure
//! is turned into a **log + degrade (schedule a rescan) while the task stays alive**, and
//! precise-root watching + indexing resume once the subdir exists. The FS/watch source is
//! injected (`FsProbe` / `WatcherFactory`) so the mandatory liveness pinning test in
//! `tests/late_root_watcher_liveness.rs` can drive the exact race deterministically.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

/// A provider's watch configuration (the subset of `CodingCliProvider` the indexer needs:
/// `getSessionRoots` / `getSessionWatchBases` + the dirs the glob watcher covers).
#[derive(Debug, Clone)]
pub struct ProviderSpec {
    pub name: String,
    /// `getSessionRoots()` — e.g. `~/.claude/projects`, `~/.codex/sessions`, opencode.db.
    pub session_roots: Vec<PathBuf>,
    /// `getSessionWatchBases()` — e.g. `~/.claude`, `~/.local/share`.
    pub watch_bases: Vec<PathBuf>,
    /// Directories the glob watcher recurses for `*.jsonl` session files.
    pub glob_dirs: Vec<PathBuf>,
}

/// Injected filesystem probe (existence checks + a rescan lister). The real impl reads
/// `std::fs`; tests inject an in-memory fake so the late-root race is deterministic.
pub trait FsProbe: Send {
    fn exists(&self, path: &Path) -> bool;
    /// `listSessionFiles()` for a provider — the rescan that resumes indexing.
    fn list_session_files(&self, spec: &ProviderSpec) -> Vec<PathBuf>;
}

/// A backend arming failure (the analog of a chokidar watch error).
#[derive(Debug, Clone)]
pub struct WatchError(pub String);

/// The OS watch primitive (notify in production; a fake in tests). Dropping the value
/// stops watching (RAII) — this is what makes the port immune to the close-during-add
/// crash.
pub trait Watcher: Send {
    /// Arm a watch over `paths` (recursive if `recursive`). `Err` simulates a transient
    /// backend failure (e.g. the close-during-add race the original crashed on).
    fn watch(&mut self, paths: &[PathBuf], recursive: bool) -> Result<(), WatchError>;
}

/// Creates fresh [`Watcher`] instances for the glob and root watchers.
pub trait WatcherFactory: Send {
    fn create(&self, label: &'static str) -> Box<dyn Watcher>;
}

/// A filesystem change fed into the indexer (in production, mapped from a notify event;
/// in tests, synthesized).
#[derive(Debug, Clone)]
pub enum FsEvent {
    Created(PathBuf),
    Removed(PathBuf),
    Modified(PathBuf),
    /// A watch-backend error surfaced to the indexer (DEV-0002 (b) — must degrade, not
    /// die).
    Error(String),
}

/// Structured indexer log for assertions (in production these map to `logger.*` lines).
#[derive(Debug, Clone, PartialEq)]
pub enum IndexerEvent {
    Reconfigured {
        key: String,
    },
    RootAppeared(PathBuf),
    RootRemoved(PathBuf),
    RescanScheduled,
    RescanRan {
        discovered: usize,
    },
    /// A watcher failed to arm during reconfigure — logged + degrade (DEV-0002 fix path).
    WatchArmFailedDegraded {
        label: &'static str,
        error: String,
    },
    /// A watch-backend error was surfaced — logged + degrade (DEV-0002 fix path).
    WatchErrorDegraded(String),
}

/// The read-only session indexer state machine.
pub struct Indexer {
    providers: Vec<ProviderSpec>,
    fs: Box<dyn FsProbe>,
    factory: Box<dyn WatcherFactory>,
    glob_watcher: Option<Box<dyn Watcher>>,
    root_watcher: Option<Box<dyn Watcher>>,
    watched_provider_key: String,
    needs_full_scan: bool,
    rescan_pending: bool,
    discovered: BTreeSet<PathBuf>,
    events: Vec<IndexerEvent>,
}

impl Indexer {
    pub fn new(
        providers: Vec<ProviderSpec>,
        fs: Box<dyn FsProbe>,
        factory: Box<dyn WatcherFactory>,
    ) -> Self {
        Self {
            providers,
            fs,
            factory,
            glob_watcher: None,
            root_watcher: None,
            watched_provider_key: String::new(),
            needs_full_scan: true,
            rescan_pending: false,
            discovered: BTreeSet::new(),
            events: Vec::new(),
        }
    }

    /// `start()` — initial full scan + arm watchers.
    pub fn start(&mut self) {
        self.needs_full_scan = true;
        self.run_pending_rescan();
        self.reconfigure_watchers();
    }

    fn provider_has_existing_root(&self, spec: &ProviderSpec) -> bool {
        spec.session_roots.iter().any(|r| self.fs.exists(r))
    }

    /// `reconfigureWatchers` — keyed on `${provider}:${hasExistingRoot?1:0}`; when the key
    /// changes it closes both watchers (drop = RAII close) and re-arms. Every arming
    /// failure degrades instead of aborting.
    pub fn reconfigure_watchers(&mut self) {
        let key = self.watcher_key();
        if key == self.watched_provider_key {
            return;
        }

        // Close both watchers by dropping them. In the original this is where chokidar's
        // synchronous removeAllListeners() detonates an in-flight add; here it is a plain
        // RAII drop that cannot deliver an error to a destroyed handler.
        self.glob_watcher = None;
        self.root_watcher = None;
        self.watched_provider_key = key.clone();
        self.events.push(IndexerEvent::Reconfigured { key });

        if self.providers.is_empty() {
            return;
        }

        self.start_session_watcher();
        self.start_root_watcher();
    }

    fn watcher_key(&self) -> String {
        let mut parts: Vec<String> = self
            .providers
            .iter()
            .map(|p| {
                format!(
                    "{}:{}",
                    p.name,
                    if self.provider_has_existing_root(p) {
                        1
                    } else {
                        0
                    }
                )
            })
            .collect();
        parts.sort();
        parts.join(",")
    }

    /// `startSessionWatcher(providers.filter(hasExistingRoot))` — watch existing roots.
    fn start_session_watcher(&mut self) {
        let mut targets: Vec<PathBuf> = Vec::new();
        for spec in &self.providers {
            if self.provider_has_existing_root(spec) {
                for glob_dir in &spec.glob_dirs {
                    if self.fs.exists(glob_dir) {
                        targets.push(glob_dir.clone());
                    }
                }
            }
        }
        targets.sort();
        targets.dedup();
        if targets.is_empty() {
            return;
        }
        let mut watcher = self.factory.create("glob");
        match watcher.watch(&targets, true) {
            Ok(()) => self.glob_watcher = Some(watcher),
            Err(e) => self.degrade_on_arm_failure("glob", e),
        }
    }

    /// `startRootWatcher(providers)` — watch the nearest existing ancestor of each session
    /// root, within that provider's watch-bases, so an absent root can be detected when it
    /// later appears.
    fn start_root_watcher(&mut self) {
        let mut watch_roots: BTreeSet<PathBuf> = BTreeSet::new();
        for spec in &self.providers {
            let bases = if spec.watch_bases.is_empty() {
                // reference default = [homeDir]; we require explicit bases, so skip.
                continue;
            } else {
                spec.watch_bases.clone()
            };
            for root in &spec.session_roots {
                // matchingBases: bases containing root, longest first.
                let mut matching: Vec<&PathBuf> = bases
                    .iter()
                    .filter(|base| is_path_within(base, root))
                    .collect();
                matching.sort_by_key(|b| std::cmp::Reverse(path_len(b)));
                let mut ancestor: Option<PathBuf> = None;
                for base in matching {
                    if let Some(found) = self.find_nearest_existing_ancestor_within(root, base) {
                        ancestor = Some(found);
                        break;
                    }
                }
                if let Some(ancestor) = ancestor {
                    watch_roots.insert(ancestor);
                }
            }
        }

        if watch_roots.is_empty() {
            return;
        }
        let targets: Vec<PathBuf> = watch_roots.into_iter().collect();
        let mut watcher = self.factory.create("root");
        match watcher.watch(&targets, true) {
            Ok(()) => self.root_watcher = Some(watcher),
            Err(e) => self.degrade_on_arm_failure("root", e),
        }
    }

    fn degrade_on_arm_failure(&mut self, label: &'static str, e: WatchError) {
        // DEV-0002 fix: log + degrade (schedule rescan) + stay alive. Never propagate a
        // panic/abort out of reconfigure.
        self.events
            .push(IndexerEvent::WatchArmFailedDegraded { label, error: e.0 });
        self.needs_full_scan = true;
        self.schedule_rescan();
    }

    /// `findNearestExistingAncestorWithin` — walk up from `target` to `floor`, returning
    /// the first existing directory (inclusive), else `None`.
    fn find_nearest_existing_ancestor_within(
        &self,
        target: &Path,
        floor: &Path,
    ) -> Option<PathBuf> {
        if !is_path_within(floor, target) {
            return None;
        }
        let mut current = target.to_path_buf();
        loop {
            if self.fs.exists(&current) {
                return Some(current);
            }
            if current == floor {
                return None;
            }
            match current.parent() {
                Some(parent) if parent != current => current = parent.to_path_buf(),
                _ => return None,
            }
        }
    }

    /// `affectsWatchedRoot(entryPath)` — true when the path IS a session root or an
    /// ancestor of one (i.e. its creation/removal changes root existence).
    fn affects_watched_root(&self, path: &Path) -> bool {
        self.providers
            .iter()
            .flat_map(|p| &p.session_roots)
            .any(|root| root == path || root.starts_with(path))
    }

    /// Feed a filesystem event. Root-affecting create/remove reconfigures + full-rescans;
    /// file changes schedule a rescan; a backend error degrades (never dies).
    pub fn on_event(&mut self, event: FsEvent) {
        match event {
            FsEvent::Created(path) => {
                if self.affects_watched_root(&path) {
                    self.events.push(IndexerEvent::RootAppeared(path));
                    self.reconfigure_watchers();
                    self.needs_full_scan = true;
                    self.schedule_rescan();
                } else {
                    self.schedule_rescan();
                }
            }
            FsEvent::Removed(path) => {
                if self.affects_watched_root(&path) {
                    self.events.push(IndexerEvent::RootRemoved(path));
                    self.reconfigure_watchers();
                    self.needs_full_scan = true;
                    self.schedule_rescan();
                } else {
                    self.schedule_rescan();
                }
            }
            FsEvent::Modified(_path) => {
                self.schedule_rescan();
            }
            FsEvent::Error(message) => {
                // DEV-0002 (b): a watcher error is logged and a rescan is scheduled —
                // degrade, do not die.
                self.events.push(IndexerEvent::WatchErrorDegraded(message));
                self.schedule_rescan();
            }
        }
    }

    fn schedule_rescan(&mut self) {
        self.rescan_pending = true;
        self.events.push(IndexerEvent::RescanScheduled);
    }

    /// Run a pending rescan (in production this is the debounced refresh timer firing).
    /// Rediscovers session files across all providers whose root exists. Returns the
    /// discovered count.
    pub fn run_pending_rescan(&mut self) -> usize {
        if !self.needs_full_scan && !self.rescan_pending {
            return self.discovered.len();
        }
        self.needs_full_scan = false;
        self.rescan_pending = false;

        let mut discovered = BTreeSet::new();
        for spec in &self.providers {
            for file in self.fs.list_session_files(spec) {
                discovered.insert(file);
            }
        }
        self.discovered = discovered;
        self.events.push(IndexerEvent::RescanRan {
            discovered: self.discovered.len(),
        });
        self.discovered.len()
    }

    /// Current discovered session files (the indexed set), sorted.
    pub fn snapshot(&self) -> Vec<PathBuf> {
        self.discovered.iter().cloned().collect()
    }

    /// Whether a rescan is queued (degrade signal).
    pub fn rescan_pending(&self) -> bool {
        self.rescan_pending || self.needs_full_scan
    }

    /// Drain the structured log for assertions.
    pub fn drain_events(&mut self) -> Vec<IndexerEvent> {
        std::mem::take(&mut self.events)
    }

    /// Peek the structured log without draining.
    pub fn events(&self) -> &[IndexerEvent] {
        &self.events
    }
}

fn path_len(p: &Path) -> usize {
    p.as_os_str().len()
}

/// `isPathWithin(basePath, targetPath)` — target is base or under base.
pub fn is_path_within(base: &Path, target: &Path) -> bool {
    target == base || target.starts_with(base)
}

// ---------------------------------------------------------------------------
// Provider specs (path derivations ported from the three providers).
// ---------------------------------------------------------------------------

/// Claude: root `<home>/projects`, watch-base `<home>`.
pub fn claude_provider_spec(home: &Path) -> ProviderSpec {
    let projects = home.join("projects");
    ProviderSpec {
        name: "claude".to_string(),
        session_roots: vec![projects.clone()],
        watch_bases: vec![home.to_path_buf()],
        glob_dirs: vec![projects],
    }
}

/// Codex: root `<home>/sessions`, watch-base `<home>`.
pub fn codex_provider_spec(home: &Path) -> ProviderSpec {
    let sessions = home.join("sessions");
    ProviderSpec {
        name: "codex".to_string(),
        session_roots: vec![sessions.clone()],
        watch_bases: vec![home.to_path_buf()],
        glob_dirs: vec![sessions],
    }
}

/// OpenCode: root `<dataHome>/opencode.db`, watch-base `dirname(dataHome)`.
pub fn opencode_provider_spec(data_home: &Path) -> ProviderSpec {
    let db = data_home.join("opencode.db");
    let base = data_home
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| data_home.to_path_buf());
    ProviderSpec {
        name: "opencode".to_string(),
        session_roots: vec![db],
        watch_bases: vec![base],
        // OpenCode is direct-listed from SQLite, not file-globbed; the glob watcher covers
        // the data-home dir so db create/update still schedules a rescan.
        glob_dirs: vec![data_home.to_path_buf()],
    }
}

// ---------------------------------------------------------------------------
// Real filesystem probe.
// ---------------------------------------------------------------------------

/// `FsProbe` backed by `std::fs`. `list_session_files` walks each provider's `glob_dirs`
/// recursively collecting `*.jsonl` (the claude/codex file layout; opencode contributes
/// none, matching its direct-listing model).
pub struct RealFsProbe;

impl FsProbe for RealFsProbe {
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }

    fn list_session_files(&self, spec: &ProviderSpec) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for dir in &spec.glob_dirs {
            collect_jsonl(dir, &mut out);
        }
        out.sort();
        out.dedup();
        out
    }
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            collect_jsonl(&path, out);
        } else if ft.is_file() && path.extension().map(|e| e == "jsonl").unwrap_or(false) {
            out.push(path);
        }
    }
}

// ---------------------------------------------------------------------------
// notify-backed watcher (production).
// ---------------------------------------------------------------------------

/// A [`WatcherFactory`] that produces real `notify` watchers, all delivering mapped
/// [`FsEvent`]s to a shared channel.
pub struct NotifyWatcherFactory {
    tx: std::sync::mpsc::Sender<FsEvent>,
}

impl NotifyWatcherFactory {
    pub fn new(tx: std::sync::mpsc::Sender<FsEvent>) -> Self {
        Self { tx }
    }
}

impl WatcherFactory for NotifyWatcherFactory {
    fn create(&self, _label: &'static str) -> Box<dyn Watcher> {
        Box::new(NotifyWatcher {
            tx: self.tx.clone(),
            inner: None,
        })
    }
}

/// A single `notify` watcher whose lifetime is tied to this value (drop = unwatch).
pub struct NotifyWatcher {
    tx: std::sync::mpsc::Sender<FsEvent>,
    inner: Option<notify::RecommendedWatcher>,
}

impl Watcher for NotifyWatcher {
    fn watch(&mut self, paths: &[PathBuf], recursive: bool) -> Result<(), WatchError> {
        use notify::{RecursiveMode, Watcher as _};
        let tx = self.tx.clone();
        let mut watcher =
            notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
                Ok(event) => {
                    for path in event.paths {
                        let mapped = match event.kind {
                            notify::EventKind::Create(_) => FsEvent::Created(path),
                            notify::EventKind::Remove(_) => FsEvent::Removed(path),
                            _ => FsEvent::Modified(path),
                        };
                        let _ = tx.send(mapped);
                    }
                }
                Err(err) => {
                    let _ = tx.send(FsEvent::Error(err.to_string()));
                }
            })
            .map_err(|e| WatchError(e.to_string()))?;

        let mode = if recursive {
            RecursiveMode::Recursive
        } else {
            RecursiveMode::NonRecursive
        };
        for path in paths {
            watcher
                .watch(path, mode)
                .map_err(|e| WatchError(e.to_string()))?;
        }
        self.inner = Some(watcher);
        Ok(())
    }
}
