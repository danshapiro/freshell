//! Select ordinary Markdown imports from their declaring logical origins.
use freshell_platform::provider_input_profiles::{
    MAX_SIMULTANEOUS_SOURCE_VIEW_BYTES, MAX_SOURCE_EVENTS, MAX_SOURCE_EVENT_BYTES,
    MAX_SOURCE_VIEW_BYTES,
};
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

pub(super) fn imports(
    home: &Path,
    roots: &[PathBuf],
    user_rules: &[PathBuf],
    excluded: &[PathBuf],
) -> Result<Vec<PathBuf>, String> {
    imports_with_frozen(home, roots, user_rules, &[], &[], excluded, None)
        .map(|(fresh, frozen)| fresh.into_iter().chain(frozen).collect())
}

pub(super) fn imports_with_frozen(
    home: &Path,
    roots: &[PathBuf],
    user_rules: &[PathBuf],
    frozen_roots: &[PathBuf],
    frozen_rules: &[PathBuf],
    excluded: &[PathBuf],
    frozen_source: Option<&dyn Fn(&Path) -> Result<PathBuf, String>>,
) -> Result<(Vec<PathBuf>, Vec<PathBuf>), String> {
    let excluded = excluded
        .iter()
        .map(|path| std::fs::canonicalize(path).unwrap_or_else(|_| path.clone()))
        .collect::<Vec<_>>();
    let mut graph = ImportGraph {
        home,
        excluded: &excluded,
        active: BTreeSet::new(),
        visited: BTreeSet::new(),
        sources: BTreeMap::new(),
        bytes: 0,
        events: 0,
        path_bytes: 0,
        selected: Vec::new(),
        rule_directories: BTreeSet::new(),
        rule_entries: 0,
        rule_path_bytes: 0,
        frozen_source,
    };
    for root in frozen_roots {
        graph.visit(root, 0, true)?;
    }
    for root in frozen_rules {
        graph.visit_rules(root, 0, true)?;
    }
    for root in roots {
        graph.visit(root, 0, false)?;
    }
    // Native user rules use the same Markdown import parser, including
    // external imports, before conditional rules are activated by the provider.
    for root in user_rules {
        graph.visit_rules(root, 0, false)?;
    }
    let (frozen, fresh): (Vec<_>, Vec<_>) =
        graph.selected.into_iter().partition(|(_, frozen)| *frozen);
    Ok((
        fresh.into_iter().map(|(path, _)| path).collect(),
        frozen.into_iter().map(|(path, _)| path).collect(),
    ))
}

