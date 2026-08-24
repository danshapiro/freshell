#![cfg(unix)]

use chrono::{DateTime, Utc};
use freshell_sessions::indexer::FsEvent;
use notify::{RecommendedWatcher, RecursiveMode, Watcher as NotifyWatcher};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::ffi::OsStr;
use std::fs::{self, File, OpenOptions};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

const SCHEMA_VERSION: u8 = 1;
const OBSERVATION_MS: u64 = 86_400_000;
const BUCKET_MS: u64 = 60_000;
const RECONCILE_MS: u64 = 900_000;
const GRACE_MS: u64 = 60_000;
const DUPLICATE_MS: u64 = 250;
const MAX_PENDING_IDS: usize = 200_000;
const INGRESS_CAPACITY: usize = 8_192;
const MAX_OWN_WATCHES: u64 = 50_000;
const MAX_OWN_INSTANCES: u64 = 4;
const MAX_UNINSPECTABLE_PROCESSES: u64 = 10;
const MAX_PID_FILE_BYTES: u64 = 64;
const MAX_PROC_CMDLINE_BYTES: u64 = 64 * 1024;
const MAX_PROC_STATUS_BYTES: u64 = 64 * 1024;
const MAX_EVENT_BYTES: u64 = 64 * 1024 * 1024;
// systemd hard-caps the observer at 5% of one core. The software guard allows
// modest accounting jitter and stops only after two consecutive actual-time windows.
const CPU_SOFTWARE_LIMIT_PERCENT: f64 = 6.0;
const CPU_BREACH_WINDOWS: u8 = 2;
const PREFLIGHT_SCHEMA_VERSION: u8 = 1;
const PREFLIGHT_MAX_AGE_MS: u64 = 300_000;
const PREFLIGHT_MAX_BYTES: u64 = 16 * 1024;
const OUTPUT_MODE: u32 = 0o600;
static SIGNAL: AtomicU8 = AtomicU8::new(0);
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);
#[cfg(test)]
static GLOBAL_SCAN_CALLS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Failure {
    Cli(&'static str),
    Production(&'static str),
    Resource(&'static str),
    Observer(&'static str),
}

impl Failure {
    fn exit_code(self) -> u8 {
        match self {
            Self::Cli(_) => 2,
            Self::Production(_) => 3,
            Self::Resource(_) => 4,
            Self::Observer(_) => 5,
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::Cli(code)
            | Self::Production(code)
            | Self::Resource(code)
            | Self::Observer(code) => code,
        }
    }
}

type Result<T> = std::result::Result<T, Failure>;

struct StopOutcome {
    reason: &'static str,
    status: &'static str,
    failure: Option<Failure>,
}

#[rustfmt::skip]
impl StopOutcome {
    fn new(reason: &'static str, status: &'static str, failure: Option<Failure>) -> Self {
        Self { reason, status, failure }
    }

    fn absorb(&mut self, error: Failure) {
        if self.failure.is_none() {
            self.reason = error.code();
            self.status = "failed";
            self.failure = Some(error);
        }
    }
}

#[derive(Debug, Clone)]
struct RunConfig {
    run_root: PathBuf,
    roots: Roots,
    production_pid_file: PathBuf,
    production_port: u16,
    preflight_file: PathBuf,
}

#[derive(Debug, Clone)]
struct PreflightConfig {
    roots: Roots,
    output: PathBuf,
}

#[derive(Debug, Clone)]
struct SmokeConfig {
    run_root: PathBuf,
    wait_for_signal: bool,
}

#[derive(Debug, Clone)]
enum Config {
    Preflight(PreflightConfig),
    Run(RunConfig),
    Smoke(SmokeConfig),
}

impl Config {
    fn run_root(&self) -> Option<&Path> {
        match self {
            Self::Preflight(_) => None,
            Self::Run(config) => Some(&config.run_root),
            Self::Smoke(config) => Some(&config.run_root),
        }
    }
}

#[rustfmt::skip]
fn parse_cli<I, S>(args: I) -> Result<Config>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut args = args.into_iter();
    let _program = args.next().ok_or(Failure::Cli("cli_missing"))?;
    let command = match args.next().map(|value| value.as_ref().to_owned()).as_deref() {
        Some("preflight") => "preflight",
        Some("run") => "run",
        Some("smoke") => "smoke",
        _ => return Err(Failure::Cli("cli_command")),
    };
    let mut values: BTreeMap<String, String> = BTreeMap::new();
    let mut wait_for_signal = false;
    let allowed = [
        "--run-root",
        "--claude-root",
        "--codex-root",
        "--amplifier-root",
        "--opencode-db",
        "--production-pid-file",
        "--production-port",
        "--preflight-file",
        "--output",
    ];
    while let Some(raw) = args.next() {
        let key = raw.as_ref();
        if key == "--wait-for-signal" {
            if wait_for_signal {
                return Err(Failure::Cli("cli_duplicate"));
            }
            wait_for_signal = true;
            continue;
        }
        if !allowed.contains(&key) {
            return Err(Failure::Cli("cli_unknown"));
        }
        let value = args.next().ok_or(Failure::Cli("cli_value"))?;
        if values.insert(key.to_owned(), value.as_ref().to_owned()).is_some() {
            return Err(Failure::Cli("cli_duplicate"));
        }
    }
    let absolute = |key: &str, required: bool| -> Result<Option<PathBuf>> {
        let value = values.get(key);
        if required && value.is_none() {
            return Err(Failure::Cli("cli_missing"));
        }
        value
            .map(PathBuf::from)
            .map(|path| {
                if path.is_absolute() {
                    Ok(path)
                } else {
                    Err(Failure::Cli("cli_relative"))
                }
            })
            .transpose()
    };
    let run_root = absolute("--run-root", command != "preflight")?;
    let is_run = command == "run";
    let is_preflight = command == "preflight";
    let production_port = values
        .get("--production-port")
        .map(|value| value.parse::<u16>().map_err(|_| Failure::Cli("cli_port")))
        .transpose()?;
    if is_run && production_port.is_none() {
        return Err(Failure::Cli("cli_missing"));
    }
    if command == "smoke" && values.keys().any(|key| key != "--run-root") {
        return Err(Failure::Cli("cli_smoke_option"));
    }
    if is_run && wait_for_signal {
        return Err(Failure::Cli("cli_smoke_option"));
    }
    let roots = || -> Result<Roots> {
        Ok(Roots {
            claude: absolute("--claude-root", true)?.ok_or(Failure::Cli("cli_missing"))?,
            codex: absolute("--codex-root", true)?.ok_or(Failure::Cli("cli_missing"))?,
            amplifier: absolute("--amplifier-root", true)?.ok_or(Failure::Cli("cli_missing"))?,
            opencode_db: absolute("--opencode-db", true)?.ok_or(Failure::Cli("cli_missing"))?,
        })
    };
    if is_preflight {
        if values.contains_key("--run-root")
            || values.contains_key("--production-pid-file")
            || values.contains_key("--production-port")
            || values.contains_key("--preflight-file")
            || wait_for_signal
        {
            return Err(Failure::Cli("cli_preflight_option"));
        }
        Ok(Config::Preflight(PreflightConfig {
            roots: roots()?,
            output: absolute("--output", true)?.ok_or(Failure::Cli("cli_missing"))?,
        }))
    } else if is_run {
        if values.contains_key("--output") {
            return Err(Failure::Cli("cli_run_option"));
        }
        Ok(Config::Run(RunConfig {
            run_root: run_root.ok_or(Failure::Cli("cli_missing"))?,
            roots: roots()?,
            production_pid_file: absolute("--production-pid-file", true)?.ok_or(Failure::Cli("cli_missing"))?,
            production_port: production_port.ok_or(Failure::Cli("cli_missing"))?,
            preflight_file: absolute("--preflight-file", true)?.ok_or(Failure::Cli("cli_missing"))?,
        }))
    } else {
        Ok(Config::Smoke(SmokeConfig {
            run_root: run_root.ok_or(Failure::Cli("cli_missing"))?,
            wait_for_signal,
        }))
    }
}

fn validate_run_root(path: &Path) -> Result<()> {
    if !path.is_absolute() {
        return Err(Failure::Cli("root_relative"));
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| Failure::Cli("root_missing"))?;
    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    let uid = unsafe { libc::geteuid() };
    let empty = fs::read_dir(path)
        .map_err(|_| Failure::Cli("root_read"))?
        .next()
        .is_none();
    validate_root_attributes(
        metadata.file_type().is_symlink(),
        metadata.is_dir(),
        metadata.uid(),
        uid,
        metadata.mode() & 0o777,
        empty,
    )
}

fn validate_root_attributes(
    symlink: bool,
    directory: bool,
    owner: u32,
    expected_owner: u32,
    mode: u32,
    empty: bool,
) -> Result<()> {
    if symlink || !directory {
        Err(Failure::Cli("root_type"))
    } else if owner != expected_owner {
        Err(Failure::Cli("root_owner"))
    } else if mode != 0o700 {
        Err(Failure::Cli("root_mode"))
    } else if !empty {
        Err(Failure::Cli("root_nonempty"))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Provider {
    Claude,
    Codex,
    Amplifier,
    Opencode,
}

impl Provider {
    const ALL: [Self; 4] = [Self::Claude, Self::Codex, Self::Amplifier, Self::Opencode];

    fn name(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::Amplifier => "amplifier",
            Self::Opencode => "opencode",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct PathId(String);

fn path_id(salt: &[u8; 32], provider: Provider, path: &Path) -> PathId {
    fn half(salt: &[u8; 32], provider: Provider, path: &Path, separator: u8) -> u64 {
        let mut hasher = DefaultHasher::new();
        separator.hash(&mut hasher);
        salt.hash(&mut hasher);
        provider.hash(&mut hasher);
        path.as_os_str().as_bytes().hash(&mut hasher);
        hasher.finish()
    }
    PathId(format!(
        "{:016x}{:016x}",
        half(salt, provider, path, 0x51),
        half(salt, provider, path, 0xa7)
    ))
}

#[derive(Debug, Clone)]
struct Roots {
    claude: PathBuf,
    codex: PathBuf,
    amplifier: PathBuf,
    opencode_db: PathBuf,
}

impl Roots {
    fn root(&self, provider: Provider) -> &Path {
        match provider {
            Provider::Claude => &self.claude,
            Provider::Codex => &self.codex,
            Provider::Amplifier => &self.amplifier,
            Provider::Opencode => &self.opencode_db,
        }
    }
}

#[derive(Debug, Clone)]
struct ObserverProbe {
    roots: Roots,
    salt: [u8; 32],
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Signature {
    provider: Provider,
    size: u64,
    mtime_sec: i64,
    mtime_nsec: i64,
    ctime_sec: i64,
    ctime_nsec: i64,
    device: u64,
    inode: u64,
}

type Inventory = BTreeMap<PathId, Signature>;

#[derive(Default)]
struct Scan {
    inventory: Inventory,
    ignored_symlinks: u64,
}

#[rustfmt::skip]
impl ObserverProbe {
    fn qualifies(&self, provider: Provider, path: &Path) -> bool {
        match provider {
            Provider::Claude | Provider::Codex => path.extension() == Some(OsStr::new("jsonl")),
            Provider::Amplifier => {
                if !path.components().any(|component| component.as_os_str() == OsStr::new("sessions")) {
                    return false;
                }
                matches!(
                    path.file_name().and_then(OsStr::to_str),
                    Some("metadata.json" | "transcript.jsonl" | "events.jsonl")
                )
            }
            Provider::Opencode => qualify_opencode(path, &self.roots.opencode_db),
        }
    }

    fn scan(&self) -> Result<Scan> {
        for provider in Provider::ALL {
            let root = self.roots.root(provider);
            if let Ok(metadata) = fs::symlink_metadata(root) {
                if metadata.file_type().is_symlink() {
                    return Err(Failure::Observer("configured_root_symlink"));
                }
            }
        }
        let mut scan = Scan::default();
        for provider in [Provider::Claude, Provider::Codex, Provider::Amplifier] {
            self.walk(provider, self.roots.root(provider), &mut scan)?;
        }
        for candidate in [
            self.roots.opencode_db.clone(),
            self.roots.opencode_db.with_file_name("opencode.db-wal"),
        ] {
            self.record(Provider::Opencode, &candidate, &mut scan)?;
        }
        Ok(scan)
    }

    fn walk(&self, provider: Provider, directory: &Path, scan: &mut Scan) -> Result<()> {
        let entries = match fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err(Failure::Observer("reconciliation_error")),
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(Failure::Observer("reconciliation_error")),
            };
            let path = entry.path();
            let metadata = match fs::symlink_metadata(&path) {
                Ok(metadata) => metadata,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err(Failure::Observer("reconciliation_error")),
            };
            if metadata.file_type().is_symlink() {
                scan.ignored_symlinks += 1;
            } else if metadata.is_dir() {
                self.walk(provider, &path, scan)?;
            } else if metadata.is_file() {
                self.record_metadata(provider, &path, metadata, scan);
            }
        }
        Ok(())
    }

    fn record(&self, provider: Provider, path: &Path, scan: &mut Scan) -> Result<()> {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                scan.ignored_symlinks += 1;
            }
            Ok(metadata) if metadata.is_file() => {
                self.record_metadata(provider, path, metadata, scan);
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Failure::Observer("reconciliation_error")),
        }
        Ok(())
    }

    fn record_metadata(&self, provider: Provider, path: &Path, metadata: fs::Metadata, scan: &mut Scan) {
        if self.qualifies(provider, path) {
            let id = path_id(&self.salt, provider, path);
            scan.inventory.insert(
                id,
                Signature {
                    provider,
                    size: metadata.size(),
                    mtime_sec: metadata.mtime(),
                    mtime_nsec: metadata.mtime_nsec(),
                    ctime_sec: metadata.ctime(),
                    ctime_nsec: metadata.ctime_nsec(),
                    device: metadata.dev(),
                    inode: metadata.ino(),
                },
            );
        }
    }

    fn provider_for_path(&self, path: &Path) -> Option<Provider> {
        if path == self.roots.opencode_db || path == self.roots.opencode_db.with_file_name("opencode.db-wal") {
            return Some(Provider::Opencode);
        }
        if path.parent() == self.roots.opencode_db.parent() {
            return Some(Provider::Opencode);
        }
        [Provider::Claude, Provider::Codex, Provider::Amplifier]
            .into_iter()
            .find(|provider| path.starts_with(self.roots.root(*provider)))
    }

    fn exists(&self, path: &Path) -> bool {
        fs::symlink_metadata(path)
            .map(|metadata| !metadata.file_type().is_symlink())
            .unwrap_or(false)
    }

    fn qualified_provider(&self, path: &Path) -> Option<Provider> {
        self.provider_for_path(path).filter(|provider| self.qualifies(*provider, path))
    }
}

fn qualify_opencode(path: &Path, db: &Path) -> bool {
    path == db || path == db.with_file_name("opencode.db-wal")
}

#[derive(Default)]
struct InventoryDiff {
    added: Vec<PathId>,
    modified: Vec<PathId>,
    removed: Vec<PathId>,
}

fn diff_inventory(old: &Inventory, new: &Inventory) -> InventoryDiff {
    let mut diff = InventoryDiff::default();
    for (id, signature) in new {
        match old.get(id) {
            None => diff.added.push(id.clone()),
            Some(previous) if previous != signature => diff.modified.push(id.clone()),
            Some(_) => {}
        }
    }
    for id in old.keys() {
        if !new.contains_key(id) {
            diff.removed.push(id.clone());
        }
    }
    diff
}

#[cfg(test)]
fn fixture_inventory<const N: usize>(items: [(&str, u64, u64, u64); N]) -> Inventory {
    items
        .into_iter()
        .map(|(id, device, inode, size)| {
            (
                PathId(id.to_owned()),
                Signature {
                    provider: Provider::Claude,
                    size,
                    mtime_sec: size as i64,
                    mtime_nsec: 0,
                    ctime_sec: 0,
                    ctime_nsec: 0,
                    device,
                    inode,
                },
            )
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
enum NoticeKind {
    Create,
    Modify,
    Remove,
    Structural,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChangeKind {
    Added,
    Modified,
    Removed,
}

#[derive(Debug, Clone)]
struct NoticeAggregate {
    count: u64,
    first_ms: u64,
    last_ms: u64,
    consumed: bool,
}

#[derive(Debug, Clone)]
struct PendingChange {
    kind: ChangeKind,
    provider: Provider,
    id: PathId,
    at_ms: u64,
}

#[derive(Debug, Clone, Copy)]
struct NoticeBatch {
    first_ms: u64,
    last_ms: u64,
    raw_count: u64,
    burst_duplicate_count: u64,
}

#[derive(Default)]
struct Correlation {
    notices: BTreeMap<(Provider, PathId, NoticeKind), NoticeAggregate>,
    pending: Vec<PendingChange>,
    matched: u64,
    delayed: u64,
    missed: u64,
    burst_duplicates: u64,
    notice_only_total: u64,
}

#[rustfmt::skip]
impl Correlation {
    #[cfg(test)]
    fn notice(&mut self, provider: Provider, id: PathId, kind: NoticeKind, at_ms: u64) {
        self.notice_coalesced(
            provider,
            id,
            kind,
            NoticeBatch {
                first_ms: at_ms,
                last_ms: at_ms,
                raw_count: 1,
                burst_duplicate_count: 0,
            },
        );
    }

    fn notice_coalesced(
        &mut self,
        provider: Provider,
        id: PathId,
        kind: NoticeKind,
        batch: NoticeBatch,
    ) {
        let cross_batch_duplicate =
            self.is_burst_duplicate(provider, &id, kind, batch.first_ms, Duration::from_millis(DUPLICATE_MS));
        self.burst_duplicates = self
            .burst_duplicates
            .saturating_add(batch.burst_duplicate_count)
            .saturating_add(u64::from(cross_batch_duplicate));
        let entry = self.notices.entry((provider, id.clone(), kind)).or_insert(NoticeAggregate {
            count: 0,
            first_ms: batch.first_ms,
            last_ms: batch.last_ms,
            consumed: false,
        });
        entry.count = entry.count.saturating_add(batch.raw_count);
        entry.last_ms = entry.last_ms.max(batch.last_ms);
        if let Some(index) = self.pending.iter().position(|pending| {
            pending.provider == provider
                && pending.id == id
                && compatible(pending.kind, kind)
                && batch.last_ms >= pending.at_ms
                && batch.first_ms <= pending.at_ms.saturating_add(GRACE_MS)
        }) {
            self.pending.swap_remove(index);
            entry.consumed = true;
            self.delayed += 1;
        }
    }

    fn is_burst_duplicate(&self, provider: Provider, id: &PathId, kind: NoticeKind, at_ms: u64, window: Duration) -> bool {
        self.notices
            .get(&(provider, id.clone(), kind))
            .is_some_and(|notice| at_ms.saturating_sub(notice.last_ms) <= window.as_millis() as u64)
    }

    fn metadata_change(&mut self, kind: ChangeKind, provider: Provider, id: PathId, at_ms: u64) {
        let match_key = self.notices.iter().find_map(|(key, notice)| {
            (key.0 == provider && key.1 == id && compatible(kind, key.2) && notice.first_ms <= at_ms && !notice.consumed)
                .then(|| key.clone())
        });
        if let Some(key) = match_key {
            if let Some(notice) = self.notices.get_mut(&key) {
                notice.consumed = true;
            }
            self.matched += 1;
        } else {
            self.pending.push(PendingChange { kind, provider, id, at_ms });
        }
    }

    fn finalize_grace(&mut self, now_ms: u64) -> BTreeMap<Provider, u64> {
        let mut per_provider = BTreeMap::new();
        self.pending.retain(|pending| {
            let keep = now_ms.saturating_sub(pending.at_ms) <= GRACE_MS;
            if !keep {
                *per_provider.entry(pending.provider).or_default() += 1;
                self.missed += 1;
            }
            keep
        });
        per_provider
    }

    fn finish_interval(&mut self, end_ms: u64) -> BTreeMap<Provider, u64> {
        let mut per_provider = BTreeMap::new();
        self.notices.retain(|key, notice| {
            let keep = notice.last_ms > end_ms;
            if !keep && !notice.consumed {
                *per_provider.entry(key.0).or_default() += 1;
                self.notice_only_total += 1;
            }
            keep
        });
        per_provider
    }

    fn budget_len(&self) -> usize {
        self.notices.len().saturating_add(self.pending.len())
    }

    fn notice_only(&self) -> u64 {
        self.notice_only_total + self.notices.values().filter(|notice| !notice.consumed).count() as u64
    }

    fn unresolved_at_shutdown(&self) -> u64 {
        self.pending.len() as u64
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct BucketSpan {
    start_ms: u64,
    end_ms: u64,
    partial: bool,
}

struct BucketSchedule {
    bucket_ms: u64,
    next_start_ms: u64,
}

#[rustfmt::skip]
impl BucketSchedule {
    fn new(bucket_ms: u64) -> Self {
        Self {
            bucket_ms,
            next_start_ms: 0,
        }
    }

    fn take_due(&mut self, elapsed_ms: u64, stopping: bool) -> Vec<BucketSpan> {
        let mut spans = Vec::new();
        while self.next_start_ms + self.bucket_ms <= elapsed_ms {
            let end = self.next_start_ms + self.bucket_ms;
            spans.push(BucketSpan {
                start_ms: self.next_start_ms,
                end_ms: end,
                partial: false,
            });
            self.next_start_ms = end;
        }
        if stopping && self.next_start_ms < elapsed_ms {
            spans.push(BucketSpan {
                start_ms: self.next_start_ms,
                end_ms: elapsed_ms,
                partial: true,
            });
            self.next_start_ms = elapsed_ms;
        }
        spans
    }
}

fn compatible(change: ChangeKind, notice: NoticeKind) -> bool {
    matches!(
        (change, notice),
        (ChangeKind::Added, NoticeKind::Create | NoticeKind::Modify)
            | (
                ChangeKind::Modified,
                NoticeKind::Modify | NoticeKind::Create
            )
            | (ChangeKind::Removed, NoticeKind::Remove | NoticeKind::Modify)
    )
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
struct InotifyUsage {
    watches: u64,
    instances: u64,
    global_accounting_complete: bool,
    uninspectable_processes: u64,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct Preflight {
    max_watches: u64,
    max_instances: u64,
    max_queue: u64,
    nofile: u64,
    existing_watches: u64,
    existing_instances: u64,
    projected_watches: u64,
    projected_instances: u64,
    global_accounting_complete: bool,
    uninspectable_processes: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PreflightSystem {
    uid: u32,
    boot_id: String,
    max_watches: u64,
    max_instances: u64,
    max_queue: u64,
    nofile: u64,
    monotonic_uptime_ms: u64,
    utc: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct PreflightHandoff {
    schema_version: u8,
    uid: u32,
    boot_id: String,
    created_utc: String,
    monotonic_uptime_ms: u64,
    max_watches: u64,
    max_instances: u64,
    max_queue: u64,
    nofile: u64,
    existing_watches: u64,
    existing_instances: u64,
    projected_watches: u64,
    projected_instances: u64,
    global_accounting_complete: bool,
    uninspectable_processes: u64,
}

impl PreflightHandoff {
    fn runtime(&self) -> Preflight {
        Preflight {
            max_watches: self.max_watches,
            max_instances: self.max_instances,
            max_queue: self.max_queue,
            nofile: self.nofile,
            existing_watches: self.existing_watches,
            existing_instances: self.existing_instances,
            projected_watches: self.projected_watches,
            projected_instances: self.projected_instances,
            global_accounting_complete: self.global_accounting_complete,
            uninspectable_processes: self.uninspectable_processes,
        }
    }
}

impl Preflight {
    fn validate(self) -> Result<()> {
        if self.uninspectable_processes > MAX_UNINSPECTABLE_PROCESSES {
            return Err(Failure::Cli("preflight_uninspectable"));
        }
        if u128::from(self.existing_watches) + u128::from(self.projected_watches)
            > u128::from(self.max_watches) / 5
        {
            return Err(Failure::Cli("preflight_watches"));
        }
        if u128::from(self.existing_instances) + u128::from(self.projected_instances)
            > u128::from(self.max_instances) / 5
        {
            return Err(Failure::Cli("preflight_instances"));
        }
        if self.max_queue < 16_384 {
            return Err(Failure::Cli("preflight_queue"));
        }
        if self.nofile < 65_536 {
            return Err(Failure::Cli("preflight_nofile"));
        }
        Ok(())
    }
}

fn validate_minute_watch_usage(
    own_watches: u64,
    own_instances: u64,
    global: InotifyUsage,
    max_watches: u64,
    max_instances: u64,
) -> Result<()> {
    if own_watches > MAX_OWN_WATCHES || own_instances > MAX_OWN_INSTANCES {
        Err(Failure::Resource("resource_watches"))
    } else if global.uninspectable_processes > MAX_UNINSPECTABLE_PROCESSES {
        Err(Failure::Resource("resource_uninspectable"))
    } else if global.watches > max_watches / 5 || global.instances > max_instances / 5 {
        Err(Failure::Resource("resource_watches"))
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
struct ResourceSample {
    cpu_percent: f64,
    cpu_window_complete: bool,
    rss_bytes: u64,
    fds: u64,
    threads: u64,
    pending_ids: u64,
    output_bytes: u64,
    own_watches: u64,
    global_watches: u64,
    global_instances: u64,
    global_accounting_complete: bool,
    uninspectable_processes: u64,
}

impl ResourceSample {
    #[cfg(test)]
    fn safe() -> Self {
        Self {
            cpu_percent: 1.0,
            cpu_window_complete: true,
            rss_bytes: 32 * 1024 * 1024,
            fds: 10,
            threads: 2,
            pending_ids: 10,
            output_bytes: 1024,
            own_watches: 10,
            global_watches: 100,
            global_instances: 10,
            global_accounting_complete: true,
            uninspectable_processes: 0,
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct ResourceLimits {
    rss_bytes: u64,
    fds: u64,
    threads: u64,
    pending_ids: u64,
    output_bytes: u64,
}

impl Default for ResourceLimits {
    fn default() -> Self {
        Self {
            rss_bytes: 192 * 1024 * 1024,
            fds: 60_000,
            threads: 12,
            pending_ids: MAX_PENDING_IDS as u64,
            output_bytes: MAX_EVENT_BYTES,
        }
    }
}

impl ResourceLimits {
    fn check(self, sample: &ResourceSample) -> Result<()> {
        if sample.rss_bytes > self.rss_bytes {
            Err(Failure::Resource("resource_rss"))
        } else if sample.fds > self.fds {
            Err(Failure::Resource("resource_fds"))
        } else if sample.threads > self.threads {
            Err(Failure::Resource("resource_threads"))
        } else if sample.pending_ids > self.pending_ids {
            Err(Failure::Resource("resource_pending"))
        } else if sample.output_bytes > self.output_bytes {
            Err(Failure::Resource("resource_output"))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Default)]
struct CpuLimitGuard {
    consecutive_breaches: u8,
    last_complete_window_ms: Option<u64>,
}

impl CpuLimitGuard {
    fn check_at(&mut self, sample: &ResourceSample, actual_elapsed_ms: u64) -> Result<()> {
        if !sample.cpu_window_complete {
            return Ok(());
        }
        if self
            .last_complete_window_ms
            .is_some_and(|last| actual_elapsed_ms.saturating_sub(last) < BUCKET_MS)
        {
            return Ok(());
        }
        self.last_complete_window_ms = Some(actual_elapsed_ms);
        if sample.cpu_percent <= CPU_SOFTWARE_LIMIT_PERCENT {
            self.consecutive_breaches = 0;
            return Ok(());
        }
        self.consecutive_breaches = self.consecutive_breaches.saturating_add(1);
        if self.consecutive_breaches >= CPU_BREACH_WINDOWS {
            Err(Failure::Resource("resource_cpu"))
        } else {
            Ok(())
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
struct ProviderStats {
    create: u64,
    modify: u64,
    remove: u64,
    structural: u64,
    unique_ids: u64,
    burst_duplicates: u64,
    added: u64,
    modified: u64,
    removed: u64,
    matched: u64,
    delayed: u64,
    missed: u64,
    notice_only: u64,
}

#[rustfmt::skip]
impl ProviderStats {
    fn delta(self, old: Self) -> Self {
        Self { create: self.create - old.create, modify: self.modify - old.modify,
            remove: self.remove - old.remove, structural: self.structural - old.structural,
            unique_ids: self.unique_ids - old.unique_ids, burst_duplicates: self.burst_duplicates - old.burst_duplicates,
            added: self.added - old.added, modified: self.modified - old.modified, removed: self.removed - old.removed,
            matched: self.matched - old.matched, delayed: self.delayed - old.delayed,
            missed: self.missed - old.missed, notice_only: self.notice_only - old.notice_only }
    }
}

#[derive(Debug, Default, Serialize)]
struct StatsDelta {
    providers: BTreeMap<Provider, ProviderStats>,
    watcher_errors: u64,
    watcher_overflows: u64,
    watcher_rearms: u64,
    reconciliations: u64,
    reconciliation_ms: u64,
    production_checks: u64,
    production_mismatches: u64,
}

#[derive(Debug, Default, Serialize)]
struct RunStats {
    providers: BTreeMap<Provider, ProviderStats>,
    watcher_errors: u64,
    watcher_overflows: u64,
    watcher_rearms: u64,
    reconciliations: u64,
    reconciliation_ms_total: u64,
    reconciliation_ms_max: u64,
    production_checks: u64,
    production_mismatches: u64,
    preflight: Option<Preflight>,
    inotify_baseline_source: Option<&'static str>,
    inotify_baseline_utc: Option<String>,
    inotify_baseline_complete: bool,
    actual_watches: u64,
    actual_instances: u64,
    bucket_sequence: u64,
    next_reconcile_ms: u64,
    latest_resources: Option<ResourceSample>,
    peak_resources: ResourceSample,
    #[serde(skip)]
    notice_ids: BTreeMap<Provider, BTreeSet<PathId>>,
    #[serde(skip)]
    bucket_baseline: StatsDelta,
}

#[rustfmt::skip]
impl RunStats {
    fn provider(&mut self, provider: Provider) -> &mut ProviderStats {
        self.providers.entry(provider).or_default()
    }

    fn sample(&mut self, sample: ResourceSample) {
        let first = self.latest_resources.is_none();
        self.peak_resources.cpu_percent = self.peak_resources.cpu_percent.max(sample.cpu_percent);
        self.peak_resources.cpu_window_complete |= sample.cpu_window_complete;
        self.peak_resources.rss_bytes = self.peak_resources.rss_bytes.max(sample.rss_bytes);
        self.peak_resources.fds = self.peak_resources.fds.max(sample.fds);
        self.peak_resources.threads = self.peak_resources.threads.max(sample.threads);
        self.peak_resources.pending_ids = self.peak_resources.pending_ids.max(sample.pending_ids);
        self.peak_resources.output_bytes = self.peak_resources.output_bytes.max(sample.output_bytes);
        self.peak_resources.own_watches = self.peak_resources.own_watches.max(sample.own_watches);
        self.peak_resources.global_watches = self.peak_resources.global_watches.max(sample.global_watches);
        self.peak_resources.global_instances = self.peak_resources.global_instances.max(sample.global_instances);
        self.peak_resources.global_accounting_complete =
            if first { sample.global_accounting_complete } else { self.peak_resources.global_accounting_complete && sample.global_accounting_complete };
        self.peak_resources.uninspectable_processes =
            self.peak_resources.uninspectable_processes.max(sample.uninspectable_processes);
        self.latest_resources = Some(sample);
    }

    fn counters(&self) -> StatsDelta {
        StatsDelta { providers: self.providers.clone(), watcher_errors: self.watcher_errors,
            watcher_overflows: self.watcher_overflows,
            watcher_rearms: self.watcher_rearms, reconciliations: self.reconciliations,
            reconciliation_ms: self.reconciliation_ms_total, production_checks: self.production_checks,
            production_mismatches: self.production_mismatches }
    }

    fn establish_bucket_baseline(&mut self) {
        self.bucket_baseline = self.counters();
        self.notice_ids.clear();
    }

    fn record_interval_id(&mut self, provider: Provider, id: PathId) {
        if self.notice_ids.entry(provider).or_default().insert(id) {
            self.provider(provider).unique_ids += 1;
        }
    }

    fn take_bucket_delta(&mut self) -> StatsDelta {
        let current = self.counters();
        let providers = Provider::ALL.into_iter().map(|provider| {
            let now = current.providers.get(&provider).copied().unwrap_or_default();
            let old = self.bucket_baseline.providers.get(&provider).copied().unwrap_or_default();
            (provider, now.delta(old))
        }).collect();
        let delta = StatsDelta { providers, watcher_errors: current.watcher_errors - self.bucket_baseline.watcher_errors,
            watcher_overflows: current.watcher_overflows - self.bucket_baseline.watcher_overflows,
            watcher_rearms: current.watcher_rearms - self.bucket_baseline.watcher_rearms,
            reconciliations: current.reconciliations - self.bucket_baseline.reconciliations,
            reconciliation_ms: current.reconciliation_ms - self.bucket_baseline.reconciliation_ms,
            production_checks: current.production_checks - self.bucket_baseline.production_checks,
            production_mismatches: current.production_mismatches - self.bucket_baseline.production_mismatches };
        self.bucket_baseline = current;
        self.notice_ids.clear();
        delta
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ListenerFingerprint {
    address: String,
    port: u16,
    inode: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProductionFingerprint {
    pid_file: Vec<u8>,
    pid: u32,
    start_ticks: u64,
    cmdline: Vec<u8>,
    status_uids: [u32; 4],
    status_gids: [u32; 4],
    proc_uid: u32,
    proc_gid: u32,
    executable_device: u64,
    executable_inode: u64,
    listeners: BTreeSet<ListenerFingerprint>,
}

#[rustfmt::skip]
fn capture_production(pid_file: &Path, port: u16) -> Result<ProductionFingerprint> {
    let pid_file_bytes = read_production_pid_file(pid_file)?;
    let pid_text =
        std::str::from_utf8(&pid_file_bytes).map_err(|_| Failure::Production("production_pid"))?;
    let pid = pid_text
        .trim()
        .parse::<u32>()
        .map_err(|_| Failure::Production("production_pid"))?;
    let proc_root = PathBuf::from(format!("/proc/{pid}"));
    let start_ticks = read_start_ticks(&proc_root)?;
    let cmdline = read_bounded_proc_file(
        &proc_root.join("cmdline"),
        MAX_PROC_CMDLINE_BYTES,
        "production_cmdline",
    )?;
    let argv0 = cmdline
        .split(|byte| *byte == 0)
        .next()
        .filter(|value| !value.is_empty())
        .ok_or(Failure::Production("production_cmdline"))?;
    let executable_path = Path::new(OsStr::from_bytes(argv0));
    if !executable_path.is_absolute() {
        return Err(Failure::Production("production_cmdline"));
    }
    let executable = fs::metadata(executable_path)
        .map_err(|_| Failure::Production("production_executable"))?;
    if !executable.is_file() {
        return Err(Failure::Production("production_executable"));
    }
    let status = read_bounded_proc_file(
        &proc_root.join("status"),
        MAX_PROC_STATUS_BYTES,
        "production_status",
    )?;
    let status = std::str::from_utf8(&status)
        .map_err(|_| Failure::Production("production_status"))?;
    let status_uids = parse_status_ids(status, "Uid:")?;
    let status_gids = parse_status_ids(status, "Gid:")?;
    let proc_metadata = fs::metadata(&proc_root)
        .map_err(|_| Failure::Production("production_identity"))?;
    if proc_metadata.uid() != status_uids[0] || proc_metadata.gid() != status_gids[0] {
        return Err(Failure::Production("production_identity"));
    }
    let listeners = listening_listeners(port)?;
    if listeners.is_empty() {
        return Err(Failure::Production("production_listener"));
    }
    if read_start_ticks(&proc_root)? != start_ticks {
        return Err(Failure::Production("production_fingerprint_changed"));
    }
    Ok(ProductionFingerprint {
        pid_file: pid_file_bytes,
        pid,
        start_ticks,
        cmdline,
        status_uids,
        status_gids,
        proc_uid: proc_metadata.uid(),
        proc_gid: proc_metadata.gid(),
        executable_device: executable.dev(),
        executable_inode: executable.ino(),
        listeners,
    })
}

fn read_start_ticks(proc_root: &Path) -> Result<u64> {
    let stat = fs::read_to_string(proc_root.join("stat"))
        .map_err(|_| Failure::Production("production_stat"))?;
    let close = stat
        .rfind(')')
        .ok_or(Failure::Production("production_stat"))?;
    let fields: Vec<&str> = stat[close + 2..].split_whitespace().collect();
    fields
        .get(19)
        .ok_or(Failure::Production("production_stat"))?
        .parse::<u64>()
        .map_err(|_| Failure::Production("production_stat"))
}

fn read_bounded_proc_file(path: &Path, limit: u64, error_code: &'static str) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| Failure::Production(error_code))?;
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::Production(error_code))?;
    if bytes.is_empty() || bytes.len() as u64 > limit {
        return Err(Failure::Production(error_code));
    }
    Ok(bytes)
}

fn parse_status_ids(status: &str, label: &str) -> Result<[u32; 4]> {
    let values = status
        .lines()
        .find(|line| line.starts_with(label))
        .ok_or(Failure::Production("production_status"))?
        .split_whitespace()
        .skip(1)
        .map(|value| {
            value
                .parse::<u32>()
                .map_err(|_| Failure::Production("production_status"))
        })
        .collect::<Result<Vec<_>>>()?;
    values
        .try_into()
        .map_err(|_| Failure::Production("production_status"))
}

fn read_production_pid_file(path: &Path) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| Failure::Production("production_pid_file"))?;
    let metadata = file
        .metadata()
        .map_err(|_| Failure::Production("production_pid_file"))?;
    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.nlink() != 1
        || metadata.len() == 0
        || metadata.len() > MAX_PID_FILE_BYTES
        || metadata.mode() & 0o022 != 0
    {
        return Err(Failure::Production("production_pid_file"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_PID_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::Production("production_pid_file"))?;
    if bytes.len() as u64 != metadata.len() {
        return Err(Failure::Production("production_pid_file"));
    }
    Ok(bytes)
}

#[rustfmt::skip]
fn listening_listeners(port: u16) -> Result<BTreeSet<ListenerFingerprint>> {
    let mut result = BTreeSet::new();
    for path in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let content =
            fs::read_to_string(path).map_err(|_| Failure::Production("production_net"))?;
        for line in content.lines().skip(1) {
            let fields: Vec<&str> = line.split_whitespace().collect();
            let Some(local) = fields.get(1) else {
                continue;
            };
            let Some(state) = fields.get(3) else {
                continue;
            };
            let Some(inode) = fields.get(9) else {
                continue;
            };
            let Some((address, hex_port)) = local.rsplit_once(':') else {
                continue;
            };
            if *state == "0A" && u16::from_str_radix(hex_port, 16).ok() == Some(port) {
                if let Ok(inode) = inode.parse::<u64>() {
                    result.insert(ListenerFingerprint { address: address.to_owned(), port, inode });
                }
            }
        }
    }
    Ok(result)
}

fn verify_production(expected: &ProductionFingerprint, pid_file: &Path, port: u16) -> Result<()> {
    let current = capture_production(pid_file, port)?;
    if fingerprint_matches(expected, &current) {
        Ok(())
    } else {
        Err(Failure::Production("production_fingerprint_changed"))
    }
}

fn fingerprint_matches(expected: &ProductionFingerprint, current: &ProductionFingerprint) -> bool {
    expected == current
}

fn read_number(path: &str) -> Result<u64> {
    fs::read_to_string(path)
        .map_err(|_| Failure::Cli("preflight_read"))?
        .trim()
        .parse::<u64>()
        .map_err(|_| Failure::Cli("preflight_parse"))
}

fn proc_error_is_race(kind: std::io::ErrorKind) -> bool {
    kind == std::io::ErrorKind::NotFound
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProcessFdInspection {
    Complete { watches: u64, instances: u64 },
    Gone { watches: u64, instances: u64 },
    Inaccessible { watches: u64, instances: u64 },
}

impl ProcessFdInspection {
    fn counts(self) -> (u64, u64) {
        match self {
            Self::Complete { watches, instances }
            | Self::Gone { watches, instances }
            | Self::Inaccessible { watches, instances } => (watches, instances),
        }
    }
}

trait ProcessProbe {
    fn read_status(&mut self) -> std::io::Result<String>;
    fn inspect_fds(&mut self) -> Result<ProcessFdInspection>;
}

struct ProcProcessProbe {
    path: PathBuf,
}

impl ProcessProbe for ProcProcessProbe {
    fn read_status(&mut self) -> std::io::Result<String> {
        fs::read_to_string(self.path.join("status"))
    }

    fn inspect_fds(&mut self) -> Result<ProcessFdInspection> {
        let fd_root = self.path.join("fd");
        let fds = match fs::read_dir(&fd_root) {
            Ok(fds) => fds,
            Err(error) if proc_error_is_race(error.kind()) => {
                return Ok(ProcessFdInspection::Gone {
                    watches: 0,
                    instances: 0,
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                return Ok(ProcessFdInspection::Inaccessible {
                    watches: 0,
                    instances: 0,
                });
            }
            Err(_) => return Err(Failure::Cli("preflight_fd")),
        };
        let mut watches = 0;
        let mut instances = 0;
        for fd in fds {
            let fd = match fd {
                Ok(fd) => fd,
                Err(error) if proc_error_is_race(error.kind()) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    return Ok(ProcessFdInspection::Inaccessible { watches, instances });
                }
                Err(_) => return Err(Failure::Cli("preflight_fd")),
            };
            let target = match fs::read_link(fd.path()) {
                Ok(target) => target,
                Err(error) if proc_error_is_race(error.kind()) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    return Ok(ProcessFdInspection::Inaccessible { watches, instances });
                }
                Err(_) => return Err(Failure::Cli("preflight_fd")),
            };
            if target != Path::new("anon_inode:inotify") {
                continue;
            }
            instances += 1;
            let info = match fs::read_to_string(self.path.join("fdinfo").join(fd.file_name())) {
                Ok(info) => info,
                Err(error) if proc_error_is_race(error.kind()) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                    return Ok(ProcessFdInspection::Inaccessible { watches, instances });
                }
                Err(_) => return Err(Failure::Cli("preflight_fdinfo")),
            };
            watches += info
                .lines()
                .filter(|line| line.starts_with("inotify wd:"))
                .count() as u64;
        }
        Ok(ProcessFdInspection::Complete { watches, instances })
    }
}

fn process_uid_and_state(status: &str) -> Result<(u32, char)> {
    let uid = status
        .lines()
        .find(|line| line.starts_with("Uid:"))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or(Failure::Cli("preflight_proc"))?;
    let state = status
        .lines()
        .find(|line| line.starts_with("State:"))
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.chars().next())
        .ok_or(Failure::Cli("preflight_proc"))?;
    Ok((uid, state))
}

fn process_is_dead(state: char) -> bool {
    matches!(state, 'Z' | 'X' | 'x')
}

fn inspect_process_inotify<P: ProcessProbe>(probe: &mut P, uid: u32) -> Result<InotifyUsage> {
    let status = match probe.read_status() {
        Ok(status) => status,
        Err(error) if proc_error_is_race(error.kind()) => return Ok(InotifyUsage::default()),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
            return Ok(InotifyUsage {
                uninspectable_processes: 1,
                ..InotifyUsage::default()
            });
        }
        Err(_) => return Err(Failure::Cli("preflight_proc")),
    };
    let (process_uid, state) = process_uid_and_state(&status)?;
    if process_uid != uid || process_is_dead(state) {
        return Ok(InotifyUsage::default());
    }

    let inspection = probe.inspect_fds()?;
    let (watches, instances) = inspection.counts();
    let uninspectable_processes = if matches!(inspection, ProcessFdInspection::Inaccessible { .. })
    {
        match probe.read_status() {
            Ok(status) => u64::from(!process_is_dead(process_uid_and_state(&status)?.1)),
            Err(error) if proc_error_is_race(error.kind()) => 0,
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => 1,
            Err(_) => return Err(Failure::Cli("preflight_proc")),
        }
    } else {
        0
    };
    Ok(InotifyUsage {
        watches,
        instances,
        global_accounting_complete: false,
        uninspectable_processes,
    })
}

fn inotify_usage() -> Result<InotifyUsage> {
    #[cfg(test)]
    GLOBAL_SCAN_CALLS.fetch_add(1, Ordering::SeqCst);
    let uid = {
        // SAFETY: geteuid has no preconditions and does not dereference pointers.
        unsafe { libc::geteuid() }
    };
    let mut usage = InotifyUsage::default();
    for entry in fs::read_dir("/proc").map_err(|_| Failure::Cli("preflight_proc"))? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) if proc_error_is_race(error.kind()) => continue,
            Err(_) => return Err(Failure::Cli("preflight_proc")),
        };
        if entry.file_name().to_string_lossy().parse::<u32>().is_err() {
            continue;
        }
        let mut probe = ProcProcessProbe { path: entry.path() };
        let process_usage = inspect_process_inotify(&mut probe, uid)?;
        usage.watches += process_usage.watches;
        usage.instances += process_usage.instances;
        usage.uninspectable_processes += process_usage.uninspectable_processes;
    }
    usage.global_accounting_complete = usage.uninspectable_processes == 0;
    Ok(usage)
}

fn current_preflight_system() -> Result<PreflightSystem> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: limit points to writable storage and RLIMIT_NOFILE is valid.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(Failure::Cli("preflight_nofile"));
    }
    let boot_id = fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map_err(|_| Failure::Cli("preflight_boot"))?
        .trim()
        .to_owned();
    if boot_id.is_empty() || boot_id.len() > 128 {
        return Err(Failure::Cli("preflight_boot"));
    }
    let uptime =
        fs::read_to_string("/proc/uptime").map_err(|_| Failure::Cli("preflight_uptime"))?;
    let monotonic_uptime_ms = uptime
        .split_whitespace()
        .next()
        .and_then(|value| value.parse::<f64>().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
        .map(|value| (value * 1_000.0) as u64)
        .ok_or(Failure::Cli("preflight_uptime"))?;
    Ok(PreflightSystem {
        // SAFETY: geteuid has no preconditions and does not dereference pointers.
        uid: unsafe { libc::geteuid() },
        boot_id,
        max_watches: read_number("/proc/sys/fs/inotify/max_user_watches")?,
        max_instances: read_number("/proc/sys/fs/inotify/max_user_instances")?,
        max_queue: read_number("/proc/sys/fs/inotify/max_queued_events")?,
        nofile: limit.rlim_cur,
        monotonic_uptime_ms,
        utc: Utc::now().to_rfc3339(),
    })
}

fn build_host_preflight(
    roots: &Roots,
    system: &PreflightSystem,
    usage: InotifyUsage,
) -> Result<PreflightHandoff> {
    let (projected_watches, projected_instances) = projected_own_usage(roots)?;
    let handoff = PreflightHandoff {
        schema_version: PREFLIGHT_SCHEMA_VERSION,
        uid: system.uid,
        boot_id: system.boot_id.clone(),
        created_utc: system.utc.clone(),
        monotonic_uptime_ms: system.monotonic_uptime_ms,
        max_watches: system.max_watches,
        max_instances: system.max_instances,
        max_queue: system.max_queue,
        nofile: system.nofile,
        existing_watches: usage.watches,
        existing_instances: usage.instances,
        projected_watches,
        projected_instances,
        global_accounting_complete: usage.global_accounting_complete,
        uninspectable_processes: usage.uninspectable_processes,
    };
    handoff.runtime().validate()?;
    Ok(handoff)
}

fn write_preflight_file(path: &Path, handoff: &PreflightHandoff) -> Result<()> {
    if !path.is_absolute() {
        return Err(Failure::Cli("preflight_file_relative"));
    }
    let encoded =
        serde_json::to_vec(handoff).map_err(|_| Failure::Observer("preflight_serialize"))?;
    if encoded.len() as u64 > PREFLIGHT_MAX_BYTES {
        return Err(Failure::Observer("preflight_oversized"));
    }
    let mut file = open_private_new(path, false)?;
    file.write_all(&encoded)
        .and_then(|()| file.sync_all())
        .map_err(|_| Failure::Observer("preflight_write"))?;
    let metadata = file
        .metadata()
        .map_err(|_| Failure::Observer("preflight_metadata"))?;
    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != uid
        || metadata.mode() & 0o777 != OUTPUT_MODE
    {
        return Err(Failure::Observer("preflight_permissions"));
    }
    Ok(())
}

fn read_preflight_file(path: &Path) -> Result<PreflightHandoff> {
    if !path.is_absolute() {
        return Err(Failure::Cli("preflight_file_relative"));
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| Failure::Cli("preflight_file_open"))?;
    let metadata = file
        .metadata()
        .map_err(|_| Failure::Cli("preflight_file_metadata"))?;
    // SAFETY: geteuid has no preconditions and does not dereference pointers.
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_file()
        || metadata.nlink() != 1
        || metadata.uid() != uid
        || metadata.mode() & 0o777 != OUTPUT_MODE
        || metadata.len() > PREFLIGHT_MAX_BYTES
    {
        return Err(Failure::Cli("preflight_file_permissions"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(PREFLIGHT_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::Cli("preflight_file_read"))?;
    if bytes.len() as u64 > PREFLIGHT_MAX_BYTES {
        return Err(Failure::Cli("preflight_file_oversized"));
    }
    serde_json::from_slice(&bytes).map_err(|_| Failure::Cli("preflight_file_parse"))
}

fn projection_within_drift(expected: (u64, u64), actual: (u64, u64)) -> bool {
    fn within(expected: u64, actual: u64) -> bool {
        if expected == 0 {
            return actual == 0;
        }
        u128::from(expected.abs_diff(actual)) * 100 <= u128::from(expected) * 5
    }
    within(expected.0, actual.0) && within(expected.1, actual.1)
}

fn load_preflight_file(
    path: &Path,
    roots: &Roots,
    system: &PreflightSystem,
) -> Result<PreflightHandoff> {
    let handoff = read_preflight_file(path)?;
    if handoff.schema_version != PREFLIGHT_SCHEMA_VERSION {
        return Err(Failure::Cli("preflight_schema"));
    }
    if handoff.uid != system.uid || handoff.boot_id != system.boot_id {
        return Err(Failure::Cli("preflight_identity"));
    }
    if (
        handoff.max_watches,
        handoff.max_instances,
        handoff.max_queue,
        handoff.nofile,
    ) != (
        system.max_watches,
        system.max_instances,
        system.max_queue,
        system.nofile,
    ) {
        return Err(Failure::Cli("preflight_limits_changed"));
    }
    let uptime_age = system
        .monotonic_uptime_ms
        .checked_sub(handoff.monotonic_uptime_ms)
        .ok_or(Failure::Cli("preflight_stale"))?;
    let created = DateTime::parse_from_rfc3339(&handoff.created_utc)
        .map_err(|_| Failure::Cli("preflight_timestamp"))?;
    let now = DateTime::parse_from_rfc3339(&system.utc)
        .map_err(|_| Failure::Cli("preflight_timestamp"))?;
    if created.offset().local_minus_utc() != 0 || now.offset().local_minus_utc() != 0 {
        return Err(Failure::Cli("preflight_timestamp"));
    }
    let utc_age = now.signed_duration_since(created).num_milliseconds();
    if uptime_age > PREFLIGHT_MAX_AGE_MS || !(0..=PREFLIGHT_MAX_AGE_MS as i64).contains(&utc_age) {
        return Err(Failure::Cli("preflight_stale"));
    }
    let projection = projected_own_usage(roots)?;
    if !projection_within_drift(
        (handoff.projected_watches, handoff.projected_instances),
        projection,
    ) {
        return Err(Failure::Cli("preflight_projection_drift"));
    }
    handoff.runtime().validate()?;
    Ok(handoff)
}

fn execute_preflight(config: &PreflightConfig) -> Result<()> {
    let system = current_preflight_system()?;
    let handoff = build_host_preflight(&config.roots, &system, inotify_usage()?)?;
    write_preflight_file(&config.output, &handoff)
}

fn count_directories(path: &Path) -> Result<u64> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(_) => return Err(Failure::Cli("preflight_directories")),
    };
    if metadata.file_type().is_symlink() {
        return Err(Failure::Cli("configured_root_symlink"));
    }
    if !metadata.is_dir() {
        return Ok(0);
    }
    let mut count = 1;
    for entry in fs::read_dir(path).map_err(|_| Failure::Cli("preflight_directories"))? {
        let entry = entry.map_err(|_| Failure::Cli("preflight_directories"))?;
        let child = fs::symlink_metadata(entry.path())
            .map_err(|_| Failure::Cli("preflight_directories"))?;
        if child.is_dir() && !child.file_type().is_symlink() {
            count += count_directories(&entry.path())?;
        }
    }
    Ok(count)
}

fn read_random<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0_u8; N];
    File::open("/dev/urandom")
        .and_then(|mut file| file.read_exact(&mut bytes))
        .map_err(|_| Failure::Observer("random_read"))?;
    Ok(bytes)
}

fn run_id() -> Result<String> {
    let bytes = read_random::<16>()?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

struct OutputWriter {
    root: PathBuf,
    events: File,
    records: u64,
    bytes: u64,
}

impl OutputWriter {
    fn create(root: &Path) -> Result<Self> {
        let events = open_private_new(&root.join("events.jsonl"), true)?;
        Ok(Self {
            root: root.to_path_buf(),
            events,
            records: 0,
            bytes: 0,
        })
    }

    fn append(&mut self, value: &Value) -> Result<()> {
        let mut encoded =
            serde_json::to_vec(value).map_err(|_| Failure::Observer("output_serialize"))?;
        encoded.push(b'\n');
        self.events
            .write_all(&encoded)
            .and_then(|()| self.events.flush())
            .and_then(|()| self.events.sync_data())
            .map_err(|_| Failure::Observer("output_events"))?;
        self.records += 1;
        self.bytes += encoded.len() as u64;
        if self.bytes > MAX_EVENT_BYTES {
            return Err(Failure::Resource("resource_output"));
        }
        Ok(())
    }

    fn state(&self, value: &Value) -> Result<()> {
        atomic_json(&self.root.join("state.json"), value, false)
    }

    fn report(&self, value: &Value) -> Result<()> {
        atomic_json(&self.root.join("report.json"), value, false)
    }
}

fn open_private_new(path: &Path, append: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options
        .write(true)
        .create_new(true)
        .append(append)
        .mode(OUTPUT_MODE)
        .custom_flags(libc::O_NOFOLLOW);
    options
        .open(path)
        .map_err(|_| Failure::Observer("output_create"))
}

fn atomic_json(path: &Path, value: &Value, fail_before_rename: bool) -> Result<()> {
    let parent = path.parent().ok_or(Failure::Observer("output_parent"))?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temp = parent.join(format!(".observer-{sequence}.tmp"));
    let operation = (|| -> Result<()> {
        let mut file = open_private_new(&temp, false)?;
        let bytes = serde_json::to_vec(value).map_err(|_| Failure::Observer("output_serialize"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|_| Failure::Observer("output_write"))?;
        if fail_before_rename {
            return Err(Failure::Observer("output_injected"));
        }
        fs::rename(&temp, path).map_err(|_| Failure::Observer("output_rename"))?;
        File::open(parent)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| Failure::Observer("output_sync_dir"))?;
        Ok(())
    })();
    if operation.is_err() {
        let _ = fs::remove_file(&temp);
    }
    operation
}

fn verify_private_outputs(root: &Path) -> Result<()> {
    let root_metadata =
        fs::symlink_metadata(root).map_err(|_| Failure::Observer("output_verify"))?;
    if root_metadata.file_type().is_symlink()
        || !root_metadata.is_dir()
        || root_metadata.mode() & 0o777 != 0o700
    {
        return Err(Failure::Observer("output_permissions"));
    }
    for entry in fs::read_dir(root).map_err(|_| Failure::Observer("output_verify"))? {
        let entry = entry.map_err(|_| Failure::Observer("output_verify"))?;
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| Failure::Observer("output_verify"))?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.nlink() != 1
            || metadata.mode() & 0o777 != OUTPUT_MODE
        {
            return Err(Failure::Observer("output_permissions"));
        }
    }
    Ok(())
}

extern "C" fn signal_handler(signal: libc::c_int) {
    SIGNAL.store(signal as u8, Ordering::Relaxed);
}

fn install_signals() -> Result<()> {
    // SAFETY: sigaction is initialized before use; the handler only performs a lock-free
    // atomic store, and the three signal numbers are valid on Unix.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = signal_handler as *const () as usize;
        action.sa_flags = 0;
        libc::sigemptyset(&mut action.sa_mask);
        for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
            if libc::sigaction(signal, &action, std::ptr::null_mut()) != 0 {
                return Err(Failure::Observer("signal_install"));
            }
        }
    }
    Ok(())
}

fn signal_reason(signal: libc::c_int) -> Option<&'static str> {
    match signal {
        libc::SIGINT => Some("signal_sigint"),
        libc::SIGTERM => Some("signal_sigterm"),
        libc::SIGHUP => Some("signal_sighup"),
        _ => None,
    }
}

struct WatchGroup {
    _watchers: Vec<RecommendedWatcher>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum IngressKey {
    Error,
    Path(NoticeKind, PathBuf),
}

impl IngressKey {
    fn from_event(event: FsEvent) -> Self {
        match event {
            FsEvent::Created(path) => Self::Path(NoticeKind::Create, path),
            FsEvent::Modified(path) => Self::Path(NoticeKind::Modify, path),
            FsEvent::Removed(path) => Self::Path(NoticeKind::Remove, path),
            FsEvent::Error(_) => Self::Error,
        }
    }

    fn event(&self) -> FsEvent {
        match self {
            Self::Error => FsEvent::Error(String::new()),
            Self::Path(NoticeKind::Create, path) => FsEvent::Created(path.clone()),
            Self::Path(NoticeKind::Remove, path) => FsEvent::Removed(path.clone()),
            Self::Path(NoticeKind::Modify | NoticeKind::Structural, path) => {
                FsEvent::Modified(path.clone())
            }
        }
    }
}

#[derive(Debug, Clone)]
struct PendingNotice {
    raw_count: u64,
    burst_duplicate_count: u64,
    first: Instant,
    last: Instant,
}

#[derive(Debug, Clone)]
struct CoalescedNotice {
    event: FsEvent,
    raw_count: u64,
    burst_duplicate_count: u64,
    first: Instant,
    last: Instant,
}

impl CoalescedNotice {
    fn event(&self) -> FsEvent {
        self.event.clone()
    }
}

#[derive(Clone)]
struct EventSink {
    pending: Arc<Mutex<BTreeMap<IngressKey, PendingNotice>>>,
    wake: SyncSender<()>,
    overflow: Arc<AtomicBool>,
    capacity: usize,
}

impl EventSink {
    fn wake(&self) {
        match self.wake.try_send(()) {
            Ok(()) | Err(TrySendError::Full(())) => {}
            Err(TrySendError::Disconnected(())) => {
                self.overflow.store(true, Ordering::Release);
            }
        }
    }

    fn push(&self, event: FsEvent) {
        self.push_at(event, Instant::now());
    }

    fn push_at(&self, event: FsEvent, now: Instant) {
        if self.overflow.load(Ordering::Acquire) {
            return;
        }
        let key = IngressKey::from_event(event);
        let mut pending = match self.pending.lock() {
            Ok(pending) => pending,
            Err(_) => {
                self.overflow.store(true, Ordering::Release);
                self.wake();
                return;
            }
        };
        if let Some(notice) = pending.get_mut(&key) {
            let Some(raw_count) = notice.raw_count.checked_add(1) else {
                self.overflow.store(true, Ordering::Release);
                drop(pending);
                self.wake();
                return;
            };
            notice.raw_count = raw_count;
            if now.saturating_duration_since(notice.last) <= Duration::from_millis(DUPLICATE_MS) {
                notice.burst_duplicate_count = notice.burst_duplicate_count.saturating_add(1);
            }
            notice.last = now;
        } else if pending.len() >= self.capacity {
            self.overflow.store(true, Ordering::Release);
        } else {
            pending.insert(
                key,
                PendingNotice {
                    raw_count: 1,
                    burst_duplicate_count: 0,
                    first: now,
                    last: now,
                },
            );
        }
        drop(pending);
        self.wake();
    }

    fn accept(&self, result: notify::Result<notify::Event>) {
        match result {
            Ok(event) => {
                for path in event.paths {
                    let mapped = match event.kind {
                        notify::EventKind::Create(_) => FsEvent::Created(path),
                        notify::EventKind::Remove(_) => FsEvent::Removed(path),
                        _ => FsEvent::Modified(path),
                    };
                    self.push(mapped);
                }
            }
            Err(_) => self.push(FsEvent::Error(String::new())),
        }
    }
}

struct EventIngress {
    sink: EventSink,
    pending: Arc<Mutex<BTreeMap<IngressKey, PendingNotice>>>,
    wake: Receiver<()>,
    overflow: Arc<AtomicBool>,
}

impl EventIngress {
    fn with_capacity(capacity: usize) -> Self {
        let pending = Arc::new(Mutex::new(BTreeMap::new()));
        let (wake_tx, wake) = mpsc::sync_channel(1);
        let overflow = Arc::new(AtomicBool::new(false));
        Self {
            sink: EventSink {
                pending: Arc::clone(&pending),
                wake: wake_tx,
                overflow: Arc::clone(&overflow),
                capacity,
            },
            pending,
            wake,
            overflow,
        }
    }

    fn new() -> Self {
        Self::with_capacity(INGRESS_CAPACITY)
    }

    fn callback(&self) -> impl FnMut(notify::Result<notify::Event>) + Send + 'static {
        let sink = self.sink.clone();
        move |result| sink.accept(result)
    }

    #[cfg(test)]
    fn push_for_test(&self, event: FsEvent) {
        self.sink.push(event);
    }

    #[cfg(test)]
    fn push_for_test_at(&self, event: FsEvent, at: Instant) {
        self.sink.push_at(event, at);
    }

    fn wait(&self, timeout: Duration) -> std::result::Result<bool, mpsc::RecvTimeoutError> {
        match self.wake.recv_timeout(timeout) {
            Ok(()) => Ok(true),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(false),
            Err(error @ mpsc::RecvTimeoutError::Disconnected) => Err(error),
        }
    }

    fn take_batch(&self) -> Result<Vec<CoalescedNotice>> {
        let _ = self.wake.try_recv();
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| Failure::Observer("watcher_state"))?;
        let drained = std::mem::take(&mut *pending);
        drop(pending);
        Ok(drained
            .into_iter()
            .map(|(key, pending)| CoalescedNotice {
                event: key.event(),
                raw_count: pending.raw_count,
                burst_duplicate_count: pending.burst_duplicate_count,
                first: pending.first,
                last: pending.last,
            })
            .collect())
    }

    #[cfg(test)]
    fn pending_len(&self) -> usize {
        self.pending.lock().map_or(0, |pending| pending.len())
    }

    fn overflowed(&self) -> bool {
        self.overflow.load(Ordering::Acquire)
    }
}

fn nearest_existing_parent(path: &Path) -> Result<PathBuf> {
    let mut candidate = path
        .parent()
        .ok_or(Failure::Observer("watcher_parent"))?
        .to_path_buf();
    loop {
        match fs::symlink_metadata(&candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(Failure::Observer("configured_root_symlink"));
            }
            Ok(metadata) if metadata.is_dir() => return Ok(candidate),
            Ok(_) => return Err(Failure::Observer("watcher_parent")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(Failure::Observer("watcher_parent")),
        }
        candidate = candidate
            .parent()
            .ok_or(Failure::Observer("watcher_parent"))?
            .to_path_buf();
    }
}

fn arm_watchers(probe: &ObserverProbe, ingress: &EventIngress) -> Result<WatchGroup> {
    let mut watchers = Vec::new();
    for provider in [Provider::Claude, Provider::Codex, Provider::Amplifier] {
        let root = probe.roots.root(provider);
        if probe.exists(root) {
            let mut watcher = notify::recommended_watcher(ingress.callback())
                .map_err(|_| Failure::Observer("watcher_rearm_failed"))?;
            watcher
                .watch(root, RecursiveMode::Recursive)
                .map_err(|_| Failure::Observer("watcher_rearm_failed"))?;
            watchers.push(watcher);
        }
    }
    let directory = nearest_existing_parent(&probe.roots.opencode_db)?;
    let mut opencode = notify::recommended_watcher(ingress.callback())
        .map_err(|_| Failure::Observer("watcher_rearm_failed"))?;
    opencode
        .watch(&directory, RecursiveMode::NonRecursive)
        .map_err(|_| Failure::Observer("watcher_rearm_failed"))?;
    watchers.push(opencode);
    Ok(WatchGroup {
        _watchers: watchers,
    })
}

fn event_kind(event: &FsEvent) -> NoticeKind {
    match event {
        FsEvent::Created(_) => NoticeKind::Create,
        FsEvent::Removed(_) => NoticeKind::Remove,
        FsEvent::Modified(_) => NoticeKind::Modify,
        FsEvent::Error(_) => NoticeKind::Structural,
    }
}

fn event_path(event: &FsEvent) -> Option<&Path> {
    match event {
        FsEvent::Created(path) | FsEvent::Removed(path) | FsEvent::Modified(path) => Some(path),
        FsEvent::Error(_) => None,
    }
}

#[cfg(test)]
fn drain_events<F>(rx: &Receiver<FsEvent>, stop: &mut StopOutcome, mut observe: F)
where
    F: FnMut(&FsEvent) -> Result<()>,
{
    while let Ok(event) = rx.try_recv() {
        if let Err(error) = observe(&event) {
            stop.absorb(error);
        }
    }
}

fn scan_with_retry(probe: &ObserverProbe) -> Result<Scan> {
    match probe.scan() {
        Ok(scan) => Ok(scan),
        Err(_) => {
            thread::sleep(Duration::from_secs(5));
            probe.scan()
        }
    }
}

fn apply_diff(
    diff: &InventoryDiff,
    old: &Inventory,
    new: &Inventory,
    correlation: &mut Correlation,
    stats: &mut RunStats,
    elapsed_ms: u64,
) {
    for (kind, ids) in [
        (ChangeKind::Added, &diff.added),
        (ChangeKind::Modified, &diff.modified),
        (ChangeKind::Removed, &diff.removed),
    ] {
        for id in ids {
            let provider = new
                .get(id)
                .or_else(|| old.get(id))
                .map(|signature| signature.provider);
            if let Some(provider) = provider {
                let matched = correlation.matched;
                correlation.metadata_change(kind, provider, id.clone(), elapsed_ms);
                stats.provider(provider).matched += correlation.matched - matched;
            }
        }
    }
}

fn projected_own_usage(roots: &Roots) -> Result<(u64, u64)> {
    let mut watches = 1;
    let mut instances = 1;
    for root in [&roots.claude, &roots.codex, &roots.amplifier] {
        let count = count_directories(root)?;
        watches += count;
        instances += u64::from(count > 0);
    }
    Ok((watches, instances))
}

fn estimated_global_usage(
    preflight: Preflight,
    own_watches: u64,
    own_instances: u64,
) -> InotifyUsage {
    InotifyUsage {
        watches: preflight.existing_watches.saturating_add(own_watches),
        instances: preflight.existing_instances.saturating_add(own_instances),
        global_accounting_complete: preflight.global_accounting_complete,
        uninspectable_processes: preflight.uninspectable_processes,
    }
}

#[derive(Debug, Clone, Copy)]
struct WatchAccounting {
    projected_watches: u64,
    projected_instances: u64,
    actual_watches: u64,
    actual_instances: u64,
}

impl WatchAccounting {
    fn from_counts(projected: (u64, u64), actual: (u64, u64)) -> Self {
        Self {
            projected_watches: projected.0,
            projected_instances: projected.1,
            actual_watches: actual.0,
            actual_instances: actual.1,
        }
    }
}

fn watch_accounting(roots: &Roots) -> Result<WatchAccounting> {
    Ok(WatchAccounting::from_counts(
        projected_own_usage(roots)?,
        own_inotify_usage()?,
    ))
}

fn validate_watch_accounting(
    preflight: Preflight,
    accounting: WatchAccounting,
) -> Result<InotifyUsage> {
    let estimated = estimated_global_usage(
        preflight,
        accounting.actual_watches,
        accounting.actual_instances,
    );
    validate_minute_watch_usage(
        accounting.actual_watches,
        accounting.actual_instances,
        estimated,
        preflight.max_watches,
        preflight.max_instances,
    )?;
    Ok(estimated)
}

fn watch_accounting_record(
    reason: &str,
    run_id: &str,
    elapsed_ms: u64,
    accounting: WatchAccounting,
    preflight: Preflight,
) -> Value {
    let estimated = estimated_global_usage(
        preflight,
        accounting.actual_watches,
        accounting.actual_instances,
    );
    json!({
        "schema_version": SCHEMA_VERSION,
        "record_type": "watch_accounting",
        "run_id": run_id,
        "utc": Utc::now().to_rfc3339(),
        "monotonic_elapsed_ms": elapsed_ms,
        "reason": reason,
        "projected_watches": accounting.projected_watches,
        "actual_watches": accounting.actual_watches,
        "watch_difference": accounting.actual_watches.abs_diff(accounting.projected_watches),
        "actual_exceeds_projection": accounting.actual_watches > accounting.projected_watches,
        "projected_instances": accounting.projected_instances,
        "actual_instances": accounting.actual_instances,
        "instance_difference": accounting.actual_instances.abs_diff(accounting.projected_instances),
        "actual_instances_exceed_projection": accounting.actual_instances > accounting.projected_instances,
        "own_watch_limit": MAX_OWN_WATCHES,
        "own_instance_limit": MAX_OWN_INSTANCES,
        "known_global_estimated_watches": estimated.watches,
        "known_global_estimated_instances": estimated.instances,
        "known_global_watch_limit": preflight.max_watches / 5,
        "known_global_instance_limit": preflight.max_instances / 5,
    })
}

#[rustfmt::skip]
fn own_inotify_usage() -> Result<(u64, u64)> {
    let mut watches = 0;
    let mut instances = 0;
    for entry in fs::read_dir("/proc/self/fd").map_err(|_| Failure::Resource("resource_proc"))? {
        let entry = match entry { Ok(entry) => entry, Err(error) if proc_error_is_race(error.kind()) => continue,
            Err(_) => return Err(Failure::Resource("resource_proc")) };
        let target = match fs::read_link(entry.path()) { Ok(target) => target,
            Err(error) if proc_error_is_race(error.kind()) => continue, Err(_) => return Err(Failure::Resource("resource_proc")) };
        if target == Path::new("anon_inode:inotify") {
            let info = match fs::read_to_string(Path::new("/proc/self/fdinfo").join(entry.file_name())) {
                Ok(info) => info, Err(error) if proc_error_is_race(error.kind()) => continue,
                Err(_) => return Err(Failure::Resource("resource_proc")) };
            instances += 1;
            watches += info.lines().filter(|line| line.starts_with("inotify wd:")).count() as u64;
        }
    }
    Ok((watches, instances))
}

fn process_sample(
    cpu_percent: Option<f64>,
    pending_ids: usize,
    output_bytes: u64,
    own_watches: u64,
    global: InotifyUsage,
) -> Result<ResourceSample> {
    let status =
        fs::read_to_string("/proc/self/status").map_err(|_| Failure::Resource("resource_proc"))?;
    let value = |prefix: &str| -> Result<u64> {
        status
            .lines()
            .find(|line| line.starts_with(prefix))
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|value| value.parse().ok())
            .ok_or(Failure::Resource("resource_proc"))
    };
    let fds = fs::read_dir("/proc/self/fd")
        .map_err(|_| Failure::Resource("resource_proc"))?
        .count() as u64;
    Ok(ResourceSample {
        cpu_percent: cpu_percent.unwrap_or(0.0),
        cpu_window_complete: cpu_percent.is_some(),
        rss_bytes: value("VmRSS:")? * 1024,
        fds,
        threads: value("Threads:")?,
        pending_ids: pending_ids as u64,
        output_bytes,
        own_watches,
        global_watches: global.watches,
        global_instances: global.instances,
        global_accounting_complete: global.global_accounting_complete,
        uninspectable_processes: global.uninspectable_processes,
    })
}

fn process_ticks() -> Result<u64> {
    let stat =
        fs::read_to_string("/proc/self/stat").map_err(|_| Failure::Resource("resource_proc"))?;
    let close = stat.rfind(')').ok_or(Failure::Resource("resource_proc"))?;
    let fields: Vec<&str> = stat[close + 2..].split_whitespace().collect();
    let user = fields
        .get(11)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(Failure::Resource("resource_proc"))?;
    let system = fields
        .get(12)
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or(Failure::Resource("resource_proc"))?;
    Ok(user + system)
}

struct CpuWindow {
    samples: VecDeque<(u64, u64)>,
    ticks_per_second: u64,
}

struct CpuWindowSample {
    percent: Option<f64>,
    actual_elapsed_ms: u64,
}

#[rustfmt::skip]
impl CpuWindow {
    fn new(start: Instant) -> Result<Self> {
        // SAFETY: sysconf is called with a valid constant and has no pointer arguments.
        let ticks = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if ticks <= 0 {
            return Err(Failure::Resource("resource_clock"));
        }
        let process_ticks = process_ticks()?;
        let actual_elapsed_ms = start.elapsed().as_millis() as u64;
        Ok(Self::for_test_at(
            ticks as u64,
            actual_elapsed_ms,
            process_ticks,
        ))
    }

    #[cfg(test)]
    fn for_test(ticks_per_second: u64, initial_ticks: u64) -> Self {
        Self::for_test_at(ticks_per_second, 0, initial_ticks)
    }

    fn for_test_at(ticks_per_second: u64, initial_elapsed_ms: u64, initial_ticks: u64) -> Self {
        Self {
            samples: VecDeque::from([(initial_elapsed_ms, initial_ticks)]),
            ticks_per_second,
        }
    }

    fn sample_now(&mut self, start: Instant) -> Result<CpuWindowSample> {
        let ticks = process_ticks()?;
        let actual_elapsed_ms = start.elapsed().as_millis() as u64;
        Ok(CpuWindowSample {
            percent: self.sample_actual_ticks(actual_elapsed_ms, ticks),
            actual_elapsed_ms,
        })
    }

    fn sample_actual_ticks(&mut self, actual_elapsed_ms: u64, ticks: u64) -> Option<f64> {
        self.samples.push_back((actual_elapsed_ms, ticks));
        while self.samples.len() > 2
            && actual_elapsed_ms.saturating_sub(self.samples[1].0) >= 300_000
        {
            self.samples.pop_front();
        }
        let (first_ms, first_ticks) = *self.samples.front()?;
        let wall_ms = actual_elapsed_ms.saturating_sub(first_ms);
        if wall_ms < 300_000 {
            return None;
        }
        Some((ticks.saturating_sub(first_ticks) as f64 * 100_000.0)
            / (self.ticks_per_second as f64 * wall_ms as f64))
    }
}

fn base_record(kind: &str, run_id: &str, start: Instant) -> Value {
    json!({
        "schema_version": SCHEMA_VERSION,
        "record_type": kind,
        "run_id": run_id,
        "utc": Utc::now().to_rfc3339(),
        "monotonic_elapsed_ms": start.elapsed().as_millis() as u64,
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "the state schema is intentionally explicit and local to this diagnostic"
)]
#[rustfmt::skip]
fn state_record(
    run_id: &str,
    status: &str,
    start_utc: &str,
    elapsed_ms: u64,
    buckets: u64,
    inventory: &Inventory,
    production_checks: u64,
    production_mismatches: u64,
    stop_reason: Option<&str>,
    stats: &RunStats,
) -> Value {
    let counts: BTreeMap<&str, u64> = Provider::ALL
        .into_iter()
        .map(|provider| {
            (
                provider.name(),
                inventory.values().filter(|item| item.provider == provider).count() as u64,
            )
        })
        .collect();
    json!({
        "schema_version": SCHEMA_VERSION, "run_id": run_id, "status": status,
        "start_utc": start_utc, "observation_elapsed_ms": elapsed_ms,
        "bucket_sequence": buckets, "next_reconcile_ms": stats.next_reconcile_ms,
        "inventory_counts": counts, "production_guard_checks": production_checks,
        "production_guard_mismatches": production_mismatches,
        "watcher_rearms": stats.watcher_rearms, "stop_reason": stop_reason,
        "stats": stats,
    })
}

#[expect(
    clippy::too_many_arguments,
    reason = "the report schema is intentionally explicit and local to this diagnostic"
)]
#[rustfmt::skip]
fn finish_report(
    writer: &OutputWriter,
    run_id: &str,
    status: &str,
    reason: &str,
    start_utc: &str,
    duration_ms: u64,
    buckets: u64,
    production_checks: u64,
    production_mismatches: u64,
    correlation: &Correlation,
    stats: &RunStats,
) -> Value {
    json!({
        "schema_version": SCHEMA_VERSION, "run_id": run_id, "status": status,
        "stop_reason": reason, "start_utc": start_utc,
        "complete_utc": Utc::now().to_rfc3339(), "duration_ms": duration_ms,
        "config": {"duration_ms": OBSERVATION_MS, "bucket_ms": BUCKET_MS,
                   "reconcile_ms": RECONCILE_MS, "grace_ms": GRACE_MS},
        "bucket_count": buckets, "production_guard_checks": production_checks,
        "production_guard_mismatches": production_mismatches,
        "correlation": {"matched": correlation.matched, "delayed": correlation.delayed,
                        "missed": correlation.missed, "notice_only": correlation.notice_only(),
                        "unresolved_at_shutdown": correlation.unresolved_at_shutdown(),
                        "burst_duplicates": correlation.burst_duplicates},
        "event_records": writer.records, "event_bytes": writer.bytes,
        "stats": stats,
    })
}

#[expect(clippy::too_many_arguments, reason = "the one-file diagnostic keeps reconciliation state explicit")]
#[rustfmt::skip]
fn reconcile(
    probe: &ObserverProbe,
    inventory: &mut Inventory,
    correlation: &mut Correlation,
    writer: &mut OutputWriter,
    run_id: &str,
    start: Instant,
    reason: &str,
    stats: &mut RunStats,
) -> Result<()> {
    let before = Instant::now();
    let scan = scan_with_retry(probe)?;
    let diff = diff_inventory(inventory, &scan.inventory);
    let elapsed = start.elapsed().as_millis() as u64;
    apply_diff(&diff, inventory, &scan.inventory, correlation, stats, elapsed);
    for id in &diff.added {
        if let Some(signature) = scan.inventory.get(id) {
            stats.provider(signature.provider).added += 1;
        }
    }
    for id in &diff.modified {
        if let Some(signature) = scan.inventory.get(id) {
            stats.provider(signature.provider).modified += 1;
        }
    }
    for id in &diff.removed {
        if let Some(signature) = inventory.get(id) {
            stats.provider(signature.provider).removed += 1;
        }
    }
    for (provider, count) in correlation.finish_interval(elapsed) {
        stats.provider(provider).notice_only += count;
    }
    *inventory = scan.inventory;
    let mut record = base_record("reconcile", run_id, start);
    record["reason"] = json!(reason);
    let scan_ms = before.elapsed().as_millis() as u64;
    stats.reconciliations += 1;
    stats.reconciliation_ms_total += scan_ms;
    stats.reconciliation_ms_max = stats.reconciliation_ms_max.max(scan_ms);
    record["scan_duration_ms"] = json!(scan_ms);
    record["inventory_total"] = json!(inventory.len());
    record["added"] = json!(diff.added.len());
    record["modified"] = json!(diff.modified.len());
    record["removed"] = json!(diff.removed.len());
    record["pending_grace"] = json!(correlation.pending.len());
    record["notice_only"] = json!(correlation.notice_only());
    record["scan_errors"] = json!(0);
    record["ignored_symlinks"] = json!(scan.ignored_symlinks);
    writer.append(&record)
}

#[rustfmt::skip]
fn record_notice_count(
    probe: &ObserverProbe,
    correlation: &mut Correlation,
    stats: &mut RunStats,
    event: &FsEvent,
    batch: NoticeBatch,
) {
    let raw_count = batch.raw_count;
    if let Some(path) = event_path(event) {
        if let Some(provider) = probe.qualified_provider(path) {
            let id = path_id(&probe.salt, provider, path);
            stats.record_interval_id(provider, id.clone());
            let duplicates = correlation.burst_duplicates;
            let delayed = correlation.delayed;
            correlation.notice_coalesced(
                provider,
                id,
                event_kind(event),
                batch,
            );
            let provider_stats = stats.provider(provider);
            provider_stats.burst_duplicates += correlation.burst_duplicates - duplicates;
            match event_kind(event) {
                NoticeKind::Create => provider_stats.create += raw_count,
                NoticeKind::Modify => provider_stats.modify += raw_count,
                NoticeKind::Remove => provider_stats.remove += raw_count,
                NoticeKind::Structural => provider_stats.structural += raw_count,
            }
            provider_stats.delayed += correlation.delayed - delayed;
        } else if let Some(provider) = probe.provider_for_path(path) {
            let provider_stats = stats.provider(provider);
            provider_stats.structural += raw_count;
            provider_stats.burst_duplicates += batch.burst_duplicate_count;
            correlation.burst_duplicates = correlation
                .burst_duplicates
                .saturating_add(batch.burst_duplicate_count);
        }
    }
}

fn record_coalesced_notice(
    probe: &ObserverProbe,
    correlation: &mut Correlation,
    stats: &mut RunStats,
    notice: &CoalescedNotice,
    start: Instant,
) {
    let event = notice.event();
    let first_elapsed = notice.first.saturating_duration_since(start).as_millis() as u64;
    let last_elapsed = notice.last.saturating_duration_since(start).as_millis() as u64;
    record_notice_count(
        probe,
        correlation,
        stats,
        &event,
        NoticeBatch {
            first_ms: first_elapsed,
            last_ms: last_elapsed,
            raw_count: notice.raw_count,
            burst_duplicate_count: notice.burst_duplicate_count,
        },
    );
}

struct Runtime<'a> {
    config: &'a RunConfig,
    probe: ObserverProbe,
    writer: OutputWriter,
    ingress: EventIngress,
    group: Option<WatchGroup>,
    inventory: Inventory,
    correlation: Correlation,
    stats: RunStats,
    schedule: BucketSchedule,
    start: Instant,
    start_utc: String,
    run_id: String,
    production: ProductionFingerprint,
    preflight: Preflight,
    cpu: CpuWindow,
    cpu_limit: CpuLimitGuard,
    presence: [bool; 4],
}

#[rustfmt::skip]
impl Runtime<'_> {
    fn production_check(&mut self) -> Result<()> {
        self.stats.production_checks += 1;
        let result = verify_production(&self.production, &self.config.production_pid_file, self.config.production_port);
        if result.is_err() {
            self.stats.production_mismatches += 1;
        }
        result
    }

    fn rearm(&mut self) -> Result<()> {
        let replacement = arm_watchers(&self.probe, &self.ingress)?;
        let _ = self.drain_queued()?;
        let old = self.group.replace(replacement);
        drop(old);
        let _ = self.drain_queued()?;
        self.stats.watcher_rearms += 1;
        self.refresh_watch_accounting("rearm")
    }

    fn refresh_watch_accounting(&mut self, reason: &str) -> Result<()> {
        let accounting = watch_accounting(&self.probe.roots)?;
        self.preflight.projected_watches = accounting.projected_watches;
        self.preflight.projected_instances = accounting.projected_instances;
        self.stats.actual_watches = accounting.actual_watches;
        self.stats.actual_instances = accounting.actual_instances;
        self.writer.append(&watch_accounting_record(
            reason,
            &self.run_id,
            self.start.elapsed().as_millis() as u64,
            accounting,
            self.preflight,
        ))?;
        validate_watch_accounting(self.preflight, accounting).map(|_| ())
    }

    fn drain_queued(&mut self) -> Result<(usize, u64)> {
        let batch = self.ingress.take_batch()?;
        let processed = batch.len();
        let mut watcher_errors = 0;
        for notice in batch {
            if matches!(&notice.event, FsEvent::Error(_)) {
                watcher_errors += notice.raw_count;
            } else {
                self.notice(&notice)?;
            }
        }
        Ok((processed, watcher_errors))
    }

    fn reconcile(&mut self, reason: &str) -> Result<()> {
        self.production_check()?;
        self.refresh_watch_accounting(reason)?;
        reconcile(
            &self.probe,
            &mut self.inventory,
            &mut self.correlation,
            &mut self.writer,
            &self.run_id,
            self.start,
            reason,
            &mut self.stats,
        )?;
        self.production_check()
    }

    fn notice(&mut self, notice: &CoalescedNotice) -> Result<()> {
        record_coalesced_notice(
            &self.probe,
            &mut self.correlation,
            &mut self.stats,
            notice,
            self.start,
        );
        if self.correlation.budget_len() > MAX_PENDING_IDS {
            Err(Failure::Resource("resource_pending"))
        } else {
            Ok(())
        }
    }

    fn bucket(&mut self, span: BucketSpan, enforce: bool) -> Result<()> {
        if enforce {
            self.production_check()?;
        }
        for (provider, count) in self.correlation.finalize_grace(span.end_ms) {
            self.stats.provider(provider).missed += count;
        }
        let (own, instances) = own_inotify_usage()?;
        let global = estimated_global_usage(self.preflight, own, instances);
        let mut breach = validate_minute_watch_usage(
            own,
            instances,
            global,
            self.preflight.max_watches,
            self.preflight.max_instances,
        )
        .err();
        let cpu = self.cpu.sample_now(self.start)?;
        let sample = process_sample(
            cpu.percent,
            self.correlation.budget_len(),
            self.writer.bytes,
            own,
            global,
        )?;
        if let Err(error) = ResourceLimits::default().check(&sample) {
            breach.get_or_insert(error);
        }
        if let Err(error) = self.cpu_limit.check_at(&sample, cpu.actual_elapsed_ms) {
            breach.get_or_insert(error);
        }
        self.stats.actual_watches = own;
        self.stats.actual_instances = instances;
        self.stats.sample(sample);
        let delta = self.stats.take_bucket_delta();
        let mut record = base_record("bucket", &self.run_id, self.start);
        self.stats.bucket_sequence += 1;
        record["sequence"] = json!(self.stats.bucket_sequence);
        record["interval_ms"] = json!(span.end_ms - span.start_ms);
        record["partial"] = json!(span.partial);
        record["stats"] = serde_json::to_value(delta).map_err(|_| Failure::Observer("output_serialize"))?;
        record["resources"] = serde_json::to_value(sample).map_err(|_| Failure::Observer("output_serialize"))?;
        record["production_guard_ok"] = json!(self.stats.production_mismatches == 0);
        self.writer.append(&record)?;
        breach.map_or(Ok(()), Err)
    }

    fn finalize(&mut self, reason: &'static str, status: &'static str, original: Option<Failure>) -> Result<()> {
        let mut stop = StopOutcome::new(reason, status, original);
        self.group.take();
        if self.ingress.overflowed() {
            if self.stats.watcher_overflows == 0 {
                self.stats.watcher_errors += 1;
                self.stats.watcher_overflows += 1;
            }
            stop.absorb(Failure::Observer("watcher_overflow"));
        }
        loop {
            match self.drain_queued() {
                Ok((0, _)) => match self.ingress.wait(Duration::from_millis(50)) {
                    Ok(true) => continue,
                    Ok(false) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                },
                Ok(_) => {}
                Err(error) => {
                    stop.absorb(error);
                    break;
                }
            }
        }
        if let Err(error) = self.production_check() {
            stop.absorb(error);
        }
        if let Err(error) = reconcile(&self.probe, &mut self.inventory, &mut self.correlation, &mut self.writer,
            &self.run_id, self.start, "shutdown", &mut self.stats) {
            stop.absorb(error);
        }
        if let Err(error) = self.production_check() {
            stop.absorb(error);
        }
        let elapsed = if stop.reason == "observation_complete" {
            OBSERVATION_MS
        } else {
            self.start.elapsed().as_millis() as u64
        };
        for span in self.schedule.take_due(elapsed, true) {
            if let Err(error) = self.bucket(span, false) {
                stop.absorb(error);
                break;
            }
        }
        let buckets = self.stats.bucket_sequence;
        let output = (|| -> Result<()> {
            self.writer.append(&base_record("stop", &self.run_id, self.start))?;
            self.writer.state(&state_record(&self.run_id, stop.status, &self.start_utc, elapsed, buckets, &self.inventory,
                self.stats.production_checks, self.stats.production_mismatches, Some(stop.reason), &self.stats))?;
            self.writer.report(&finish_report(&self.writer, &self.run_id, stop.status, stop.reason, &self.start_utc, elapsed,
                buckets, self.stats.production_checks, self.stats.production_mismatches, &self.correlation, &self.stats))?;
            verify_private_outputs(&self.config.run_root)
        })();
        match stop.failure { Some(error) => Err(error), None => output }
    }
}

#[rustfmt::skip]
fn run_loop(runtime: &mut Runtime<'_>) -> Result<(&'static str, &'static str)> {
    let mut next_reconcile = RECONCILE_MS;
    runtime.stats.next_reconcile_ms = next_reconcile;
    loop {
        let elapsed = runtime.start.elapsed().as_millis() as u64;
        if elapsed >= OBSERVATION_MS {
            return Ok(("observation_complete", "complete"));
        }
        let signal = SIGNAL.load(Ordering::Relaxed) as libc::c_int;
        if let Some(reason) = signal_reason(signal) {
            return Ok((reason, "interrupted"));
        }
        if runtime.ingress.overflowed() {
            runtime.stats.watcher_errors += 1;
            runtime.stats.watcher_overflows += 1;
            runtime.rearm()?;
            runtime.reconcile("watcher_overflow")?;
            return Err(Failure::Observer("watcher_overflow"));
        }
        match runtime.ingress.wait(Duration::from_millis(100)) {
            Ok(true) => {
                let (_, watcher_errors) = runtime.drain_queued()?;
                if watcher_errors > 0 {
                    runtime.stats.watcher_errors += watcher_errors;
                    runtime.rearm()?;
                    runtime.reconcile("watcher_error")?;
                }
            }
            Ok(false) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(Failure::Observer("watcher_channel"));
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        let presence = watch_presence(&runtime.probe);
        if presence != runtime.presence {
            runtime.rearm()?;
            runtime.reconcile("watcher_error")?;
            runtime.presence = presence;
        }
        if elapsed >= next_reconcile {
            runtime.reconcile("periodic")?;
            next_reconcile += RECONCILE_MS;
            runtime.stats.next_reconcile_ms = next_reconcile;
        }
        for span in runtime.schedule.take_due(elapsed, false) {
            runtime.bucket(span, true)?;
            runtime.writer.state(&state_record(
                &runtime.run_id,
                "running",
                &runtime.start_utc,
                elapsed,
                runtime.schedule.next_start_ms / BUCKET_MS,
                &runtime.inventory,
                runtime.stats.production_checks,
                runtime.stats.production_mismatches,
                None,
                &runtime.stats,
            ))?;
        }
    }
}

#[rustfmt::skip]
fn watch_presence(probe: &ObserverProbe) -> [bool; 4] {
    [
        probe.exists(&probe.roots.claude),
        probe.exists(&probe.roots.codex),
        probe.exists(&probe.roots.amplifier),
        probe.roots.opencode_db.parent().is_some_and(|path| probe.exists(path)),
    ]
}

#[rustfmt::skip]
fn run_observer(config: &RunConfig) -> Result<()> {
    let production = capture_production(&config.production_pid_file, config.production_port)?;
    let system = current_preflight_system()?;
    let handoff = load_preflight_file(&config.preflight_file, &config.roots, &system)?;
    let projection = projected_own_usage(&config.roots)?;
    let mut preflight = handoff.runtime();
    preflight.projected_watches = projection.0;
    preflight.projected_instances = projection.1;
    preflight.validate()?;
    let probe = ObserverProbe {
        roots: config.roots.clone(),
        salt: read_random::<32>()?,
    };
    let mut writer = OutputWriter::create(&config.run_root)?;
    let ingress = EventIngress::new();
    let group = arm_watchers(&probe, &ingress)?;
    let accounting = watch_accounting(&config.roots)?;
    preflight.projected_watches = accounting.projected_watches;
    preflight.projected_instances = accounting.projected_instances;
    let run_id = run_id()?;
    writer.append(&watch_accounting_record(
        "startup",
        &run_id,
        0,
        accounting,
        preflight,
    ))?;
    validate_watch_accounting(preflight, accounting)?;
    let scan_started = Instant::now();
    let initial = scan_with_retry(&probe)?;
    let scan_ms = scan_started.elapsed().as_millis() as u64;
    let mut stats = RunStats {
        preflight: Some(handoff.runtime()),
        actual_watches: accounting.actual_watches,
        actual_instances: accounting.actual_instances,
        reconciliations: 1,
        reconciliation_ms_total: scan_ms,
        reconciliation_ms_max: scan_ms,
        production_checks: 1,
        next_reconcile_ms: RECONCILE_MS,
        inotify_baseline_source: Some("host_preflight_handoff"),
        inotify_baseline_utc: Some(handoff.created_utc),
        inotify_baseline_complete: handoff.global_accounting_complete,
        ..RunStats::default()
    };
    for provider in Provider::ALL {
        stats.provider(provider);
    }
    stats.establish_bucket_baseline();
    let start = Instant::now();
    let start_utc = Utc::now().to_rfc3339();
    let mut startup = base_record("reconcile", &run_id, start);
    startup["reason"] = json!("startup");
    startup["scan_duration_ms"] = json!(scan_ms);
    startup["inventory_total"] = json!(initial.inventory.len());
    startup["ignored_symlinks"] = json!(initial.ignored_symlinks);
    writer.append(&startup)?;
    writer.append(&base_record("start", &run_id, start))?;
    let mut runtime = Runtime {
        config,
        probe,
        writer,
        ingress,
        group: Some(group),
        inventory: initial.inventory,
        correlation: Correlation::default(),
        stats,
        schedule: BucketSchedule::new(BUCKET_MS),
        start,
        start_utc,
        run_id,
        production,
        preflight,
        cpu: CpuWindow::new(start)?,
        cpu_limit: CpuLimitGuard::default(),
        presence: watch_presence(&ObserverProbe {
            roots: config.roots.clone(),
            salt: [0; 32],
        }),
    };
    runtime.writer.state(&state_record(
        &runtime.run_id,
        "running",
        &runtime.start_utc,
        0,
        0,
        &runtime.inventory,
        runtime.stats.production_checks,
        0,
        None,
        &runtime.stats,
    ))?;
    match run_loop(&mut runtime) {
        Ok((reason, status)) => runtime.finalize(reason, status, None),
        Err(error) => runtime.finalize(error.code(), "failed", Some(error)),
    }
}

fn collect_smoke_events(
    ingress: &EventIngress,
    probe: &ObserverProbe,
    correlation: &mut Correlation,
    stats: &mut RunStats,
    start: Instant,
) -> Result<()> {
    let deadline = Instant::now() + Duration::from_millis(500);
    while Instant::now() < deadline {
        if ingress.overflowed() {
            return Err(Failure::Observer("watcher_overflow"));
        }
        match ingress.wait(Duration::from_millis(20)) {
            Ok(true) => {
                for notice in ingress.take_batch()? {
                    if matches!(&notice.event, FsEvent::Error(_)) {
                        return Err(Failure::Observer("watcher_error"));
                    }
                    record_coalesced_notice(probe, correlation, stats, &notice, start);
                }
            }
            Ok(false) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(Failure::Observer("watcher_channel"));
            }
        }
    }
    Ok(())
}

#[rustfmt::skip]
fn smoke_inner(config: &SmokeConfig, fixture: &Path) -> Result<()> {
    let roots = Roots {
        claude: fixture.join("claude"),
        codex: fixture.join("codex"),
        amplifier: fixture.join("amplifier"),
        opencode_db: fixture.join("opencode").join("opencode.db"),
    };
    for root in [&roots.claude, &roots.codex, &roots.amplifier] {
        fs::create_dir_all(root).map_err(|_| Failure::Observer("smoke_fixture"))?;
    }
    fs::create_dir_all(roots.opencode_db.parent().ok_or(Failure::Observer("smoke_fixture"))?)
        .map_err(|_| Failure::Observer("smoke_fixture"))?;
    let amplifier_session = roots.amplifier.join("sessions").join("fixture");
    fs::create_dir_all(&amplifier_session).map_err(|_| Failure::Observer("smoke_fixture"))?;
    let probe = ObserverProbe {
        roots,
        salt: read_random::<32>()?,
    };
    let smoke_system = PreflightSystem {
        // SAFETY: geteuid has no preconditions and does not dereference pointers.
        uid: unsafe { libc::geteuid() },
        boot_id: "synthetic-smoke".into(),
        max_watches: 524_288,
        max_instances: 1_024,
        max_queue: 16_384,
        nofile: 65_536,
        monotonic_uptime_ms: 0,
        utc: Utc::now().to_rfc3339(),
    };
    let smoke_handoff =
        build_host_preflight(&probe.roots, &smoke_system, InotifyUsage::default())?;
    let smoke_preflight = smoke_handoff.runtime();
    let run_id = run_id()?;
    let mut writer = OutputWriter::create(&config.run_root)?;
    let ingress = EventIngress::new();
    let group = arm_watchers(&probe, &ingress)?;
    let initial = probe.scan()?;
    let mut inventory = initial.inventory;
    let mut correlation = Correlation::default();
    let mut stats = RunStats {
        preflight: Some(smoke_preflight),
        actual_watches: own_inotify_usage()?.0,
        actual_instances: own_inotify_usage()?.1,
        reconciliations: 1,
        inotify_baseline_source: Some("injected_smoke_preflight"),
        inotify_baseline_utc: Some(smoke_handoff.created_utc),
        inotify_baseline_complete: true,
        ..RunStats::default()
    };
    for provider in Provider::ALL {
        stats.provider(provider);
    }
    stats.establish_bucket_baseline();
    let start = Instant::now();
    let start_utc = Utc::now().to_rfc3339();
    writer.append(&base_record("start", &run_id, start))?;
    writer.state(&state_record(&run_id, "running", &start_utc, 0, 0, &inventory, 0, 0, None, &stats))?;
    let fixtures = [
        probe.roots.claude.join("claude.jsonl"),
        probe.roots.codex.join("codex.jsonl"),
        amplifier_session.join("metadata.json"),
        amplifier_session.join("transcript.jsonl"),
        amplifier_session.join("events.jsonl"),
        probe.roots.opencode_db.clone(),
        probe.roots.opencode_db.with_file_name("opencode.db-wal"),
    ];
    for path in &fixtures {
        fs::write(path, b"synthetic observer fixture").map_err(|_| Failure::Observer("smoke_fixture"))?;
    }
    collect_smoke_events(&ingress, &probe, &mut correlation, &mut stats, start)?;
    reconcile(&probe, &mut inventory, &mut correlation, &mut writer, &run_id, start, "smoke_create", &mut stats)?;
    for path in &fixtures {
        OpenOptions::new().append(true).open(path).and_then(|mut file| file.write_all(b"-modified"))
            .map_err(|_| Failure::Observer("smoke_fixture"))?;
    }
    collect_smoke_events(&ingress, &probe, &mut correlation, &mut stats, start)?;
    reconcile(&probe, &mut inventory, &mut correlation, &mut writer, &run_id, start, "smoke_modify", &mut stats)?;
    let renamed_claude = probe.roots.claude.join("renamed.jsonl");
    let renamed_codex = probe.roots.codex.join("renamed.jsonl");
    let renamed_amplifier = amplifier_session.with_file_name("renamed");
    fs::rename(&fixtures[0], &renamed_claude).map_err(|_| Failure::Observer("smoke_fixture"))?;
    fs::rename(&fixtures[1], &renamed_codex).map_err(|_| Failure::Observer("smoke_fixture"))?;
    fs::rename(&amplifier_session, &renamed_amplifier).map_err(|_| Failure::Observer("smoke_fixture"))?;
    let moved_db = fixture.join("opencode").join("moved.db");
    let moved_wal = fixture.join("opencode").join("moved.db-wal");
    fs::rename(&fixtures[5], &moved_db).map_err(|_| Failure::Observer("smoke_fixture"))?;
    fs::rename(&fixtures[6], &moved_wal).map_err(|_| Failure::Observer("smoke_fixture"))?;
    collect_smoke_events(&ingress, &probe, &mut correlation, &mut stats, start)?;
    reconcile(&probe, &mut inventory, &mut correlation, &mut writer, &run_id, start, "smoke_rename", &mut stats)?;
    fs::rename(&moved_db, &fixtures[5]).map_err(|_| Failure::Observer("smoke_fixture"))?;
    fs::rename(&moved_wal, &fixtures[6]).map_err(|_| Failure::Observer("smoke_fixture"))?;
    collect_smoke_events(&ingress, &probe, &mut correlation, &mut stats, start)?;
    reconcile(&probe, &mut inventory, &mut correlation, &mut writer, &run_id, start, "smoke_rename_back", &mut stats)?;
    for path in [&renamed_claude, &renamed_codex] {
        fs::remove_file(path).map_err(|_| Failure::Observer("smoke_fixture"))?;
    }
    fs::remove_dir_all(&renamed_amplifier).map_err(|_| Failure::Observer("smoke_fixture"))?;
    for path in &fixtures[5..] {
        fs::remove_file(path).map_err(|_| Failure::Observer("smoke_fixture"))?;
    }
    collect_smoke_events(&ingress, &probe, &mut correlation, &mut stats, start)?;
    drop(group);
    loop {
        let batch = ingress.take_batch()?;
        if batch.is_empty() {
            break;
        }
        for notice in batch {
            if !matches!(&notice.event, FsEvent::Error(_)) {
                record_coalesced_notice(&probe, &mut correlation, &mut stats, &notice, start);
            }
        }
    }
    reconcile(
        &probe,
        &mut inventory,
        &mut correlation,
        &mut writer,
        &run_id,
        start,
        "smoke_remove",
        &mut stats,
    )?;
    if Provider::ALL.into_iter().any(|provider| {
        let provider = stats.providers.get(&provider).copied().unwrap_or_default();
        provider.added == 0 || provider.modified == 0 || provider.removed == 0 || provider.matched == 0
    }) {
        return Err(Failure::Observer("smoke_correlation"));
    }
    let reason = if config.wait_for_signal {
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Some(reason) = signal_reason(SIGNAL.load(Ordering::Relaxed) as libc::c_int) {
                break reason;
            }
            if Instant::now() >= deadline {
                return Err(Failure::Observer("smoke_signal_timeout"));
            }
            thread::sleep(Duration::from_millis(20));
        }
    } else {
        "smoke_complete"
    };
    let status = if reason == "smoke_complete" { "complete" } else { "interrupted" };
    let elapsed = start.elapsed().as_millis() as u64;
    for (provider, count) in correlation.finalize_grace(elapsed + GRACE_MS + 1) {
        stats.provider(provider).missed += count;
    }
    for (provider, count) in correlation.finish_interval(elapsed) {
        stats.provider(provider).notice_only += count;
    }
    let sample = process_sample(
        None,
        correlation.budget_len(),
        writer.bytes,
        stats.actual_watches,
        estimated_global_usage(
            smoke_preflight,
            stats.actual_watches,
            stats.actual_instances,
        ),
    )?;
    stats.sample(sample);
    let mut bucket = base_record("bucket", &run_id, start);
    bucket["sequence"] = json!(1);
    bucket["interval_ms"] = json!(elapsed);
    bucket["partial"] = json!(true);
    bucket["stats"] = serde_json::to_value(stats.take_bucket_delta()).map_err(|_| Failure::Observer("output_serialize"))?;
    bucket["resources"] = serde_json::to_value(sample).map_err(|_| Failure::Observer("output_serialize"))?;
    writer.append(&bucket)?;
    writer.append(&base_record("stop", &run_id, start))?;
    writer.state(&state_record(
        &run_id,
        status,
        &start_utc,
        elapsed,
        1,
        &inventory,
        0,
        0,
        Some(reason),
        &stats,
    ))?;
    writer.report(&finish_report(
        &writer,
        &run_id,
        status,
        reason,
        &start_utc,
        elapsed,
        1,
        0,
        0,
        &correlation,
        &stats,
    ))?;
    verify_private_outputs(&config.run_root)
}

fn smoke(config: &SmokeConfig) -> Result<()> {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let fixture = std::env::temp_dir().join(format!(
        "freshell-0gdd-observer-fixture-{}-{sequence}",
        std::process::id()
    ));
    fs::create_dir(&fixture).map_err(|_| Failure::Observer("smoke_fixture"))?;
    fs::set_permissions(&fixture, fs::Permissions::from_mode(0o700))
        .map_err(|_| Failure::Observer("smoke_fixture"))?;
    let result = smoke_inner(config, &fixture);
    let cleanup = fs::remove_dir_all(&fixture).map_err(|_| Failure::Observer("smoke_cleanup"));
    result.and(cleanup)
}

fn execute(config: Config) -> Result<()> {
    if let Some(run_root) = config.run_root() {
        validate_run_root(run_root)?;
        install_signals()?;
    }
    match config {
        Config::Preflight(config) => execute_preflight(&config),
        Config::Run(config) => run_observer(&config),
        Config::Smoke(config) => smoke(&config),
    }
}

fn main() -> ExitCode {
    std::panic::set_hook(Box::new(|_| eprintln!("observer_panic")));
    let result = parse_cli(std::env::args()).and_then(execute);
    match result {
        Ok(()) => {
            println!("observer_complete");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("{}", error.code());
            ExitCode::from(error.exit_code())
        }
    }
}

#[cfg(test)]
#[rustfmt::skip]
mod tests {
    use super::*;
    use notify::event::ModifyKind;
    use notify::{Event, EventKind};
    use std::net::TcpListener;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::process::Command;
    use std::sync::{Mutex, MutexGuard};
    use std::time::Duration;

    static WATCH_TEST_LOCK: Mutex<()> = Mutex::new(());

    fn lock_watch_tests() -> MutexGuard<'static, ()> {
        WATCH_TEST_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn wait_for_path(ingress: &EventIngress, path: &Path) -> Option<FsEvent> {
        (0..40).find_map(|_| {
            if !ingress.wait(Duration::from_millis(50)).ok()? {
                return None;
            }
            ingress
                .take_batch()
                .ok()?
                .into_iter()
                .map(|notice| notice.event())
                .find(|event| event_path(event) == Some(path))
        })
    }

    #[test]
    fn cli_rejects_missing_relative_duplicate_and_unknown_arguments() {
        assert!(parse_cli(["observer", "run"]).is_err());
        assert!(parse_cli(["observer", "smoke", "--run-root", "relative",]).is_err());
        assert!(parse_cli(["observer", "smoke", "--run-root", "/tmp/a", "--run-root", "/tmp/b",]).is_err());
        assert!(parse_cli(["observer", "smoke", "--run-root", "/tmp/a", "--mystery",]).is_err());
    }

    #[test]
    fn path_ids_are_deterministic_salted_and_fixed_width() {
        let path = PathBuf::from("/private/fixture-secret");
        let one = path_id(&[1; 32], Provider::Claude, &path);
        let same = path_id(&[1; 32], Provider::Claude, &path);
        let other = path_id(&[2; 32], Provider::Claude, &path);
        assert_eq!(one, same);
        assert_ne!(one, other);
        assert_eq!(one.0.len(), 32);
        assert!(one.0.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn inventory_diff_detects_add_modify_remove_and_rename() {
        let old = fixture_inventory([("removed", 1, 1, 1), ("modified", 2, 2, 2), ("rename-old", 3, 3, 3)]);
        let new = fixture_inventory([("added", 4, 4, 4), ("modified", 2, 2, 9), ("rename-new", 3, 3, 3)]);
        let diff = diff_inventory(&old, &new);
        assert_eq!(diff.added.len(), 2);
        assert_eq!(diff.modified.len(), 1);
        assert_eq!(diff.removed.len(), 2);
    }

    #[test]
    fn correlation_covers_match_delay_miss_duplicate_notice_only_and_shutdown() {
        let mut correlation = Correlation::default();
        let id = PathId("0123456789abcdef0123456789abcdef".into());
        correlation.notice(Provider::Claude, id.clone(), NoticeKind::Create, 100);
        assert!(correlation.is_burst_duplicate(Provider::Claude, &id, NoticeKind::Create, 200, Duration::from_millis(250),));
        correlation.notice(Provider::Claude, id.clone(), NoticeKind::Create, 200);
        assert_eq!(correlation.burst_duplicates, 1);
        correlation.metadata_change(ChangeKind::Added, Provider::Claude, id.clone(), 300);
        assert_eq!(correlation.matched, 1);

        let delayed = PathId("1123456789abcdef0123456789abcdef".into());
        correlation.metadata_change(ChangeKind::Modified, Provider::Claude, delayed.clone(), 400);
        correlation.notice(Provider::Claude, delayed, NoticeKind::Modify, 500);
        assert_eq!(correlation.delayed, 1);

        let missed = PathId("2123456789abcdef0123456789abcdef".into());
        correlation.metadata_change(ChangeKind::Removed, Provider::Claude, missed, 600);
        correlation.notice(
            Provider::Codex,
            PathId("3123456789abcdef0123456789abcdef".into()),
            NoticeKind::Create,
            700,
        );
        correlation.finalize_grace(61_000);
        assert_eq!(correlation.missed, 1);
        assert!(correlation.notice_only() >= 1);
        assert_eq!(correlation.unresolved_at_shutdown(), 0);
        correlation.metadata_change(ChangeKind::Added, Provider::Amplifier, id, 62_000);
        assert_eq!(correlation.unresolved_at_shutdown(), 1);
    }

    #[test]
    fn preflight_accepts_calibration_and_rejects_each_limit() {
        let safe = Preflight {
            max_watches: 524_288,
            max_instances: 1_024,
            max_queue: 16_384,
            nofile: 65_536,
            existing_watches: 23_734,
            existing_instances: 86,
            projected_watches: 26_484,
            projected_instances: 4,
            global_accounting_complete: true,
            uninspectable_processes: 0,
        };
        assert!(safe.validate().is_ok());
        assert!(Preflight {
            max_watches: 50_000,
            ..safe
        }
        .validate()
        .is_err());
        assert!(Preflight {
            max_instances: 100,
            ..safe
        }
        .validate()
        .is_err());
        assert!(Preflight { max_queue: 8_192, ..safe }.validate().is_err());
        assert!(Preflight { nofile: 1_024, ..safe }.validate().is_err());
        let differing = WatchAccounting {
            projected_watches: 26_484,
            projected_instances: 4,
            actual_watches: 27_900,
            actual_instances: 4,
        };
        validate_watch_accounting(safe, differing)
            .expect("projection difference is informational when actual usage is safe");
        assert_eq!(
            validate_watch_accounting(
                safe,
                WatchAccounting {
                    actual_watches: MAX_OWN_WATCHES + 1,
                    ..differing
                },
            ),
            Err(Failure::Resource("resource_watches")),
        );
        assert_eq!(
            validate_watch_accounting(
                safe,
                WatchAccounting {
                    actual_instances: MAX_OWN_INSTANCES + 1,
                    ..differing
                },
            ),
            Err(Failure::Resource("resource_watches")),
        );
        assert!(Preflight { uninspectable_processes: 11, ..safe }.validate().is_err());
        assert!(validate_minute_watch_usage(0, 0, InotifyUsage { watches: 104_000, instances: 200,
            global_accounting_complete: false, uninspectable_processes: 3 }, safe.max_watches, safe.max_instances).is_ok());
        assert!(validate_minute_watch_usage(50_001, 4, InotifyUsage::default(), safe.max_watches, safe.max_instances).is_err());
        assert!(validate_minute_watch_usage(50_000, 5, InotifyUsage::default(), safe.max_watches, safe.max_instances).is_err());
        assert!(validate_minute_watch_usage(0, 0, InotifyUsage { uninspectable_processes: 11, ..InotifyUsage::default() },
            safe.max_watches, safe.max_instances).is_err());
        assert!(validate_minute_watch_usage(0, 0, InotifyUsage { watches: 104_858, ..InotifyUsage::default() },
            safe.max_watches, safe.max_instances).is_err());
    }

    #[test]
    fn every_resource_stop_rule_is_enforced() {
        let limits = ResourceLimits::default();
        assert!(limits.check(&ResourceSample::safe()).is_ok());
        assert!(limits
            .check(&ResourceSample {
                rss_bytes: 193 * 1024 * 1024,
                ..ResourceSample::safe()
            })
            .is_err());
        assert!(limits
            .check(&ResourceSample {
                fds: 60_001,
                ..ResourceSample::safe()
            })
            .is_err());
        assert!(limits
            .check(&ResourceSample {
                threads: 13,
                ..ResourceSample::safe()
            })
            .is_err());
        assert!(limits
            .check(&ResourceSample {
                pending_ids: 200_001,
                ..ResourceSample::safe()
            })
            .is_err());
        assert!(limits
            .check(&ResourceSample {
                output_bytes: 64 * 1024 * 1024 + 1,
                ..ResourceSample::safe()
            })
            .is_err());
    }

    #[test]
    fn opencode_filter_accepts_only_database_and_wal() {
        let db = PathBuf::from("/data/opencode.db");
        assert!(qualify_opencode(&db, &db));
        assert!(qualify_opencode(&db.with_file_name("opencode.db-wal"), &db));
        assert!(!qualify_opencode(&db.with_file_name("other.db"), &db));
    }

    #[test]
    fn signal_codes_map_to_fixed_reasons() {
        assert_eq!(signal_reason(libc::SIGINT), Some("signal_sigint"));
        assert_eq!(signal_reason(libc::SIGTERM), Some("signal_sigterm"));
        assert_eq!(signal_reason(libc::SIGHUP), Some("signal_sighup"));
        assert_eq!(signal_reason(0), None);
    }

    fn temporary(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "observer-0gdd-test-{}-{name}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).expect("create temporary test directory");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("secure temporary test directory");
        path
    }

    fn fixture_probe(root: &Path) -> ObserverProbe {
        ObserverProbe {
            roots: Roots {
                claude: root.join("claude"),
                codex: root.join("codex"),
                amplifier: root.join("amplifier"),
                opencode_db: root.join("opencode").join("opencode.db"),
            },
            salt: [7; 32],
        }
    }

    fn fixture_production(listeners: BTreeSet<ListenerFingerprint>) -> ProductionFingerprint {
        ProductionFingerprint {
            pid_file: b"1\n".to_vec(),
            pid: 1,
            start_ticks: 2,
            cmdline: b"/bin/example\0--flag\0".to_vec(),
            status_uids: [1000; 4],
            status_gids: [1000; 4],
            proc_uid: 1000,
            proc_gid: 1000,
            executable_device: 3,
            executable_inode: 4,
            listeners,
        }
    }

    #[test]
    fn root_policy_rejects_type_owner_mode_and_nonempty() {
        assert!(validate_root_attributes(false, true, 7, 7, 0o700, true).is_ok());
        assert!(validate_root_attributes(true, true, 7, 7, 0o700, true).is_err());
        assert!(validate_root_attributes(false, false, 7, 7, 0o700, true).is_err());
        assert!(validate_root_attributes(false, true, 8, 7, 0o700, true).is_err());
        assert!(validate_root_attributes(false, true, 7, 7, 0o755, true).is_err());
        assert!(validate_root_attributes(false, true, 7, 7, 0o700, false).is_err());
    }

    #[test]
    fn probe_qualifies_metadata_only_and_ignores_symlink_escape() {
        use std::os::unix::fs::symlink;
        let root = temporary("probe");
        let probe = fixture_probe(&root);
        fs::create_dir_all(probe.roots.claude.join("project")).expect("claude fixture");
        fs::create_dir_all(probe.roots.amplifier.join("sessions").join("one")).expect("amplifier fixture");
        fs::create_dir_all(probe.roots.opencode_db.parent().expect("db parent")).expect("opencode fixture");
        let claude = probe.roots.claude.join("project").join("session.jsonl");
        fs::write(&claude, b"fixture secret").expect("fixture file");
        fs::set_permissions(&claude, fs::Permissions::from_mode(0o000)).expect("mode zero");
        fs::write(
            probe.roots.amplifier.join("sessions").join("one").join("metadata.json"),
            b"private content",
        )
        .expect("amplifier metadata");
        fs::write(&probe.roots.opencode_db, b"database").expect("db");
        symlink("/etc/passwd", probe.roots.claude.join("escape.jsonl")).expect("file symlink");
        let scan = probe.scan().expect("metadata-only scan");
        assert_eq!(scan.inventory.len(), 3);
        assert_eq!(scan.ignored_symlinks, 1);
        fs::set_permissions(&claude, fs::Permissions::from_mode(0o600)).expect("restore mode");
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn atomic_write_preserves_old_state_and_cleans_temp() {
        let root = temporary("atomic");
        let path = root.join("state.json");
        atomic_json(&path, &json!({"old": true}), false).expect("initial state");
        assert!(atomic_json(&path, &json!({"new": true}), true).is_err());
        let value: Value = serde_json::from_slice(&fs::read(&path).expect("read state")).expect("parse state");
        assert_eq!(value, json!({"old": true}));
        assert_eq!(fs::read_dir(&root).expect("list").count(), 1);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn production_comparison_is_exact_and_has_no_signal_path() {
        let fingerprint = fixture_production(BTreeSet::from([ListenerFingerprint {
            address: "00000000".into(), port: 3001, inode: 7,
        }]));
        assert!(fingerprint_matches(&fingerprint, &fingerprint.clone()));
        let mut changes = Vec::new();
        macro_rules! changed {
            ($field:ident, $value:expr) => {{
                let mut changed = fingerprint.clone();
                changed.$field = $value;
                changes.push(changed);
            }};
        }
        changed!(pid_file, b"2\n".to_vec());
        changed!(pid, 2);
        changed!(start_ticks, 3);
        changed!(cmdline, b"/bin/replacement\0".to_vec());
        changed!(status_uids, [1001; 4]);
        changed!(status_gids, [1001; 4]);
        changed!(proc_uid, 1001);
        changed!(proc_gid, 1001);
        changed!(executable_device, 5);
        changed!(executable_inode, 6);
        changed!(listeners, BTreeSet::from([ListenerFingerprint {
            address: "0100007F".into(), port: 3001, inode: 8,
        }]));
        assert!(changes.iter().all(|changed| !fingerprint_matches(&fingerprint, changed)));
    }

    #[test]
    fn bounded_proc_reads_and_status_identity_parsing_fail_closed() {
        let root = temporary("bounded-proc");
        let file = root.join("proc-value");
        fs::write(&file, b"12345").expect("bounded fixture");
        assert_eq!(read_bounded_proc_file(&file, 5, "production_cmdline").expect("exact limit"), b"12345");
        assert_eq!(
            read_bounded_proc_file(&file, 4, "production_cmdline"),
            Err(Failure::Production("production_cmdline"))
        );
        assert_eq!(parse_status_ids("Name:\ttest\nUid:\t1\t2\t3\t4\n", "Uid:"), Ok([1, 2, 3, 4]));
        assert_eq!(
            parse_status_ids("Name:\ttest\nUid:\t1\t2\t3\n", "Uid:"),
            Err(Failure::Production("production_status"))
        );
        fs::remove_dir_all(root).expect("bounded fixture cleanup");
    }

    #[test]
    fn production_fingerprint_works_inside_systemd_filesystem_sandbox() {
        const INNER: &str = "FRESHELL_0GDD_SYSTEMD_FINGERPRINT_INNER";
        const ROOT: &str = "FRESHELL_0GDD_SYSTEMD_FINGERPRINT_ROOT";
        const PORT: &str = "FRESHELL_0GDD_SYSTEMD_FINGERPRINT_PORT";
        if std::env::var_os(INNER).is_some() {
            let root = PathBuf::from(std::env::var_os(ROOT).expect("sandbox fixture root"));
            let pid_file = root.join("production.pid");
            let port = std::env::var(PORT).expect("sandbox listener port").parse::<u16>().expect("numeric sandbox port");
            let fingerprint = capture_production(&pid_file, port).expect("capture inside filesystem sandbox");
            verify_production(&fingerprint, &pid_file, port).expect("verify inside filesystem sandbox");
            return;
        }

        let root = temporary("systemd-fingerprint");
        let listener = TcpListener::bind("127.0.0.1:0").expect("test production listener");
        let port = listener.local_addr().expect("test production listener address").port();
        let pid_file = root.join("production.pid");
        fs::write(&pid_file, format!("{}\n", std::process::id())).expect("test production pid file");
        fs::set_permissions(&pid_file, fs::Permissions::from_mode(0o600)).expect("private test production pid file");
        let executable = fs::canonicalize(std::env::current_exe().expect("current test executable"))
            .expect("canonical test executable");
        let test_name = "tests::production_fingerprint_works_inside_systemd_filesystem_sandbox";
        let unit = format!(
            "freshell-0gdd-fingerprint-test-{}-{}",
            std::process::id(),
            TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        let output = Command::new("systemd-run")
            .args([
                "--user",
                "--wait",
                "--pipe",
                "--collect",
                "--quiet",
                "--unit",
                &unit,
                "--property=ProtectSystem=strict",
                "--property=ProtectHome=read-only",
                &format!("--property=ReadWritePaths={}", root.display()),
                "--setenv",
                &format!("{INNER}=1"),
                "--setenv",
                &format!("{ROOT}={}", root.display()),
                "--setenv",
                &format!("{PORT}={port}"),
            ])
            .arg(executable)
            .args(["--exact", test_name, "--nocapture", "--test-threads=1"])
            .output()
            .expect("launch sandboxed fingerprint regression");
        assert!(
            output.status.success(),
            "sandboxed fingerprint regression failed\nstdout:\n{}\nstderr:\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        drop(listener);
        fs::remove_dir_all(root).expect("sandbox fixture cleanup");
    }

    #[test]
    fn smoke_output_is_private_schema_valid_and_contains_no_fixture_data() {
        let _guard = lock_watch_tests();
        let root = temporary("smoke");
        let Config::Smoke(config) =
            parse_cli(["observer", "smoke", "--run-root", root.to_str().expect("utf8 fixture path")]).expect("smoke cli")
        else {
            panic!("expected smoke config");
        };
        GLOBAL_SCAN_CALLS.store(0, Ordering::SeqCst);
        execute(Config::Smoke(config)).expect("smoke through entry path");
        assert_eq!(GLOBAL_SCAN_CALLS.load(Ordering::SeqCst), 0);
        verify_private_outputs(&root).expect("private outputs");
        let report_bytes = fs::read(root.join("report.json")).expect("read report");
        let report: Value = serde_json::from_slice(&report_bytes).expect("parse report");
        assert_eq!(report["status"], "complete");
        assert_eq!(report["stop_reason"], "smoke_complete");
        assert_eq!(
            report["stats"]["inotify_baseline_source"],
            "injected_smoke_preflight"
        );
        assert_eq!(report["stats"]["inotify_baseline_complete"], true);
        for provider in ["claude", "codex", "amplifier", "opencode"] {
            assert!(report["stats"]["providers"][provider]["unique_ids"].as_u64().unwrap_or(0) > 0);
        }
        let total = |field: &str| ["claude", "codex", "amplifier", "opencode"].iter()
            .map(|provider| report["stats"]["providers"][provider][field].as_u64().unwrap_or(0)).sum::<u64>();
        for field in ["matched", "delayed", "missed", "notice_only", "burst_duplicates"] {
            assert_eq!(total(field), report["correlation"][field].as_u64().unwrap_or(0), "{field}");
        }
        let text = fs::read_dir(&root).expect("outputs").map(|entry| {
            String::from_utf8(fs::read(entry.expect("entry").path()).expect("read output")).expect("utf8 output")
        }).collect::<String>();
        assert!(!text.contains(root.to_str().expect("utf8 path")));
        assert!(!text.contains("fixture secret"));
        assert!(!text.contains("salt"));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn scan_and_event_use_the_same_path_identity_domain() {
        let _guard = lock_watch_tests();
        let root = temporary("identity");
        let probe = fixture_probe(&root);
        fs::create_dir_all(&probe.roots.claude).expect("claude root");
        let ingress = EventIngress::new();
        let watcher = arm_watchers(&probe, &ingress).expect("watcher");
        let file = probe.roots.claude.join("same.jsonl");
        fs::write(&file, b"opaque").expect("fixture");
        let event = wait_for_path(&ingress, &file);
        let event_path = event.as_ref().and_then(super::event_path).expect("real event path");
        let scan = probe.scan().expect("scan");
        let scanned = scan.inventory.keys().next().expect("inventory id");
        assert_eq!(scanned, &path_id(&probe.salt, probe.qualified_provider(event_path).expect("qualified event"), event_path));
        drop(watcher);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn interval_eviction_prevents_stale_match_and_union_budget_is_bounded() {
        let mut correlation = Correlation::default();
        let stale = PathId("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into());
        correlation.notice(Provider::Claude, stale.clone(), NoticeKind::Modify, 10);
        correlation.finish_interval(1_000);
        correlation.metadata_change(ChangeKind::Modified, Provider::Claude, stale, 2_000);
        assert_eq!(correlation.matched, 0);
        assert_eq!(correlation.pending.len(), 1);

        let shared = PathId("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".into());
        correlation.notice(Provider::Codex, shared.clone(), NoticeKind::Create, 2_100);
        correlation.metadata_change(ChangeKind::Removed, Provider::Codex, shared, 2_200);
        assert_eq!(correlation.budget_len(), 3);
    }

    #[test]
    fn notices_survive_buckets_close_at_reconcile_and_late_notice_resolves_grace() {
        let mut correlation = Correlation::default();
        let id = PathId("cccccccccccccccccccccccccccccccc".into());
        correlation.notice(Provider::Claude, id.clone(), NoticeKind::Modify, 10);
        correlation.finalize_grace(BUCKET_MS);
        assert_eq!(correlation.budget_len(), 1);
        correlation.metadata_change(ChangeKind::Modified, Provider::Claude, id.clone(), RECONCILE_MS);
        assert_eq!(correlation.matched, 1);
        correlation.finish_interval(RECONCILE_MS);
        correlation.metadata_change(ChangeKind::Modified, Provider::Claude, id, RECONCILE_MS + 1);
        assert_eq!(correlation.matched, 1);
        let late = PathId("dddddddddddddddddddddddddddddddd".into());
        correlation.metadata_change(ChangeKind::Added, Provider::Codex, late.clone(), RECONCILE_MS + 2);
        correlation.notice(Provider::Codex, late, NoticeKind::Create, RECONCILE_MS + 3);
        assert_eq!(correlation.delayed, 1);
    }

    #[test]
    fn four_instance_threshold_and_proc_errors_fail_closed() {
        let base = Preflight { max_watches: 1000, max_instances: 1000, max_queue: 16_384, nofile: 65_536,
            existing_watches: 0, existing_instances: 196, projected_watches: 1, projected_instances: 4,
            global_accounting_complete: true, uninspectable_processes: 0 };
        assert!(base.validate().is_ok());
        assert!(Preflight { existing_instances: 197, ..base }.validate().is_err());
        assert!(proc_error_is_race(std::io::ErrorKind::NotFound));
        assert!(!proc_error_is_race(std::io::ErrorKind::PermissionDenied));
        assert!(!proc_error_is_race(std::io::ErrorKind::Other));
    }

    #[test]
    fn opencode_directory_and_recursive_root_presence_drive_rearm() {
        let _guard = lock_watch_tests();
        let root = temporary("presence");
        let probe = fixture_probe(&root);
        let before = watch_presence(&probe);
        fs::create_dir_all(&probe.roots.claude).expect("claude");
        fs::create_dir_all(probe.roots.opencode_db.parent().expect("parent")).expect("opencode");
        let after = watch_presence(&probe);
        assert_ne!(before, after);
        fs::remove_dir_all(probe.roots.opencode_db.parent().expect("parent")).expect("remove opencode");
        assert_ne!(after, watch_presence(&probe));
        fs::remove_dir_all(&probe.roots.claude).expect("remove claude");
        fs::create_dir_all(&probe.roots.claude).expect("recreate claude");
        fs::create_dir_all(probe.roots.opencode_db.parent().expect("parent")).expect("recreate opencode");
        let ingress = EventIngress::new();
        let watcher = arm_watchers(&probe, &ingress).expect("rearm");
        let file = probe.roots.claude.join("recreated.jsonl");
        fs::write(&file, b"fixture").expect("write recreated root");
        assert!(wait_for_path(&ingress, &file).is_some());
        drop(watcher);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn cpu_requires_full_window_and_bucket_stats_are_deltas() {
        let mut cpu = CpuWindow::for_test(100, 0);
        assert_eq!(cpu.sample_actual_ticks(299_999, 100), None);
        assert!(cpu.sample_actual_ticks(300_000, 100).is_some());
        let mut stats = RunStats::default();
        stats.provider(Provider::Claude).create = 2;
        assert_eq!(stats.take_bucket_delta().providers[&Provider::Claude].create, 2);
        assert_eq!(stats.take_bucket_delta().providers[&Provider::Claude].create, 0);
        stats.next_reconcile_ms = 123;
        assert_eq!(state_record("run", "running", "utc", 1, 0, &Inventory::new(), 0, 0, None, &stats)
            ["next_reconcile_ms"], 123);
    }

    #[test]
    fn listener_address_mismatch_and_final_overflow_upgrade_stop() {
        let listener = ListenerFingerprint { address: "00000000".into(), port: 3001, inode: 7 };
        let mut first = fixture_production(BTreeSet::from([listener.clone()]));
        let second = first.clone();
        assert!(fingerprint_matches(&first, &second));
        first.listeners = BTreeSet::from([ListenerFingerprint { address: "0100007F".into(), ..listener }]);
        assert!(!fingerprint_matches(&first, &second));
        let (tx, rx) = mpsc::sync_channel(1);
        tx.try_send(FsEvent::Error("synthetic".into())).expect("queue");
        let mut stop = StopOutcome::new("signal_sigterm", "interrupted", None);
        drain_events(&rx, &mut stop, |_| Err(Failure::Resource("resource_pending")));
        assert_eq!((stop.reason, stop.status), ("resource_pending", "failed"));
        stop.absorb(Failure::Observer("reconciliation_error"));
        assert_eq!(stop.reason, "resource_pending");
    }

    #[test]
    fn injected_elapsed_schedule_emits_full_and_partial_final_buckets() {
        let mut schedule = BucketSchedule::new(60_000);
        assert_eq!(schedule.take_due(59_999, false), Vec::<BucketSpan>::new());
        assert_eq!(
            schedule.take_due(120_000, true),
            vec![
                BucketSpan {
                    start_ms: 0,
                    end_ms: 60_000,
                    partial: false,
                },
                BucketSpan {
                    start_ms: 60_000,
                    end_ms: 120_000,
                    partial: false,
                }
            ]
        );
        let mut partial = BucketSchedule::new(60_000);
        assert_eq!(
            partial.take_due(75_000, true).last(),
            Some(&BucketSpan {
                start_ms: 60_000,
                end_ms: 75_000,
                partial: true,
            })
        );
        assert_eq!(BucketSchedule::new(BUCKET_MS).take_due(OBSERVATION_MS, true).len(), 1_440);
        let root = temporary("report-duration");
        let writer = OutputWriter::create(&root).expect("writer");
        let report = finish_report(&writer, "run", "complete", "observation_complete", "utc",
            OBSERVATION_MS, 1_440, 1, 0, &Correlation::default(), &RunStats::default());
        assert_eq!((report["duration_ms"].as_u64(), report["bucket_count"].as_u64()),
            (Some(OBSERVATION_MS), Some(1_440)));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn startup_work_is_absent_from_bucket_one() {
        let mut stats = RunStats::default();
        stats.reconciliations = 1;
        stats.production_checks = 1;
        stats.provider(Provider::Claude).added = 3;
        stats.establish_bucket_baseline();
        stats.provider(Provider::Claude).create = 1;
        let bucket = stats.take_bucket_delta();
        assert_eq!((bucket.reconciliations, bucket.production_checks, bucket.providers[&Provider::Claude].added), (0, 0, 0));
        assert_eq!(bucket.providers[&Provider::Claude].create, 1);
        assert_eq!(stats.providers[&Provider::Claude].added, 3);
    }

    #[test]
    fn same_path_is_unique_in_each_bucket() {
        let mut stats = RunStats::default();
        let id = PathId("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee".into());
        stats.record_interval_id(Provider::Claude, id.clone());
        assert_eq!(stats.take_bucket_delta().providers[&Provider::Claude].unique_ids, 1);
        stats.record_interval_id(Provider::Claude, id);
        assert_eq!(stats.take_bucket_delta().providers[&Provider::Claude].unique_ids, 1);
    }

    #[test]
    fn massive_same_key_burst_coalesces_without_overflow() {
        let ingress = EventIngress::with_capacity(INGRESS_CAPACITY);
        let path = PathBuf::from("/tmp/repeated.jsonl");
        let at = Instant::now();
        for _ in 0..100_000 {
            ingress.push_for_test_at(FsEvent::Modified(path.clone()), at);
        }
        let batch = ingress.take_batch().expect("coalesced batch");
        assert!(!ingress.overflowed());
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].raw_count, 100_000);
        assert_eq!(batch[0].burst_duplicate_count, 99_999);
        assert_eq!(event_path(&batch[0].event()), Some(path.as_path()));
        assert_eq!(event_kind(&batch[0].event()), NoticeKind::Modify);
        assert!(batch[0].last >= batch[0].first);
    }

    #[test]
    fn far_apart_same_key_events_coalesce_without_becoming_burst_duplicates() {
        let ingress = EventIngress::with_capacity(1);
        let path = PathBuf::from("/tmp/far-apart.jsonl");
        let start = Instant::now();
        for offset_ms in [0, 251, 502, 753] {
            ingress.push_for_test_at(
                FsEvent::Modified(path.clone()),
                start + Duration::from_millis(offset_ms),
            );
        }
        let batch = ingress.take_batch().expect("far-apart batch");
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].raw_count, 4);
        assert_eq!(batch[0].burst_duplicate_count, 0);
        assert!(!ingress.overflowed());
    }

    #[test]
    fn mixed_near_and_far_spacing_counts_only_true_burst_duplicates() {
        let ingress = EventIngress::with_capacity(1);
        let path = PathBuf::from("/tmp/mixed-spacing.jsonl");
        let start = Instant::now();
        for offset_ms in [0, 100, 400, 500, 751, 1_001] {
            ingress.push_for_test_at(
                FsEvent::Modified(path.clone()),
                start + Duration::from_millis(offset_ms),
            );
        }
        let batch = ingress.take_batch().expect("mixed-spacing batch");
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].raw_count, 6);
        assert_eq!(batch[0].burst_duplicate_count, 3);
        assert!(!ingress.overflowed());
    }

    #[test]
    fn distinct_key_capacity_overflow_stops_at_exact_bound() {
        let ingress = EventIngress::with_capacity(INGRESS_CAPACITY);
        let mut callback = ingress.callback();
        for index in 0..=INGRESS_CAPACITY {
            callback(Ok(
                Event::new(EventKind::Modify(ModifyKind::Any))
                    .add_path(PathBuf::from(format!("/tmp/{index}.jsonl"))),
            ));
        }
        let batch = ingress.take_batch().expect("bounded batch");
        assert!(ingress.overflowed());
        assert_eq!(batch.len(), INGRESS_CAPACITY);
        assert_eq!(batch.iter().map(|notice| notice.raw_count).sum::<u64>(), INGRESS_CAPACITY as u64);
    }

    #[test]
    fn events_arriving_after_swap_remain_for_the_next_drain() {
        let ingress = EventIngress::with_capacity(2);
        let mut callback = ingress.callback();
        let path = PathBuf::from("/tmp/concurrent.jsonl");
        let (ready_tx, ready_rx) = mpsc::sync_channel(0);
        let (continue_tx, continue_rx) = mpsc::sync_channel(0);
        let producer = thread::spawn(move || {
            for _ in 0..50_000 {
                callback(Ok(
                    Event::new(EventKind::Modify(ModifyKind::Any))
                        .add_path(path.clone()),
                ));
            }
            ready_tx.send(()).expect("first half ready");
            continue_rx.recv().expect("continue after swap");
            for _ in 0..50_000 {
                callback(Ok(
                    Event::new(EventKind::Modify(ModifyKind::Any))
                        .add_path(path.clone()),
                ));
            }
        });
        ready_rx.recv().expect("first half produced");
        let first = ingress.take_batch().expect("first swapped batch");
        continue_tx.send(()).expect("release second half");
        producer.join().expect("producer");
        let second = ingress.take_batch().expect("replacement batch");
        assert_eq!(first.len(), 1);
        assert_eq!(second.len(), 1);
        assert_eq!(first[0].raw_count, 50_000);
        assert_eq!(second[0].raw_count, 50_000);
        assert!(!ingress.overflowed());
    }

    #[test]
    fn coalesced_raw_count_is_preserved_in_notice_evidence() {
        let root = temporary("coalesced-evidence");
        let probe = fixture_probe(&root);
        let path = probe.roots.claude.join("project").join("session.jsonl");
        let ingress = EventIngress::with_capacity(2);
        let at = Instant::now();
        for _ in 0..100_000 {
            ingress.push_for_test_at(FsEvent::Modified(path.clone()), at);
        }
        let start = Instant::now();
        let mut correlation = Correlation::default();
        let mut stats = RunStats::default();
        for notice in ingress.take_batch().expect("coalesced evidence batch") {
            record_coalesced_notice(&probe, &mut correlation, &mut stats, &notice, start);
        }
        let provider = &stats.providers[&Provider::Claude];
        assert_eq!(provider.modify, 100_000);
        assert_eq!(provider.burst_duplicates, 99_999);
        assert_eq!(correlation.burst_duplicates, 99_999);
        assert!(!ingress.overflowed());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn event_budget_is_conservative_and_handles_large_bursts() {
        let mut correlation = Correlation::default();
        for index in 0..100_000 {
            let id = PathId(format!("{index:032x}"));
            correlation.notice(Provider::Claude, id, NoticeKind::Modify, index);
        }
        assert_eq!(correlation.budget_len(), correlation.notices.len() + correlation.pending.len());
    }

    #[test]
    fn modified_notice_can_explain_removed_path_from_rename() {
        let mut correlation = Correlation::default();
        let old = PathId("ffffffffffffffffffffffffffffffff".into());
        correlation.notice(Provider::Claude, old.clone(), NoticeKind::Modify, 10);
        correlation.metadata_change(ChangeKind::Removed, Provider::Claude, old, 20);
        assert_eq!((correlation.matched, correlation.missed), (1, 0));
    }

    #[test]
    fn production_pid_file_rejects_symlink_writable_and_oversized_files() {
        use std::os::unix::fs::symlink;
        let root = temporary("pid-file");
        let valid = root.join("valid.pid");
        fs::write(&valid, b"123\n").expect("valid pid file");
        fs::set_permissions(&valid, fs::Permissions::from_mode(0o600)).expect("private pid");
        assert_eq!(read_production_pid_file(&valid).expect("valid secure pid"), b"123\n");

        let link = root.join("link.pid");
        symlink(&valid, &link).expect("pid symlink");
        assert!(read_production_pid_file(&link).is_err());

        let writable = root.join("writable.pid");
        fs::write(&writable, b"123\n").expect("writable pid");
        fs::set_permissions(&writable, fs::Permissions::from_mode(0o622)).expect("writable mode");
        assert!(read_production_pid_file(&writable).is_err());

        let oversized = root.join("oversized.pid");
        fs::write(&oversized, [b'1'; 65]).expect("oversized pid");
        fs::set_permissions(&oversized, fs::Permissions::from_mode(0o600)).expect("private oversized");
        assert!(read_production_pid_file(&oversized).is_err());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn wait_for_signal_is_smoke_only() {
        assert!(parse_cli([
            "observer", "run", "--run-root", "/tmp/run", "--claude-root", "/tmp/c",
            "--codex-root", "/tmp/x", "--amplifier-root", "/tmp/a", "--opencode-db",
            "/tmp/o.db", "--production-pid-file", "/tmp/pid", "--production-port", "3001",
            "--wait-for-signal",
        ])
        .is_err());
    }

    #[test]
    fn real_rename_modified_notices_match_remove_and_add() {
        let _guard = lock_watch_tests();
        let root = temporary("real-rename");
        let probe = fixture_probe(&root);
        fs::create_dir_all(&probe.roots.claude).expect("claude root");
        fs::create_dir_all(probe.roots.opencode_db.parent().expect("opencode parent")).expect("opencode root");
        let old = probe.roots.claude.join("old.jsonl");
        let new = probe.roots.claude.join("new.jsonl");
        fs::write(&old, b"opaque").expect("old fixture");
        let original = probe.scan().expect("original scan").inventory;
        let ingress = EventIngress::new();
        let group = arm_watchers(&probe, &ingress).expect("watchers");
        fs::rename(&old, &new).expect("rename");
        let mut correlation = Correlation::default();
        let mut stats = RunStats::default();
        collect_smoke_events(&ingress, &probe, &mut correlation, &mut stats, Instant::now()).expect("events");
        let current = probe.scan().expect("renamed scan").inventory;
        let diff = diff_inventory(&original, &current);
        apply_diff(&diff, &original, &current, &mut correlation, &mut stats, 1_000);
        assert_eq!((diff.removed.len(), diff.added.len()), (1, 1));
        assert_eq!((correlation.matched, correlation.missed), (2, 0));
        drop(group);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn queued_events_survive_successful_and_failed_rearm_attempts() {
        let _guard = lock_watch_tests();
        let root = temporary("rearm-queue");
        let probe = fixture_probe(&root);
        for path in [&probe.roots.claude, &probe.roots.codex, &probe.roots.amplifier] {
            fs::create_dir_all(path).expect("provider root");
        }
        fs::create_dir_all(probe.roots.opencode_db.parent().expect("opencode parent")).expect("opencode root");
        let ingress = EventIngress::new();
        let old = arm_watchers(&probe, &ingress).expect("old watchers");
        let queued = probe.roots.claude.join("queued.jsonl");
        ingress.push_for_test(FsEvent::Modified(queued.clone()));
        let replacement = arm_watchers(&probe, &ingress).expect("replacement watchers");
        drop(old);
        assert!(wait_for_path(&ingress, &queued).is_some());
        let mut bad = probe.clone();
        bad.roots.opencode_db = PathBuf::from("/");
        assert!(arm_watchers(&bad, &ingress).is_err());
        drop(replacement);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn watch_accounting_accepts_directories_added_and_removed_between_estimate_and_arm() {
        let _guard = lock_watch_tests();
        let root = temporary("dynamic-directories");
        let probe = fixture_probe(&root);
        for path in [&probe.roots.claude, &probe.roots.codex, &probe.roots.amplifier] {
            fs::create_dir_all(path).expect("provider root");
        }
        fs::create_dir_all(probe.roots.opencode_db.parent().expect("opencode parent")).expect("opencode root");
        let ingress = EventIngress::new();
        let before_add = projected_own_usage(&probe.roots).expect("projection before add");
        fs::create_dir_all(probe.roots.claude.join("new").join("nested")).expect("new recursive directories");
        let added_group = arm_watchers(&probe, &ingress).expect("watchers after add");
        let added_actual = own_inotify_usage().expect("actual after add");
        let added = WatchAccounting::from_counts(before_add, added_actual);
        assert_ne!(added.projected_watches, added.actual_watches);
        validate_watch_accounting(
            Preflight {
                max_watches: 524_288,
                max_instances: 1_024,
                max_queue: 16_384,
                nofile: 65_536,
                existing_watches: 0,
                existing_instances: 0,
                projected_watches: before_add.0,
                projected_instances: before_add.1,
                global_accounting_complete: true,
                uninspectable_processes: 0,
            },
            added,
        )
        .expect("added directories do not invalidate safe actual usage");
        drop(added_group);

        let before_remove = projected_own_usage(&probe.roots).expect("projection before remove");
        fs::remove_dir_all(probe.roots.claude.join("new")).expect("remove recursive directories");
        let removed_group = arm_watchers(&probe, &ingress).expect("watchers after remove");
        let removed_actual = own_inotify_usage().expect("actual after remove");
        let removed = WatchAccounting::from_counts(before_remove, removed_actual);
        assert_ne!(removed.projected_watches, removed.actual_watches);
        validate_watch_accounting(
            Preflight {
                projected_watches: before_remove.0,
                projected_instances: before_remove.1,
                ..Preflight {
                    max_watches: 524_288,
                    max_instances: 1_024,
                    max_queue: 16_384,
                    nofile: 65_536,
                    existing_watches: 0,
                    existing_instances: 0,
                    projected_watches: 0,
                    projected_instances: 0,
                    global_accounting_complete: true,
                    uninspectable_processes: 0,
                }
            },
            removed,
        )
        .expect("removed directories do not invalidate safe actual usage");
        drop(removed_group);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn watch_accounting_record_contains_estimate_actual_difference_and_limits() {
        let preflight = Preflight {
            max_watches: 524_288,
            max_instances: 1_024,
            max_queue: 16_384,
            nofile: 65_536,
            existing_watches: 8_626,
            existing_instances: 95,
            projected_watches: 27_733,
            projected_instances: 4,
            global_accounting_complete: false,
            uninspectable_processes: 3,
        };
        let accounting = WatchAccounting {
            projected_watches: 27_733,
            projected_instances: 4,
            actual_watches: 27_739,
            actual_instances: 4,
        };
        let record = watch_accounting_record("startup", "run", 0, accounting, preflight);
        assert_eq!(record["record_type"], "watch_accounting");
        assert_eq!(record["reason"], "startup");
        assert_eq!(record["projected_watches"], 27_733);
        assert_eq!(record["actual_watches"], 27_739);
        assert_eq!(record["watch_difference"], 6);
        assert_eq!(record["actual_exceeds_projection"], true);
        assert_eq!(record["own_watch_limit"], MAX_OWN_WATCHES);
        assert_eq!(record["known_global_watch_limit"], preflight.max_watches / 5);
        assert_eq!(record["known_global_estimated_watches"], 8_626 + 27_739);
    }

    fn run_finalizer_case(name: &str, failure: Failure, overflow: bool) {
        let root = temporary(name);
        let output = root.join("output");
        fs::create_dir(&output).expect("output root");
        fs::set_permissions(&output, fs::Permissions::from_mode(0o700)).expect("private output");
        let probe = fixture_probe(&root.join("providers"));
        for path in [&probe.roots.claude, &probe.roots.codex, &probe.roots.amplifier] {
            fs::create_dir_all(path).expect("provider root");
        }
        fs::create_dir_all(probe.roots.opencode_db.parent().expect("opencode parent")).expect("opencode root");

        let listener = TcpListener::bind("127.0.0.1:0").expect("test listener");
        let port = listener.local_addr().expect("listener address").port();
        let pid_file = root.join("production.pid");
        fs::write(&pid_file, format!("{}\n", std::process::id())).expect("pid file");
        fs::set_permissions(&pid_file, fs::Permissions::from_mode(0o600)).expect("private pid file");
        let config = RunConfig {
            run_root: output.clone(),
            roots: probe.roots.clone(),
            production_pid_file: pid_file,
            production_port: port,
            preflight_file: root.join("unused-preflight.json"),
        };
        let production = capture_production(&config.production_pid_file, port).expect("test production fingerprint");
        let ingress = EventIngress::with_capacity(if overflow { 1 } else { 8 });
        let group = arm_watchers(&probe, &ingress).expect("watchers");
        let queued = probe.roots.claude.join("queued.jsonl");
        ingress.push_for_test(FsEvent::Created(queued.clone()));
        if overflow {
            ingress.push_for_test(FsEvent::Modified(queued.clone()));
        }
        fs::write(&queued, b"opaque").expect("queued fixture");
        let initial = Inventory::new();
        let accounting = watch_accounting(&probe.roots).expect("watch accounting");
        let preflight = Preflight {
            max_watches: 524_288,
            max_instances: 1_024,
            max_queue: 16_384,
            nofile: 65_536,
            existing_watches: 0,
            existing_instances: 0,
            projected_watches: accounting.projected_watches,
            projected_instances: accounting.projected_instances,
            global_accounting_complete: true,
            uninspectable_processes: 0,
        };
        let mut runtime = Runtime {
            config: &config,
            probe,
            writer: OutputWriter::create(&output).expect("writer"),
            ingress,
            group: Some(group),
            inventory: initial,
            correlation: Correlation::default(),
            stats: RunStats {
                preflight: Some(preflight),
                actual_watches: accounting.actual_watches,
                actual_instances: accounting.actual_instances,
                ..RunStats::default()
            },
            schedule: BucketSchedule::new(BUCKET_MS),
            start: Instant::now(),
            start_utc: Utc::now().to_rfc3339(),
            run_id: "0123456789abcdef0123456789abcdef".into(),
            production,
            preflight,
            cpu: CpuWindow::for_test(100, 0),
            cpu_limit: CpuLimitGuard::default(),
            presence: [true; 4],
        };
        runtime.stats.establish_bucket_baseline();
        thread::sleep(Duration::from_millis(2));
        assert_eq!(runtime.finalize(failure.code(), "failed", Some(failure)), Err(failure));
        assert!(runtime.group.is_none(), "watchers must be dropped");
        assert_eq!(runtime.ingress.pending_len(), 0, "queued events must be drained");

        let after_drop = queued.with_file_name("after-drop.jsonl");
        fs::write(after_drop, b"opaque").expect("post-drop fixture");
        thread::sleep(Duration::from_millis(30));
        assert_eq!(runtime.ingress.pending_len(), 0, "dropped watchers must emit nothing");

        let state: Value = serde_json::from_slice(&fs::read(output.join("state.json")).expect("state")).expect("state json");
        let report: Value =
            serde_json::from_slice(&fs::read(output.join("report.json")).expect("report")).expect("report json");
        assert_eq!((state["status"].as_str(), state["stop_reason"].as_str()), (Some("failed"), Some(failure.code())));
        assert_eq!((report["status"].as_str(), report["stop_reason"].as_str()), (Some("failed"), Some(failure.code())));
        assert_eq!(report["stats"]["reconciliations"], 1, "final reconciliation must be attempted");
        assert_eq!(
            report["stats"]["watcher_overflows"],
            u64::from(overflow),
            "overflow must be counted exactly once"
        );
        assert!(report["stats"]["providers"]["claude"]["create"].as_u64().unwrap_or(0) >= 1, "queued event must be recorded");
        let records: Vec<Value> = fs::read_to_string(output.join("events.jsonl"))
            .expect("events")
            .lines()
            .map(|line| serde_json::from_str(line).expect("event json"))
            .collect();
        assert!(records.iter().any(|record| record["record_type"] == "reconcile" && record["reason"] == "shutdown"));
        assert!(records.iter().any(|record| record["record_type"] == "bucket" && record["partial"] == true));
        drop(listener);
        drop(runtime);
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn controlled_stops_use_the_real_finalizer_path() {
        let _guard = lock_watch_tests();
        run_finalizer_case(
            "finalize-production",
            Failure::Production("production_fingerprint_changed"),
            false,
        );
        run_finalizer_case("finalize-overflow", Failure::Observer("watcher_overflow"), true);
        run_finalizer_case("finalize-memory", Failure::Resource("resource_rss"), false);
        run_finalizer_case("finalize-cpu", Failure::Resource("resource_cpu"), false);
    }

    #[test]
    fn delayed_reconciliation_uses_actual_cpu_window_time() {
        let mut cpu = CpuWindow::for_test(100, 0);
        assert_eq!(cpu.sample_actual_ticks(299_999, 600), None);
        let cpu_percent = cpu
            .sample_actual_ticks(562_000, 1_755)
            .expect("complete actual-time window after delayed reconciliation");
        assert!((cpu_percent - 3.122_775_8).abs() < 0.000_001);
    }

    #[test]
    fn cpu_initial_ticks_are_paired_with_their_actual_time() {
        let mut cpu = CpuWindow::for_test_at(100, 160_000, 500);
        assert_eq!(cpu.sample_actual_ticks(459_999, 2_299), None);
        let cpu_percent = cpu
            .sample_actual_ticks(460_000, 2_300)
            .expect("300 actual seconds since initial paired sample");
        assert!((cpu_percent - 6.0).abs() < f64::EPSILON);
    }

    #[test]
    fn cpu_guard_requires_two_consecutive_complete_breaches() {
        let mut guard = CpuLimitGuard::default();
        let high = ResourceSample {
            cpu_percent: 6.1,
            ..ResourceSample::safe()
        };
        assert!(guard
            .check_at(&high, 300_000)
            .is_ok(), "first complete breach is tolerated");
        let error = guard
            .check_at(&high, 360_000)
            .expect_err("second consecutive complete breach stops");
        let mut stop = StopOutcome::new("running", "running", None);
        stop.absorb(error);
        assert_eq!((stop.status, stop.reason), ("failed", "resource_cpu"));
    }

    #[test]
    fn cpu_guard_resets_after_a_non_breach() {
        let mut guard = CpuLimitGuard::default();
        let high = ResourceSample {
            cpu_percent: 6.1,
            ..ResourceSample::safe()
        };
        assert!(guard.check_at(&high, 300_000).is_ok());
        assert!(guard.check_at(&ResourceSample::safe(), 360_000).is_ok());
        assert!(guard
            .check_at(&high, 420_000)
            .is_ok(), "breach after reset is first, not second");
        assert!(guard.check_at(&high, 480_000).is_err());
    }

    #[test]
    fn incomplete_cpu_windows_neither_breach_nor_reset_a_streak() {
        let mut guard = CpuLimitGuard::default();
        let high = ResourceSample {
            cpu_percent: 99.0,
            ..ResourceSample::safe()
        };
        assert!(guard.check_at(&high, 300_000).is_ok());
        assert!(guard
            .check_at(
                &ResourceSample {
                    cpu_percent: 99.0,
                    cpu_window_complete: false,
                    ..ResourceSample::safe()
                },
                360_000,
            )
            .is_ok());
        assert!(guard
            .check_at(&high, 420_000)
            .is_err(), "incomplete window is not a complete non-breach");
    }

    #[test]
    fn catch_up_buckets_do_not_count_one_actual_cpu_window_twice() {
        let mut guard = CpuLimitGuard::default();
        let high = ResourceSample {
            cpu_percent: 6.1,
            ..ResourceSample::safe()
        };
        assert!(guard.check_at(&high, 300_000).is_ok());
        assert!(guard
            .check_at(&high, 300_001)
            .is_ok(), "near-simultaneous catch-up bucket reuses the same window");
        assert!(guard
            .check_at(&high, 360_000)
            .is_err(), "next distinct actual-time window is the second breach");
    }

    #[test]
    fn peak_reporting_uses_actual_window_cpu() {
        let mut stats = RunStats::default();
        stats.sample(ResourceSample {
            cpu_percent: 3.122_775_8,
            ..ResourceSample::safe()
        });
        stats.sample(ResourceSample {
            cpu_percent: 1.0,
            ..ResourceSample::safe()
        });
        let encoded = serde_json::to_value(&stats).expect("serialize stats");
        assert_eq!(encoded["latest_resources"]["cpu_percent"], 1.0);
        assert_eq!(encoded["peak_resources"]["cpu_percent"], 3.122_775_8);
    }

    struct FakeProcessProbe {
        statuses: VecDeque<String>,
        fd_inspection: ProcessFdInspection,
        fd_inspections: u64,
    }

    impl FakeProcessProbe {
        fn new(states: &[char], fd_inspection: ProcessFdInspection) -> Self {
            Self {
                statuses: states.iter().map(|state| fixture_process_status(*state)).collect(),
                fd_inspection,
                fd_inspections: 0,
            }
        }
    }

    impl ProcessProbe for FakeProcessProbe {
        fn read_status(&mut self) -> std::io::Result<String> {
            self.statuses
                .pop_front()
                .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "status"))
        }

        fn inspect_fds(&mut self) -> Result<ProcessFdInspection> {
            self.fd_inspections += 1;
            Ok(self.fd_inspection)
        }
    }

    fn fixture_process_status(state: char) -> String {
        format!("Name:\ttest\nState:\t{state} (test)\nUid:\t1000\t1000\t1000\t1000\n")
    }

    #[test]
    fn preflight_skips_processes_already_dead_before_fd_inspection() {
        for state in ['Z', 'X', 'x'] {
            let mut probe = FakeProcessProbe::new(
                &[state],
                ProcessFdInspection::Inaccessible {
                    watches: 0,
                    instances: 0,
                },
            );
            let usage = inspect_process_inotify(&mut probe, 1000).expect("dead process");
            assert_eq!(usage, InotifyUsage::default(), "state {state}");
            assert_eq!(probe.fd_inspections, 0, "state {state}");
        }
    }

    #[test]
    fn preflight_rereads_state_and_skips_process_that_becomes_zombie() {
        let mut probe = FakeProcessProbe::new(
            &['S', 'Z'],
            ProcessFdInspection::Inaccessible {
                watches: 2,
                instances: 1,
            },
        );
        let usage = inspect_process_inotify(&mut probe, 1000).expect("racing process");
        assert_eq!(usage.watches, 2);
        assert_eq!(usage.instances, 1);
        assert_eq!(usage.uninspectable_processes, 0);
        assert_eq!(probe.fd_inspections, 1);
    }

    #[test]
    fn preflight_still_counts_inaccessible_live_process() {
        let mut probe = FakeProcessProbe::new(
            &['S', 'S'],
            ProcessFdInspection::Inaccessible {
                watches: 3,
                instances: 1,
            },
        );
        let usage = inspect_process_inotify(&mut probe, 1000).expect("live process");
        assert_eq!(usage.watches, 3);
        assert_eq!(usage.instances, 1);
        assert_eq!(usage.uninspectable_processes, 1);
        assert_eq!(probe.fd_inspections, 1);
    }

    fn fixture_system() -> PreflightSystem {
        PreflightSystem {
            uid: unsafe { libc::geteuid() },
            boot_id: "11111111-2222-3333-4444-555555555555".into(),
            max_watches: 524_288,
            max_instances: 1_024,
            max_queue: 16_384,
            nofile: 65_536,
            monotonic_uptime_ms: 10_000_000,
            utc: "2026-08-13T12:00:00Z".into(),
        }
    }

    fn fixture_handoff(projected_watches: u64, projected_instances: u64) -> PreflightHandoff {
        let system = fixture_system();
        PreflightHandoff {
            schema_version: PREFLIGHT_SCHEMA_VERSION,
            uid: system.uid,
            boot_id: system.boot_id,
            created_utc: system.utc,
            monotonic_uptime_ms: system.monotonic_uptime_ms,
            max_watches: system.max_watches,
            max_instances: system.max_instances,
            max_queue: system.max_queue,
            nofile: system.nofile,
            existing_watches: 12_696,
            existing_instances: 112,
            projected_watches,
            projected_instances,
            global_accounting_complete: false,
            uninspectable_processes: 7,
        }
    }

    #[test]
    fn cli_supports_host_preflight_and_requires_run_handoff() {
        let preflight = parse_cli([
            "observer", "preflight", "--claude-root", "/tmp/c", "--codex-root", "/tmp/x",
            "--amplifier-root", "/tmp/a", "--opencode-db", "/tmp/o.db", "--output", "/tmp/preflight.json",
        ]).expect("preflight cli");
        assert!(matches!(preflight, Config::Preflight(_)));
        assert!(parse_cli([
            "observer", "run", "--run-root", "/tmp/run", "--claude-root", "/tmp/c",
            "--codex-root", "/tmp/x", "--amplifier-root", "/tmp/a", "--opencode-db", "/tmp/o.db",
            "--production-pid-file", "/tmp/pid", "--production-port", "3001",
        ]).is_err());
        assert!(parse_cli([
            "observer", "run", "--run-root", "/tmp/run", "--claude-root", "/tmp/c",
            "--codex-root", "/tmp/x", "--amplifier-root", "/tmp/a", "--opencode-db", "/tmp/o.db",
            "--production-pid-file", "/tmp/pid", "--production-port", "3001",
            "--preflight-file", "/tmp/preflight.json",
        ]).is_ok());
    }

    #[test]
    fn valid_private_preflight_handoff_round_trips_without_paths() {
        let root = temporary("preflight-valid");
        let path = root.join("handoff.json");
        let roots = fixture_probe(&root.join("providers")).roots;
        for provider_root in [&roots.claude, &roots.codex, &roots.amplifier] {
            fs::create_dir_all(provider_root).expect("provider root");
        }
        fs::create_dir_all(roots.opencode_db.parent().expect("opencode parent")).expect("opencode root");
        let projection = projected_own_usage(&roots).expect("projection");
        let handoff = fixture_handoff(projection.0, projection.1);
        write_preflight_file(&path, &handoff).expect("write handoff");
        let loaded = load_preflight_file(&path, &roots, &fixture_system()).expect("load handoff");
        assert_eq!(loaded.existing_watches, handoff.existing_watches);
        assert_eq!(loaded.uninspectable_processes, 7);
        let encoded = fs::read_to_string(&path).expect("read handoff");
        for forbidden in ["/tmp/", "claude", "codex", "amplifier", "opencode", "HOME", "PATH"] {
            assert!(!encoded.contains(forbidden), "{forbidden}");
        }
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn preflight_handoff_rejects_stale_utc_and_monotonic_age() {
        let root = temporary("preflight-stale");
        let path = root.join("handoff.json");
        let roots = fixture_probe(&root.join("providers")).roots;
        let mut handoff = fixture_handoff(1, 1);
        write_preflight_file(&path, &handoff).expect("write handoff");
        let mut now = fixture_system();
        now.monotonic_uptime_ms += PREFLIGHT_MAX_AGE_MS + 1;
        assert_eq!(load_preflight_file(&path, &roots, &now), Err(Failure::Cli("preflight_stale")));
        fs::remove_file(&path).expect("remove stale uptime handoff");
        handoff.monotonic_uptime_ms = fixture_system().monotonic_uptime_ms;
        handoff.created_utc = "2026-08-13T11:54:59Z".into();
        write_preflight_file(&path, &handoff).expect("write stale utc handoff");
        assert_eq!(load_preflight_file(&path, &roots, &fixture_system()), Err(Failure::Cli("preflight_stale")));
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn preflight_handoff_rejects_boot_uid_and_kernel_limit_mismatch() {
        let root = temporary("preflight-identity");
        let roots = fixture_probe(&root.join("providers")).roots;
        for (name, mutate) in [
            ("boot", 0_u8),
            ("uid", 1),
            ("limit", 2),
        ] {
            let path = root.join(format!("{name}.json"));
            let mut handoff = fixture_handoff(1, 1);
            match mutate {
                0 => handoff.boot_id = "different-boot".into(),
                1 => handoff.uid = handoff.uid.saturating_add(1),
                _ => handoff.max_watches -= 1,
            }
            write_preflight_file(&path, &handoff).expect("write mismatched handoff");
            assert!(load_preflight_file(&path, &roots, &fixture_system()).is_err(), "{name}");
        }
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn preflight_file_rejects_symlink_writable_oversized_and_hard_link() {
        use std::fs::hard_link;
        use std::os::unix::fs::symlink;
        let root = temporary("preflight-file-policy");
        let roots = fixture_probe(&root.join("providers")).roots;
        let valid = root.join("valid.json");
        write_preflight_file(&valid, &fixture_handoff(1, 1)).expect("valid handoff");

        let link = root.join("link.json");
        symlink(&valid, &link).expect("symlink");
        assert!(load_preflight_file(&link, &roots, &fixture_system()).is_err());

        let writable = root.join("writable.json");
        fs::copy(&valid, &writable).expect("writable copy");
        fs::set_permissions(&writable, fs::Permissions::from_mode(0o660)).expect("writable mode");
        assert!(load_preflight_file(&writable, &roots, &fixture_system()).is_err());

        let oversized = root.join("oversized.json");
        fs::write(&oversized, vec![b' '; PREFLIGHT_MAX_BYTES as usize + 1]).expect("oversized handoff");
        fs::set_permissions(&oversized, fs::Permissions::from_mode(0o600)).expect("oversized mode");
        assert!(load_preflight_file(&oversized, &roots, &fixture_system()).is_err());

        let hard = root.join("hard.json");
        hard_link(&valid, &hard).expect("hard link");
        assert!(load_preflight_file(&hard, &roots, &fixture_system()).is_err());
        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn projection_drift_accepts_five_percent_boundary_only() {
        assert!(projection_within_drift((10_000, 100), (10_500, 105)));
        assert!(projection_within_drift((10_000, 100), (9_500, 95)));
        assert!(!projection_within_drift((10_000, 100), (10_501, 105)));
        assert!(!projection_within_drift((10_000, 100), (10_500, 106)));
        assert!(projection_within_drift((0, 0), (0, 0)));
        assert!(!projection_within_drift((0, 0), (1, 0)));
    }

    #[test]
    fn host_preflight_rejects_uninspectable_and_twenty_percent_thresholds() {
        let roots = Roots {
            claude: PathBuf::from("/missing/claude"),
            codex: PathBuf::from("/missing/codex"),
            amplifier: PathBuf::from("/missing/amplifier"),
            opencode_db: PathBuf::from("/missing/opencode/opencode.db"),
        };
        let safe = build_host_preflight(
            &roots,
            &fixture_system(),
            InotifyUsage { watches: 10_000, instances: 100, global_accounting_complete: false, uninspectable_processes: 7 },
        ).expect("safe host preflight");
        assert!(safe.runtime().validate().is_ok());
        assert!(build_host_preflight(
            &roots,
            &fixture_system(),
            InotifyUsage { watches: 10_000, instances: 100, global_accounting_complete: false, uninspectable_processes: 11 },
        ).is_err());
        let mut narrow = fixture_system();
        narrow.max_watches = 50_000;
        assert!(build_host_preflight(
            &roots,
            &narrow,
            InotifyUsage { watches: 10_000, instances: 100, global_accounting_complete: false, uninspectable_processes: 7 },
        ).is_err());
    }

    #[test]
    fn run_handoff_load_does_not_scan_foreign_process_fds() {
        let root = temporary("preflight-no-proc");
        let path = root.join("handoff.json");
        let roots = fixture_probe(&root.join("providers")).roots;
        let projection = projected_own_usage(&roots).expect("projection");
        write_preflight_file(&path, &fixture_handoff(projection.0, projection.1)).expect("handoff");
        GLOBAL_SCAN_CALLS.store(0, Ordering::SeqCst);
        load_preflight_file(&path, &roots, &fixture_system()).expect("load without global scan");
        assert_eq!(GLOBAL_SCAN_CALLS.load(Ordering::SeqCst), 0);
        fs::remove_dir_all(root).expect("cleanup");
    }
}
