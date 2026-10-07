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
            return Err(error(path,"select_resource_scope","an external resource cannot infer the entire account home or filesystem root; select a complete resource/package directory with its own scope"));
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
            return Err(error(&path,"inspect","selected resource must be a regular file, directory or resolvable symbolic link; replace the unsupported node"));
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
    copy_environment_projection(
        selections,
        destination_root,
        excluded_canonical_sources,
        limits,
        account_home,
        &[],
    )
}

/// Directory subpaths mounted at native discovery aliases retain in-unit
/// relative links, while cross-unit links address the final physical HOME.
pub fn copy_environment_for_mounts(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    limits: CopyLimits,
    mounted_directories: &[PathBuf],
) -> Result<CopyReport, CopyError> {
    let account_home = std::env::var_os("HOME").and_then(|home| fs::canonicalize(home).ok());
    copy_environment_projection(
        selections,
        destination_root,
        excluded_canonical_sources,
        limits,
        account_home,
        mounted_directories,
    )
}

fn copy_environment_projection(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    limits: CopyLimits,
    account_home: Option<PathBuf>,
    mounted_directories: &[PathBuf],
) -> Result<CopyReport, CopyError> {
    bound(
        Path::new(""),
        "entries",
        mounted_directories.len() as u64,
        limits.max_entries as u64,
    )?;
    for root in mounted_directories {
        if !valid_relative(root) || !destination_root.is_absolute() {
            return Err(error(
                root,
                "select_mount_root",
                "mounted resource requires a normal relative root and absolute destination HOME",
            ));
        }
    }
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
            return Err(error(path,"select","selected resource is excluded native state or a credential source; keep native state in its store and use managed references for credentials"));
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
            ))
        }
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => false,
        Err(cause) => return Err(io_error(Path::new(""), "inspect_destination", cause)),
    };
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
    let temporary = TemporaryProjection::create(parent.join(format!(
        ".freshell-copy-{}-{}",
        std::process::id(),
        NEXT_PROJECTION.fetch_add(1, Ordering::Relaxed)
    )))?;
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
            }
            Node::Link(target) => {
                let mounted = mounted_directories
                    .iter()
                    .find(|root| relative.starts_with(root));
                let target = if mounted.is_some_and(|root| !target.starts_with(root)) {
                    destination_root.join(target)
                } else {
                    relative_link(relative.parent().unwrap_or(Path::new("")), target)
                };
                #[cfg(unix)]
                std::os::unix::fs::symlink(target, &destination)
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
                        ))
                    }
                    Err(cause) if cause.kind() != std::io::ErrorKind::NotFound => {
                        return Err(io_error(relative, "inspect_destination", cause))
                    }
                    _ => {}
                }
            }
            match fs::symlink_metadata(destination_root.join(relative)) {
                Ok(metadata)
                    if matches!(node, Node::Directory(_))
                        && (!metadata.is_dir() || metadata.file_type().is_symlink()) =>
                {
                    return Err(error(
                        relative,
                        "inspect_destination",
                        "existing destination type conflicts with selected resource",
                    ))
                }
                Ok(metadata) if !matches!(node, Node::Directory(_)) && metadata.is_dir() => {
                    return Err(error(
                        relative,
                        "inspect_destination",
                        "existing directory conflicts with selected resource leaf",
                    ))
                }
                Err(cause) if cause.kind() != std::io::ErrorKind::NotFound => {
                    return Err(io_error(relative, "inspect_destination", cause))
                }
                _ => {}
            }
        }
        for (relative, node) in &plan.nodes {
            let destination = destination_root.join(relative);
            match fs::symlink_metadata(&destination) {
                Ok(metadata)
                    if matches!(node, Node::Directory(_))
                        && metadata.is_dir()
                        && !metadata.file_type().is_symlink() => {}
                Ok(metadata) if metadata.is_dir() || (matches!(node, Node::Directory(_))) => {
                    return Err(error(
                        relative,
                        "publish",
                        "existing destination type conflicts with selected resource",
                    ))
                }
                Ok(_) => {}
                Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => {}
                Err(cause) => return Err(io_error(relative, "inspect_destination", cause)),
            }
            if matches!(node, Node::Directory(_)) {
                if !destination.exists() {
                    fs::create_dir(&destination)
                        .map_err(|cause| io_error(relative, "publish_directory", cause))?;
                }
                mode(&destination, 0o700, relative)?;
            } else {
                fs::rename(temporary.0.join(relative), destination)
                    .map_err(|cause| io_error(relative, "publish_leaf", cause))?;
            }
        }
    }
    let entries = plan.nodes.len();
    Ok(CopyReport {
        entries,
        bytes: actual_bytes,
        projected_paths: plan.nodes.into_keys().collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use std::os::unix::fs::{symlink, PermissionsExt};
    use std::{fs, path::Path, process::Command};

    fn selection(source: &Path, destination: &str) -> CopySelection {
        CopySelection {
            source: source.to_owned(),
            destination_relative: destination.into(),
        }
    }

    fn executable_fixture() -> tempfile::TempDir {
        match std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR") {
            Some(root) => tempfile::tempdir_in(root).unwrap(),
            None => tempfile::tempdir().unwrap(),
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
        let root = executable_fixture();
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
        let root = executable_fixture();
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