struct ImportGraph<'a> {
    home: &'a Path,
    excluded: &'a [PathBuf],
    active: BTreeSet<PathBuf>,
    visited: BTreeSet<PathBuf>,
    sources: BTreeMap<PathBuf, Arc<String>>,
    bytes: u64,
    events: usize,
    path_bytes: usize,
    selected: Vec<(PathBuf, bool)>,
    rule_directories: BTreeSet<PathBuf>,
    rule_entries: usize,
    rule_path_bytes: usize,
    frozen_source: Option<&'a dyn Fn(&Path) -> Result<PathBuf, String>>,
}
impl ImportGraph<'_> {
    fn source(&self, logical: &Path, frozen: bool) -> Result<PathBuf, String> {
        if frozen {
            self.frozen_source
                .ok_or("Claude frozen source view unavailable")?(logical)
        } else {
            std::fs::canonicalize(logical)
                .map_err(|cause| format!("selected source unavailable: {cause}"))
        }
    }
    fn visit_rules(&mut self, logical: &Path, depth: usize, frozen: bool) -> Result<(), String> {
        let limits = freshell_platform::provider_environment::CopyLimits::default();
        let error =
            |cause: &str| format!("Claude selected user rules {}: {cause}", logical.display());
        if depth > limits.max_depth {
            return Err(error("resource depth profile exceeded"));
        }
        let source = self
            .source(logical, frozen)
            .map_err(|cause| error(&cause))?;
        if self
            .excluded
            .iter()
            .any(|excluded| source.starts_with(excluded) || logical.starts_with(excluded))
        {
            return Err(error(
                "selected private or native-state source cannot become ordinary rules",
            ));
        }
        if self.active.contains(&source) {
            return Err(error("cyclic selected rules directory"));
        }
        if !self.rule_directories.insert(logical.to_owned()) {
            return Ok(());
        }
        self.active.insert(source.clone());
        let entries = std::fs::read_dir(&source)
            .map_err(|cause| error(&format!("selected directory unreadable: {cause}")))?;
        let mut paths = Vec::new();
        for entry in entries {
            let entry = entry
                .map_err(|cause| error(&format!("selected directory entry unavailable: {cause}")))?
                .file_name();
            let path = logical.join(entry);
            self.rule_entries = self
                .rule_entries
                .checked_add(1)
                .ok_or_else(|| error("resource entry accounting overflow"))?;
            self.rule_path_bytes = self
                .rule_path_bytes
                .checked_add(path.as_os_str().len())
                .ok_or_else(|| error("resource metadata accounting overflow"))?;
            if self.rule_entries > limits.max_entries || self.rule_path_bytes > 64 * 1024 * 1024 {
                return Err(error("resource entry or metadata profile exceeded"));
            }
            paths.push(path);
        }
        paths.sort();
        for path in paths {
            let physical = self.source(&path, frozen).map_err(|cause| error(&cause))?;
            let metadata = std::fs::metadata(&physical).map_err(|cause| {
                error(&format!(
                    "selected rule {} metadata failed: {cause}",
                    path.display()
                ))
            })?;
            if metadata.is_dir() {
                self.visit_rules(&path, depth + 1, frozen)?;
            } else if path.extension().is_some_and(|extension| extension == "md") {
                self.visit(&path, depth + 1, frozen)?;
            }
        }
        self.active.remove(&source);
        Ok(())
    }

    fn visit(&mut self, logical: &Path, depth: usize, frozen: bool) -> Result<(), String> {
        let logical = normalize(logical);
        let error = |cause: &str| format!("Claude memory import {}: {cause}", logical.display());
        if depth > freshell_platform::provider_environment::CopyLimits::default().max_depth {
            return Err(error("resource depth profile exceeded"));
        }
        let source = self
            .source(&logical, frozen)
            .map_err(|cause| error(&cause))?;
        if self
            .excluded
            .iter()
            .any(|excluded| source.starts_with(excluded) || logical.starts_with(excluded))
        {
            return Err(error(
                "selected private or native-state source cannot become ordinary memory",
            ));
        }
        if self.active.contains(&source) {
            return Err(error("cyclic selected memory import"));
        }
        if self.visited.contains(&logical) {
            return Ok(());
        }
        if self.visited.len() >= MAX_SOURCE_EVENTS {
            return Err(error("ordinary source event profile exceeded"));
        }
        let path_bytes = self
            .path_bytes
            .checked_add(logical.as_os_str().len())
            .and_then(|bytes| bytes.checked_add(source.as_os_str().len()))
            .ok_or_else(|| error("ordinary source metadata accounting overflow"))?;
        if path_bytes > MAX_SOURCE_EVENT_BYTES {
            return Err(error("ordinary source event metadata profile exceeded"));
        }
        self.path_bytes = path_bytes;
        let raw = if let Some(raw) = self.sources.get(&source) {
            Arc::clone(raw)
        } else {
            let file = std::fs::File::open(&source)
                .map_err(|cause| error(&format!("selected file unreadable: {cause}")))?;
            let metadata = file
                .metadata()
                .map_err(|cause| error(&format!("selected file metadata failed: {cause}")))?;
            if !metadata.is_file() || metadata.len() > MAX_SOURCE_VIEW_BYTES {
                return Err(error("ordinary source type or per-view profile exceeded"));
            }
            let next = self
                .bytes
                .checked_add(metadata.len())
                .ok_or_else(|| error("reference source accounting overflow"))?;
            if next > MAX_SIMULTANEOUS_SOURCE_VIEW_BYTES {
                return Err(error("ordinary simultaneous source view profile exceeded"));
            }
            let mut raw = String::new();
            file.take(MAX_SOURCE_VIEW_BYTES + 1)
                .read_to_string(&mut raw)
                .map_err(|cause| error(&format!("selected Markdown read failed: {cause}")))?;
            let next = self
                .bytes
                .checked_add(raw.len() as u64)
                .ok_or_else(|| error("reference source accounting overflow"))?;
            if raw.len() as u64 > MAX_SOURCE_VIEW_BYTES || next > MAX_SIMULTANEOUS_SOURCE_VIEW_BYTES
            {
                return Err(error("ordinary source grew beyond its view profile"));
            }
            self.bytes = next;
            let raw = Arc::new(raw);
            self.sources.insert(source.clone(), Arc::clone(&raw));
            raw
        };
        self.active.insert(source.clone());
        self.visited.insert(logical.clone());
        for selected in paths(&raw) {
            let selected = selected.map_err(error)?;
            self.events = self
                .events
                .checked_add(1)
                .ok_or_else(|| error("source event accounting overflow"))?;
            if self.events > MAX_SOURCE_EVENTS {
                return Err(error("source event metadata profile exceeded"));
            }
            let selected = if let Some(relative) = selected.strip_prefix("~/") {
                self.home.join(relative)
            } else if Path::new(&selected).is_absolute() {
                selected.into()
            } else {
                logical
                    .parent()
                    .ok_or_else(|| error("declaring parent unavailable"))?
                    .join(selected)
            };
            let selected = normalize(&selected);
            if selected.as_os_str().len() > 64 * 1024
                || selected.to_string_lossy().chars().any(char::is_control)
            {
                return Err(error("selected import path profile exceeded"));
            }
            self.visit(&selected, depth + 1, frozen)?;
            if !self.selected.iter().any(|(path, _)| path == &selected) {
                self.selected.push((selected, frozen));
            }
        }
        self.active.remove(&source);
        Ok(())
    }
}

