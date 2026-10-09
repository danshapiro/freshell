//! Finite native ordinary resource fields. Keep raw documents and every
//! unrelated string intact; these selections are paths, never private payloads.
use super::sources::PlannedSourceOccurrence;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy)]
enum Token {
    String(usize, usize),
    Punctuation(u8),
    Other(usize),
}
struct Cursor<'a> {
    raw: &'a str,
    at: usize,
}
impl Cursor<'_> {
    fn next(&mut self) -> Option<Token> {
        let bytes = self.raw.as_bytes();
        loop {
            while bytes.get(self.at).is_some_and(u8::is_ascii_whitespace) {
                self.at += 1;
            }
            if bytes.get(self.at..self.at + 2) == Some(b"//") {
                while bytes.get(self.at).is_some_and(|b| *b != b'\n') {
                    self.at += 1;
                }
            } else if bytes.get(self.at..self.at + 2) == Some(b"/*") {
                self.at += 2;
                while self.at < bytes.len() && bytes.get(self.at..self.at + 2) != Some(b"*/") {
                    self.at += 1;
                }
                self.at = (self.at + 2).min(bytes.len());
            } else {
                break;
            }
        }
        let byte = *bytes.get(self.at)?;
        let start = self.at;
        self.at += 1;
        if byte == b'"' {
            while let Some(byte) = bytes.get(self.at) {
                self.at += 1;
                if *byte == b'\\' {
                    self.at = (self.at + 1).min(bytes.len());
                } else if *byte == b'"' {
                    return Some(Token::String(start, self.at));
                }
            }
            None
        } else if b"{}[]:,".contains(&byte) {
            Some(Token::Punctuation(byte))
        } else {
            while bytes
                .get(self.at)
                .is_some_and(|b| !b.is_ascii_whitespace() && !b"{}[]:,".contains(b))
            {
                self.at += 1;
            }
            Some(Token::Other(start))
        }
    }
}

