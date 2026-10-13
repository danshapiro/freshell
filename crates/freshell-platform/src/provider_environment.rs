//! Bounded resource projection shared by controller staging and provider HOME copying.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Clone, Copy, Debug)]
pub struct CopyLimits {
    pub max_entries: usize,
    pub max_total_bytes: u64,
    pub max_file_bytes: u64,
    pub max_depth: usize,
}
impl Default for CopyLimits {
    fn default() -> Self {
        Self {
            max_entries: 100_000,
            max_total_bytes: 512 * 1024 * 1024,
            max_file_bytes: 128 * 1024 * 1024,
            max_depth: 64,
        }
    }
}
#[derive(Debug, Clone)]
pub struct CopySelection {
    pub source: PathBuf,
    pub destination_relative: PathBuf,
}
#[derive(Debug)]
pub struct CopyReport {
    pub entries: usize,
    pub bytes: u64,
    pub projected_paths: Vec<PathBuf>,
    pub created_paths: Vec<PathBuf>,
}
#[derive(Debug)]
pub struct CopyError {
    pub relative_path: PathBuf,
    pub operation: &'static str,
    pub limit_kind: Option<&'static str>,
    pub observed: Option<u64>,
    pub permitted: Option<u64>,
    pub corrective_message: String,
}
impl std::fmt::Display for CopyError {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            out,
            "{} {}: {}",
            self.operation,
            self.relative_path.display(),
            self.corrective_message
        )?;
        if let (Some(kind), Some(observed), Some(permitted)) =
            (self.limit_kind, self.observed, self.permitted)
        {
            write!(out, " ({kind}: observed {observed}, permitted {permitted})")?;
        }
        Ok(())
    }
}
impl std::error::Error for CopyError {}
fn error(path: &Path, operation: &'static str, message: impl Into<String>) -> CopyError {
    CopyError {
        relative_path: if valid_relative(path) || path.as_os_str().is_empty() {
            path.to_owned()
        } else {
            "invalid-selection".into()
        },
        operation,
        limit_kind: None,
        observed: None,
        permitted: None,
        corrective_message: message.into(),
    }
}
fn io_error(path: &Path, operation: &'static str, cause: std::io::Error) -> CopyError {
    // IO error kinds/codes are useful; never include source bytes or arbitrary IO text.
    error(
        path,
        operation,
        format!(
            "selected resource is unavailable ({:?}, OS {:?}); repair the named resource and retry",
            cause.kind(),
            cause.raw_os_error()
        ),
    )
}
fn bound(path: &Path, kind: &'static str, observed: u64, permitted: u64) -> Result<(), CopyError> {
    if observed <= permitted {
        return Ok(());
    }
    Err(CopyError {
        relative_path: if valid_relative(path) || path.as_os_str().is_empty() {
            path.to_owned()
        } else {
            "invalid-selection".into()
        },
        operation: "plan",
        limit_kind: Some(kind),
        observed: Some(observed),
        permitted: Some(permitted),
        corrective_message:
            "reduce unrelated data in the selected resource or repair its topology and retry".into(),
    })
}
pub fn private_file_mode(source_mode: u32) -> u32 {
    0o600 | (source_mode & 0o111)
}
pub fn provider_read_stage_mode(source_mode: u32) -> u32 {
    0o640 | (source_mode & 0o111)
}
fn valid_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty() && path.components().all(|part| matches!(part,Component::Normal(name) if name.len()<=255 && !name.to_string_lossy().chars().any(char::is_control)))
}
#[derive(Clone, Debug, PartialEq, Eq)]
enum Node {
    Directory(PathBuf),
    File(PathBuf, u32, u64),
    Link(PathBuf),
}
struct Plan {
    nodes: BTreeMap<PathBuf, Node>,
    mappings: BTreeMap<PathBuf, PathBuf>,
    pending: VecDeque<(PathBuf, PathBuf, usize)>,
    exclusions: Vec<PathBuf>,
    counted_files: BTreeSet<PathBuf>,
    bytes: u64,
    metadata_bytes: u64,
    limits: CopyLimits,
    account_home: Option<PathBuf>,
}
const MAX_METADATA_BYTES: u64 = 64 * 1024 * 1024;
impl Plan {
    fn excluded(&self, source: &Path) -> bool {
        self.exclusions
            .iter()
            .any(|path| source == path || source.starts_with(path))
    }
    fn resolve_destination(&self, path: &Path, include_leaf: bool) -> Result<PathBuf, CopyError> {
        let mut current = path.to_owned();
        // Every redirect uses an already planned link; more redirects than
        // entries proves a cyclic logical destination rather than a package cycle.
        for _ in 0..=self.nodes.len() {
            let link = current
                .ancestors()
                .skip(usize::from(!include_leaf))
                .find_map(|ancestor| match self.nodes.get(ancestor) {
                    Some(Node::Link(target)) => Some((ancestor.to_owned(), target.clone())),
                    _ => None,
                });
            let Some((ancestor, target)) = link else {
                return Ok(current);
            };
            current = target.join(current.strip_prefix(&ancestor).unwrap());
        }
        Err(error(
            path,
            "plan",
            "cyclic logical resource destinations; repair the selected aliases",
        ))
    }
    fn mapped(&self, source: &Path) -> Result<Option<PathBuf>, CopyError> {
        for root in source.ancestors() {
            if let Some(destination) = self.mappings.get(root) {
                return self
                    .resolve_destination(
                        &destination.join(source.strip_prefix(root).unwrap()),
                        true,
                    )
                    .map(Some);
            }
        }
        Ok(None)
    }
    fn claim(&mut self, path: PathBuf, node: Node) -> Result<(), CopyError> {
        let path = self.resolve_destination(&path, false)?;
        let node = if let Node::Link(target) = node {
            let target = self.resolve_destination(&target, true)?;
            // A parent alias already exposes the physical child. Redundant
            // selections add no inode or duplicate byte charge.
            if target == path {
                return Ok(());
            }
            Node::Link(target)
        } else {
            node
        };
        if let Some(existing) = self.nodes.get(&path) {
            if existing == &node
                || matches!((existing,&node),(Node::Directory(a),Node::Directory(b)) if a.as_os_str().is_empty() || b.as_os_str().is_empty())
            {
                return Ok(());
            }
            return Err(error(
                &path,
                "plan",
                "incompatible selected destinations; select one coherent resource for this path",
            ));
        }
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            self.claim(parent.to_owned(), Node::Directory(PathBuf::new()))?;
        }
        let entries = (self.nodes.len() as u64)
            .checked_add(1)
            .ok_or_else(|| error(&path, "plan", "entry accounting overflow"))?;
        bound(&path, "entries", entries, self.limits.max_entries as u64)?;
        let source_bytes = match &node {
            Node::Directory(source) | Node::File(source, ..) | Node::Link(source) => {
                source.as_os_str().len() as u64
            }
        };
        self.metadata_bytes = self
            .metadata_bytes
            .checked_add(path.as_os_str().len() as u64)
            .and_then(|bytes| bytes.checked_add(source_bytes))
            .ok_or_else(|| error(&path, "plan", "resource metadata accounting overflow"))?;
        bound(
            &path,
            "metadata_bytes",
            self.metadata_bytes,
            MAX_METADATA_BYTES,
        )?;
        self.nodes.insert(path, node);
        Ok(())
    }
    fn add_mapping(&mut self, source: PathBuf, destination: PathBuf) -> Result<(), CopyError> {
        self.charge_metadata(
            &destination,
            source.as_os_str().len() as u64 + destination.as_os_str().len() as u64,
        )?;
        self.mappings.insert(source, destination);
        Ok(())
    }
    fn charge_metadata(&mut self, path: &Path, bytes: u64) -> Result<(), CopyError> {
        let observed = self
            .metadata_bytes
            .checked_add(bytes)
            .ok_or_else(|| error(path, "plan", "resource metadata accounting overflow"))?;
        bound(path, "metadata_bytes", observed, MAX_METADATA_BYTES)?;
        self.metadata_bytes = observed;
        Ok(())
    }
    fn enqueue(&mut self, source: PathBuf, path: PathBuf, depth: usize) -> Result<(), CopyError> {
        // Reserve before queue allocation. Excluded aliases never consume the
        // selected-resource entry budget or cause their bytes to be read.
        let canonical =
            fs::canonicalize(&source).map_err(|cause| io_error(&path, "resolve", cause))?;
        if self.excluded(&canonical) {
            return Ok(());
        }
        bound(
            &path,
            "entries",
            self.nodes
                .len()
                .checked_add(self.pending.len())
                .and_then(|count| count.checked_add(1))
                .ok_or_else(|| error(&path, "plan", "entry accounting overflow"))?
                as u64,
            self.limits.max_entries as u64,
        )?;
        self.charge_metadata(
            &path,
            source.as_os_str().len() as u64 + path.as_os_str().len() as u64,
        )?;
        self.pending.push_back((source, path, depth));
        Ok(())
    }
    fn directory_mapping(
        &mut self,
        source: &Path,
        destination: &Path,
        depth: usize,
    ) -> Result<(), CopyError> {
        if let Some(mapped) = self.mapped(source)? {
            if mapped != destination {
                self.claim(destination.to_owned(), Node::Link(mapped))?;
            }
            return Ok(());
        }
        self.add_mapping(source.to_owned(), destination.to_owned())?;
        self.enqueue(source.to_owned(), destination.to_owned(), depth)?;
        Ok(())
    }
    fn external_resource(
        &mut self,
        target: &Path,
        path: &Path,
        depth: usize,
    ) -> Result<PathBuf, CopyError> {
        if let Some(mapped) = self.mapped(target)? {
            return Ok(mapped);
        }
        let metadata =
            fs::metadata(target).map_err(|cause| io_error(path, "inspect_link_target", cause))?;
        let mut resource = target.to_owned();
        if metadata.is_file() {
            let parent = target.parent().ok_or_else(|| {
                error(path, "plan", "linked resource has no containing directory")
            })?;
            if matches!(
                target.extension().and_then(|ext| ext.to_str()),
                Some("js" | "mjs" | "cjs" | "ts" | "tsx")
            ) {
                resource = parent.to_owned();
            }
            for ancestor in parent.ancestors() {
                if self.account_home.as_deref() == Some(ancestor) {
                    break;
                }
                if ancestor.join("package.json").is_file() || ancestor.join("SKILL.md").is_file() {
                    resource = ancestor.to_owned();
                    break;
                }
                // Do not select arbitrary account HOME ancestors as resource units.
                if ancestor
                    .file_name()
                    .is_some_and(|name| name == "node_modules")
                {
                    break;
                }
            }
        }
        if resource == Path::new("/") || self.account_home.as_deref() == Some(resource.as_path()) {
            return Err(error(
                path,
                "select_resource_scope",
                "an external resource cannot infer the entire account home or filesystem root; select a complete resource/package directory with its own scope",
            ));
        }
        let destination = Path::new(".freshell/resources/tree")
            .join(resource.strip_prefix(Path::new("/")).unwrap_or(&resource));
        if metadata.is_file() && resource == target {
            self.add_mapping(target.to_owned(), destination.clone())?;
            self.enqueue(target.to_owned(), destination, depth)?;
        } else {
            self.directory_mapping(&resource, &destination, depth)?;
        }
        // Preserve installed lookup order by copying bounded node_modules units,
        // and package-scope metadata, with just the connecting ancestor skeleton.
        for ancestor in resource.parent().into_iter().flat_map(Path::ancestors) {
            if ancestor.as_os_str().is_empty() || ancestor == Path::new("/") {
                break;
            }
            let modules = ancestor.join("node_modules");
            if modules.is_dir() {
                let canonical = fs::canonicalize(&modules)
                    .map_err(|cause| io_error(path, "resolve_lookup_context", cause))?;
                let destination = Path::new(".freshell/resources/tree")
                    .join(modules.strip_prefix("/").unwrap_or(&modules));
                self.directory_mapping(&canonical, &destination, depth)?;
            }
            let package = ancestor.join("package.json");
            if package.is_file() {
                let canonical = fs::canonicalize(&package)
                    .map_err(|cause| io_error(path, "resolve_package_scope", cause))?;
                let destination = Path::new(".freshell/resources/tree")
                    .join(package.strip_prefix("/").unwrap_or(&package));
                if let Some(mapped) = self.mapped(&canonical)? {
                    if mapped != destination {
                        self.claim(destination, Node::Link(mapped))?;
                    }
                } else {
                    self.add_mapping(canonical.clone(), destination.clone())?;
                    self.enqueue(canonical, destination, depth)?;
                }
            }
            if self.account_home.as_deref() == Some(ancestor) {
                break;
            }
        }
        self.mapped(target)?.ok_or_else(|| {
            error(
                path,
                "plan",
                "linked resource has no coherent physical mapping",
            )
        })
    }
    fn select_linked_ancestors(
        &mut self,
        selection: &CopySelection,
        selections: &[&CopySelection],
        canonical: &Path,
    ) -> Result<(), CopyError> {
        for parent in selections {
            let Ok(tail) = selection
                .destination_relative
                .strip_prefix(&parent.destination_relative)
            else {
                continue;
            };
            if tail.as_os_str().is_empty() {
                continue;
            }
            if !fs::metadata(&parent.source).is_ok_and(|metadata| metadata.is_dir()) {
                continue;
            }
            let mut source = parent.source.clone();
            let mut destination = parent.destination_relative.clone();
            let parts = std::iter::once(None).chain(tail.components().map(Some));
            for part in parts {
                if let Some(part) = part {
                    source.push(part.as_os_str());
                    destination.push(part.as_os_str());
                }
                let Ok(metadata) = fs::symlink_metadata(&source) else {
                    break;
                };
                if !metadata.file_type().is_symlink() {
                    continue;
                }
                let target = fs::canonicalize(&source)
                    .map_err(|cause| io_error(&destination, "resolve_selected_alias", cause))?;
                if destination == selection.destination_relative && target != canonical {
                    continue;
                }
                if !fs::metadata(&target).is_ok_and(|metadata| metadata.is_dir()) {
                    continue;
                }
                if self.excluded(&target) {
                    return Err(error(
                        &destination,
                        "select",
                        "selected directory alias is excluded native state or a credential source",
                    ));
                }
                let mapped = self.external_resource(&target, &destination, 0)?;
                self.claim(destination.clone(), Node::Link(mapped))?;
            }
        }
        Ok(())
    }
    fn walk(&mut self, source: PathBuf, path: PathBuf, depth: usize) -> Result<(), CopyError> {
        let path = self.resolve_destination(&path, false)?;
        bound(&path, "depth", depth as u64, self.limits.max_depth as u64)?;
        let metadata =
            fs::symlink_metadata(&source).map_err(|cause| io_error(&path, "inspect", cause))?;
        let canonical =
            fs::canonicalize(&source).map_err(|cause| io_error(&path, "resolve", cause))?;
        if self.excluded(&canonical) {
            return Ok(());
        }
        if !metadata.file_type().is_symlink() {
            if let Some(mapped) = self.mapped(&canonical)? {
                if mapped != path {
                    return self.claim(path, Node::Link(mapped));
                }
            }
        }
        if metadata.file_type().is_symlink() {
            let target = self.external_resource(&canonical, &path, depth)?;
            return self.claim(path, Node::Link(target));
        }
        if metadata.is_dir() {
            self.claim(path.clone(), Node::Directory(canonical))?;
            let pending_start = self.pending.len();
            for entry in
                fs::read_dir(&source).map_err(|cause| io_error(&path, "read_directory", cause))?
            {
                let entry = entry.map_err(|cause| io_error(&path, "read_directory", cause))?;
                let child = path.join(entry.file_name());
                if !valid_relative(&child) {
                    return Err(error(
                        &child,
                        "plan",
                        "resource name is not a bounded normal relative path",
                    ));
                }
                self.enqueue(
                    entry.path(),
                    child,
                    depth
                        .checked_add(1)
                        .ok_or_else(|| error(&path, "plan", "depth accounting overflow"))?,
                )?;
            }
            self.pending.make_contiguous()[pending_start..].sort_by(|a, b| a.1.cmp(&b.1));
        } else if metadata.is_file() {
            bound(
                &path,
                "file_bytes",
                metadata.len(),
                self.limits.max_file_bytes,
            )?;
            if self.counted_files.insert(canonical.clone()) {
                self.bytes = self
                    .bytes
                    .checked_add(metadata.len())
                    .ok_or_else(|| error(&path, "plan", "regular-file byte accounting overflow"))?;
                bound(
                    &path,
                    "total_bytes",
                    self.bytes,
                    self.limits.max_total_bytes,
                )?;
            }
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode()
            };
            #[cfg(not(unix))]
            let mode = 0;
            self.claim(path, Node::File(canonical, mode, metadata.len()))?;
        } else {
            return Err(error(
                &path,
                "inspect",
                "selected resource must be a regular file, directory or resolvable symbolic link; replace the unsupported node",
            ));
        }
        Ok(())
    }
}
fn relative_link(from: &Path, to: &Path) -> PathBuf {
    let from = from.components().collect::<Vec<_>>();
    let to = to.components().collect::<Vec<_>>();
    let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
    let mut result = PathBuf::new();
    for _ in common..from.len() {
        result.push("..");
    }
    for part in &to[common..] {
        result.push(part.as_os_str());
    }
    if result.as_os_str().is_empty() {
        result.push(".");
    }
    result
}
fn mode(path: &Path, permissions: u32, relative: &Path) -> Result<(), CopyError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(permissions))
            .map_err(|cause| io_error(relative, "set_private_mode", cause))?;
    }
    #[cfg(not(unix))]
    let _ = (path, permissions, relative);
    Ok(())
}
struct TemporaryProjection(PathBuf);
impl TemporaryProjection {
    fn create(path: PathBuf) -> Result<Self, CopyError> {
        fs::create_dir(&path).map_err(|cause| io_error(Path::new(""), "create_stage", cause))?;
        let temporary = Self(path);
        mode(&temporary.0, 0o700, Path::new(""))?;
        Ok(temporary)
    }
}
impl Drop for TemporaryProjection {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

const STAGE_PREFIX: &str = ".freshell-copy-v1-";
const BACKUP_PREFIX: &str = ".freshell-copy-backups-v1-";
const OWNERSHIP_FILE: &str = ".freshell-owner-v1";
const OWNERSHIP_CONTENT: &[u8] = b"freshell-provider-publication-v1\n";
const JOURNAL_FILE: &str = ".manifest.json";
const JOURNAL_TEMP_FILE: &str = ".manifest.tmp";
const COMMITTED_FILE: &str = ".committed";
const COMMITTED_CONTENT: &[u8] = b"committed\n";
const CLEANUP_FILE: &str = ".cleanup-started";
const CLEANUP_TEMP_FILE: &str = ".cleanup-started.tmp";
const CLEANUP_CONTENT: &[u8] = b"cleanup-started\n";
const OLD_FILES_DIR: &str = ".old";
const MAX_JOURNAL_BYTES: u64 = 160 * 1024 * 1024;

#[cfg(test)]
thread_local! {
    static PUBLICATION_RECOVERY_EVENTS: std::cell::RefCell<Vec<serde_json::Value>> = const {
        std::cell::RefCell::new(Vec::new())
    };
    static PUBLICATION_JOURNAL_WRITES: std::cell::Cell<usize> = const {
        std::cell::Cell::new(0)
    };
    static PUBLICATION_JOURNAL_ENTRY_COMPARISONS: std::cell::Cell<usize> = const {
        std::cell::Cell::new(0)
    };
    static PUBLICATION_LEAF_JOURNAL_PATH_COMPARISONS: std::cell::Cell<usize> = const {
        std::cell::Cell::new(0)
    };
}

#[derive(Default)]
struct PublicationRecoveryReport {
    transactions: usize,
    committed: usize,
    rolled_back: usize,
    restored_paths: usize,
}

fn emit_publication_recovery_completed(report: &PublicationRecoveryReport) {
    let event = serde_json::json!({
        "severity": "info",
        "event": "provider.environment.recovery.completed",
        "status": "success",
        "transactions": report.transactions,
        "committed": report.committed,
        "rolled_back": report.rolled_back,
        "restored_paths": report.restored_paths,
    });
    #[cfg(test)]
    PUBLICATION_RECOVERY_EVENTS.with(|events| events.borrow_mut().push(event.clone()));
    eprintln!("{event}");
}

#[derive(Clone, Debug)]
enum PublicationJournalEntry {
    Leaf {
        relative: PathBuf,
        backup_id: usize,
        had_original: bool,
    },
    CreatedDirectory(PathBuf),
    Obsolete {
        relative: PathBuf,
        backup_id: usize,
    },
}

impl PartialEq for PublicationJournalEntry {
    fn eq(&self, other: &Self) -> bool {
        #[cfg(test)]
        PUBLICATION_JOURNAL_ENTRY_COMPARISONS.with(|comparisons| {
            comparisons.set(comparisons.get() + 1);
        });
        match (self, other) {
            (
                Self::Leaf {
                    relative: left_relative,
                    backup_id: left_backup_id,
                    had_original: left_had_original,
                },
                Self::Leaf {
                    relative: right_relative,
                    backup_id: right_backup_id,
                    had_original: right_had_original,
                },
            ) => {
                left_relative == right_relative
                    && left_backup_id == right_backup_id
                    && left_had_original == right_had_original
            }
            (Self::CreatedDirectory(left), Self::CreatedDirectory(right)) => left == right,
            (
                Self::Obsolete {
                    relative: left_relative,
                    backup_id: left_backup_id,
                },
                Self::Obsolete {
                    relative: right_relative,
                    backup_id: right_backup_id,
                },
            ) => left_relative == right_relative && left_backup_id == right_backup_id,
            _ => false,
        }
    }
}

impl Eq for PublicationJournalEntry {}

impl PartialOrd for PublicationJournalEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for PublicationJournalEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering;

