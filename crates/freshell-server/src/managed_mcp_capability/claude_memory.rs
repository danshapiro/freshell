//! Select ordinary Markdown imports from their declaring logical origins.
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::Arc,
};

pub(super) fn imports(
    home: &Path,
    roots: &[PathBuf],
    excluded: &[PathBuf],
) -> Result<Vec<PathBuf>, String> {
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
    };
    for root in roots {
        graph.visit(root, 0)?;
    }
    Ok(graph.selected)
}

struct ImportGraph<'a> {
    home: &'a Path,
    excluded: &'a [PathBuf],
    active: BTreeSet<PathBuf>,
    visited: BTreeSet<PathBuf>,
    sources: BTreeMap<PathBuf, Arc<str>>,
    bytes: u64,
    events: usize,
    path_bytes: usize,
    selected: Vec<PathBuf>,
}
impl ImportGraph<'_> {
    fn visit(&mut self, logical: &Path, depth: usize) -> Result<(), String> {
        let logical = normalize(logical);
        let error = |cause: &str| format!("Claude memory import {}: {cause}", logical.display());
        if depth > freshell_platform::provider_environment::CopyLimits::default().max_depth {
            return Err(error("resource depth profile exceeded"));
        }
        let source = std::fs::canonicalize(&logical)
            .map_err(|cause| error(&format!("selected file unavailable: {cause}")))?;
        if self
            .excluded
            .iter()
            .any(|excluded| source.starts_with(excluded))
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
        if self.visited.len() >= 256 {
            return Err(error("reference alias profile exceeded"));
        }
        let raw = if let Some(raw) = self.sources.get(&source) {
            Arc::clone(raw)
        } else {
            use freshell_platform::provider_input_exchange::{MAX_FILE_BYTES, MAX_TOTAL_BYTES};
            let file = std::fs::File::open(&source)
                .map_err(|cause| error(&format!("selected file unreadable: {cause}")))?;
            let metadata = file
                .metadata()
                .map_err(|cause| error(&format!("selected file metadata failed: {cause}")))?;
            if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
                return Err(error("reference source type or per-file profile exceeded"));
            }
            let next = self
                .bytes
                .checked_add(metadata.len())
                .ok_or_else(|| error("reference source accounting overflow"))?;
            if self.sources.len() >= 128 || next > MAX_TOTAL_BYTES {
                return Err(error("reference source aggregate profile exceeded"));
            }
            let mut raw = String::new();
            file.take(MAX_FILE_BYTES + 1)
                .read_to_string(&mut raw)
                .map_err(|cause| error(&format!("selected Markdown read failed: {cause}")))?;
            let next = self
                .bytes
                .checked_add(raw.len() as u64)
                .ok_or_else(|| error("reference source accounting overflow"))?;
            if raw.len() as u64 > MAX_FILE_BYTES || next > MAX_TOTAL_BYTES {
                return Err(error("reference source grew beyond its profile"));
            }
            self.bytes = next;
            let raw: Arc<str> = raw.into();
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
            self.path_bytes = self
                .path_bytes
                .checked_add(selected.len())
                .ok_or_else(|| error("source path accounting overflow"))?;
            if self.events > 8192 || self.path_bytes > 8 * 1024 * 1024 {
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
            self.visit(&selected, depth + 1)?;
            if !self.selected.contains(&selected) {
                self.selected.push(selected);
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
        let selected = imports(&home, &[memory], &[]).unwrap();
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
        let missing = imports(owned.path(), &[root.clone()], &[]).unwrap_err();
        assert!(missing.contains("nested.md") && missing.contains("unavailable"));
        std::fs::write(&nested, "@CLAUDE.md\n").unwrap();
        let cycle = imports(owned.path(), &[root.clone()], &[]).unwrap_err();
        assert!(cycle.contains("cyclic"));
        assert_eq!(std::fs::read_to_string(root).unwrap(), "@nested.md\n");
        assert_eq!(std::fs::read_to_string(nested).unwrap(), "@CLAUDE.md\n");
    }
}