// A finite field visitor rather than decoded/serialized document rewriting.
// Plugin tuple options (and nested unrelated fields) are never path schemas.
fn fields(raw: &str) -> Result<Vec<(&'static str, String)>, &'static str> {
    let mut cursor = Cursor { raw, at: 0 };
    let mut depth = 0usize;
    let mut result = Vec::new();
    while let Some(token) = cursor.next() {
        match token {
            Token::Punctuation(b'{' | b'[') => depth += 1,
            Token::Punctuation(b'}' | b']') => depth = depth.saturating_sub(1),
            Token::String(start, end) if depth == 1 && end - start <= 64 => {
                let key: String = serde_json::from_str(&raw[start..end])
                    .map_err(|_| "invalid selected resource field")?;
                let mut selected = Cursor { raw, at: cursor.at };
                if !matches!(selected.next(), Some(Token::Punctuation(b':'))) {
                    continue;
                }
                match key.as_str() {
                    "plugin" | "instructions"
                        if matches!(selected.next(), Some(Token::Punctuation(b'['))) =>
                    {
                        let field = if key == "plugin" {
                            "OpenCode plugin"
                        } else {
                            "OpenCode instructions"
                        };
                        resource_array(&mut selected, field, &mut result)?;
                        cursor = selected;
                    }
                    "skills" if matches!(selected.next(), Some(Token::Punctuation(b'{'))) => {
                        let mut skills_depth = 1usize;
                        while skills_depth != 0 {
                            match selected.next().ok_or("incomplete selected skills field")? {
                                Token::Punctuation(b'{' | b'[') => skills_depth += 1,
                                Token::Punctuation(b'}' | b']') => skills_depth -= 1,
                                Token::String(start, end)
                                    if skills_depth == 1 && end - start <= 64 =>
                                {
                                    let key: String = serde_json::from_str(&raw[start..end])
                                        .map_err(|_| "invalid selected skills field")?;
                                    if key != "paths" {
                                        continue;
                                    }
                                    let mut paths = Cursor {
                                        raw,
                                        at: selected.at,
                                    };
                                    if matches!(paths.next(), Some(Token::Punctuation(b':')))
                                        && matches!(paths.next(), Some(Token::Punctuation(b'[')))
                                    {
                                        resource_array(
                                            &mut paths,
                                            "OpenCode skills.paths",
                                            &mut result,
                                        )?;
                                        selected = paths;
                                    }
                                }
                                _ => {}
                            }
                        }
                        cursor = selected;
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    Ok(result)
}

// Read only member spans: selected nested schemas never deserialize or rewrite
// an entire source document, nor interpret command arrays as file selections.
fn object_members(
    raw: &str,
    start: usize,
) -> Result<Vec<(std::ops::Range<usize>, std::ops::Range<usize>)>, &'static str> {
    let mut cursor = Cursor { raw, at: start };
    if !matches!(cursor.next(), Some(Token::Punctuation(b'{'))) {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    loop {
        let key = match cursor.next().ok_or("incomplete selected object")? {
            Token::Punctuation(b'}') => return Ok(result),
            Token::Punctuation(b',') => continue,
            Token::String(start, end) => start..end,
            _ => return Err("invalid selected object member"),
        };
        if !matches!(cursor.next(), Some(Token::Punctuation(b':'))) {
            return Err("invalid selected object member");
        }
        let token = cursor.next().ok_or("incomplete selected object value")?;
        let start = match token {
            Token::String(start, _) | Token::Other(start) => start,
            Token::Punctuation(_) => cursor.at - 1,
        };
        let mut depth = usize::from(matches!(token, Token::Punctuation(b'{' | b'[')));
        while depth > 0 {
            match cursor.next().ok_or("incomplete selected object value")? {
                Token::Punctuation(b'{' | b'[') => {
                    depth += 1;
                    if depth > 64 {
                        return Err("selected object exceeds shared depth profile");
                    }
                }
                Token::Punctuation(b'}' | b']') => depth -= 1,
                _ => {}
            }
        }
        if result.len() >= 100_000 {
            return Err("selected object exceeds shared entry profile");
        }
        result.push((key, start..cursor.at));
    }
}
fn member<'a>(
    raw: &'a str,
    members: &[(std::ops::Range<usize>, std::ops::Range<usize>)],
    name: &str,
) -> Option<&'a str> {
    members.iter().rev().find_map(|(key, value)| {
        if key.len() <= 64
            && serde_json::from_str::<String>(&raw[key.clone()])
                .ok()
                .as_deref()
                == Some(name)
        {
            Some(&raw[value.clone()])
        } else {
            None
        }
    })
}
fn selected_string(raw: &str) -> Result<Option<String>, &'static str> {
    if !raw.trim_start().starts_with('"') {
        return Ok(None);
    }
    if raw.len() > 64 * 1024 {
        return Err("configured resource selection profile exceeded");
    }
    serde_json::from_str(raw)
        .map(Some)
        .map_err(|_| "invalid selected resource path")
}
fn nested_fields(raw: &str, tui: bool) -> Result<Vec<(&'static str, String)>, &'static str> {
    let top = object_members(raw, 0)?;
    let mut result = Vec::new();
    if tui {
        if let Some(attention) = member(raw, &top, "attention") {
            let entries = object_members(attention, 0)?;
            if let Some(sounds) = member(attention, &entries, "sounds") {
                let entries = object_members(sounds, 0)?;
                for name in ["default", "question", "error", "subagent_done"] {
                    if let Some(value) = member(sounds, &entries, name) {
                        if let Some(path) = selected_string(value)?.filter(|path| !path.is_empty())
                        {
                            result.push(("OpenCode attention.sounds", path));
                        }
                    }
                }
            }
        }
    }
    if let Some(mcp) = member(raw, &top, "mcp") {
        for (_, range) in object_members(mcp, 0)? {
            let entry = &mcp[range];
            let entries = object_members(entry, 0)?;
            if member(entry, &entries, "type")
                .and_then(|value| serde_json::from_str::<String>(value).ok())
                .as_deref()
                != Some("local")
                || member(entry, &entries, "enabled").is_some_and(|value| value.trim() == "false")
            {
                continue;
            }
            if let Some(value) = member(entry, &entries, "cwd") {
                if let Some(path) = selected_string(value)? {
                    result.push(("OpenCode mcp.cwd", path));
                }
            }
        }
    }
    Ok(result)
}

fn resource_array(
    cursor: &mut Cursor<'_>,
    field: &'static str,
    result: &mut Vec<(&'static str, String)>,
) -> Result<(), &'static str> {
    let mut depth = 1usize;
    let mut tuple_first = false;
    while depth != 0 {
        match cursor.next().ok_or("incomplete selected resource field")? {
            Token::Punctuation(b'[') => {
                depth += 1;
                tuple_first = depth == 2;
            }
            Token::Punctuation(b'{') => {
                depth += 1;
                tuple_first = false;
            }
            Token::Punctuation(b']' | b'}') => {
                depth -= 1;
                tuple_first = false;
            }
            Token::String(start, end)
                if depth == 1 || (field == "OpenCode plugin" && depth == 2 && tuple_first) =>
            {
                tuple_first = false;
                if result.len() >= 100_000 || end - start > 64 * 1024 {
                    return Err("configured resource selection profile exceeded");
                }
                result.push((
                    field,
                    serde_json::from_str(&cursor.raw[start..end])
                        .map_err(|_| "invalid selected resource path")?,
                ));
            }
            _ if depth == 2 => tuple_first = false,
            _ => {}
        }
    }
    Ok(())
}

fn home_path(path: &str, home: &Path) -> PathBuf {
    if let Some(relative) = path.strip_prefix("~/") {
        home.join(relative)
    } else {
        path.into()
    }
}
pub struct ResourceError {
    pub field: &'static str,
    pub cause: &'static str,
}
fn checked(path: &Path, field: &'static str, _source: &Path) -> Result<PathBuf, ResourceError> {
    let fail = |cause| ResourceError { field, cause };
    let canonical = std::fs::canonicalize(path)
        .map_err(|_| fail("selected path is missing, inaccessible, dangling or cyclic"))?;
    let metadata =
        std::fs::metadata(&canonical).map_err(|_| fail("selected path metadata unavailable"))?;
    if metadata.is_file() {
        std::fs::File::open(&canonical).map_err(|_| fail("selected file is unreadable"))?;
    } else if metadata.is_dir() {
        std::fs::read_dir(&canonical).map_err(|_| fail("selected directory is unreadable"))?;
    } else {
        return Err(fail("selected resource has an unsupported type"));
    }
    Ok(canonical)
}

/// Return complete ordinary units and native installed ancestor lookup units.
/// Exact mounts retain native field spellings and their declaring origins.
pub fn select(
    source: &PlannedSourceOccurrence,
    home: &Path,
    global: Option<&Path>,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<(Vec<PathBuf>, Vec<String>), ResourceError> {
    let declaring = &source.source.logical_path;
    let fail = |field: &'static str, cause: &'static str| ResourceError { field, cause };
    let mut result = std::collections::BTreeSet::new();
    let mut resource_path_bytes = 0usize;
    let mut insert = |path: PathBuf, field| {
        if !result.contains(&path) {
            let bytes = path.as_os_str().len();
            if result.len() >= 100_000
                || bytes > (64 * 1024 * 1024usize).saturating_sub(resource_path_bytes)
            {
                return Err(fail(
                    field,
                    "configured resource selection exceeds shared entry or metadata profile",
                ));
            }
            resource_path_bytes += bytes;
            result.insert(path);
        }
        Ok(())
    };
    let mut variables = std::collections::BTreeSet::new();
    let raw = source.references.unexpanded_source();
    let mut selections = fields(raw).map_err(|cause| fail("OpenCode resource", cause))?;
    selections.extend(
        nested_fields(raw, source.source.lane == super::sources::SourceLane::Tui)
            .map_err(|cause| fail("OpenCode resource", cause))?,
    );
    for (field, spelling) in selections {
        // Private file-token payloads already use the accepted grant plan.
        if spelling.contains("{file:") {
            continue;
        }
        let names = std::cell::RefCell::new(std::collections::BTreeSet::new());
        let introduced_file = std::cell::Cell::new(false);
        let invalid_input = std::cell::Cell::new(false);
        let spelling = freshell_platform::opencode_config::transform_file_tokens(
            &spelling,
            &|name| {
                names.borrow_mut().insert(name.to_owned());
                let value = lookup(name);
                if value.as_ref().is_some_and(|value| value.len() > 64 * 1024) {
                    invalid_input.set(true);
                    return None;
                }
                value
            },
            |_| {
                introduced_file.set(true);
                Ok::<_, ()>(String::new())
            },
        )
        .map_err(|_| {
            fail(
                field,
                "selected path substitution exceeds its finite profile",
            )
        })?;
        if invalid_input.get() || spelling.len() > 64 * 1024 {
            return Err(fail(field, "selected path input exceeds 64 KiB"));
        }
        if introduced_file.get() {
            continue;
        }
        if field != "OpenCode attention.sounds"
            && field != "OpenCode mcp.cwd"
            && (spelling.starts_with("http://") || spelling.starts_with("https://"))
        {
            continue;
        }
        let mut path = if field == "OpenCode plugin" || field == "OpenCode attention.sounds" {
            if spelling.starts_with("file:") {
                reqwest::Url::parse(&spelling)
                    .ok()
                    .and_then(|url| url.to_file_path().ok())
                    .ok_or_else(|| fail(field, "local file URL is invalid"))?
            } else if field == "OpenCode attention.sounds"
                || spelling.starts_with(['/', '.'])
                || spelling.starts_with("~/")
            {
                home_path(&spelling, home)
            } else {
                continue;
            } // Native package identity remains native.
        } else {
            home_path(&spelling, home)
        };
        let runtime_home = Path::new("/home/freshell/provider");
        if field == "OpenCode plugin"
            && [
                freshell_platform::opencode_plugin::rebind_plugin_path(runtime_home),
                freshell_platform::opencode_plugin::rebind_plugin_package_path(runtime_home),
            ]
            .contains(&path)
        {
            continue;
        }
        if let Ok(relative) = path.strip_prefix(runtime_home.join(".config/opencode")) {
            path = global
                .unwrap_or(&home.join(".config/opencode"))
                .join(relative);
        } else if let Ok(relative) = path.strip_prefix(runtime_home) {
            path = home.join(relative);
        }
        if field == "OpenCode instructions" && path.to_string_lossy().contains(['*', '?', '[']) {
            let candidates = if path.is_absolute() {
                vec![path]
            } else {
                source
                    .instance_cwd
                    .ancestors()
                    .map(|base| base.join(&path))
                    .collect()
            };
            let mut matched = false;
            for candidate in candidates {
                let pattern = candidate
                    .to_str()
                    .ok_or_else(|| fail(field, "instruction glob is not UTF-8"))?;
                for selected in
                    glob::glob(pattern).map_err(|_| fail(field, "instruction glob is invalid"))?
                {
                    let selected =
                        selected.map_err(|_| fail(field, "instruction glob traversal failed"))?;
                    let canonical = checked(&selected, field, declaring)?;
                    if !canonical.is_file() {
                        return Err(fail(field, "selected file resource is not a regular file"));
                    }
                    insert(selected, field)?;
                    matched = true;
                }
                if matched {
                    break;
                }
            }
            if !matched {
                return Err(fail(
                    field,
                    "selected instruction glob has no available files",
                ));
            }
            variables.extend(names.into_inner());
            continue;
        }
        if !path.is_absolute() {
            if field == "OpenCode plugin" || field == "OpenCode attention.sounds" {
                path = declaring
                    .parent()
                    .unwrap_or(&source.instance_cwd)
                    .join(path);
            } else if field == "OpenCode skills.paths" || field == "OpenCode mcp.cwd" {
                path = source.instance_cwd.join(path);
            } else {
                path = source
                    .instance_cwd
                    .ancestors()
                    .map(|base| base.join(&path))
                    .find(|candidate| std::fs::symlink_metadata(candidate).is_ok())
                    .unwrap_or_else(|| source.instance_cwd.join(path));
            }
        }
        if field == "OpenCode skills.paths" || field == "OpenCode mcp.cwd" {
            // Native instance-cwd resolution normalizes .. before deciding
            // whether the selected directory is supplied by the workspace.
            path = freshell_platform::opencode_config::lexical_path(&path);
        }
        let canonical = checked(&path, field, declaring)?;
        variables.extend(names.into_inner());
        if field == "OpenCode instructions" || field == "OpenCode attention.sounds" {
            if !canonical.is_file() {
                return Err(fail(field, "selected file resource is not a regular file"));
            }
            insert(path, field)?;
            continue;
        }
        if field == "OpenCode skills.paths" || field == "OpenCode mcp.cwd" {
            if !canonical.is_dir() {
                return Err(fail(
                    field,
                    "selected directory resource is not a directory",
                ));
            }
            insert(path, field)?;
            continue;
        }
        // The native global plugin discovery unit is already selected in the
        // ordinary global projection, including its installed dependencies.
        // Do not widen it to the entire config package (private siblings belong
        // to the indexed/grant path, not ordinary package transport).
        if global.is_some_and(|global| path.starts_with(global.join("plugins"))) {
            continue;
        }
        let mut scope = if canonical.is_dir() {
            path.clone()
        } else {
            path.parent()
                .ok_or_else(|| fail(field, "plugin has no containing scope"))?
                .to_owned()
        };
        if canonical.is_file() {
            for ancestor in scope.ancestors() {
                if ancestor == home || ancestor == Path::new("/") {
                    break;
                }
                if ancestor.join("package.json").is_file() {
                    scope = ancestor.to_owned();
                    break;
                }
            }
        }
        if scope == home || scope == Path::new("/") {
            return Err(fail(field, "select a bounded plugin or package directory"));
        }
        insert(scope.clone(), field)?;
        for ancestor in scope.parent().into_iter().flat_map(Path::ancestors) {
            if ancestor == Path::new("/") {
                break;
            }
            for name in [
                "node_modules",
                "package.json",
                "package-lock.json",
                "bun.lock",
                "bun.lockb",
                "pnpm-lock.yaml",
            ] {
                let candidate = ancestor.join(name);
                match std::fs::symlink_metadata(&candidate) {
                    Ok(_) => {
                        checked(&candidate, field, declaring)?;
                        insert(candidate, field)?;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => {
                        return Err(fail(
                            field,
                            "installed plugin lookup context is unavailable",
                        ))
                    }
                }
            }
            if ancestor == home {
                break;
            }
        }
    }
    Ok((
        result.into_iter().collect(),
        variables.into_iter().collect(),
    ))
}