        #[cfg(test)]
        PUBLICATION_JOURNAL_ENTRY_COMPARISONS.with(|comparisons| {
            comparisons.set(comparisons.get() + 1);
        });
        match (self, other) {
            (
                Self::Leaf {
                    relative: left_relative,
                    backup_id: left_backup_id,
                    had_original: left_had_original,
                },
                Self::Leaf {
                    relative: right_relative,
                    backup_id: right_backup_id,
                    had_original: right_had_original,
                },
            ) => left_relative
                .cmp(right_relative)
                .then_with(|| left_backup_id.cmp(right_backup_id))
                .then_with(|| left_had_original.cmp(right_had_original)),
            (Self::CreatedDirectory(left), Self::CreatedDirectory(right)) => left.cmp(right),
            (
                Self::Obsolete {
                    relative: left_relative,
                    backup_id: left_backup_id,
                },
                Self::Obsolete {
                    relative: right_relative,
                    backup_id: right_backup_id,
                },
            ) => left_relative
                .cmp(right_relative)
                .then_with(|| left_backup_id.cmp(right_backup_id)),
            (Self::Leaf { .. }, _) => Ordering::Less,
            (Self::CreatedDirectory(_), Self::Leaf { .. }) => Ordering::Greater,
            (Self::CreatedDirectory(_), Self::Obsolete { .. }) => Ordering::Less,
            (Self::Obsolete { .. }, _) => Ordering::Greater,
        }
    }
}

fn publication_paths(
    parent: &Path,
    destination_root: &Path,
    existing_root: bool,
) -> Result<(TemporaryProjection, Option<TemporaryProjection>), CopyError> {
    loop {
        let suffix = format!(
            "{}-{}",
            std::process::id(),
            NEXT_PROJECTION.fetch_add(1, Ordering::Relaxed)
        );
        let stage_path = parent.join(format!("{STAGE_PREFIX}{suffix}"));
        let backup_path = destination_root.join(format!("{BACKUP_PREFIX}{suffix}"));
        if path_exists(&stage_path)? || (existing_root && path_exists(&backup_path)?) {
            continue;
        }

        let stage = TemporaryProjection::create(stage_path)?;
        let backup = if existing_root {
            let backup = TemporaryProjection::create(backup_path)?;
            write_publication_owner_marker(destination_root, &backup.0)?;
            Some(backup)
        } else {
            None
        };
        return Ok((stage, backup));
    }
}

fn path_exists(path: &Path) -> Result<bool, CopyError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(cause) => Err(io_error(Path::new(""), "inspect_publication_path", cause)),
    }
}

fn encode_relative_path(path: &Path) -> Result<String, CopyError> {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes()
    };
    #[cfg(not(unix))]
    let bytes = path
        .to_str()
        .ok_or_else(|| {
            error(
                path,
                "write_journal",
                "path is not representable in the journal",
            )
        })?
        .as_bytes();

    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}")
            .map_err(|_| error(path, "write_journal", "could not encode journal path"))?;
    }
    Ok(encoded)
}

fn decode_relative_path(encoded: &str) -> Option<PathBuf> {
    if encoded.len() % 2 != 0 {
        return None;
    }
    let mut bytes = Vec::with_capacity(encoded.len() / 2);
    for pair in encoded.as_bytes().chunks_exact(2) {
        let high = (pair[0] as char).to_digit(16)? as u8;
        let low = (pair[1] as char).to_digit(16)? as u8;
        bytes.push((high << 4) | low);
    }
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Some(PathBuf::from(std::ffi::OsStr::from_bytes(&bytes)))
    }
    #[cfg(not(unix))]
    {
        String::from_utf8(bytes).ok().map(PathBuf::from)
    }
}

fn journal_entry_value(entry: &PublicationJournalEntry) -> Result<serde_json::Value, CopyError> {
    match entry {
        PublicationJournalEntry::Leaf {
            relative,
            backup_id,
            had_original,
        } => Ok(serde_json::json!({
            "kind": "leaf",
            "pathHex": encode_relative_path(relative)?,
            "backupId": backup_id,
            "hadOriginal": had_original,
        })),
        PublicationJournalEntry::CreatedDirectory(path) => Ok(serde_json::json!({
            "kind": "created_directory",
            "pathHex": encode_relative_path(path)?,
        })),
        PublicationJournalEntry::Obsolete {
            relative,
            backup_id,
        } => Ok(serde_json::json!({
            "kind": "obsolete",
            "pathHex": encode_relative_path(relative)?,
            "backupId": backup_id,
        })),
    }
}

fn write_publication_journal(
    destination_root: &Path,
    backup_root: &Path,
    entries: &[PublicationJournalEntry],
) -> Result<(), CopyError> {
    let entries = entries
        .iter()
        .map(journal_entry_value)
        .collect::<Result<Vec<_>, _>>()?;
    let bytes = serde_json::to_vec(&serde_json::json!({ "version": 1, "entries": entries }))
        .map_err(|_| {
            error(
                Path::new(""),
                "write_journal",
                "could not encode publication journal",
            )
        })?;
    if bytes.len() as u64 > MAX_JOURNAL_BYTES {
        return Err(error(
            Path::new(""),
            "write_journal",
            "publication journal exceeds its size limit",
        ));
    }
    #[cfg(test)]
    PUBLICATION_JOURNAL_WRITES.with(|writes| writes.set(writes.get() + 1));
    let temporary = backup_root.join(JOURNAL_TEMP_FILE);
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|cause| io_error(Path::new(""), "create_journal", cause))?;
    file.write_all(&bytes)
        .map_err(|cause| io_error(Path::new(""), "write_journal", cause))?;
    file.sync_all()
        .map_err(|cause| io_error(Path::new(""), "sync_journal", cause))?;
    drop(file);
    fs::rename(&temporary, backup_root.join(JOURNAL_FILE))
        .map_err(|cause| io_error(Path::new(""), "publish_journal", cause))?;
    sync_directory_chain(destination_root, backup_root)
}

fn sync_directory_chain(root: &Path, directory: &Path) -> Result<(), CopyError> {
    let mut current = directory;
    loop {
        File::open(current)
            .and_then(|handle| handle.sync_all())
            .map_err(|cause| io_error(Path::new(""), "sync_publication", cause))?;
        if current == root {
            return Ok(());
        }
        current = current.parent().ok_or_else(|| {
            error(
                Path::new(""),
                "sync_publication",
                "publication directory escaped its root",
            )
        })?;
        if !current.starts_with(root) {
            return Err(error(
                Path::new(""),
                "sync_publication",
                "publication directory escaped its root",
            ));
        }
    }
}

