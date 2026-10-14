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
    MountedLink(PathBuf),
}
struct Plan {
    nodes: BTreeMap<PathBuf, Node>,
    mappings: BTreeMap<PathBuf, PathBuf>,
    independent_file_roots: BTreeSet<PathBuf>,
    pending: VecDeque<(PathBuf, PathBuf, usize)>,
    exclusions: Vec<PathBuf>,
    excluded_subtree: Option<PathBuf>,
    included_subtree_resources: BTreeSet<PathBuf>,
    counted_files: BTreeSet<PathBuf>,
    bytes: u64,
    metadata_bytes: u64,
    limits: CopyLimits,
    account_home: Option<PathBuf>,
}
const MAX_METADATA_BYTES: u64 = 64 * 1024 * 1024;
impl Plan {
    fn excluded(&self, source: &Path) -> bool {
        self.exclusions.iter().any(|path| {
            if source != path && !source.starts_with(path) {
                return false;
            }
            let included_alias = self.excluded_subtree.as_ref() == Some(path)
                && self
                    .included_subtree_resources
                    .iter()
                    .any(|root| source == root || source.starts_with(root));
            !included_alias
        })
    }
    fn is_alias_into_excluded_subtree(&self, source: &Path) -> bool {
        let Some(excluded_subtree) = &self.excluded_subtree else {
            return false;
        };
        if !source.starts_with(excluded_subtree) {
            return false;
        }
        !self.exclusions.iter().any(|exclusion| {
            exclusion != excluded_subtree && (source == exclusion || source.starts_with(exclusion))
        })
    }
    fn include_selected_subtree_resource(&mut self, source: &Path) {
        if self
            .excluded_subtree
            .as_ref()
            .is_some_and(|excluded| source == excluded || source.starts_with(excluded))
        {
            self.included_subtree_resources.insert(source.to_owned());
        }
    }
    fn materialize_excluded_subtree_alias(
        &mut self,
        source: PathBuf,
        destination: PathBuf,
        depth: usize,
    ) -> Result<(), CopyError> {
        if self.is_alias_into_excluded_subtree(&source)
            && self
                .excluded_subtree
                .as_deref()
                .is_some_and(|excluded| source == excluded || source.parent() == Some(excluded))
        {
            // The managed runtime mounts the workspace at its original absolute
            // path. Keep root aliases pointed at that mount instead of
            // materializing an unbounded workspace as a package dependency.
            return self.claim(destination, Node::MountedLink(source));
        }
        let mapped = self.external_resource(&source, &destination, depth)?;
        self.claim(destination, Node::Link(mapped))
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
        let inside_excluded_subtree = self
            .excluded_subtree
            .as_ref()
            .is_some_and(|excluded| source == excluded || source.starts_with(excluded));
        for root in source.ancestors() {
            if inside_excluded_subtree
                && !self
                    .excluded_subtree
                    .as_ref()
                    .is_some_and(|excluded| root == excluded || root.starts_with(excluded))
            {
                continue;
            }
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
            Node::Directory(source)
            | Node::File(source, ..)
            | Node::Link(source)
            | Node::MountedLink(source) => source.as_os_str().len() as u64,
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
        let workspace_alias = if self.excluded(&canonical) {
            let metadata =
                fs::symlink_metadata(&source).map_err(|cause| io_error(&path, "inspect", cause))?;
            metadata.file_type().is_symlink() && self.is_alias_into_excluded_subtree(&canonical)
        } else {
            false
        };
        if self.excluded(&canonical) && !workspace_alias {
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
        let is_script = matches!(
            target.extension().and_then(|ext| ext.to_str()),
            Some("js" | "mjs" | "cjs" | "ts" | "tsx")
        );
        let mut resource = target.to_owned();
        if metadata.is_file() {
            let parent = target.parent().ok_or_else(|| {
                error(path, "plan", "linked resource has no containing directory")
            })?;
            if is_script {
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
        if let Some(excluded_subtree) = self
            .excluded_subtree
            .as_ref()
            .filter(|excluded| target == *excluded || target.starts_with(*excluded))
        {
            if target == excluded_subtree {
                return Err(error(
                    path,
                    "select_resource_scope",
                    "a link to the entire excluded workspace cannot be copied as a bounded dependency; select a package or smaller resource",
                ));
            }
            if resource == *excluded_subtree || !resource.starts_with(excluded_subtree) {
                if metadata.is_file()
                    && is_script
                    && target.parent() == Some(excluded_subtree.as_path())
                {
                    return Err(error(
                        path,
                        "select_resource_scope",
                        "a script linked directly from the excluded workspace root has no bounded sibling-resource scope; place the script and its required files in a package directory or select a smaller resource",
                    ));
                }
                resource = target
                    .parent()
                    .filter(|parent| *parent != excluded_subtree)
                    .map(Path::to_owned)
                    .unwrap_or_else(|| target.to_owned());
            }
        }
        if resource == Path::new("/") || self.account_home.as_deref() == Some(resource.as_path()) {
            return Err(error(path,"select_resource_scope","an external resource cannot infer the entire account home or filesystem root; select a complete resource/package directory with its own scope"));
        }
        let destination = Path::new(".freshell/resources/tree")
            .join(resource.strip_prefix(Path::new("/")).unwrap_or(&resource));
        self.include_selected_subtree_resource(&resource);
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
                self.include_selected_subtree_resource(&canonical);
                self.directory_mapping(&canonical, &destination, depth)?;
            }
            let package = ancestor.join("package.json");
            if package.is_file() {
                let canonical = fs::canonicalize(&package)
                    .map_err(|cause| io_error(path, "resolve_package_scope", cause))?;
                let destination = Path::new(".freshell/resources/tree")
                    .join(package.strip_prefix("/").unwrap_or(&package));
                self.include_selected_subtree_resource(&canonical);
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
            if metadata.file_type().is_symlink() && self.is_alias_into_excluded_subtree(&canonical)
            {
                let next_depth = depth
                    .checked_add(1)
                    .ok_or_else(|| error(&path, "plan", "depth accounting overflow"))?;
                return self.materialize_excluded_subtree_alias(canonical, path, next_depth);
            }
            return Ok(());
        }
        if !metadata.file_type().is_symlink() && !self.independent_file_roots.contains(&path) {
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
        CopyProjectionOptions {
            account_home,
            ..Default::default()
        },
    )
}

/// Copies a selected resource while omitting one nested tree. Symlink aliases
/// into bounded subresources are materialized at the alias path; aliases to the
/// excluded tree root or one of its top-level files remain absolute links to its
/// separately mounted workspace. A child selected directly remains bounded to
/// that child. All other exclusions still apply.
pub fn copy_environment_excluding_subtree(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    excluded_subtree: &Path,
    limits: CopyLimits,
) -> Result<CopyReport, CopyError> {
    copy_environment_excluding_subtree_for_mounts(
        selections,
        destination_root,
        excluded_canonical_sources,
        excluded_subtree,
        limits,
        &[],
    )
}

/// Exclusion-aware projection for a runtime with separately mounted resource
/// roots. Aliases at the excluded workspace root remain absolute links to that
/// mount, while mounted roots retain their existing publication behavior.
pub fn copy_environment_excluding_subtree_for_mounts(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    excluded_subtree: &Path,
    limits: CopyLimits,
    mounted_roots: &[PathBuf],
) -> Result<CopyReport, CopyError> {
    copy_environment_excluding_subtree_for_mounts_preserving_files(
        selections,
        destination_root,
        excluded_canonical_sources,
        excluded_subtree,
        limits,
        mounted_roots,
        &[],
    )
}

/// Exclusion-aware projection that can retain an existing writable exact-file
/// mount's contents during recovery while still refreshing other mounted inputs.
pub fn copy_environment_excluding_subtree_for_mounts_preserving_files(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    excluded_subtree: &Path,
    limits: CopyLimits,
    mounted_roots: &[PathBuf],
    preserve_existing_mounted_files: &[PathBuf],
) -> Result<CopyReport, CopyError> {
    let excluded_subtree = fs::canonicalize(excluded_subtree).map_err(|cause| {
        io_error(
            Path::new("excluded-subtree"),
            "resolve_excluded_subtree",
            cause,
        )
    })?;
    let mut exclusions = excluded_canonical_sources.to_vec();
    if !exclusions.contains(&excluded_subtree) {
        exclusions.push(excluded_subtree.clone());
    }
    let account_home = std::env::var_os("HOME").and_then(|home| fs::canonicalize(home).ok());
    copy_environment_projection(
        selections,
        destination_root,
        &exclusions,
        limits,
        CopyProjectionOptions {
            account_home,
            mounted_roots,
            preserve_existing_mounted_files,
            excluded_subtree: Some(excluded_subtree),
        },
    )
}

/// Mounted directory aliases retain in-unit relative links. Mounted regular
/// files retain their existing inode, so native aliases see the published bytes.
pub fn copy_environment_for_mounts(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    limits: CopyLimits,
    mounted_roots: &[PathBuf],
) -> Result<CopyReport, CopyError> {
    copy_environment_for_mounts_preserving_files(
        selections,
        destination_root,
        excluded_canonical_sources,
        limits,
        mounted_roots,
        &[],
    )
}

/// Projects mounted resources while retaining selected existing writable file
/// contents. Missing preserved files still follow normal mount publication.
pub fn copy_environment_for_mounts_preserving_files(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    limits: CopyLimits,
    mounted_roots: &[PathBuf],
    preserve_existing_mounted_files: &[PathBuf],
) -> Result<CopyReport, CopyError> {
    let account_home = std::env::var_os("HOME").and_then(|home| fs::canonicalize(home).ok());
    copy_environment_projection(
        selections,
        destination_root,
        excluded_canonical_sources,
        limits,
        CopyProjectionOptions {
            account_home,
            mounted_roots,
            preserve_existing_mounted_files,
            ..Default::default()
        },
    )
}

#[derive(Default)]
struct CopyProjectionOptions<'a> {
    account_home: Option<PathBuf>,
    mounted_roots: &'a [PathBuf],
    preserve_existing_mounted_files: &'a [PathBuf],
    excluded_subtree: Option<PathBuf>,
}

fn copy_environment_projection(
    selections: &[CopySelection],
    destination_root: &Path,
    excluded_canonical_sources: &[PathBuf],
    limits: CopyLimits,
    options: CopyProjectionOptions<'_>,
) -> Result<CopyReport, CopyError> {
    let CopyProjectionOptions {
        account_home,
        mounted_roots,
        preserve_existing_mounted_files,
        excluded_subtree,
    } = options;
    if preserve_existing_mounted_files
        .iter()
        .any(|path| !mounted_roots.contains(path))
    {
        return Err(error(
            Path::new("mounted-resource"),
            "validate_preserved_mounts",
            "preserved exact files must also be declared mounted roots",
        ));
    }
    bound(
        Path::new(""),
        "entries",
        mounted_roots.len() as u64,
        limits.max_entries as u64,
    )?;
    for root in mounted_roots {
        if !valid_relative(root) || !destination_root.is_absolute() {
            return Err(error(
                root,
                "select_mount_root",
                "mounted resource requires a normal relative root and absolute destination HOME",
            ));
        }
    }
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
    let independent_file_roots = selections
        .iter()
        .filter(|selection| mounted_roots.contains(&selection.destination_relative))
        .filter_map(|selection| {
            let metadata = fs::symlink_metadata(&selection.source).ok()?;
            (metadata.is_file() && !metadata.file_type().is_symlink())
                .then(|| selection.destination_relative.clone())
        })
        .collect();
    let mut plan = Plan {
        nodes: BTreeMap::new(),
        mappings: BTreeMap::new(),
        independent_file_roots,
        pending: VecDeque::new(),
        exclusions: excluded_canonical_sources.to_vec(),
        excluded_subtree,
        included_subtree_resources: BTreeSet::new(),
        counted_files: BTreeSet::new(),
        bytes: 0,
        metadata_bytes: 0,
        limits,
        account_home,
    };
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
        if plan
            .excluded_subtree
            .as_deref()
            .is_some_and(|excluded| canonical != excluded && canonical.starts_with(excluded))
        {
            // A specifically selected child remains an independent bounded
            // resource even when its containing workspace is separately
            // mounted and excluded from enclosing package resources.
            plan.include_selected_subtree_resource(&canonical);
        }
        if plan.excluded(&canonical) {
            return Err(error(path,"select","selected resource is excluded native state or a credential source; keep native state in its store and use managed references for credentials"));
        }
        plan.select_linked_ancestors(selection, &selections, &canonical)?;
        if metadata.file_type().is_symlink() {
            plan.enqueue(selection.source.clone(), path.clone(), 0)?;
        } else if plan.independent_file_roots.contains(path) {
            // A separately mounted exact file needs its own inode even when
            // the same source file was already copied through a selected
            // directory. Canonical-path accounting still charges its bytes
            // once.
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
    let mut prior_mounted_bytes = 0u64;
    for root in mounted_roots.iter().collect::<BTreeSet<_>>() {
        if !matches!(plan.nodes.get(root), Some(Node::File(..))) {
            continue;
        }
        let metadata = fs::symlink_metadata(destination_root.join(root))
            .map_err(|cause| io_error(root, "inspect_mounted_file", cause))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(error(
                root,
                "inspect_mounted_file",
                "mounted resource must retain an owned physical regular inode",
            ));
        }
        bound(root, "file_bytes", metadata.len(), limits.max_file_bytes)?;
        prior_mounted_bytes = prior_mounted_bytes
            .checked_add(metadata.len())
            .ok_or_else(|| {
                error(
                    root,
                    "inspect_mounted_file",
                    "prior mounted byte accounting overflow",
                )
            })?;
        bound(
            root,
            "total_bytes",
            prior_mounted_bytes,
            limits.max_total_bytes,
        )?;
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
    let temporary = TemporaryProjection::create(parent.join(format!(
        ".freshell-copy-{}-{}",
        std::process::id(),
        NEXT_PROJECTION.fetch_add(1, Ordering::Relaxed)
    )))?;
    let mut actual_bytes = 0u64;
    let mut counted_sources = BTreeSet::new();
    for (relative, node) in &plan.nodes {
        let destination = temporary.0.join(relative);
        match node {
            Node::Directory(_) => {
                fs::create_dir(&destination)
                    .map_err(|cause| io_error(relative, "create_directory", cause))?;
                mode(&destination, 0o700, relative)?;
            }
            Node::File(source, source_mode, expected) => {
                let count_source_bytes = counted_sources.insert(source.clone());
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
                    if count_source_bytes {
                        actual_bytes = actual_bytes.checked_add(read as u64).ok_or_else(|| {
                            error(relative, "read", "total byte accounting overflow")
                        })?;
                    }
                    bound(relative, "file_bytes", file_bytes, limits.max_file_bytes)?;
                    if count_source_bytes {
                        bound(
                            relative,
                            "total_bytes",
                            actual_bytes,
                            limits.max_total_bytes,
                        )?;
                    }
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
                let mounted = mounted_roots.iter().find(|root| relative.starts_with(root));
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
            Node::MountedLink(target) => {
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
            } else if mounted_roots.contains(relative) && matches!(node, Node::File(..)) {
                if preserve_existing_mounted_files.contains(relative)
                    && preserve_existing_mounted_file(&destination, relative, limits)?
                {
                    continue;
                }
                let Node::File(_, source_mode, _) = node else {
                    unreachable!()
                };
                publish_mounted_file(
                    &temporary.0.join(relative),
                    &destination,
                    &temporary.0.join(format!(
                        ".freshell-mounted-backup-{}",
                        NEXT_PROJECTION.fetch_add(1, Ordering::Relaxed)
                    )),
                    relative,
                    *source_mode,
                    limits,
                )?;
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

fn preserve_existing_mounted_file(
    destination: &Path,
    relative: &Path,
    limits: CopyLimits,
) -> Result<bool, CopyError> {
    #[cfg(unix)]
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let metadata = match fs::symlink_metadata(destination) {
        Ok(metadata) => metadata,
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(cause) => return Err(io_error(relative, "inspect_preserved_mount", cause)),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(error(
            relative,
            "inspect_preserved_mount",
            "preserved mounted resource must be a physical regular file",
        ));
    }
    bound(
        relative,
        "file_bytes",
        metadata.len(),
        limits.max_file_bytes,
    )?;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let opened = options
        .open(destination)
        .map_err(|cause| io_error(relative, "open_preserved_mount", cause))?;
    let opened_metadata = opened
        .metadata()
        .map_err(|cause| io_error(relative, "inspect_preserved_mount", cause))?;
    #[cfg(unix)]
    let inode_changed =
        metadata.dev() != opened_metadata.dev() || metadata.ino() != opened_metadata.ino();
    #[cfg(not(unix))]
    let inode_changed = false;
    if inode_changed || metadata.len() != opened_metadata.len() {
        return Err(error(
            relative,
            "inspect_preserved_mount",
            "mounted resource changed while recovery inspected its inode",
        ));
    }
    Ok(true)
}

fn publish_mounted_file(
    source: &Path,
    destination: &Path,
    backup: &Path,
    relative: &Path,
    source_mode: u32,
    limits: CopyLimits,
) -> Result<(), CopyError> {
    use std::io::{Seek, SeekFrom};
    #[cfg(unix)]
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let metadata = fs::symlink_metadata(destination)
        .map_err(|cause| io_error(relative, "inspect_mounted_file", cause))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(error(
            relative,
            "inspect_mounted_file",
            "mounted resource must retain an owned physical regular inode",
        ));
    }
    bound(
        relative,
        "file_bytes",
        metadata.len(),
        limits.max_file_bytes,
    )?;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW);
    let mut target = options
        .open(destination)
        .map_err(|cause| io_error(relative, "open_mounted_file", cause))?;
    #[cfg(unix)]
    {
        let opened = target
            .metadata()
            .map_err(|cause| io_error(relative, "inspect_mounted_file", cause))?;
        if opened.dev() != metadata.dev() || opened.ino() != metadata.ino() {
            return Err(error(
                relative,
                "inspect_mounted_file",
                "mounted resource inode changed before publication",
            ));
        }
    }
    // Preserve the previous selected bytes before modifying an inode that is
    // already bound into the worker. Both copies are streamed on its own HOME.
    let mut saved = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(backup)
        .map_err(|cause| io_error(relative, "backup_mounted_file", cause))?;
    mode(backup, 0o600, relative)?;
    let observed = std::io::copy(
        &mut (&mut target).take(metadata.len().checked_add(1).ok_or_else(|| {
            error(
                relative,
                "backup_mounted_file",
                "mounted file size overflow",
            )
        })?),
        &mut saved,
    )
    .map_err(|cause| io_error(relative, "backup_mounted_file", cause))?;
    if observed != metadata.len() {
        return Err(error(
            relative,
            "backup_mounted_file",
            "mounted resource changed before publication; retry with a quiescent owner",
        ));
    }
    let result = (|| -> std::io::Result<()> {
        let incoming = File::open(source)?;
        let expected = incoming.metadata()?.len();
        if expected > limits.max_file_bytes {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "staged mounted file exceeds copy profile",
            ));
        }
        let maximum = expected.checked_add(1).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidData, "staged file size overflow")
        })?;
        target.seek(SeekFrom::Start(0))?;
        let copied = std::io::copy(&mut incoming.take(maximum), &mut target)?;
        if copied != expected {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "staged mounted file changed",
            ));
        }
        target.set_len(copied)?;
        target.sync_all()?;
        mode(destination, private_file_mode(source_mode), relative).map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "mounted file mode publication failed",
            )
        })?;
        Ok(())
    })();
    if let Err(cause) = result {
        let restore = (|| -> std::io::Result<()> {
            saved.seek(SeekFrom::Start(0))?;
            target.seek(SeekFrom::Start(0))?;
            let restored = std::io::copy(&mut saved, &mut target)?;
            target.set_len(restored)?;
            target.sync_all()?;
            fs::set_permissions(destination, metadata.permissions())?;
            Ok(())
        })();
        if let Err(restore) = restore {
            return Err(io_error(relative, "restore_mounted_file", restore));
        }
        return Err(io_error(relative, "publish_mounted_file", cause));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn provider_environment_mounted_file_alias_reads_complete_publication_on_same_inode() {
        use std::io::{Read, Seek};
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("selected-instructions");
        fs::write(&source, b"complete selected instructions").unwrap();
        let home = fixture.path().join("provider-home");
        let leaf = PathBuf::from(".freshell/provider-roots/root-0/source");
        fs::create_dir_all(home.join(leaf.parent().unwrap())).unwrap();
        fs::write(home.join(&leaf), b"").unwrap();
        // Docker binds the already owned regular inode at a native alias
        // before the session host publishes its complete selected inputs.
        let mut alias = fs::File::open(home.join(&leaf)).unwrap();
        let selection = [CopySelection {
            source: source.clone(),
            destination_relative: leaf.clone(),
        }];
        for content in [
            b"complete selected instructions".as_slice(),
            b"replacement selected instructions".as_slice(),
        ] {
            fs::write(&source, content).unwrap();
            copy_environment_for_mounts(
                &selection,
                &home,
                &[],
                CopyLimits::default(),
                std::slice::from_ref(&leaf),
            )
            .unwrap();
            alias.rewind().unwrap();
            let mut observed = Vec::new();
            alias.read_to_end(&mut observed).unwrap();
            assert_eq!(observed,content,"an existing native file alias must see complete initial and refreshed resource bytes");
        }
    }

    #[test]
    fn provider_environment_recovery_keeps_existing_writable_mount_and_refreshes_read_only_mount() {
        use std::io::{Read, Seek, SeekFrom, Write};
        let fixture = tempfile::tempdir().unwrap();
        let writable_source = fixture.path().join("writable-source");
        let readonly_source = fixture.path().join("readonly-source");
        fs::write(&writable_source, b"writable seed").unwrap();
        fs::write(&readonly_source, b"readonly seed").unwrap();
        let home = fixture.path().join("provider-home");
        let writable = PathBuf::from(".freshell/provider-roots/writable/source");
        let readonly = PathBuf::from(".freshell/provider-roots/readonly/source");
        fs::create_dir_all(home.join(writable.parent().unwrap())).unwrap();
        fs::create_dir_all(home.join(readonly.parent().unwrap())).unwrap();
        fs::write(home.join(&writable), b"").unwrap();
        fs::write(home.join(&readonly), b"").unwrap();
        // The provider's native volume alias points at this same exact-file
        // inode and writes to it while the runtime is alive.
        let mut native_alias = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(home.join(&writable))
            .unwrap();
        let selections = [
            selection(&writable_source, writable.to_str().unwrap()),
            selection(&readonly_source, readonly.to_str().unwrap()),
        ];
        let mounted = [writable.clone(), readonly.clone()];
        copy_environment_for_mounts(&selections, &home, &[], CopyLimits::default(), &mounted)
            .unwrap();
        native_alias.seek(SeekFrom::End(0)).unwrap();
        native_alias.write_all(b" + runtime state").unwrap();
        fs::write(&writable_source, b"refreshed writable seed").unwrap();
        fs::write(&readonly_source, b"refreshed readonly seed").unwrap();

        copy_environment_for_mounts_preserving_files(
            &selections,
            &home,
            &[],
            CopyLimits::default(),
            &mounted,
            std::slice::from_ref(&writable),
        )
        .unwrap();

        native_alias.seek(SeekFrom::Start(0)).unwrap();
        let mut runtime_state = Vec::new();
        native_alias.read_to_end(&mut runtime_state).unwrap();
        assert_eq!(
            runtime_state, b"writable seed + runtime state",
            "recovery must retain runtime data in an existing writable mount"
        );
        assert_eq!(
            fs::read(home.join(&readonly)).unwrap(),
            b"refreshed readonly seed",
            "ordinary read-only mounted inputs must still refresh"
        );
    }

    #[cfg(unix)]
    #[test]
    fn provider_environment_mounted_file_invalid_target_and_profile_failure_preserve_prior_bytes() {
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("source");
        fs::write(&source, b"x").unwrap();
        let home = fixture.path().join("provider-home");
        let leaf = PathBuf::from(".freshell/provider-roots/root-0/source");
        fs::create_dir_all(home.join(leaf.parent().unwrap())).unwrap();
        fs::write(home.join(&leaf), b"prior selected bytes").unwrap();
        let selection = [CopySelection {
            source: source.clone(),
            destination_relative: leaf.clone(),
        }];
        let limits = CopyLimits {
            max_total_bytes: 2,
            ..Default::default()
        };
        assert!(copy_environment_for_mounts(
            &selection,
            &home,
            &[],
            limits,
            std::slice::from_ref(&leaf)
        )
        .is_err());
        assert_eq!(fs::read(home.join(&leaf)).unwrap(), b"prior selected bytes");
        let outside = fixture.path().join("unselected");
        fs::write(&outside, b"unselected original bytes").unwrap();
        fs::remove_file(home.join(&leaf)).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(&leaf)).unwrap();
        assert!(copy_environment_for_mounts(
            &selection,
            &home,
            &[],
            Default::default(),
            std::slice::from_ref(&leaf)
        )
        .is_err());
        assert_eq!(fs::read(&outside).unwrap(), b"unselected original bytes");
        assert!(fs::symlink_metadata(home.join(&leaf))
            .unwrap()
            .file_type()
            .is_symlink());
    }

    #[test]
    fn provider_environment_shared_mounted_file_aliases_use_one_prior_byte_budget() {
        let fixture = tempfile::tempdir().unwrap();
        let source = fixture.path().join("source");
        fs::write(&source, b"y").unwrap();
        let home = fixture.path().join("provider-home");
        let leaf = PathBuf::from(".freshell/provider-roots/root-0/source");
        fs::create_dir_all(home.join(leaf.parent().unwrap())).unwrap();
        fs::write(home.join(&leaf), b"x").unwrap();
        let selections = [CopySelection {
            source,
            destination_relative: leaf.clone(),
        }];
        copy_environment_for_mounts(&selections,&home,&[],CopyLimits {max_total_bytes:1,..Default::default()},&[leaf.clone(),leaf.clone(),leaf.clone()])
            .expect("three native aliases to one physical resource must retain the full shared byte capacity");
        assert_eq!(fs::read(home.join(leaf)).unwrap(), b"y");
    }

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

    #[cfg(unix)]
    fn execute_fixture_with_transient_text_file_busy_retry(
        path: &Path,
    ) -> std::io::Result<std::process::Output> {
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            match Command::new(path).output() {
                Err(error)
                    if error.raw_os_error() == Some(libc::ETXTBSY)
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Ok(output)
                    if !output.status.success()
                        && output
                            .stderr
                            .windows(b"Text file busy".len())
                            .any(|window| window == b"Text file busy")
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                result => return result,
            }
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
    fn excluding_nested_tree_materializes_only_selected_alias_targets() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        let package = source.join("external");
        let workspace = source.join("project");
        let selected_package = workspace.join("packages/local-package");
        let manifest = r#"{"name":"local-package"}"#;
        let module = "export const value = 1;\n";
        fs::create_dir_all(package.join("node_modules")).unwrap();
        fs::create_dir_all(&selected_package).unwrap();
        fs::write(workspace.join("private-project-data"), "must stay excluded").unwrap();
        fs::write(selected_package.join("package.json"), manifest).unwrap();
        fs::write(selected_package.join("index.js"), module).unwrap();
        symlink(
            "../../project/packages/local-package",
            package.join("node_modules/local-package"),
        )
        .unwrap();
        let destination = root.path().join("provider");

        let report = copy_environment_excluding_subtree(
            &[selection(&package, "package")],
            &destination,
            &[],
            &workspace,
            CopyLimits::default(),
        )
        .unwrap();

        let materialized = destination.join("package/node_modules/local-package");
        assert!(materialized.join("package.json").is_file());
        assert_eq!(
            fs::read_to_string(materialized.join("index.js")).unwrap(),
            module
        );
        assert!(
            !destination
                .join("package/project/private-project-data")
                .exists(),
            "ordinary workspace files remain excluded"
        );
        assert_eq!(
            report.bytes,
            (manifest.len() + module.len()) as u64,
            "the enclosing workspace itself is not charged or copied"
        );

        let credential_excluded = root.path().join("credential-excluded-provider");
        copy_environment_excluding_subtree(
            &[selection(&package, "package")],
            &credential_excluded,
            &[selected_package.canonicalize().unwrap()],
            &workspace,
            CopyLimits::default(),
        )
        .unwrap();
        assert!(
            !credential_excluded
                .join("package/node_modules/local-package")
                .exists(),
            "the nested-tree allowance must not override another exclusion"
        );
    }

    #[cfg(unix)]
    #[test]
    fn excluded_workspace_file_alias_keeps_its_sibling_package_resources() {
        let root = tempfile::tempdir().unwrap();
        let external = root.path().join("external");
        let workspace = external.join("project");
        let worker_package = workspace.join("packages/worker-package");
        let tools = external.join("tools");
        fs::create_dir_all(&worker_package).unwrap();
        fs::create_dir_all(&tools).unwrap();
        fs::write(external.join("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::write(
            worker_package.join("schema.json"),
            r#"{"nonce":"linked-file-sibling-loaded"}"#,
        )
        .unwrap();
        fs::write(
            worker_package.join("worker.mjs"),
            "import { readFileSync } from 'node:fs';\nconst schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));\nexport const nonce = schema.nonce;\n",
        )
        .unwrap();
        symlink(
            "../project/packages/worker-package/worker.mjs",
            tools.join("worker-link.mjs"),
        )
        .unwrap();
        fs::write(
            tools.join("server.mjs"),
            "import { nonce } from './worker-link.mjs';\nprocess.stdout.write(nonce + '\\n');\n",
        )
        .unwrap();

        let destination = root.path().join("provider");
        copy_environment_excluding_subtree(
            &[selection(&external, "resource")],
            &destination,
            &[],
            &workspace,
            CopyLimits::default(),
        )
        .unwrap();
        let copied_server = destination.join("resource/tools/server.mjs");
        let hidden = root.path().join("external-hidden");
        fs::rename(&external, &hidden).unwrap();
        let output = Command::new("node")
            .arg(&copied_server)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output();
        fs::rename(&hidden, &external).unwrap();
        let output = output.unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"linked-file-sibling-loaded\n");
    }

    #[cfg(unix)]
    #[test]
    fn excluded_workspace_root_file_alias_uses_the_separately_mounted_workspace() {
        let root = tempfile::tempdir().unwrap();
        let external = root.path().join("external");
        let workspace = external.join("project");
        let tools = external.join("tools");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&tools).unwrap();
        fs::write(external.join("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::write(
            workspace.join("schema.json"),
            r#"{"nonce":"workspace-root-sibling-loaded"}"#,
        )
        .unwrap();
        fs::write(
            workspace.join("worker.mjs"),
            "import { readFileSync } from 'node:fs';\nconst schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));\nexport const nonce = schema.nonce;\n",
        )
        .unwrap();
        symlink("../project/worker.mjs", tools.join("worker-link.mjs")).unwrap();
        fs::write(
            tools.join("server.mjs"),
            "import { nonce } from './worker-link.mjs';\nprocess.stdout.write(nonce + '\\n');\n",
        )
        .unwrap();

        let destination = root.path().join("provider");
        copy_environment_excluding_subtree(
            &[selection(&external, "resource")],
            &destination,
            &[],
            &workspace,
            CopyLimits::default(),
        )
        .unwrap();
        let copied_root = destination.join("resource");
        assert_eq!(
            fs::canonicalize(copied_root.join("tools/worker-link.mjs")).unwrap(),
            workspace.join("worker.mjs").canonicalize().unwrap(),
            "the linked script resolves through the separately mounted workspace"
        );
        assert!(
            !copied_root.join("project").exists(),
            "the workspace is not copied under the package resource"
        );
        let output = Command::new("node")
            .arg(copied_root.join("tools/server.mjs"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"workspace-root-sibling-loaded\n");
    }

    #[cfg(unix)]
    #[test]
    fn excluded_workspace_root_alias_uses_the_separately_mounted_workspace() {
        let root = tempfile::tempdir().unwrap();
        let external = root.path().join("external");
        let workspace = external.join("project");
        fs::create_dir_all(workspace.join("packages")).unwrap();
        fs::create_dir_all(external.join("node_modules")).unwrap();
        fs::write(workspace.join("private-project-data"), "do not copy").unwrap();
        fs::write(
            workspace.join("index.mjs"),
            "export const nonce = 'workspace-root-package-loaded';\n",
        )
        .unwrap();
        symlink("../project", external.join("node_modules/workspace")).unwrap();
        fs::write(external.join("package.json"), r#"{"type":"module"}"#).unwrap();
        fs::write(
            external.join("server.mjs"),
            "import { nonce } from './node_modules/workspace/index.mjs';\nprocess.stdout.write(nonce + '\\n');\n",
        )
        .unwrap();
        let destination = root.path().join("provider");

        copy_environment_excluding_subtree(
            &[selection(&external, "resource")],
            &destination,
            &[],
            &workspace,
            CopyLimits::default(),
        )
        .unwrap();

        let copied_root = destination.join("resource");
        assert_eq!(
            fs::canonicalize(copied_root.join("node_modules/workspace")).unwrap(),
            workspace.canonicalize().unwrap(),
            "the local package alias must resolve to the separately mounted workspace"
        );
        assert!(
            !copied_root.join("project/private-project-data").exists(),
            "the excluded workspace is not copied as a package dependency"
        );
        let output = Command::new("node")
            .arg(copied_root.join("server.mjs"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"workspace-root-package-loaded\n");
    }

    #[test]
    fn excluded_workspace_keeps_explicitly_selected_child_resources() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("selected-config.json"), "selected config").unwrap();
        fs::write(workspace.join("unselected-workspace-data"), "keep out").unwrap();
        let destination = root.path().join("provider");

        copy_environment_excluding_subtree(
            &[selection(
                &workspace.join("selected-config.json"),
                "config.json",
            )],
            &destination,
            &[],
            &workspace,
            CopyLimits::default(),
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(destination.join("config.json")).unwrap(),
            "selected config"
        );
        assert!(
            !destination.join("unselected-workspace-data").exists(),
            "an explicitly selected child does not widen into its workspace"
        );
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
            let output = execute_fixture_with_transient_text_file_busy_retry(
                &home.join("skills/fixture/scripts/run"),
            )
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

    #[test]
    fn default_copy_entry_capacity_survives_both_stages_and_rejects_one_more() {
        let root = executable_fixture();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        for index in 0..99_999 {
            fs::write(source.join(format!("f{index:05}")), []).unwrap();
        }
        fs::write(source.join("f99998"), b"entry-capacity-nonce").unwrap();
        let (first, second, home) = copy_default_twice(&source, root.path());
        assert_eq!((first.entries, second.entries), (100_000, 100_000));
        assert_eq!((first.bytes, second.bytes), (20, 20));
        assert_eq!(
            fs::read(home.join("resource/f99998")).unwrap(),
            b"entry-capacity-nonce"
        );
        fs::write(source.join("extra"), []).unwrap();
        let rejected = copy_environment(
            &[selection(&source, "resource")],
            &home,
            &[],
            CopyLimits::default(),
        )
        .unwrap_err();
        assert_eq!(rejected.limit_kind, Some("entries"));
        assert_eq!(
            (rejected.observed, rejected.permitted),
            (Some(100_001), Some(100_000))
        );
        assert_eq!(
            fs::read(home.join("resource/f99998")).unwrap(),
            b"entry-capacity-nonce"
        );
        assert!(!home.join("resource/extra").exists());
        assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
    }

    #[test]
    fn default_copy_actual_metadata_capacity_preserves_both_stages_on_one_byte_overflow() {
        fn destination(length: usize) -> PathBuf {
            assert!((402..=656).contains(&length));
            PathBuf::from("a".repeat(200))
                .join("b".repeat(199))
                .join("c".repeat(length - 401))
        }
        fn name(index: usize, length: usize) -> String {
            let prefix = format!("f{index:06}");
            assert!((prefix.len()..=255).contains(&length));
            format!("{prefix}{}", "x".repeat(length - prefix.len()))
        }
        fn verify(directory: &Path, names: &[String]) {
            assert_eq!(fs::read_dir(directory).unwrap().count(), names.len());
            for (index, name) in names.iter().enumerate() {
                assert_eq!(
                    fs::read(directory.join(name)).unwrap(),
                    (index as u64).to_le_bytes()
                );
            }
        }
        fn verify_projection(root: &Path, relative: &Path, alias_length: usize, names: &[String]) {
            let alias = root.join("z".repeat(alias_length));
            assert!(fs::symlink_metadata(&alias)
                .unwrap()
                .file_type()
                .is_symlink());
            assert_eq!(
                fs::canonicalize(&alias).unwrap(),
                fs::canonicalize(root.join(relative)).unwrap()
            );
            verify(&root.join(relative), names);
            verify(&alias, names);
            assert_eq!(fs::read_dir(root).unwrap().count(), 2);
        }
        fn mark_unread(directory: &Path, names: &[String]) -> std::time::SystemTime {
            let before = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1);
            for name in names {
                File::options()
                    .write(true)
                    .open(directory.join(name))
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_accessed(before))
                    .unwrap();
            }
            before
        }
        fn verify_unread(directory: &Path, names: &[String], before: std::time::SystemTime) {
            for name in names {
                assert_eq!(
                    fs::metadata(directory.join(name))
                        .unwrap()
                        .accessed()
                        .unwrap(),
                    before
                );
            }
        }
        fn selections(source: &Path, relative: &Path, alias_length: usize) -> [CopySelection; 2] {
            [
                CopySelection {
                    source: source.into(),
                    destination_relative: relative.into(),
                },
                selection(source, &"z".repeat(alias_length)),
            ]
        }

        let root = executable_fixture();
        let mut source = root.path().join("s".repeat(200)).join("t".repeat(200));
        let remaining = 500usize.checked_sub(source.as_os_str().len() + 1).unwrap();
        assert!((1..=255).contains(&remaining));
        source.push("u".repeat(remaining));
        fs::create_dir_all(&source).unwrap();
        assert_eq!(source.as_os_str().len(), 500);
        assert_eq!(fs::canonicalize(&source).unwrap().as_os_str().len(), 500);
        let first_relative = destination(500);
        assert_eq!(first_relative.as_os_str().len(), 500);
        // Both graphs retain a 1000-byte source/destination path pair, 600
        // bytes of connecting parents, and a 508-byte selected directory alias
        // (including the retained separator on its mapped directory target).
        // Ten adjustable physical filenames calibrate the real graph at 64 MiB.
        let limit = 64 * 1024 * 1024usize;
        let base = 2 * 1000 + 600 + 508;
        let full_count = (limit - base - 10 * 1002 - 2 * 160) / 1402;
        let mut extra = (limit - base - full_count * 1402 - 10 * 1002) / 2;
        let mut names: Vec<_> = (0..full_count).map(|index| name(index, 200)).collect();
        for index in 0..10 {
            let length = (extra - (9 - index) * 7).min(255);
            names.push(name(full_count + index, length));
            extra -= length;
        }
        assert_eq!(extra, 0);
        assert_eq!(
            base + names
                .iter()
                .map(|name| 1002 + 2 * name.len())
                .sum::<usize>(),
            limit
        );
        for (index, name) in names.iter().enumerate() {
            fs::write(source.join(name), (index as u64).to_le_bytes()).unwrap();
            assert_eq!(
                fs::canonicalize(source.join(name))
                    .unwrap()
                    .as_os_str()
                    .len(),
                501 + name.len()
            );
        }
        let stage = root.path().join("stage");
        let first = copy_environment(
            &selections(&source, &first_relative, 7),
            &stage,
            &[],
            CopyLimits::default(),
        )
        .unwrap();
        assert_eq!(
            (first.entries, first.bytes),
            (names.len() + 4, (8 * names.len()) as u64)
        );
        let staged_source = stage.join(&first_relative);
        verify_projection(&stage, &first_relative, 7, &names);
        let second_relative = destination(500 - stage.as_os_str().len() - 1);
        let second_alias_length = 507 - second_relative.as_os_str().len();
        let home = root.path().join("home");
        let second = copy_environment(
            &selections(&staged_source, &second_relative, second_alias_length),
            &home,
            &[],
            CopyLimits::default(),
        )
        .unwrap();
        assert_eq!((first.entries, first.bytes), (second.entries, second.bytes));
        verify_projection(&home, &second_relative, second_alias_length, &names);
        // Only the logical alias grows by one byte. The underlying file names
        // and contents remain unchanged; the two rejected attempts must not
        // open any regular source file or alter either previous publication.
        for (source, destination, relative, alias_length) in [
            (&source, &stage, &first_relative, 7),
            (&staged_source, &home, &second_relative, second_alias_length),
        ] {
            let before = mark_unread(source, &names);
            let failure = copy_environment(
                &selections(source, relative, alias_length + 1),
                destination,
                &[],
                CopyLimits::default(),
            )
            .unwrap_err();
            assert_eq!(failure.limit_kind, Some("metadata_bytes"));
            assert_eq!(
                (failure.observed, failure.permitted),
                (Some(limit as u64 + 1), Some(limit as u64))
            );
            verify_unread(source, &names, before);
            verify_projection(destination, relative, alias_length, &names);
            assert!(!destination.join("z".repeat(alias_length + 1)).exists());
        }
        assert_eq!(fs::read_dir(root.path()).unwrap().count(), 3);
        println!(
            "RESOURCE_METADATA_CAPACITY={}",
            serde_json::json!({"bytes":limit,"entries":first.entries,"fileBytes":first.bytes,"copies":2,"oneByteOverRejected":2})
        );
    }

    fn copy_default_twice(source: &Path, root: &Path) -> (CopyReport, CopyReport, PathBuf) {
        let stage = root.join("stage");
        let first = copy_environment(
            &[selection(source, "resource")],
            &stage,
            &[],
            CopyLimits::default(),
        )
        .unwrap();
        let home = root.join("home");
        let second = copy_environment(
            &[selection(&stage.join("resource"), "resource")],
            &home,
            &[],
            CopyLimits::default(),
        )
        .unwrap();
        (first, second, home)
    }

    fn verify_capacity_payloads(home: &Path) {
        for index in 0..4 {
            let mut input = File::open(home.join(format!("resource/payload{index}"))).unwrap();
            let mut bytes = 0u64;
            let mut actual = [0u8; 64 * 1024];
            loop {
                let length = input.read(&mut actual).unwrap();
                if length == 0 {
                    break;
                }
                assert!(actual[..length].iter().all(|byte| *byte == 0x5a));
                bytes += length as u64;
            }
            assert_eq!(bytes, 128 * 1024 * 1024);
        }
    }

    fn mark_capacity_sources_unread(source: &Path) -> std::time::SystemTime {
        let before = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1);
        for index in 0..4 {
            File::options()
                .write(true)
                .open(source.join(format!("payload{index}")))
                .unwrap()
                .set_times(fs::FileTimes::new().set_accessed(before))
                .unwrap();
        }
        before
    }

    fn verify_capacity_sources_unread(source: &Path, before: std::time::SystemTime) {
        for index in 0..4 {
            assert_eq!(
                fs::metadata(source.join(format!("payload{index}")))
                    .unwrap()
                    .accessed()
                    .unwrap(),
                before
            );
        }
    }

    #[test]
    fn default_copy_byte_capacity_reads_both_complete_stages_and_rejects_overflow() {
        let root = executable_fixture();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        let block = [0x5au8; 64 * 1024];
        for index in 0..4 {
            let mut file = File::create(source.join(format!("payload{index}"))).unwrap();
            for _ in 0..2048 {
                file.write_all(&block).unwrap();
            }
        }
        let (first, second, home) = copy_default_twice(&source, root.path());
        assert_eq!(
            (first.bytes, second.bytes),
            (512 * 1024 * 1024, 512 * 1024 * 1024)
        );
        verify_capacity_payloads(&home);
        fs::write(source.join("extra"), b"x").unwrap();
        let unread = mark_capacity_sources_unread(&source);
        let total = copy_environment(
            &[selection(&source, "resource")],
            &home,
            &[],
            CopyLimits::default(),
        )
        .unwrap_err();
        assert_eq!(total.limit_kind, Some("total_bytes"));
        assert_eq!(
            (total.observed, total.permitted),
            (Some(512 * 1024 * 1024 + 1), Some(512 * 1024 * 1024))
        );
        assert!(!home.join("resource/extra").exists());
        verify_capacity_sources_unread(&source, unread);
        verify_capacity_payloads(&home);
        fs::remove_file(source.join("extra")).unwrap();
        OpenOptions::new()
            .append(true)
            .open(source.join("payload0"))
            .unwrap()
            .write_all(b"x")
            .unwrap();
        let unread = mark_capacity_sources_unread(&source);
        let file = copy_environment(
            &[selection(&source, "resource")],
            &home,
            &[],
            CopyLimits::default(),
        )
        .unwrap_err();
        assert_eq!(file.limit_kind, Some("file_bytes"));
        assert_eq!(
            (file.observed, file.permitted),
            (Some(128 * 1024 * 1024 + 1), Some(128 * 1024 * 1024))
        );
        verify_capacity_sources_unread(&source, unread);
        verify_capacity_payloads(&home);
        assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
    }

    #[test]
    fn default_copy_depth_capacity_survives_both_stages_and_rejects_one_more() {
        let root = executable_fixture();
        let source = root.path().join("source");
        fs::create_dir(&source).unwrap();
        let mut leaf = source.clone();
        let mut relative = PathBuf::new();
        for _ in 0..63 {
            leaf.push("d");
            relative.push("d");
            fs::create_dir(&leaf).unwrap();
        }
        fs::write(leaf.join("nonce"), b"depth-capacity-nonce").unwrap();
        let (_, _, home) = copy_default_twice(&source, root.path());
        let published = home.join("resource").join(&relative).join("nonce");
        assert_eq!(fs::read(&published).unwrap(), b"depth-capacity-nonce");
        fs::create_dir(leaf.join("d")).unwrap();
        fs::write(leaf.join("d/extra"), b"x").unwrap();
        let error = copy_environment(
            &[selection(&source, "resource")],
            &home,
            &[],
            CopyLimits::default(),
        )
        .unwrap_err();
        assert_eq!(error.limit_kind, Some("depth"));
        assert_eq!((error.observed, error.permitted), (Some(65), Some(64)));
        assert_eq!(fs::read(published).unwrap(), b"depth-capacity-nonce");
        assert!(!home.join("resource").join(relative).join("d").exists());
        assert_eq!(fs::read_dir(&home).unwrap().count(), 1);
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
    fn mounted_nested_file_root_keeps_an_independent_inode_and_single_byte_charge() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source");
        fs::create_dir_all(source.join("mcp")).unwrap();
        fs::write(source.join("mcp/state.json"), "nonce").unwrap();
        let destination = root.path().join("out");
        fs::create_dir_all(destination.join("exact")).unwrap();
        fs::write(destination.join("exact/source"), []).unwrap();

        let report = copy_environment_for_mounts(
            &[
                selection(&source.join("mcp"), "directory"),
                selection(&source.join("mcp/state.json"), "exact/source"),
            ],
            &destination,
            &[],
            CopyLimits {
                max_total_bytes: 5,
                ..CopyLimits::default()
            },
            &[PathBuf::from("exact/source")],
        )
        .unwrap();

        assert_eq!(
            report.bytes, 5,
            "duplicate physical copies share one byte charge"
        );
        for path in [
            destination.join("directory/state.json"),
            destination.join("exact/source"),
        ] {
            let metadata = fs::symlink_metadata(&path).unwrap();
            assert!(metadata.is_file() && !metadata.file_type().is_symlink());
        }
        fs::write(destination.join("exact/source"), "runtime state").unwrap();
        assert_eq!(
            fs::read(destination.join("directory/state.json")).unwrap(),
            b"nonce",
            "the exact mounted file must not alias its selected directory copy"
        );
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