fn normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

/// Markdown code fences and matching backtick spans cannot select imports.
/// Quoted tokens are not paths; escaped spaces remain part of one path.
fn paths(raw: &str) -> ImportPaths<'_> {
    ImportPaths {
        lines: raw.lines(),
        line: "",
        index: 0,
        fence: None,
        span: 0,
    }
}
struct ImportPaths<'a> {
    lines: std::str::Lines<'a>,
    line: &'a str,
    index: usize,
    fence: Option<(u8, usize)>,
    span: usize,
}
impl Iterator for ImportPaths<'_> {
    type Item = Result<String, &'static str>;
    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.index >= self.line.len() {
                self.line = self.lines.next()?;
                self.index = 0;
                let trimmed = self.line.trim_start_matches(' ');
                let bytes = trimmed.as_bytes();
                let marker = bytes.first().copied();
                let count = bytes
                    .iter()
                    .take_while(|byte| Some(**byte) == marker)
                    .count();
                if self.line.len() - trimmed.len() <= 3
                    && matches!(marker, Some(b'`' | b'~'))
                    && count >= 3
                {
                    if let Some((active, width)) = self.fence {
                        if marker == Some(active)
                            && count >= width
                            && trimmed[count..].trim().is_empty()
                        {
                            self.fence = None;
                        }
                    } else if self.span == 0 {
                        self.fence = Some((marker.unwrap(), count));
                    }
                    self.index = self.line.len();
                    continue;
                }
                if self.fence.is_some() {
                    self.index = self.line.len();
                    continue;
                }
            }
            let bytes = self.line.as_bytes();
            while self.index < bytes.len() {
                if bytes[self.index] == b'`' {
                    let count = bytes[self.index..]
                        .iter()
                        .take_while(|byte| **byte == b'`')
                        .count();
                    if self.span == 0 {
                        self.span = count;
                    } else if self.span == count {
                        self.span = 0;
                    }
                    self.index += count;
                    continue;
                }
                if self.span == 0
                    && bytes[self.index] == b'@'
                    && (self.index == 0 || bytes[self.index - 1].is_ascii_whitespace())
                {
                    let start = self.index + 1;
                    self.index = start;
                    while self.index < bytes.len() {
                        if bytes[self.index] == b'\\' && bytes.get(self.index + 1) == Some(&b' ') {
                            self.index += 2;
                        } else if bytes[self.index].is_ascii_whitespace()
                            || matches!(bytes[self.index], b'`' | b'\'' | b'"')
                        {
                            break;
                        } else {
                            self.index += 1;
                        }
                    }
                    if self.index - start > 64 * 1024 {
                        return Some(Err("selected import path profile exceeded"));
                    }
                    if self.index > start {
                        return Some(Ok(self.line[start..self.index].replace("\\ ", " ")));
                    }
                } else {
                    self.index += 1;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordinary_memory_graph_does_not_inherit_private_indexed_payload_count_limit() {
        let owned = tempfile::tempdir().unwrap();
        let root = owned.path().join("CLAUDE.md");
        let mut memory = String::new();
        for index in 0..129 {
            let name = format!("memory-{index}.md");
            std::fs::write(owned.path().join(&name), format!("ordinary-memory-{index}")).unwrap();
            memory.push_str(&format!("@{name}\n"));
        }
        std::fs::write(&root, memory).unwrap();
        let selected = imports(owned.path(), &[root], &[], &[])
            .expect("ordinary references retain the declared source event profile");
        assert_eq!(selected.len(), 129);
        for path in selected {
            assert!(std::fs::read_to_string(path)
                .unwrap()
                .starts_with("ordinary-memory-"));
        }
    }

    #[test]
    fn selected_memory_imports_resolve_home_absolute_and_escaped_spaces() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let absolute = owned.path().join("absolute.md");
        std::fs::write(&absolute, "absolute-memory").unwrap();
        std::fs::write(home.join("spaced memory.md"), "home-memory").unwrap();
        let memory = home.join(".claude/CLAUDE.md");
        std::fs::write(
            &memory,
            format!(
                "@~/spaced\\ memory.md\n@{}\n`@missing-inline`\n~~~\n@missing-fence\n~~~\n",
                absolute.display()
            ),
        )
        .unwrap();
        let selected = imports(&home, &[memory], &[], &[]).unwrap();
        assert_eq!(selected.len(), 2);
        let values = selected
            .iter()
            .map(|path| std::fs::read_to_string(path).unwrap())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            values,
            BTreeSet::from(["absolute-memory".into(), "home-memory".into()])
        );
    }

    #[test]
    fn selected_memory_missing_and_cyclic_imports_fail_without_changing_sources() {
        let owned = tempfile::tempdir().unwrap();
        let root = owned.path().join("CLAUDE.md");
        let nested = owned.path().join("nested.md");
        std::fs::write(&root, "@nested.md\n").unwrap();
        let missing = imports(owned.path(), &[root.clone()], &[], &[]).unwrap_err();
        assert!(missing.contains("nested.md") && missing.contains("unavailable"));
        std::fs::write(&nested, "@CLAUDE.md\n").unwrap();
        let cycle = imports(owned.path(), &[root.clone()], &[], &[]).unwrap_err();
        assert!(cycle.contains("cyclic"));
        assert_eq!(std::fs::read_to_string(root).unwrap(), "@nested.md\n");
        assert_eq!(std::fs::read_to_string(nested).unwrap(), "@CLAUDE.md\n");
    }
}