fn read_publication_journal(path: &Path) -> Result<Vec<PublicationJournalEntry>, CopyError> {
    let metadata =
        fs::metadata(path).map_err(|cause| io_error(Path::new(""), "read_journal", cause))?;
    if metadata.len() > MAX_JOURNAL_BYTES {
        return Err(error(
            Path::new(""),
            "read_journal",
            "publication journal exceeds its size limit",
        ));
    }
    let bytes = fs::read(path).map_err(|cause| io_error(Path::new(""), "read_journal", cause))?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).map_err(|_| {
        error(
            Path::new(""),
            "read_journal",
            "publication journal is invalid",
        )
    })?;
    if value.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err(error(
            Path::new(""),
            "read_journal",
            "publication journal version is unsupported",
        ));
    }
    let entries = value
        .get("entries")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            error(
                Path::new(""),
                "read_journal",
                "publication journal has no entries",
            )
        })?;
    let mut result = Vec::with_capacity(entries.len());
    for entry in entries {
        let kind = entry
            .get("kind")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                error(
                    Path::new(""),
                    "read_journal",
                    "publication journal entry is invalid",
                )
            })?;
        let encoded_path = entry
            .get("pathHex")
            .and_then(serde_json::Value::as_str)
            .ok_or_else(|| {
                error(
                    Path::new(""),
                    "read_journal",
                    "publication journal path is invalid",
                )
            })?;
        let path = decode_relative_path(encoded_path)
            .filter(|path| valid_relative(path))
            .ok_or_else(|| {
                error(
                    Path::new(""),
                    "read_journal",
                    "publication journal path is unsafe",
                )
            })?;
        result.push(match kind {
            "leaf" => PublicationJournalEntry::Leaf {
                relative: path,
                backup_id: entry
                    .get("backupId")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                    .ok_or_else(|| {
                        error(
                            Path::new(""),
                            "read_journal",
                            "publication backup reference is invalid",
                        )
                    })?,
                had_original: entry
                    .get("hadOriginal")
                    .and_then(serde_json::Value::as_bool)
                    .ok_or_else(|| {
                        error(
                            Path::new(""),
                            "read_journal",
                            "publication prior-state flag is invalid",
                        )
                    })?,
            },
            "created_directory" => PublicationJournalEntry::CreatedDirectory(path),
            "obsolete" => PublicationJournalEntry::Obsolete {
                relative: path,
                backup_id: entry
                    .get("backupId")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|value| usize::try_from(value).ok())
                    .ok_or_else(|| {
                        error(
                            Path::new(""),
                            "read_journal",
                            "publication backup reference is invalid",
                        )
                    })?,
            },
            _ => {
                return Err(error(
                    Path::new(""),
                    "read_journal",
                    "publication journal entry kind is unknown",
                ));
            }
        });
    }
    Ok(result)
}

fn backup_path(backup_root: &Path, backup_id: usize) -> PathBuf {
    backup_root.join(OLD_FILES_DIR).join(backup_id.to_string())
}

fn write_publication_owner_marker(
    destination_root: &Path,
    backup_root: &Path,
) -> Result<(), CopyError> {
    let path = backup_root.join(OWNERSHIP_FILE);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .map_err(|cause| io_error(Path::new(""), "create_publication_owner", cause))?;
    file.write_all(OWNERSHIP_CONTENT)
        .map_err(|cause| io_error(Path::new(""), "write_publication_owner", cause))?;
    file.sync_all()
        .map_err(|cause| io_error(Path::new(""), "sync_publication_owner", cause))?;
    sync_directory_chain(destination_root, backup_root)
}

fn has_publication_owner_marker(backup_root: &Path) -> Result<bool, CopyError> {
    let path = backup_root.join(OWNERSHIP_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(cause) => return Err(io_error(Path::new(""), "inspect_publication_owner", cause)),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Ok(false);
    }
    let bytes = fs::read(&path)
        .map_err(|cause| io_error(Path::new(""), "read_publication_owner", cause))?;
    Ok(bytes == OWNERSHIP_CONTENT)
}

fn remove_if_present(path: &Path) -> Result<(), CopyError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            fs::remove_dir_all(path)
                .map_err(|cause| io_error(Path::new(""), "remove_recovery_artifact", cause))
        }
        Ok(_) => fs::remove_file(path)
            .map_err(|cause| io_error(Path::new(""), "remove_recovery_artifact", cause)),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(cause) => Err(io_error(Path::new(""), "inspect_recovery_artifact", cause)),
    }
}

fn cleanup_committed_publication_with_hook(
    destination_root: &Path,
    stage_root: &Path,
    backup_root: &Path,
    after_rollback_disarmed: impl FnOnce() -> Result<(), CopyError>,
) -> Result<(), CopyError> {
    write_publication_cleanup_marker(destination_root, backup_root)?;
    after_rollback_disarmed()?;

    // The cleanup marker makes the commit decision durable before the commit
    // marker or the rollback journal can disappear. A crash during recursive
    // cleanup can therefore never make recovery mistake committed output for
    // an unfinished publication.
    remove_if_present(&backup_root.join(JOURNAL_FILE))?;
    remove_if_present(&backup_root.join(JOURNAL_TEMP_FILE))?;
    sync_directory_chain(destination_root, backup_root)?;
    remove_if_present(&backup_root.join(CLEANUP_TEMP_FILE))?;
    remove_if_present(stage_root)?;
    remove_if_present(backup_root)?;
    sync_directory_chain(destination_root, destination_root)
}

fn write_publication_cleanup_marker(
    destination_root: &Path,
    backup_root: &Path,
) -> Result<(), CopyError> {
    let temporary = backup_root.join(CLEANUP_TEMP_FILE);
    let path = backup_root.join(CLEANUP_FILE);
    if has_publication_cleanup_marker(backup_root)? {
        return sync_directory_chain(destination_root, backup_root);
    }
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|cause| io_error(Path::new(""), "create_publication_cleanup", cause))?;
    file.write_all(CLEANUP_CONTENT)
        .map_err(|cause| io_error(Path::new(""), "write_publication_cleanup", cause))?;
    file.sync_all()
        .map_err(|cause| io_error(Path::new(""), "sync_publication_cleanup", cause))?;
    drop(file);
    if let Err(cause) = fs::rename(&temporary, &path) {
        if has_publication_cleanup_marker(backup_root)? {
            remove_if_present(&temporary)?;
            return sync_directory_chain(destination_root, backup_root);
        }
        return Err(io_error(
            Path::new(""),
            "publish_publication_cleanup",
            cause,
        ));
    }
    sync_directory_chain(destination_root, backup_root)
}

fn has_publication_cleanup_marker(backup_root: &Path) -> Result<bool, CopyError> {
    let path = backup_root.join(CLEANUP_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(cause) => {
            return Err(io_error(
                Path::new(""),
                "inspect_publication_cleanup",
                cause,
            ))
        }
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(error(
            Path::new(""),
            "recover_publication",
            "publication cleanup marker is invalid",
        ));
    }
    let bytes = fs::read(&path)
        .map_err(|cause| io_error(Path::new(""), "read_publication_cleanup", cause))?;
    if bytes != CLEANUP_CONTENT {
        return Err(error(
            Path::new(""),
            "recover_publication",
            "publication cleanup marker is invalid",
        ));
    }
    Ok(true)
}

fn cleanup_committed_publication(
    destination_root: &Path,
    stage_root: &Path,
    backup_root: &Path,
) -> Result<(), CopyError> {
    cleanup_committed_publication_with_hook(destination_root, stage_root, backup_root, || Ok(()))
}

fn remove_recovered_leaf(path: &Path) -> Result<(), CopyError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => Err(error(
            path,
            "recover_publication",
            "journal leaf unexpectedly resolves to a directory",
        )),
        Ok(_) => {
            fs::remove_file(path).map_err(|cause| io_error(path, "remove_recovered_leaf", cause))
        }
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(cause) => Err(io_error(path, "inspect_recovered_leaf", cause)),
    }
}

fn validate_recovery_parent_directories(
    destination_root: &Path,
    relative: &Path,
) -> Result<Option<PathBuf>, CopyError> {
    let destination = destination_root.join(relative);
    let parent = destination.parent().ok_or_else(|| {
        error(
            relative,
            "recover_publication",
            "journal destination has no parent",
        )
    })?;
    let components = relative
        .parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .filter(|path| !path.as_os_str().is_empty())
        .collect::<Vec<_>>();
    for component in components.into_iter().rev() {
        match fs::symlink_metadata(destination_root.join(component)) {
            Ok(parent_metadata)
                if parent_metadata.is_dir() && !parent_metadata.file_type().is_symlink() => {}
            Ok(_) => {
                return Err(error(
                    relative,
                    "recover_publication",
                    "journal parent is not a physical directory",
                ));
            }
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(cause) => {
                return Err(io_error(relative, "inspect_recovery_parent", cause));
            }
        }
    }
    Ok(Some(parent.to_owned()))
}

fn has_publication_committed_marker(backup_root: &Path) -> Result<bool, CopyError> {
    let path = backup_root.join(COMMITTED_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(cause) => {
            return Err(io_error(Path::new(""), "inspect_publication_commit", cause));
        }
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(error(
            Path::new(""),
            "recover_publication",
            "publication commit marker is invalid",
        ));
    }
    let bytes = fs::read(&path)
        .map_err(|cause| io_error(Path::new(""), "read_publication_commit", cause))?;
    if bytes != COMMITTED_CONTENT {
        return Err(error(
            Path::new(""),
            "recover_publication",
            "publication commit marker is invalid",
        ));
    }
    Ok(true)
}

fn recover_interrupted_publications(
    destination_root: &Path,
) -> Result<PublicationRecoveryReport, CopyError> {
    let mut report = PublicationRecoveryReport::default();
    let mut transactions = Vec::new();
    for entry in fs::read_dir(destination_root)
        .map_err(|cause| io_error(Path::new(""), "list_publication_transactions", cause))?
    {
        let entry = entry
            .map_err(|cause| io_error(Path::new(""), "list_publication_transactions", cause))?;
        let path = entry.path();
        if path
            .file_name()
            .and_then(std::ffi::OsStr::to_str)
            .is_some_and(|name| name.starts_with(BACKUP_PREFIX))
        {
            transactions.push(path);
        }
    }
    transactions.sort();
    for backup_root in transactions {
        let metadata = fs::symlink_metadata(&backup_root)
            .map_err(|cause| io_error(Path::new(""), "inspect_publication_transaction", cause))?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            continue;
        }
        if !has_publication_owner_marker(&backup_root)? {
            continue;
        }
        report.transactions += 1;
        let name = backup_root
            .file_name()
            .and_then(std::ffi::OsStr::to_str)
            .ok_or_else(|| {
                error(
                    Path::new(""),
                    "recover_publication",
                    "publication transaction name is invalid",
                )
            })?;
        let suffix = name.strip_prefix(BACKUP_PREFIX).ok_or_else(|| {
            error(
                Path::new(""),
                "recover_publication",
                "publication transaction name is invalid",
            )
        })?;
        let stage_root = destination_root.join(format!("{STAGE_PREFIX}{suffix}"));
        let cleanup_marker = has_publication_cleanup_marker(&backup_root)?;
        let committed = cleanup_marker || has_publication_committed_marker(&backup_root)?;
        if committed {
            cleanup_committed_publication(destination_root, &stage_root, &backup_root)?;
            report.committed += 1;
            continue;
        }

        let journal_path = backup_root.join(JOURNAL_FILE);
        let entries = match fs::symlink_metadata(&journal_path) {
            Ok(_) => read_publication_journal(&journal_path)?,
            // The journal is atomically installed before any destination path
            // changes, so a transaction without it has nothing to roll back.
            Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(cause) => {
                return Err(io_error(
                    Path::new(""),
                    "inspect_publication_journal",
                    cause,
                ));
            }
        };

        let mut created_directories = Vec::new();
        for entry in &entries {
            match entry {
                PublicationJournalEntry::CreatedDirectory(relative) => {
                    created_directories.push(relative.clone());
                }
                PublicationJournalEntry::Leaf {
                    relative,
                    backup_id,
                    ..
                }
                | PublicationJournalEntry::Obsolete {
                    relative,
                    backup_id,
                } => {
                    let had_original = match entry {
                        PublicationJournalEntry::Leaf { had_original, .. } => *had_original,
                        PublicationJournalEntry::Obsolete { .. } => true,
                        PublicationJournalEntry::CreatedDirectory(_) => unreachable!(),
                    };
                    let destination = destination_root.join(relative);
                    let backup = backup_path(&backup_root, *backup_id);
                    match fs::symlink_metadata(&backup) {
                        Ok(backup_metadata) => {
                            let parent =
                                validate_recovery_parent_directories(destination_root, relative)?
                                    .ok_or_else(|| {
                                    error(
                                        relative,
                                        "recover_publication",
                                        "journal parent is missing",
                                    )
                                })?;
                            match fs::symlink_metadata(&destination) {
                                Ok(destination_metadata)
                                    if matches!(
                                        entry,
                                        PublicationJournalEntry::Obsolete { .. }
                                    ) || (destination_metadata.is_dir()
                                        && !destination_metadata.file_type().is_symlink())
                                        || (backup_metadata.is_dir()
                                            && !backup_metadata.file_type().is_symlink()) =>
                                {
                                    return Err(error(
                                        relative,
                                        "recover_publication",
                                        "recovery destination conflicts with retained data",
                                    ));
                                }
                                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
                                Err(cause) => {
                                    return Err(io_error(
                                        relative,
                                        "inspect_recovery_destination",
                                        cause,
                                    ));
                                }
                                _ => {}
                            }
                            fs::rename(&backup, &destination).map_err(|cause| {
                                io_error(relative, "restore_recovery_backup", cause)
                            })?;
                            report.restored_paths += 1;
                            sync_directory_chain(destination_root, &parent)?;
                        }
                        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
                            if matches!(entry, PublicationJournalEntry::Leaf { .. })
                                && !had_original
                            {
                                match fs::symlink_metadata(stage_root.join(relative)) {
                                    Ok(_) => {}
                                    Err(stage_error)
                                        if stage_error.kind() == std::io::ErrorKind::NotFound =>
                                    {
                                        if validate_recovery_parent_directories(
                                            destination_root,
                                            relative,
                                        )?
                                        .is_some()
                                        {
                                            remove_recovered_leaf(&destination)?;
                                        }
                                    }
                                    Err(stage_error) => {
                                        return Err(io_error(
                                            relative,
                                            "inspect_recovery_stage",
                                            stage_error,
                                        ));
                                    }
                                }
                            }
                        }
                        Err(cause) => {
                            return Err(io_error(relative, "inspect_recovery_backup", cause));
                        }
                    }
                }
            }
        }
        created_directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
        for relative in created_directories {
            let path = destination_root.join(relative);
            match fs::symlink_metadata(&path) {
                Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
                    match fs::remove_dir(&path) {
                        Ok(()) => {}
                        Err(cause) if cause.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
                        Err(cause) => {
                            return Err(io_error(
                                Path::new(""),
                                "remove_recovered_directory",
                                cause,
                            ));
                        }
                    }
                }
                Ok(_) => {
                    return Err(error(
                        Path::new(""),
                        "recover_publication",
                        "journal directory conflicts with a non-directory",
                    ));
                }
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
                Err(cause) => {
                    return Err(io_error(
                        Path::new(""),
                        "inspect_recovered_directory",
                        cause,
                    ));
                }
            }
        }
        sync_directory_chain(destination_root, destination_root)?;
        remove_if_present(&stage_root)?;
        remove_if_present(&backup_root)?;
        sync_directory_chain(destination_root, destination_root)?;
        report.rolled_back += 1;
    }
    if report.transactions > 0 {
        emit_publication_recovery_completed(&report);
    }
    Ok(report)
}

/// Recover owned provider HOME publications before reading projection metadata.
/// An absent HOME is already clean; an existing non-directory root is unsafe.
pub fn recover_environment(destination_root: &Path) -> Result<(), CopyError> {
    match fs::symlink_metadata(destination_root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            recover_interrupted_publications(destination_root)?;
            Ok(())
        }
        Ok(_) => Err(error(
            Path::new(""),
            "recover_publication",
            "destination root must be a physical directory",
        )),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(cause) => Err(io_error(Path::new(""), "inspect_destination", cause)),
    }
}

impl Publication {
    fn record_journal_entries(
        &mut self,
        destination_root: &Path,
        entries: &[PublicationJournalEntry],
    ) -> Result<(), CopyError> {
        let mut known_entries = self
            .journal_entries
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>();
        let mut changed = false;
        for entry in entries {
            if known_entries.insert(entry.clone()) {
                self.journal_entries.push(entry.clone());
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        write_publication_journal(destination_root, &self.backup.0, &self.journal_entries)
    }

    fn set_leaf_had_original(
        &mut self,
        destination_root: &Path,
        relative: &Path,
        leaf_journal_indices: &[usize],
        had_original: bool,
    ) -> Result<(), CopyError> {
        let index_position = leaf_journal_indices
            .binary_search_by(|journal_index| {
                #[cfg(test)]
                PUBLICATION_LEAF_JOURNAL_PATH_COMPARISONS.with(|comparisons| {
                    comparisons.set(comparisons.get() + 1);
                });
                let PublicationJournalEntry::Leaf {
                    relative: journal_relative,
                    ..
                } = &self.journal_entries[*journal_index]
                else {
                    unreachable!("leaf journal index contains only leaves")
                };
                journal_relative.as_path().cmp(relative)
            })
            .map_err(|_| {
                error(
                    relative,
                    "write_journal",
                    "published leaf is absent from the journal",
                )
            })?;
        let entry_index = leaf_journal_indices[index_position];
        let entry = &mut self.journal_entries[entry_index];
        if let PublicationJournalEntry::Leaf {
            had_original: previous,
            ..
        } = entry
        {
            if *previous == had_original {
                return Ok(());
            }
            *previous = had_original;
        }
        write_publication_journal(destination_root, &self.backup.0, &self.journal_entries)
    }

    fn write_committed_marker(&self, destination_root: &Path) -> Result<(), CopyError> {
        let temporary = self.backup.0.join(format!("{COMMITTED_FILE}.tmp"));
        let path = self.backup.0.join(COMMITTED_FILE);
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)
            .map_err(|cause| io_error(Path::new(""), "create_publication_commit", cause))?;
        file.write_all(COMMITTED_CONTENT)
            .map_err(|cause| io_error(Path::new(""), "write_publication_commit", cause))?;
        file.sync_all()
            .map_err(|cause| io_error(Path::new(""), "sync_publication_commit", cause))?;
        drop(file);
        fs::rename(&temporary, &path)
            .map_err(|cause| io_error(Path::new(""), "publish_publication_commit", cause))?;
        sync_directory_chain(destination_root, &self.backup.0)
    }
}

/// Removal authority covers only inodes created by this attempt. A hard link
/// keeps each replaced provider inode available for rollback until commit.
struct Publication {
    backup: TemporaryProjection,
    created: Vec<PathBuf>,
    replaced: Vec<(PathBuf, PathBuf)>,
    journal_entries: Vec<PublicationJournalEntry>,
    next_backup_id: usize,
    committed: bool,
}
impl Drop for Publication {
    fn drop(&mut self) {
        if self.committed {
            let cleanup = (|| {
                let root = self.backup.0.parent().ok_or_else(|| {
                    error(
                        Path::new(""),
                        "cleanup_committed_publication",
                        "publication transaction has no parent",
                    )
                })?;
                let name = self
                    .backup
                    .0
                    .file_name()
                    .and_then(std::ffi::OsStr::to_str)
                    .ok_or_else(|| {
                        error(
                            Path::new(""),
                            "cleanup_committed_publication",
                            "publication transaction name is invalid",
                        )
                    })?;
                let suffix = name.strip_prefix(BACKUP_PREFIX).ok_or_else(|| {
                    error(
                        Path::new(""),
                        "cleanup_committed_publication",
                        "publication transaction name is invalid",
                    )
                })?;
                let stage_root = root.join(format!("{STAGE_PREFIX}{suffix}"));
                cleanup_committed_publication(root, &stage_root, &self.backup.0)
            })();
            if let Err(cause) = cleanup {
                eprintln!(
                    "{}",
                    serde_json::json!({"severity":"error","event":"provider.environment.cleanup.failed","operation":cause.operation,"relative_path":cause.relative_path,"corrective_message":cause.corrective_message})
                );
            }
            // Do not let TemporaryProjection::drop use an unjournaled recursive
            // delete after a cleanup error. Recovery can safely retry later.
            self.backup.0 = PathBuf::new();
            return;
        }
        for path in self.created.iter().rev() {
            if let Ok(stat) = fs::symlink_metadata(path) {
                let result = if stat.is_dir() {
                    fs::remove_dir(path)
                } else {
                    fs::remove_file(path)
                };
                if let Err(cause) = result {
                    eprintln!(
                        "{}",
                        serde_json::json!({"severity":"error","event":"provider.environment.rollback.failed","operation":"remove_created","error_kind":format!("{:?}",cause.kind()),"os_error":cause.raw_os_error()})
                    );
                }
            }
        }
        let mut failed = false;
        for (destination, backup) in self.replaced.iter().rev() {
            if let Err(cause) = fs::rename(backup, destination) {
                failed = true;
                eprintln!(
                    "{}",
                    serde_json::json!({"severity":"error","event":"provider.environment.rollback.failed","operation":"restore_replacement","error_kind":format!("{:?}",cause.kind()),"os_error":cause.raw_os_error()})
                );
            }
        }
        if failed {
            // Never erase the last original inode after a rollback failure.
            self.backup.0 = PathBuf::new();
        }
    }
}
/// A bounded HOME publication retains prior inodes until all associated
/// projection operations succeed. Dropping an unfinished attempt restores them.
pub struct EnvironmentPublication {
    report: CopyReport,
    root: PathBuf,
    rollback: Option<Publication>,
    unfinished_new_root: bool,
    _stage: TemporaryProjection,
}
impl Drop for EnvironmentPublication {
    fn drop(&mut self) {
        if !self.unfinished_new_root {
            return;
        }
        for relative in self.report.projected_paths.iter().rev() {
            let path = self.root.join(relative);
            if let Ok(metadata) = fs::symlink_metadata(&path) {
                if metadata.is_dir() && !metadata.file_type().is_symlink() {
                    let _ = fs::remove_dir(&path);
                } else {
                    let _ = fs::remove_file(&path);
                }
            }
        }
        // A concurrently added sibling keeps the new directory intact.
        let _ = fs::remove_dir(&self.root);
    }
}
impl EnvironmentPublication {
    pub fn remove_obsolete(&mut self, relative: &Path) -> Result<(), CopyError> {
        self.remove_obsolete_batch(&[relative.to_owned()])
    }

    /// Retain a set of stale managed paths under one durable journal update.
    /// Paths are removed deepest-first and recorded parent-first so recovery
    /// can rebuild a removed directory before restoring its children.
    pub fn remove_obsolete_batch(&mut self, relatives: &[PathBuf]) -> Result<(), CopyError> {
        struct Candidate {
            relative: PathBuf,
            path: PathBuf,
            backup_id: usize,
        }

        let mut unique = BTreeSet::new();
        for relative in relatives {
            if !valid_relative(relative) {
                return Err(error(
                    relative,
                    "remove_obsolete",
                    "projection path is unsafe",
                ));
            }
            unique.insert(relative.clone());
        }
        let mut ordered = unique.into_iter().collect::<Vec<_>>();
        ordered.sort_by(|left, right| {
            right
                .components()
                .count()
                .cmp(&left.components().count())
                .then_with(|| left.cmp(right))
        });

        let mut candidates = Vec::new();
        let mut scheduled = BTreeSet::new();
        let mut next_backup_id = self
            .rollback
            .as_ref()
            .map(|publication| publication.next_backup_id)
            .unwrap_or_default();
        for relative in ordered {
            let path = self.root.join(&relative);
            let mut missing_parent = false;
            for parent in relative
                .parent()
                .into_iter()
                .flat_map(Path::ancestors)
                .filter(|path| !path.as_os_str().is_empty())
            {
                let stat = match fs::symlink_metadata(self.root.join(parent)) {
                    Ok(stat) => stat,
                    Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {
                        missing_parent = true;
                        break;
                    }
                    Err(cause) => return Err(io_error(&relative, "inspect_obsolete", cause)),
                };
                if !stat.is_dir() || stat.file_type().is_symlink() {
                    return Err(error(
                        &relative,
                        "remove_obsolete",
                        "projection parent must be a physical directory",
                    ));
                }
            }
            if missing_parent {
                continue;
            }
            let stat = match fs::symlink_metadata(&path) {
                Ok(stat) => stat,
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => continue,
                Err(cause) => return Err(io_error(&relative, "inspect_obsolete", cause)),
            };
            if stat.is_dir() && !stat.file_type().is_symlink() {
                let mut empty_after_scheduled_removals = true;
                for entry in fs::read_dir(&path)
                    .map_err(|cause| io_error(&relative, "inspect_obsolete", cause))?
                {
                    let entry =
                        entry.map_err(|cause| io_error(&relative, "inspect_obsolete", cause))?;
                    if !scheduled.contains(&relative.join(entry.file_name())) {
                        empty_after_scheduled_removals = false;
                        break;
                    }
                }
                if !empty_after_scheduled_removals {
                    continue;
                }
            }
            let backup_id = next_backup_id;
            next_backup_id = backup_id
                .checked_add(1)
                .ok_or_else(|| error(&relative, "remove_obsolete", "backup id overflow"))?;
            candidates.push(Candidate {
                relative: relative.clone(),
                path,
                backup_id,
            });
            scheduled.insert(relative);
        }
        if candidates.is_empty() {
            return Ok(());
        }

        let publication = self.rollback.as_mut().ok_or_else(|| {
            error(
                &candidates[0].relative,
                "remove_obsolete",
                "new root has no previous projection",
            )
        })?;
        // Reserve the complete range before journaling it. A partial move can
        // fail after any candidate, and a later removal must not reuse an ID
        // already assigned to a still-pending journal entry.
        publication.next_backup_id = next_backup_id;
        let journal_entries = candidates
            .iter()
            .rev()
            .map(|candidate| PublicationJournalEntry::Obsolete {
                relative: candidate.relative.clone(),
                backup_id: candidate.backup_id,
            })
            .collect::<Vec<_>>();
        publication.record_journal_entries(&self.root, &journal_entries)?;

        for candidate in &candidates {
            let backup = backup_path(&publication.backup.0, candidate.backup_id);
            let backup_parent = backup.parent().ok_or_else(|| {
                error(
                    &candidate.relative,
                    "retain_obsolete",
                    "backup path has no parent",
                )
            })?;
            fs::create_dir_all(backup_parent).map_err(|cause| {
                io_error(&candidate.relative, "create_obsolete_backup_parent", cause)
            })?;
            fs::rename(&candidate.path, &backup)
                .map_err(|cause| io_error(&candidate.relative, "retain_obsolete", cause))?;
            publication
                .replaced
                .push((candidate.path.clone(), backup.clone()));
            if let Some(parent) = candidate.path.parent() {
                sync_directory_chain(&self.root, parent)?;
            }
            sync_directory_chain(&self.root, backup_parent)?;
        }
        Ok(())
    }
    pub fn created_paths(&self) -> &[PathBuf] {
        &self.report.created_paths
    }
    pub fn commit(mut self) -> Result<CopyReport, CopyError> {
        File::open(&self.root)
            .and_then(|directory| directory.sync_all())
            .map_err(|cause| io_error(Path::new(""), "sync_publication", cause))?;
        if let Some(publication) = self.rollback.as_mut() {
            publication.write_committed_marker(&self.root)?;
            publication.committed = true;
        }
        self.unfinished_new_root = false;
        Ok(std::mem::replace(
            &mut self.report,
            CopyReport {
                entries: 0,
                bytes: 0,
                projected_paths: Vec::new(),
                created_paths: Vec::new(),
            },
        ))
    }
}

pub fn stage_environment_with_publication(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    limits: CopyLimits,
    publish: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<EnvironmentPublication, CopyError> {
    let account_home = std::env::var_os("HOME").and_then(|home| fs::canonicalize(home).ok());
    stage_environment_with_publisher(
        selections,
        destination_root,
        excluded_canonical_sources,
        limits,
        account_home,
        publish,
    )
}
pub fn stage_environment(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    limits: CopyLimits,
) -> Result<EnvironmentPublication, CopyError> {
    let account_home = std::env::var_os("HOME").and_then(|home| fs::canonicalize(home).ok());
    stage_environment_with_publisher(
        selections,
        destination_root,
        excluded_canonical_sources,
        limits,
        account_home,
        |source, destination| fs::rename(source, destination),
    )
}
static NEXT_PROJECTION: AtomicU64 = AtomicU64::new(0);

/// Plans the complete physical graph first; rejected selections cannot publish
/// partial environments. Only selected resources and their dependency closure
/// are read. Originals, credentials and provider-owned siblings remain intact.
pub fn copy_environment(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    limits: CopyLimits,
) -> Result<CopyReport, CopyError> {
    let account_home = std::env::var_os("HOME").and_then(|home| fs::canonicalize(home).ok());
    copy_environment_with_account_home(
        selections,
        destination_root,
        excluded_canonical_sources,
        limits,
        account_home,
    )
}
fn copy_environment_with_account_home(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    limits: CopyLimits,
    account_home: Option<PathBuf>,
) -> Result<CopyReport, CopyError> {
    stage_environment_with_publisher(
        selections,
        destination_root,
        excluded_canonical_sources,
        limits,
        account_home,
        |source, destination| fs::rename(source, destination),
    )?
    .commit()
}

#[cfg(test)]
fn copy_environment_with_publisher(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    limits: CopyLimits,
    account_home: Option<PathBuf>,
    publish: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<CopyReport, CopyError> {
    stage_environment_with_publisher(
        selections,
        destination_root,
        excluded_canonical_sources,
        limits,
        account_home,
        publish,
    )?
    .commit()
}
fn stage_environment_with_publisher(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    limits: CopyLimits,
    account_home: Option<PathBuf>,
    mut publish: impl FnMut(&Path, &Path) -> std::io::Result<()>,
) -> Result<EnvironmentPublication, CopyError> {
    let mut plan = Plan {
        nodes: BTreeMap::new(),
        mappings: BTreeMap::new(),
        pending: VecDeque::new(),
        exclusions: excluded_canonical_sources.to_vec(),
        counted_files: BTreeSet::new(),
        bytes: 0,
        metadata_bytes: 0,
        limits,
        account_home,
    };
    let mut selections = selections.iter().collect::<Vec<_>>();
    selections.sort_by_key(|selection| {
        (
            selection.source.components().count(),
            selection.source.clone(),
            selection.destination_relative.clone(),
        )
    });
    for selection in &selections {
        if !valid_relative(&selection.destination_relative) {
            return Err(error(
                &selection.destination_relative,
                "select",
                "destination must contain bounded normal relative components without traversal",
            ));
        }
    }
    for selection in &selections {
        let path = &selection.destination_relative;
        if !valid_relative(path) {
            return Err(error(
                path,
                "select",
                "destination must contain bounded normal relative components without traversal",
            ));
        }
        let metadata = fs::symlink_metadata(&selection.source)
            .map_err(|cause| io_error(path, "select", cause))?;
        let canonical = fs::canonicalize(&selection.source)
            .map_err(|cause| io_error(path, "resolve_selection", cause))?;
        if plan.excluded(&canonical) {
            return Err(error(
                path,
                "select",
                "selected resource is excluded native state or a credential source; keep native state in its store and use managed references for credentials",
            ));
        }
        plan.select_linked_ancestors(selection, &selections, &canonical)?;
        if metadata.file_type().is_symlink() {
            plan.enqueue(selection.source.clone(), path.clone(), 0)?;
        } else if let Some(mapped) = plan.mapped(&canonical)? {
            if mapped != *path {
                plan.claim(path.clone(), Node::Link(mapped))?;
            }
        } else {
            plan.add_mapping(canonical, path.clone())?;
            plan.enqueue(selection.source.clone(), path.clone(), 0)?;
        }
    }
    while let Some((source, path, depth)) = plan.pending.pop_front() {
        plan.metadata_bytes -= source.as_os_str().len() as u64 + path.as_os_str().len() as u64;
        plan.walk(source, path, depth)?;
    }
    // Ensure physical targets and incompatible parent claims have been settled.
    for (path, node) in &plan.nodes {
        if let Node::Link(target) = node {
            if !plan.nodes.contains_key(target) {
                return Err(error(
                    path,
                    "plan",
                    "selected link has an excluded or unavailable target; repair the resource",
                ));
            }
        }
    }
    // A mounted destination's parent may be read-only or on another filesystem.
    // Keep its inode stable and stage inside the writable destination instead.
    let existing_root = match fs::symlink_metadata(destination_root) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => true,
        Ok(_) => {
            return Err(error(
                Path::new(""),
                "publish",
                "destination root must be a physical directory",
            ));
        }
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => false,
        Err(cause) => return Err(io_error(Path::new(""), "inspect_destination", cause)),
    };
    if existing_root {
        recover_interrupted_publications(destination_root)?;
    }
    let parent = if existing_root {
        destination_root
    } else {
        let parent = destination_root
            .parent()
            .ok_or_else(|| error(Path::new(""), "stage", "destination has no parent"))?;
        fs::create_dir_all(parent)
            .map_err(|cause| io_error(Path::new(""), "create_stage_parent", cause))?;
        parent
    };
    let (temporary, backup_root) = publication_paths(parent, destination_root, existing_root)?;
    let mut actual_bytes = 0u64;
    for (relative, node) in &plan.nodes {
        let destination = temporary.0.join(relative);
        match node {
            Node::Directory(_) => {
                fs::create_dir(&destination)
                    .map_err(|cause| io_error(relative, "create_directory", cause))?;
                mode(&destination, 0o700, relative)?;
            }
            Node::File(source, source_mode, expected) => {
                let mut input =
                    File::open(source).map_err(|cause| io_error(relative, "open", cause))?;
                let mut options = OpenOptions::new();
                options.create_new(true).write(true);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.mode(0o600);
                }
                let mut output = options
                    .open(&destination)
                    .map_err(|cause| io_error(relative, "create_file", cause))?;
                let mut buffer = [0u8; 64 * 1024];
                let mut file_bytes = 0u64;
                loop {
                    let read = input
                        .read(&mut buffer)
                        .map_err(|cause| io_error(relative, "read", cause))?;
                    if read == 0 {
                        break;
                    }
                    file_bytes = file_bytes
                        .checked_add(read as u64)
                        .ok_or_else(|| error(relative, "read", "file byte accounting overflow"))?;
                    actual_bytes = actual_bytes
                        .checked_add(read as u64)
                        .ok_or_else(|| error(relative, "read", "total byte accounting overflow"))?;
                    bound(relative, "file_bytes", file_bytes, limits.max_file_bytes)?;
                    bound(
                        relative,
                        "total_bytes",
                        actual_bytes,
                        limits.max_total_bytes,
                    )?;
                    output
                        .write_all(&buffer[..read])
                        .map_err(|cause| io_error(relative, "write", cause))?;
                }
                if file_bytes != *expected {
                    return Err(error(
                        relative,
                        "read",
                        "resource changed while being copied; retry with a stable installation",
                    ));
                }
                mode(&destination, private_file_mode(*source_mode), relative)?;
                output
                    .sync_all()
                    .map_err(|cause| io_error(relative, "sync_file", cause))?;
            }
            Node::Link(target) => {
                #[cfg(unix)]
                std::os::unix::fs::symlink(
                    relative_link(relative.parent().unwrap_or(Path::new("")), target),
                    &destination,
                )
                .map_err(|cause| io_error(relative, "create_link", cause))?;
                #[cfg(not(unix))]
                return Err(error(
                    relative,
                    "create_link",
                    "symbolic resource projection requires Unix",
                ));
            }
        }
    }
    let mut rollback = None;
    if !existing_root {
        fs::rename(&temporary.0, destination_root)
            .map_err(|cause| io_error(Path::new(""), "publish", cause))?;
    } else {
        let root_metadata = fs::symlink_metadata(destination_root)
            .map_err(|cause| io_error(Path::new(""), "inspect_destination", cause))?;
        if !root_metadata.is_dir() || root_metadata.file_type().is_symlink() {
            return Err(error(
                Path::new(""),
                "publish",
                "destination root must be a physical directory",
            ));
        }
        let mut journal_entries = Vec::new();
        let mut next_backup_id = 0;
        for (relative, node) in &plan.nodes {
            for parent in relative
                .parent()
                .into_iter()
                .flat_map(Path::ancestors)
                .filter(|path| !path.as_os_str().is_empty())
            {
                match fs::symlink_metadata(destination_root.join(parent)) {
                    Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
                        return Err(error(
                            relative,
                            "inspect_destination",
                            "selected destination parent must be a physical directory",
                        ));
                    }
                    Err(cause) if cause.kind() != std::io::ErrorKind::NotFound => {
                        return Err(io_error(relative, "inspect_destination", cause));
                    }
                    _ => {}
                }
            }
            let existing = match fs::symlink_metadata(destination_root.join(relative)) {
                Ok(metadata) => Some(metadata),
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => None,
                Err(cause) => return Err(io_error(relative, "inspect_destination", cause)),
            };
            match existing.as_ref() {
                Some(metadata)
                    if matches!(node, Node::Directory(_))
                        && (!metadata.is_dir() || metadata.file_type().is_symlink()) =>
                {
                    return Err(error(
                        relative,
                        "inspect_destination",
                        "existing destination type conflicts with selected resource",
                    ));
                }
                Some(metadata) if !matches!(node, Node::Directory(_)) && metadata.is_dir() => {
                    return Err(error(
                        relative,
                        "inspect_destination",
                        "existing directory conflicts with selected resource leaf",
                    ));
                }
                _ => {}
            }
            if matches!(node, Node::Directory(_)) {
                if existing.is_none() {
                    journal_entries
                        .push(PublicationJournalEntry::CreatedDirectory(relative.clone()));
                }
            } else {
                journal_entries.push(PublicationJournalEntry::Leaf {
                    relative: relative.clone(),
                    backup_id: next_backup_id,
                    had_original: existing.is_some(),
                });
                next_backup_id += 1;
            }
        }
        let mut publication = Publication {
            backup: backup_root.ok_or_else(|| {
                error(
                    Path::new(""),
                    "publish",
                    "existing HOME has no publication journal",
                )
            })?,
            created: Vec::new(),
            replaced: Vec::new(),
            journal_entries,
            next_backup_id,
            committed: false,
        };
        write_publication_journal(
            destination_root,
            &publication.backup.0,
            &publication.journal_entries,
        )?;
        // The journal was built by walking `plan.nodes`, a BTreeMap ordered
        // by relative path. Filtering that order keeps the leaf index sorted
        // while preserving the durable journal's original entry order.
        let leaf_journal_indices = publication
            .journal_entries
            .iter()
            .enumerate()
            .filter_map(|(index, entry)| {
                matches!(entry, PublicationJournalEntry::Leaf { .. }).then_some(index)
            })
            .collect::<Vec<_>>();
        let old_files = publication.backup.0.join(OLD_FILES_DIR);
        fs::create_dir(&old_files)
            .map_err(|cause| io_error(Path::new(""), "create_publication_backups", cause))?;
        sync_directory_chain(destination_root, &old_files)?;
        let mut backup_id = 0;
        for (relative, node) in &plan.nodes {
            let destination = destination_root.join(relative);
            let existing = match fs::symlink_metadata(&destination) {
                Ok(metadata) => Some(metadata),
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => None,
                Err(cause) => return Err(io_error(relative, "inspect_destination", cause)),
            };
            if matches!(node, Node::Directory(_)) {
                if existing.is_none() {
                    fs::create_dir(&destination)
                        .map_err(|cause| io_error(relative, "publish_directory", cause))?;
                    publication.created.push(destination.clone());
                    mode(&destination, 0o700, relative)?;
                    if let Some(parent) = destination.parent() {
                        sync_directory_chain(destination_root, parent)?;
                    }
                }
                // An existing parent grants no chmod/chown/removal authority.
            } else {
                publication.set_leaf_had_original(
                    destination_root,
                    relative,
                    &leaf_journal_indices,
                    existing.is_some(),
                )?;
                if existing.is_some() {
                    let backup = backup_path(&publication.backup.0, backup_id);
                    // Keep the provider-visible leaf in place until rename
                    // atomically publishes the staged replacement. The hard
                    // link retains the prior inode for ordinary-error rollback.
                    fs::hard_link(&destination, &backup)
                        .map_err(|cause| io_error(relative, "retain_replacement", cause))?;
                    publication.replaced.push((destination.clone(), backup));
                    sync_directory_chain(
                        destination_root,
                        publication.backup.0.join(OLD_FILES_DIR).as_path(),
                    )?;
                }
                if existing.is_none() {
                    publication.created.push(destination.clone());
                }
                publish(&temporary.0.join(relative), &destination)
                    .map_err(|cause| io_error(relative, "publish_leaf", cause))?;
                if let Some(parent) = destination.parent() {
                    sync_directory_chain(destination_root, parent)?;
                }
                backup_id += 1;
            }
        }
        sync_directory_chain(destination_root, destination_root)?;
        rollback = Some(publication);
    }
    let entries = plan.nodes.len();
    let created_paths = if let Some(publication) = &rollback {
        publication
            .created
            .iter()
            .chain(
                publication
                    .replaced
                    .iter()
                    .map(|(destination, _)| destination),
            )
            .filter_map(|path| {
                path.strip_prefix(destination_root)
                    .ok()
                    .map(Path::to_path_buf)
            })
            .collect()
    } else {
        plan.nodes.keys().cloned().collect()
    };
    Ok(EnvironmentPublication {
        report: CopyReport {
            entries,
            bytes: actual_bytes,
            projected_paths: plan.nodes.into_keys().collect(),
            created_paths,
        },
        root: destination_root.to_owned(),
        unfinished_new_root: rollback.is_none(),
        rollback,
        _stage: temporary,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::{fs, path::Path, process::Command};

    #[cfg(unix)]
    #[test]
    fn unfinished_new_home_publication_removes_only_its_created_paths() {
        let source = tempfile::tempdir().unwrap();
        let parent = tempfile::tempdir().unwrap();
        fs::write(source.path().join("config.json"), b"new").unwrap();
        let sibling = parent.path().join("sibling");
        fs::write(&sibling, b"keep").unwrap();
        let home = parent.path().join("provider");
        let selection = CopySelection {
            source: source.path().join("config.json"),
            destination_relative: PathBuf::from("config.json"),
        };
        let publication = stage_environment(
            std::slice::from_ref(&selection),
            &home,
            &[],
            Default::default(),
        )
        .unwrap();
        assert_eq!(fs::read(home.join("config.json")).unwrap(), b"new");
        drop(publication);
        assert!(
            !home.exists(),
            "unfinished initial publication must roll back its new HOME"
        );
        assert_eq!(fs::read(&sibling).unwrap(), b"keep");
        stage_environment(&[selection], &home, &[], Default::default())
            .unwrap()
            .commit()
            .unwrap();
        assert_eq!(fs::read(home.join("config.json")).unwrap(), b"new");
    }

    #[test]
    fn publication_failure_after_first_replacement_restores_original_inodes() {
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let home = root.path().join("home");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&home).unwrap();
        for name in ["a-first", "z-last"] {
            fs::write(source.join(name), format!("new-{name}")).unwrap();
            fs::write(home.join(name), format!("prior-{name}")).unwrap();
        }
        fs::write(home.join("sibling"), "sibling-nonce").unwrap();
        fs::create_dir(source.join("b-new")).unwrap();
        fs::write(source.join("b-new/child"), "new-child").unwrap();
        let identity = |path: &Path| {
            let stat = fs::metadata(path).unwrap();
            (stat.ino(), stat.uid(), stat.gid(), stat.mode())
        };
        let before = ["a-first", "z-last", "sibling"].map(|name| {
            (
                name,
                identity(&home.join(name)),
                fs::read(home.join(name)).unwrap(),
            )
        });
        let home_identity = identity(&home);
        let mut executed = 0;
        let error = copy_environment_with_publisher(
            &[
                selection(&source.join("a-first"), "a-first"),
                selection(&source.join("b-new"), "b-new"),
                selection(&source.join("z-last"), "z-last"),
            ],
            &home,
            &[],
            Default::default(),
            None,
            |from, to| {
                assert!(
                    from.starts_with(&home),
                    "staging must be inside writable HOME"
                );
                executed += 1;
                if executed == 3 {
                    assert_eq!(fs::read(home.join("a-first")).unwrap(), b"new-a-first");
                    assert_eq!(fs::read(home.join("b-new/child")).unwrap(), b"new-child");
                    return Err(std::io::Error::other(
                        "fixture failure after first replacement",
                    ));
                }
                fs::rename(from, to)
            },
        );
        // Use direct selected leaves, so both calls actually replace old inodes.
        assert!(error.is_err());
        assert_eq!(executed, 3);
        assert_eq!(identity(&home), home_identity);
        for (name, stat, bytes) in before {
            assert_eq!(identity(&home.join(name)), stat);
            assert_eq!(fs::read(home.join(name)).unwrap(), bytes);
        }
        assert!(!home.join("b-new").exists(), "created paths must roll back");
        assert_eq!(fs::read_dir(&home).unwrap().count(), 3);
        copy_environment(
            &[
                selection(&source.join("a-first"), "a-first"),
                selection(&source.join("z-last"), "z-last"),
            ],
            &home,
            &[],
            Default::default(),
        )
        .unwrap();
        assert_eq!(fs::read(home.join("a-first")).unwrap(), b"new-a-first");
        assert_eq!(fs::read(home.join("z-last")).unwrap(), b"new-z-last");
        assert_eq!(fs::read(home.join("sibling")).unwrap(), b"sibling-nonce");
    }

    #[cfg(unix)]
    struct ChildGuard(std::process::Child);

    #[cfg(unix)]
    impl Drop for ChildGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "process-kill recovery test; run only through scripts/sandbox-test.sh"]
    fn abrupt_termination_during_replacement_keeps_existing_leaf() {
        const CHILD_ROOT: &str = "FRESHELL_PROVIDER_PUBLICATION_CHILD_ROOT";
        const PUBLISH_REACHED: &str = "publisher-reached";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            let root = PathBuf::from(root);
            let source = root.join("source/config.json");
            let home = root.join("home");
            let reached = root.join(PUBLISH_REACHED);
            let _ = copy_environment_with_publisher(
                &[selection(&source, "config.json")],
                &home,
                &[],
                Default::default(),
                None,
                |_, _| {
                    fs::write(&reached, b"reached").unwrap();
                    loop {
                        std::thread::park_timeout(std::time::Duration::from_secs(10));
                    }
                },
            );
            panic!("child should be killed at the publication boundary");
        }

        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let home = root.path().join("home");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&home).unwrap();
        fs::write(source.join("config.json"), b"replacement").unwrap();
        fs::write(home.join("config.json"), b"original").unwrap();

        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "provider_environment::tests::abrupt_termination_during_replacement_keeps_existing_leaf",
                "--ignored",
                "--nocapture",
            ])
            .env(CHILD_ROOT, root.path())
            .spawn()
            .unwrap(),
        );
        let reached = root.path().join(PUBLISH_REACHED);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !reached.exists() {
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("child exited before the publication boundary: {status}");
            }
            assert!(
                std::time::Instant::now() < deadline,
                "child did not reach the publication boundary"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        child.0.kill().unwrap();
        assert!(!child.0.wait().unwrap().success());
        assert_eq!(fs::read(home.join("config.json")).unwrap(), b"original");
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "process-kill recovery test; run only through scripts/sandbox-test.sh"]
    fn abrupt_termination_after_partial_publish_recovers_prior_home_before_retry() {
        const CHILD_ROOT: &str = "FRESHELL_PROVIDER_MULTI_PUBLICATION_CHILD_ROOT";
        const PARTIAL_PUBLISH_REACHED: &str = "partial-publish-reached";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            let root = PathBuf::from(root);
            let source = root.join("source");
            let home = root.join("home");
            let reached = root.join(PARTIAL_PUBLISH_REACHED);
            let mut published = 0;
            let _ = copy_environment_with_publisher(
                &[
                    selection(&source.join("a-first"), "a-first"),
                    selection(&source.join("m-new"), "m-new"),
                    selection(&source.join("z-last"), "z-last"),
                ],
                &home,
                &[],
                Default::default(),
                None,
                |from, to| {
                    fs::rename(from, to)?;
                    published += 1;
                    if published == 2 {
                        fs::write(&reached, b"published").unwrap();
                        loop {
                            std::thread::park_timeout(std::time::Duration::from_secs(10));
                        }
                    }
                    Ok(())
                },
            );
            panic!("child should be killed after publishing part of the projection");
        }

        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let home = root.path().join("home");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&home).unwrap();
        for name in ["a-first", "z-last"] {
            fs::write(source.join(name), format!("new-{name}")).unwrap();
            fs::write(home.join(name), format!("prior-{name}")).unwrap();
        }
        fs::write(source.join("m-new"), b"new-m-new").unwrap();

        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "provider_environment::tests::abrupt_termination_after_partial_publish_recovers_prior_home_before_retry",
                    "--ignored",
                    "--nocapture",
                ])
                .env(CHILD_ROOT, root.path())
                .spawn()
                .unwrap(),
        );
        let reached = root.path().join(PARTIAL_PUBLISH_REACHED);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !reached.exists() {
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("child exited before the partial publication: {status}");
            }
            assert!(
                std::time::Instant::now() < deadline,
                "child did not publish a partial projection"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        child.0.kill().unwrap();
        assert!(!child.0.wait().unwrap().success());

        let unrelated = source.join("unrelated");
        fs::write(&unrelated, b"unrelated").unwrap();
        stage_environment(
            &[selection(&unrelated, "unrelated")],
            &home,
            &[],
            Default::default(),
        )
        .unwrap()
        .commit()
        .unwrap();
        assert_eq!(fs::read(home.join("a-first")).unwrap(), b"prior-a-first");
        assert_eq!(fs::read(home.join("z-last")).unwrap(), b"prior-z-last");
        assert!(!home.join("m-new").exists());
        assert_eq!(fs::read(home.join("unrelated")).unwrap(), b"unrelated");

        stage_environment(
            &[
                selection(&source.join("a-first"), "a-first"),
                selection(&source.join("m-new"), "m-new"),
                selection(&source.join("z-last"), "z-last"),
            ],
            &home,
            &[],
            Default::default(),
        )
        .unwrap()
        .commit()
        .unwrap();
        assert_eq!(fs::read(home.join("a-first")).unwrap(), b"new-a-first");
        assert_eq!(fs::read(home.join("m-new")).unwrap(), b"new-m-new");
        assert_eq!(fs::read(home.join("z-last")).unwrap(), b"new-z-last");
    }

    #[cfg(unix)]
    #[test]
    #[ignore = "process-kill recovery test; run only through scripts/sandbox-test.sh"]
    fn interrupted_committed_cleanup_does_not_restore_committed_home() {
        const CHILD_ROOT: &str = "FRESHELL_PROVIDER_COMMITTED_CLEANUP_CHILD_ROOT";
        const CLEANUP_REACHED: &str = "committed-cleanup-reached";
        if let Some(root) = std::env::var_os(CHILD_ROOT) {
            let root = PathBuf::from(root);
            let backup = root.join(format!("{BACKUP_PREFIX}committed-cleanup"));
            let stage = root.join(format!("{STAGE_PREFIX}committed-cleanup"));
            let reached = root.join(CLEANUP_REACHED);
            let result = cleanup_committed_publication_with_hook(
                &root,
                &stage,
                &backup,
                || -> Result<(), CopyError> {
                    fs::remove_file(backup.join(COMMITTED_FILE)).unwrap();
                    fs::write(&reached, b"reached").unwrap();
                    loop {
                        std::thread::park_timeout(std::time::Duration::from_secs(10));
                    }
                },
            );
            panic!("child should be killed during committed cleanup: {result:?}");
        }

        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("config.json"), b"committed-value").unwrap();

        let backup = home.join(format!("{BACKUP_PREFIX}committed-cleanup"));
        fs::create_dir_all(backup.join(OLD_FILES_DIR)).unwrap();
        write_publication_owner_marker(&home, &backup).unwrap();
        fs::write(backup.join(COMMITTED_FILE), b"committed\n").unwrap();
        fs::write(backup_path(&backup, 0), b"previous-value").unwrap();
        write_publication_journal(
            &home,
            &backup,
            &[PublicationJournalEntry::Leaf {
                relative: "config.json".into(),
                backup_id: 0,
                had_original: true,
            }],
        )
        .unwrap();
        let stage = home.join(format!("{STAGE_PREFIX}committed-cleanup"));
        fs::create_dir(&stage).unwrap();

        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "provider_environment::tests::interrupted_committed_cleanup_does_not_restore_committed_home",
                    "--ignored",
                    "--nocapture",
                ])
                .env(CHILD_ROOT, &home)
                .spawn()
                .unwrap(),
        );
        let reached = home.join(CLEANUP_REACHED);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !reached.exists() {
            if let Some(status) = child.0.try_wait().unwrap() {
                panic!("cleanup child exited before interruption point: {status}");
            }
            assert!(
                std::time::Instant::now() < deadline,
                "cleanup child did not reach the interruption point"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(!backup.join(COMMITTED_FILE).exists());
        assert!(backup.join(JOURNAL_FILE).is_file());
        assert!(has_publication_cleanup_marker(&backup).unwrap());
        child.0.kill().unwrap();
        assert!(!child.0.wait().unwrap().success());

        recover_environment(&home).unwrap();
        assert_eq!(
            fs::read(home.join("config.json")).unwrap(),
            b"committed-value"
        );
        assert!(!backup.exists());

        // A repeated recovery after interrupted cleanup is a clean no-op.
        recover_environment(&home).unwrap();
        assert_eq!(
            fs::read(home.join("config.json")).unwrap(),
            b"committed-value"
        );
    }

    #[test]
    fn recovery_preserves_unowned_backup_prefix_directories() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let source = root.path().join("source");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(source.join("new"), b"new").unwrap();
        let unrelated = home.join(format!("{BACKUP_PREFIX}unrelated"));
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("sentinel"), b"keep").unwrap();

        stage_environment(
            &[selection(&source.join("new"), "new")],
            &home,
            &[],
            Default::default(),
        )
        .unwrap()
        .commit()
        .unwrap();

        assert_eq!(fs::read(unrelated.join("sentinel")).unwrap(), b"keep");
    }

    #[test]
    fn recovery_treats_durable_cleanup_marker_as_committed() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("config.json"), b"committed-value").unwrap();

        let backup = home.join(format!("{BACKUP_PREFIX}cleanup-started"));
        fs::create_dir_all(backup.join(OLD_FILES_DIR)).unwrap();
        write_publication_owner_marker(&home, &backup).unwrap();
        fs::write(backup.join(CLEANUP_FILE), CLEANUP_CONTENT).unwrap();
        fs::write(backup_path(&backup, 0), b"previous-value").unwrap();
        write_publication_journal(
            &home,
            &backup,
            &[PublicationJournalEntry::Leaf {
                relative: "config.json".into(),
                backup_id: 0,
                had_original: true,
            }],
        )
        .unwrap();

        // Rewriting the already-published marker is safe on platforms where
        // rename cannot replace an existing destination.
        write_publication_cleanup_marker(&home, &backup).unwrap();
        assert!(!backup.join(CLEANUP_TEMP_FILE).exists());

        recover_environment(&home).unwrap();
        recover_environment(&home).unwrap();

        assert_eq!(
            fs::read(home.join("config.json")).unwrap(),
            b"committed-value"
        );
        assert!(!backup.exists());
    }

    #[test]
    fn recovery_emits_structured_completion_event_for_restored_transaction() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        let backup = home.join(format!("{BACKUP_PREFIX}recovery-event"));
        fs::create_dir_all(backup.join(OLD_FILES_DIR)).unwrap();
        write_publication_owner_marker(&home, &backup).unwrap();
        fs::write(backup_path(&backup, 0), b"previous-value").unwrap();
        write_publication_journal(
            &home,
            &backup,
            &[PublicationJournalEntry::Leaf {
                relative: "config.json".into(),
                backup_id: 0,
                had_original: true,
            }],
        )
        .unwrap();
        PUBLICATION_RECOVERY_EVENTS.with(|events| events.borrow_mut().clear());

        recover_environment(&home).unwrap();

        assert_eq!(
            fs::read(home.join("config.json")).unwrap(),
            b"previous-value"
        );
        let events = PUBLICATION_RECOVERY_EVENTS.with(|events| events.borrow().clone());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["severity"], "info");
        assert_eq!(
            events[0]["event"],
            "provider.environment.recovery.completed"
        );
        assert_eq!(events[0]["status"], "success");
        assert_eq!(events[0]["transactions"], 1);
        assert_eq!(events[0]["committed"], 0);
        assert_eq!(events[0]["rolled_back"], 1);
        assert_eq!(events[0]["restored_paths"], 1);
    }

    #[cfg(unix)]
    #[test]
    fn recovery_refuses_to_remove_missing_backup_leaf_through_symlinked_parent() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let outside = root.path().join("outside");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&outside).unwrap();
        let sentinel = outside.join("sentinel");
        fs::write(&sentinel, b"external-data").unwrap();

        let backup = home.join(format!("{BACKUP_PREFIX}missing-backup-symlink-parent"));
        fs::create_dir_all(backup.join(OLD_FILES_DIR)).unwrap();
        write_publication_owner_marker(&home, &backup).unwrap();
        let entry = PublicationJournalEntry::Leaf {
            relative: "nested/sentinel".into(),
            backup_id: 0,
            had_original: false,
        };
        write_publication_journal(&home, &backup, std::slice::from_ref(&entry)).unwrap();
        symlink(&outside, home.join("nested")).unwrap();

        let result = recover_environment(&home);

        assert_eq!(fs::read(&sentinel).unwrap(), b"external-data");
        assert!(result.is_err(), "symlinked parents must block leaf removal");
        assert!(backup.join(JOURNAL_FILE).is_file());
        assert_eq!(
            read_publication_journal(&backup.join(JOURNAL_FILE)).unwrap(),
            vec![entry]
        );
        assert!(has_publication_owner_marker(&backup).unwrap());
    }

    #[test]
    fn recovery_treats_missing_parent_as_absent_for_missing_backup_leaf() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        let backup = home.join(format!("{BACKUP_PREFIX}missing-parent"));
        fs::create_dir_all(backup.join(OLD_FILES_DIR)).unwrap();
        write_publication_owner_marker(&home, &backup).unwrap();
        let entry = PublicationJournalEntry::Leaf {
            relative: "nested/new-leaf".into(),
            backup_id: 0,
            had_original: false,
        };
        write_publication_journal(&home, &backup, std::slice::from_ref(&entry)).unwrap();

        recover_environment(&home).unwrap();

        assert!(!home.join("nested").exists());
        assert!(!backup.exists());
    }

    #[test]
    fn recovery_rejects_invalid_committed_markers_and_preserves_rollback_evidence() {
        fn assert_invalid_marker(create_marker: impl FnOnce(&Path, &Path)) {
            let root = tempfile::tempdir().unwrap();
            let home = root.path().join("home");
            fs::create_dir(&home).unwrap();
            fs::write(home.join("config.json"), b"published-value").unwrap();
            let backup = home.join(format!("{BACKUP_PREFIX}invalid-commit-marker"));
            fs::create_dir_all(backup.join(OLD_FILES_DIR)).unwrap();
            write_publication_owner_marker(&home, &backup).unwrap();
            fs::write(backup_path(&backup, 0), b"prior-value").unwrap();
            let entry = PublicationJournalEntry::Leaf {
                relative: "config.json".into(),
                backup_id: 0,
                had_original: true,
            };
            write_publication_journal(&home, &backup, std::slice::from_ref(&entry)).unwrap();
            let marker_target = root.path().join("external-marker-target");
            fs::write(&marker_target, b"external-marker-data").unwrap();
            let marker = backup.join(COMMITTED_FILE);
            create_marker(&marker, &marker_target);

            let result = recover_environment(&home);

            assert!(
                result.is_err(),
                "invalid committed marker must stop recovery"
            );
            assert_eq!(
                fs::read(home.join("config.json")).unwrap(),
                b"published-value"
            );
            assert_eq!(fs::read(backup_path(&backup, 0)).unwrap(), b"prior-value");
            assert_eq!(
                read_publication_journal(&backup.join(JOURNAL_FILE)).unwrap(),
                vec![entry]
            );
            assert!(has_publication_owner_marker(&backup).unwrap());
            assert_eq!(fs::read(&marker_target).unwrap(), b"external-marker-data");
            assert!(fs::symlink_metadata(&marker).is_ok());
        }

        assert_invalid_marker(|marker, _| fs::write(marker, b"").unwrap());
        assert_invalid_marker(|marker, _| fs::write(marker, b"not committed\n").unwrap());
        assert_invalid_marker(|marker, _| fs::create_dir(marker).unwrap());
        #[cfg(unix)]
        assert_invalid_marker(|marker, target| symlink(target, marker).unwrap());
    }

    #[test]
    fn recovery_accepts_the_marker_written_by_publication_commit() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("config.json"), b"published-value").unwrap();
        let backup = home.join(format!("{BACKUP_PREFIX}valid-commit-marker"));
        fs::create_dir_all(backup.join(OLD_FILES_DIR)).unwrap();
        write_publication_owner_marker(&home, &backup).unwrap();
        fs::write(backup_path(&backup, 0), b"prior-value").unwrap();
        write_publication_journal(
            &home,
            &backup,
            &[PublicationJournalEntry::Leaf {
                relative: "config.json".into(),
                backup_id: 0,
                had_original: true,
            }],
        )
        .unwrap();
        let publication = Publication {
            backup: TemporaryProjection(backup.clone()),
            created: Vec::new(),
            replaced: Vec::new(),
            journal_entries: Vec::new(),
            next_backup_id: 0,
            committed: false,
        };
        publication.write_committed_marker(&home).unwrap();
        std::mem::forget(publication);
        assert_eq!(
            fs::read(backup.join(COMMITTED_FILE)).unwrap(),
            COMMITTED_CONTENT
        );

        recover_environment(&home).unwrap();

        assert_eq!(
            fs::read(home.join("config.json")).unwrap(),
            b"published-value"
        );
        assert!(!backup.exists());
    }

    #[test]
    fn recovery_uses_durable_cleanup_marker_before_older_commit_marker() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("config.json"), b"published-value").unwrap();
        let backup = home.join(format!("{BACKUP_PREFIX}cleanup-marker-precedence"));
        fs::create_dir_all(backup.join(OLD_FILES_DIR)).unwrap();
        write_publication_owner_marker(&home, &backup).unwrap();
        fs::write(backup_path(&backup, 0), b"prior-value").unwrap();
        write_publication_journal(
            &home,
            &backup,
            &[PublicationJournalEntry::Leaf {
                relative: "config.json".into(),
                backup_id: 0,
                had_original: true,
            }],
        )
        .unwrap();
        fs::write(backup.join(COMMITTED_FILE), b"malformed older marker").unwrap();
        fs::write(backup.join(CLEANUP_FILE), CLEANUP_CONTENT).unwrap();

        recover_environment(&home).unwrap();

        assert_eq!(
            fs::read(home.join("config.json")).unwrap(),
            b"published-value"
        );
        assert!(!backup.exists());
    }

    #[test]
    fn obsolete_path_batch_writes_one_journal_and_rolls_back_all_paths() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let source = root.path().join("source");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(source.join("new"), b"new").unwrap();
        let stale = (0..64)
            .map(|index| PathBuf::from(format!("old-{index}")))
            .collect::<Vec<_>>();
        for path in &stale {
            fs::write(home.join(path), b"previous").unwrap();
        }

        let mut publication = stage_environment(
            &[selection(&source.join("new"), "new")],
            &home,
            &[],
            Default::default(),
        )
        .unwrap();
        PUBLICATION_JOURNAL_WRITES.with(|writes| writes.set(0));
        publication.remove_obsolete_batch(&stale).unwrap();
        let journal_writes = PUBLICATION_JOURNAL_WRITES.with(std::cell::Cell::get);
        assert_eq!(
            journal_writes, 1,
            "obsolete paths should share one durable journal rewrite"
        );

        drop(publication);
        assert!(!home.join("new").exists());
        for path in stale {
            assert_eq!(fs::read(home.join(path)).unwrap(), b"previous");
        }
    }

    #[cfg(unix)]
    #[test]
    fn recovery_reserves_backup_ids_across_partial_obsolete_batch_retry() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let source = root.path().join("source");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(home.join("old-a"), b"A").unwrap();
        fs::write(home.join("old-b"), b"B").unwrap();
        fs::write(home.join("old-c"), b"C").unwrap();
        fs::write(source.join("new"), b"new").unwrap();

        let mut publication = stage_environment(
            &[selection(&source.join("new"), "new")],
            &home,
            &[],
            Default::default(),
        )
        .unwrap();
        let backup_root = publication.rollback.as_ref().unwrap().backup.0.clone();
        let first_backup = backup_path(&backup_root, 1);
        let obstructed_backup = backup_path(&backup_root, 2);
        fs::create_dir(&obstructed_backup).unwrap();
        let obsolete = [PathBuf::from("old-a"), PathBuf::from("old-b")];

        assert!(publication.remove_obsolete_batch(&obsolete).is_err());
        assert!(!home.join("old-a").exists());
        assert_eq!(fs::read(&first_backup).unwrap(), b"A");
        assert_eq!(fs::read(home.join("old-b")).unwrap(), b"B");

        fs::remove_dir(&obstructed_backup).unwrap();
        publication.remove_obsolete(Path::new("old-c")).unwrap();
        assert!(!home.join("old-c").exists());
        publication.remove_obsolete(Path::new("old-b")).unwrap();
        assert!(!home.join("old-b").exists());
        assert_eq!(fs::read(&first_backup).unwrap(), b"A");

        // Model process interruption: recovery sees only the durable journal
        // and backup files, with no in-memory rollback running first.
        std::mem::forget(publication);
        recover_environment(&home).unwrap();

        assert_eq!(fs::read(home.join("old-a")).unwrap(), b"A");
        assert_eq!(fs::read(home.join("old-b")).unwrap(), b"B");
        assert_eq!(fs::read(home.join("old-c")).unwrap(), b"C");
        assert!(!home.join("new").exists());
        assert!(!backup_root.exists());
    }

    #[test]
    fn obsolete_path_journal_membership_scales_with_comparison_count() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let source = root.path().join("source");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&source).unwrap();
        fs::write(source.join("new"), b"new").unwrap();
        let stale = (0..1024)
            .map(|index| PathBuf::from(format!("old-{index:04}")))
            .collect::<Vec<_>>();
        for path in &stale {
            fs::write(home.join(path), b"previous").unwrap();
        }

        let mut publication = stage_environment(
            &[selection(&source.join("new"), "new")],
            &home,
            &[],
            Default::default(),
        )
        .unwrap();
        let duplicated_stale = stale
            .iter()
            .chain(stale.iter())
            .cloned()
            .collect::<Vec<_>>();
        PUBLICATION_JOURNAL_WRITES.with(|writes| writes.set(0));
        PUBLICATION_JOURNAL_ENTRY_COMPARISONS.with(|comparisons| comparisons.set(0));
        publication
            .remove_obsolete_batch(&duplicated_stale)
            .unwrap();
        let journal_writes = PUBLICATION_JOURNAL_WRITES.with(std::cell::Cell::get);
        let comparisons = PUBLICATION_JOURNAL_ENTRY_COMPARISONS.with(std::cell::Cell::get);
        assert_eq!(
            journal_writes, 1,
            "the batch must durably write the journal once"
        );
        assert!(
            comparisons <= stale.len() * 64,
            "journal deduplication compared entries {comparisons} times for {} unique paths",
            stale.len()
        );

        drop(publication);
        assert!(!home.join("new").exists());
        for path in stale {
            assert_eq!(fs::read(home.join(path)).unwrap(), b"previous");
        }
    }

    #[test]
    fn existing_leaf_journal_membership_scales_with_lookup_steps() {
        const LEAF_COUNT: usize = 512;
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let source = root.path().join("source");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&source).unwrap();
        let selections = (0..LEAF_COUNT)
            .map(|index| {
                let name = format!("leaf-{index:04}");
                let source_leaf = source.join(&name);
                fs::write(&source_leaf, b"new").unwrap();
                fs::write(home.join(&name), b"previous").unwrap();
                selection(&source_leaf, &name)
            })
            .collect::<Vec<_>>();

        PUBLICATION_LEAF_JOURNAL_PATH_COMPARISONS.with(|comparisons| comparisons.set(0));
        copy_environment_with_account_home(&selections, &home, &[], Default::default(), None)
            .unwrap();
        let comparisons = PUBLICATION_LEAF_JOURNAL_PATH_COMPARISONS.with(std::cell::Cell::get);

        assert!(
            comparisons <= LEAF_COUNT * 16,
            "existing-leaf journal lookup compared paths {comparisons} times for {LEAF_COUNT} leaves"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "process-kill recovery test; run only through scripts/sandbox-test.sh"]
    fn checkpoint_timeout_cleanup_kills_and_reaps_child() {
        let child = ChildGuard(Command::new("sleep").arg("2").spawn().unwrap());
        let pid = child.0.id();

        // Model the bounded wait in the parent test reaching its timeout.
        std::thread::sleep(std::time::Duration::from_millis(20));
        drop(child);

        assert!(
            !Path::new(&format!("/proc/{pid}")).exists(),
            "child must be killed and reaped when the checkpoint wait times out"
        );
    }

    fn selection(source: &Path, destination: &str) -> CopySelection {
        CopySelection {
            source: source.to_owned(),
            destination_relative: destination.into(),
        }
    }

    #[test]
    fn failed_stage_creation_never_removes_a_preexisting_directory() {
        let root = tempfile::tempdir().unwrap();
        let existing = root.path().join("existing-provider-sibling");
        fs::create_dir(&existing).unwrap();
        fs::write(existing.join("sentinel"), "provider-owned-nonce").unwrap();
        assert!(TemporaryProjection::create(existing.clone()).is_err());
        assert_eq!(
            fs::read(existing.join("sentinel")).expect("failed create grants no cleanup authority"),
            b"provider-owned-nonce"
        );
    }

    #[cfg(unix)]
    #[test]
    fn existing_destination_keeps_root_and_siblings_when_staging_or_validation_fails() {
        use std::os::unix::fs::MetadataExt;
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let home = root.path().join("home");
        fs::create_dir_all(source.join("z-conflict")).unwrap();
        fs::create_dir_all(home.join("selected")).unwrap();
        fs::write(source.join("a-first"), "new-nonce").unwrap();
        fs::write(source.join("z-conflict/child"), "child-nonce").unwrap();
        fs::write(home.join("selected/a-first"), "prior-nonce").unwrap();
        fs::write(home.join("selected/z-conflict"), "existing-type").unwrap();
        fs::write(home.join("sibling"), "sibling-nonce").unwrap();
        let identity = |path: &Path| {
            let metadata = fs::metadata(path).unwrap();
            (
                metadata.ino(),
                metadata.uid(),
                metadata.gid(),
                metadata.mode(),
            )
        };
        let before_home = identity(&home);
        let before_sibling = identity(&home.join("sibling"));
        let before_leaf = identity(&home.join("selected/a-first"));
        let selected = [selection(&source, "selected")];
        assert!(copy_environment(&selected, &home, &[], CopyLimits::default()).is_err());
        assert_eq!(
            fs::read(home.join("selected/a-first")).unwrap(),
            b"prior-nonce"
        );
        assert_eq!(identity(&home.join("selected/a-first")), before_leaf);
        assert_eq!(identity(&home), before_home);
        assert_eq!(identity(&home.join("sibling")), before_sibling);
        assert_eq!(
            fs::read_dir(&home).unwrap().count(),
            2,
            "attempt stage must be removed"
        );

        fs::remove_file(home.join("selected/z-conflict")).unwrap();
        copy_environment(&selected, &home, &[], CopyLimits::default()).unwrap();
        assert_eq!(
            fs::read(home.join("selected/a-first")).unwrap(),
            b"new-nonce"
        );
        assert_eq!(
            fs::read(home.join("selected/z-conflict/child")).unwrap(),
            b"child-nonce"
        );
        assert_eq!(identity(&home), before_home);
        assert_eq!(identity(&home.join("sibling")), before_sibling);
        assert_eq!(fs::read(home.join("sibling")).unwrap(), b"sibling-nonce");
        assert_eq!(fs::read_dir(&home).unwrap().count(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn copied_skill_executes_sibling_resources_after_two_stages() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source/skill");
        fs::create_dir_all(source.join("scripts")).unwrap();
        fs::create_dir_all(source.join("references")).unwrap();
        fs::create_dir_all(source.join("assets")).unwrap();
        fs::write(source.join("SKILL.md"), "fixture skill").unwrap();
        fs::write(source.join("references/data.json"), "resource-nonce\n").unwrap();
        fs::write(source.join("assets/template.txt"), "asset-nonce\n").unwrap();
        fs::write(source.join("scripts/run"), "#!/bin/sh\nset -eu\ncd \"$(dirname \"$0\")/..\"\ncat references/data.json assets/template.txt\n").unwrap();
        for mode in [0o755, 0o700] {
            fs::set_permissions(source.join("scripts/run"), fs::Permissions::from_mode(mode))
                .unwrap();
            let stage = root.path().join(format!("stage-{mode}"));
            copy_environment(
                &[selection(&source, "skills/fixture")],
                &stage,
                &[],
                CopyLimits::default(),
            )
            .unwrap();
            let home = root.path().join(format!("home-{mode}"));
            copy_environment(
                &[selection(&stage.join("skills"), "skills")],
                &home,
                &[],
                CopyLimits::default(),
            )
            .unwrap();
            let output = Command::new(home.join("skills/fixture/scripts/run"))
                .output()
                .unwrap();
            assert!(output.status.success(), "{output:?}");
            assert_eq!(output.stdout, b"resource-nonce\nasset-nonce\n");
            assert_eq!(
                fs::metadata(source.join("scripts/run"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                mode,
                "copying never changes the original executable"
            );
            assert_eq!(
                fs::metadata(home.join("skills/fixture/scripts/run"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o7777,
                private_file_mode(mode)
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn copied_pnpm_plugin_external_resources_and_circular_dependencies_execute() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let package =
            source.join("node_modules/.pnpm/fixture-dependency@1/node_modules/fixture-dependency");
        fs::create_dir_all(&package).unwrap();
        fs::create_dir_all(source.join("node_modules/.bin")).unwrap();
        fs::create_dir_all(source.join("plugins")).unwrap();
        fs::write(source.join("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::write(
            package.join("package.json"),
            r#"{"name":"fixture-dependency","type":"module","exports":"./index.js"}"#,
        )
        .unwrap();
        fs::write(package.join("auth.json"), r#"{"nonce":"dependency-nonce"}"#).unwrap();
        fs::write(package.join("index.js"), "import fs from 'node:fs'; export default JSON.parse(fs.readFileSync(new URL('./auth.json', import.meta.url))).nonce;\n").unwrap();
        fs::write(package.join("bin"), "#!/bin/sh\nprintf bin-nonce\n").unwrap();
        fs::set_permissions(package.join("bin"), fs::Permissions::from_mode(0o755)).unwrap();
        symlink(
            ".pnpm/fixture-dependency@1/node_modules/fixture-dependency",
            source.join("node_modules/fixture-dependency"),
        )
        .unwrap();
        symlink(
            "../fixture-dependency/bin",
            source.join("node_modules/.bin/fixture"),
        )
        .unwrap();
        symlink("..", package.join("node_modules")).unwrap();
        fs::write(
            source.join("plugins/main.js"),
            "import nonce from 'fixture-dependency'; console.log(nonce);\n",
        )
        .unwrap();
        let external = root.path().join("external/skill");
        fs::create_dir_all(external.join("assets")).unwrap();
        fs::write(external.join("SKILL.md"), "fixture").unwrap();
        fs::write(external.join("assets/data"), "external-nonce").unwrap();
        symlink(&external, source.join("linked-skill")).unwrap();
        let selections = [
            selection(&source.join("plugins"), "plugins"),
            selection(&source.join("node_modules"), "node_modules"),
            selection(&source.join("package.json"), "package.json"),
            selection(&source.join("linked-skill"), "skills/linked"),
        ];
        let stage = root.path().join("stage");
        copy_environment(&selections, &stage, &[], CopyLimits::default()).unwrap();
        let home = root.path().join("home");
        let transported = fs::read_dir(&stage)
            .unwrap()
            .map(|entry| {
                let entry = entry.unwrap();
                CopySelection {
                    source: entry.path(),
                    destination_relative: entry.file_name().into(),
                }
            })
            .collect::<Vec<_>>();
        copy_environment(&transported, &home, &[], CopyLimits::default()).unwrap();
        let output = Command::new("node")
            .arg(home.join("plugins/main.js"))
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(output.stdout, b"dependency-nonce\n");
        let output = Command::new(home.join("node_modules/.bin/fixture"))
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"bin-nonce");
        assert_eq!(
            fs::read(home.join("skills/linked/assets/data")).unwrap(),
            b"external-nonce"
        );
        assert!(
            fs::symlink_metadata(home.join("node_modules/fixture-dependency"))
                .unwrap()
                .file_type()
                .is_symlink()
        );
    }

    #[cfg(unix)]
    #[test]
    fn external_plugin_entry_preserves_adjacent_imports_and_selected_lookup_context() {
        let root = tempfile::tempdir().unwrap();
        let install = root.path().join("installation");
        let suite = install.join("suite");
        let selected = root.path().join("selected");
        fs::create_dir_all(suite.join("plugins")).unwrap();
        fs::create_dir_all(install.join("node_modules/fixture-dependency")).unwrap();
        fs::create_dir(&selected).unwrap();
        fs::create_dir_all(suite.join("node_modules/fixture-local")).unwrap();
        fs::write(
            suite.join("node_modules/fixture-local/package.json"),
            r#"{"main":"index.js"}"#,
        )
        .unwrap();
        fs::write(
            suite.join("node_modules/fixture-local/index.js"),
            "module.exports='local-dependency';",
        )
        .unwrap();
        fs::write(suite.join("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::write(
            suite.join("plugins/helper.js"),
            "export default 'adjacent-nonce';",
        )
        .unwrap();
        fs::write(suite.join("plugins/main.js"),"import local from './helper.js'; import dependency from 'fixture-dependency'; import scoped from 'fixture-local'; console.log(local + ':' + dependency + ':' + scoped);").unwrap();
        fs::write(
            install.join("node_modules/fixture-dependency/package.json"),
            r#"{"main":"index.js"}"#,
        )
        .unwrap();
        fs::write(
            install.join("node_modules/fixture-dependency/index.js"),
            "module.exports=require('./auth.json').nonce;",
        )
        .unwrap();
        fs::write(
            install.join("node_modules/fixture-dependency/auth.json"),
            r#"{"nonce":"dependency-nonce"}"#,
        )
        .unwrap();
        symlink(suite.join("plugins/main.js"), selected.join("main.js")).unwrap();
        let stage = root.path().join("stage");
        copy_environment(
            &[
                selection(&selected, "plugin"),
                selection(&install.join("node_modules"), "node_modules"),
                selection(&suite.join("node_modules"), "local-node_modules"),
            ],
            &stage,
            &[],
            Default::default(),
        )
        .unwrap();
        let home = root.path().join("home");
        copy_environment(
            &[
                selection(&stage.join("plugin"), ".config/opencode/plugin"),
                selection(&stage.join("node_modules"), ".config/opencode/node_modules"),
                selection(
                    &stage.join("local-node_modules"),
                    ".config/opencode/local-node_modules",
                ),
                selection(&stage.join(".freshell/resources"), ".freshell/resources"),
            ],
            &home,
            &[],
            Default::default(),
        )
        .unwrap();
        let output = Command::new("node")
            .arg(home.join(".config/opencode/plugin/main.js"))
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "external package context: {output:?}"
        );
        assert_eq!(
            output.stdout,
            b"adjacent-nonce:dependency-nonce:local-dependency\n"
        );
    }

    #[test]
    fn all_four_limits_accept_exact_and_reject_beyond_before_publication() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("nested/data"), b"1234").unwrap();
        let selections = [selection(&source, "resource")];
        let exact = CopyLimits {
            max_entries: 3,
            max_total_bytes: 4,
            max_file_bytes: 4,
            max_depth: 2,
        };
        let report = copy_environment(&selections, &root.path().join("exact"), &[], exact).unwrap();
        assert_eq!((report.entries, report.bytes), (3, 4));
        for (kind, limits, observed, permitted) in [
            (
                "entries",
                CopyLimits {
                    max_entries: 2,
                    ..exact
                },
                3,
                2,
            ),
            (
                "total_bytes",
                CopyLimits {
                    max_total_bytes: 3,
                    ..exact
                },
                4,
                3,
            ),
            (
                "file_bytes",
                CopyLimits {
                    max_file_bytes: 3,
                    ..exact
                },
                4,
                3,
            ),
            (
                "depth",
                CopyLimits {
                    max_depth: 1,
                    ..exact
                },
                2,
                1,
            ),
        ] {
            let destination = root.path().join(kind);
            let error = copy_environment(&selections, &destination, &[], limits).unwrap_err();
            assert_eq!(error.limit_kind, Some(kind));
            assert_eq!(error.observed, Some(observed));
            assert_eq!(error.permitted, Some(permitted));
            assert!(!error.relative_path.is_absolute());
            assert!(!destination.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn concrete_credential_identities_exclude_aliases_but_keep_package_auth() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir_all(source.join("package")).unwrap();
        fs::write(source.join("auth.json"), "credential-marker").unwrap();
        fs::write(source.join("package/auth.json"), "ordinary-resource").unwrap();
        symlink("../auth.json", source.join("package/alias")).unwrap();
        let destination = root.path().join("destination");
        copy_environment(
            &[selection(&source, "config")],
            &destination,
            &[fs::canonicalize(source.join("auth.json")).unwrap()],
            CopyLimits::default(),
        )
        .unwrap();
        assert!(!destination.join("config/auth.json").exists());
        assert!(!destination.join("config/package/alias").exists());
        assert_eq!(
            fs::read(destination.join("config/package/auth.json")).unwrap(),
            b"ordinary-resource"
        );
    }

    #[cfg(unix)]
    #[test]
    fn automatic_external_package_scope_never_selects_account_home() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("home");
        let selected = root.path().join("selected");
        fs::create_dir(&home).unwrap();
        fs::create_dir(&selected).unwrap();
        fs::write(home.join("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::write(home.join("standalone.js"), "export default 'nonce';").unwrap();
        fs::write(home.join("account-data"), "account-nonce").unwrap();
        symlink(home.join("standalone.js"), selected.join("main.js")).unwrap();
        let destination = root.path().join("destination");
        let result = copy_environment_with_account_home(
            &[selection(&selected, "plugins")],
            &destination,
            &[],
            Default::default(),
            Some(home.clone()),
        );
        let error =
            result.expect_err("a plugin file does not authorize copying the entire account home");
        assert!(error.corrective_message.contains("account home"));
        assert!(!destination.exists());
        assert_eq!(
            fs::read(home.join("account-data")).unwrap(),
            b"account-nonce"
        );
        let scoped = home.join("scoped");
        fs::create_dir(&scoped).unwrap();
        fs::write(scoped.join("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::write(scoped.join("main.js"), "export default 'scoped-nonce';").unwrap();
        symlink(scoped.join("main.js"), selected.join("scoped.js")).unwrap();
        fs::remove_file(selected.join("main.js")).unwrap();
        copy_environment_with_account_home(
            &[selection(&selected, "plugins")],
            &destination,
            &[],
            Default::default(),
            Some(home),
        )
        .unwrap();
        assert!(!destination.join("account-data").exists());
        assert_eq!(
            fs::read(destination.join("plugins/scoped.js")).unwrap(),
            b"export default 'scoped-nonce';"
        );
    }

    #[cfg(unix)]
    #[test]
    fn external_regular_link_uses_the_same_accounted_resource_budget() {
        let root = tempfile::tempdir().unwrap();
        let external = root.path().join("external.txt");
        fs::write(&external, "external-nonce").unwrap();
        let source = root.path().join("selected-link");
        symlink(&external, &source).unwrap();
        let destination = root.path().join("destination");
        let report = copy_environment(
            &[selection(&source, "alias")],
            &destination,
            &[],
            Default::default(),
        )
        .unwrap();
        assert_eq!(report.bytes, 14);
        assert!(fs::symlink_metadata(destination.join("alias"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read(destination.join("alias")).unwrap(),
            b"external-nonce"
        );
        let failed = root.path().join("failed");
        let error = copy_environment(
            &[selection(&source, "alias")],
            &failed,
            &[],
            CopyLimits {
                max_total_bytes: 13,
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(error.limit_kind, Some("total_bytes"));
        assert_eq!(error.observed, Some(14));
        assert!(!failed.exists());
    }

    #[cfg(unix)]
    #[test]
    fn missing_dangling_and_unsupported_resources_fail_without_publication() {
        use std::os::unix::net::UnixListener;
        let root = tempfile::tempdir().unwrap();
        symlink("missing", root.path().join("dangling")).unwrap();
        let _socket = UnixListener::bind(root.path().join("socket")).unwrap();
        symlink("cycle-b", root.path().join("cycle-a")).unwrap();
        symlink("cycle-a", root.path().join("cycle-b")).unwrap();
        for name in ["missing", "dangling", "socket", "cycle-a"] {
            let destination = root.path().join(format!("out-{name}"));
            let error = copy_environment(
                &[selection(&root.path().join(name), "selected")],
                &destination,
                &[],
                CopyLimits::default(),
            )
            .unwrap_err();
            assert_eq!(error.relative_path, Path::new("selected"));
            assert!(!error.corrective_message.is_empty());
            assert!(!destination.exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn overlapping_selections_share_physical_resources_without_double_byte_charge() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir_all(source.join("skill")).unwrap();
        fs::write(source.join("skill/data"), "nonce").unwrap();
        let destination = root.path().join("out");
        let report = copy_environment(
            &[
                selection(&source, "all"),
                selection(&source.join("skill"), "skill"),
                selection(&source.join("skill/data"), "skill/data"),
            ],
            &destination,
            &[],
            CopyLimits::default(),
        )
        .unwrap();
        assert_eq!(report.bytes, 5);
        assert!(fs::symlink_metadata(destination.join("skill"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read(destination.join("skill/data")).unwrap(), b"nonce");
    }

    #[cfg(unix)]
    #[test]
    fn overlapping_root_and_external_canonical_unit_preserve_the_logical_link() {
        let root = tempfile::tempdir().unwrap();
        let parent = root.path().join("source-a");
        let external = root.path().join("source-b");
        fs::create_dir(&parent).unwrap();
        fs::create_dir(&external).unwrap();
        fs::write(external.join("SKILL.md"), "fixture").unwrap();
        fs::write(external.join("data"), "nonce").unwrap();
        symlink(&external, parent.join("linked")).unwrap();
        let destination = root.path().join("destination");
        let report = copy_environment(
            &[
                selection(&parent, "skills"),
                selection(&external, "skills/linked"),
                selection(&external.join("data"), "skills/linked/data"),
            ],
            &destination,
            &[],
            Default::default(),
        )
        .unwrap();
        assert!(fs::symlink_metadata(destination.join("skills/linked"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            fs::read(destination.join("skills/linked/data")).unwrap(),
            b"nonce"
        );
        assert_eq!(report.bytes, 12);
    }

    #[test]
    fn unsafe_and_incompatible_destinations_fail_before_publication() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("one"), "one").unwrap();
        fs::write(root.path().join("two"), "two").unwrap();
        for selections in [
            vec![selection(&root.path().join("one"), "../escape")],
            vec![
                selection(&root.path().join("one"), "same"),
                selection(&root.path().join("two"), "same"),
            ],
        ] {
            let destination = root.path().join("out");
            assert!(
                copy_environment(&selections, &destination, &[], CopyLimits::default()).is_err()
            );
            assert!(!destination.exists());
        }
    }
}
