//! Finite native ordinary resource fields. Keep raw documents and every
//! unrelated string intact; these selections are paths, never private payloads.
use super::sources::PlannedSourceOccurrence;
use std::path::{Path, PathBuf};

const FRESHELL_IMAGE_MCP_SERVER_PATH: &str = "/opt/freshell-mcp/server.js";

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
    // Native JSONC parsing assigns each member in order: only the final
    // spelling owns a configured capability, including escaped duplicate keys.
    // Reuse raw member spans so plugin tuple options and source origins survive.
    let top = object_members(raw, 0)?;
    let mut result = Vec::new();
    for (name, field) in [
        ("plugin", "OpenCode plugin"),
        ("instructions", "OpenCode instructions"),
    ] {
        if let Some(value) = member(raw, &top, name) {
            let mut selected = Cursor { raw: value, at: 0 };
            if matches!(selected.next(), Some(Token::Punctuation(b'['))) {
                resource_array(&mut selected, field, &mut result)?;
            }
        }
    }
    if let Some(skills) = member(raw, &top, "skills") {
        let entries = object_members(skills, 0)?;
        if let Some(paths) = member(skills, &entries, "paths") {
            let mut selected = Cursor { raw: paths, at: 0 };
            if matches!(selected.next(), Some(Token::Punctuation(b'['))) {
                resource_array(&mut selected, "OpenCode skills.paths", &mut result)?;
            }
        }
    }
    Ok(result)
}

// Read only member spans: selected nested schemas never deserialize or rewrite
// an entire source document, nor interpret unrelated command arguments as paths.
type ObjectMember = (std::ops::Range<usize>, std::ops::Range<usize>);

fn object_members(raw: &str, start: usize) -> Result<Vec<ObjectMember>, &'static str> {
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
        // Every ASCII name character can use a six-byte Unicode escape.
        // Bound the finite name before decoding, without excluding valid keys.
        if key.len() <= 2 + 6 * name.len()
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
        // Native TUI normalization is shallow: any present top-level attention
        // replaces the entire nested key, including non-object values.
        let attention = if let Some(attention) = member(raw, &top, "attention") {
            Some(attention)
        } else if let Some(tui) = member(raw, &top, "tui") {
            member(tui, &object_members(tui, 0)?, "attention")
        } else {
            None
        };
        if let Some(attention) = attention {
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
        // Native Object.entries sees only the last value for each decoded
        // server name. Discard overwritten entries before selecting their cwd.
        let mut names = std::collections::BTreeSet::new();
        let mut winners = Vec::new();
        for (name, range) in object_members(mcp, 0)?.into_iter().rev() {
            let name = serde_json::from_str::<String>(&mcp[name])
                .map_err(|_| "invalid selected MCP server name")?;
            if names.insert(name.clone()) {
                winners.push((name, range));
            }
        }
        drop(names);
        for (name, range) in winners.into_iter().rev() {
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
            // Keep each server's cwd adjacent to its command references so a
            // different server's cwd cannot accidentally satisfy a missing path.
            result.push(("OpenCode mcp.entry", String::new()));
            if let Some(value) = member(entry, &entries, "cwd") {
                if let Some(path) = selected_string(value)? {
                    result.push(("OpenCode mcp.cwd", path));
                }
            }
            if let Some(value) = member(entry, &entries, "command") {
                let command = string_array(value)?;
                // Freshell's exact server command is supplied by the managed
                // runtime image. Its /opt path is not a host resource to copy.
                let image_command = name == "freshell"
                    && command.len() == 2
                    && command[0] == "node"
                    && command[1] == FRESHELL_IMAGE_MCP_SERVER_PATH;
                if !image_command {
                    for (index, argument) in command.iter().enumerate() {
                        if (index == 0 && is_explicit_command_path(argument))
                            || is_script_path(argument)
                        {
                            result.push(("OpenCode mcp.command", argument.clone()));
                        }
                    }
                    let inline_code = command.iter().any(|argument| {
                        matches!(argument.as_str(), "-e" | "-c" | "--eval" | "--print")
                    });
                    let bare_script_arguments = command
                        .iter()
                        .skip(1)
                        .filter(|argument| !argument.starts_with('-') && !argument.is_empty())
                        .collect::<Vec<_>>();
                    if command_uses_script_runtime(command.first().map(String::as_str))
                        && !inline_code
                        && bare_script_arguments.len() == 1
                        && !is_script_path(bare_script_arguments[0])
                    {
                        result.push(("OpenCode mcp.command", bare_script_arguments[0].clone()));
                    }
                }
            }
        }
    }
    Ok(result)
}

fn string_array(raw: &str) -> Result<Vec<String>, &'static str> {
    let mut cursor = Cursor { raw, at: 0 };
    if !matches!(cursor.next(), Some(Token::Punctuation(b'['))) {
        return Ok(Vec::new());
    }
    let mut depth = 1usize;
    let mut result = Vec::new();
    while depth != 0 {
        match cursor.next().ok_or("incomplete selected command array")? {
            Token::Punctuation(b'[' | b'{') => {
                depth += 1;
                if depth > 64 {
                    return Err("selected command exceeds shared depth profile");
                }
            }
            Token::Punctuation(b']' | b'}') => depth -= 1,
            Token::String(start, end) if depth == 1 => {
                if result.len() >= 100_000 || end - start > 64 * 1024 {
                    return Err("configured resource selection profile exceeded");
                }
                result.push(
                    serde_json::from_str(&cursor.raw[start..end])
                        .map_err(|_| "invalid selected command argument")?,
                );
            }
            _ => {}
        }
    }
    Ok(result)
}

fn is_explicit_command_path(argument: &str) -> bool {
    !argument.starts_with('-')
        && (Path::new(argument).is_absolute()
            || argument.starts_with("./")
            || argument.starts_with("../"))
}

fn is_script_path(argument: &str) -> bool {
    if argument.starts_with('-') || argument.starts_with('@') {
        return false;
    }
    Path::new(argument).extension().is_some_and(|extension| {
        matches!(
            extension.to_string_lossy().to_ascii_lowercase().as_str(),
            "js" | "mjs" | "cjs" | "ts" | "mts" | "cts" | "py" | "sh" | "rb"
        )
    })
}

fn command_uses_script_runtime(executable: Option<&str>) -> bool {
    let Some(executable) = executable.and_then(|executable| Path::new(executable).file_name())
    else {
        return false;
    };
    let executable = executable.to_string_lossy().to_ascii_lowercase();
    let executable = executable.strip_suffix(".exe").unwrap_or(&executable);
    matches!(
        executable,
        "node"
            | "nodejs"
            | "bun"
            | "deno"
            | "tsx"
            | "ts-node"
            | "python"
            | "python3"
            | "ruby"
            | "bash"
            | "sh"
            | "zsh"
            | "pwsh"
            | "powershell"
    )
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
    let mut current_mcp_working_dir: Option<PathBuf> = None;
    for (field, spelling) in selections {
        if field == "OpenCode mcp.entry" {
            current_mcp_working_dir = None;
            continue;
        }
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
                if field == "OpenCode attention.sounds" {
                    PathBuf::from(&spelling)
                } else {
                    home_path(&spelling, home)
                }
            } else {
                continue;
            } // Native package identity remains native.
        } else if field == "OpenCode mcp.cwd" || field == "OpenCode mcp.command" {
            // Native path.resolve(instance cwd, raw): no HOME or URL expansion.
            PathBuf::from(&spelling)
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
            } else if field == "OpenCode mcp.command" {
                path = if let Some(working_dir) = &current_mcp_working_dir {
                    working_dir.join(path)
                } else {
                    source
                        .instance_cwd
                        .ancestors()
                        .map(|base| base.join(&path))
                        .find(|candidate| std::fs::symlink_metadata(candidate).is_ok())
                        .unwrap_or_else(|| source.instance_cwd.join(path))
                };
            } else {
                path = source
                    .instance_cwd
                    .ancestors()
                    .map(|base| base.join(&path))
                    .find(|candidate| std::fs::symlink_metadata(candidate).is_ok())
                    .unwrap_or_else(|| source.instance_cwd.join(path));
            }
        }
        if matches!(
            field,
            "OpenCode skills.paths"
                | "OpenCode mcp.cwd"
                | "OpenCode mcp.command"
                | "OpenCode attention.sounds"
        ) {
            // Native resolution resolution normalizes .. before deciding
            // whether the selected resource is supplied by the workspace.
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
        if field == "OpenCode mcp.command" {
            if !canonical.is_file() {
                return Err(fail(
                    field,
                    "selected command resource is not a regular file",
                ));
            }
            // The server's selected cwd is already copied as a directory.
            // Avoid an overlapping file/package mount for a script it contains;
            // besides being redundant, that shape cannot be authorized by the
            // closed launch fixture. Canonical resolution keeps symlinks that
            // escape the cwd on the explicit-resource path below.
            if current_mcp_working_dir
                .as_ref()
                .is_some_and(|working_dir| canonical.starts_with(working_dir))
            {
                continue;
            }
            // Retain the exact executable/script path as well as its bounded
            // package closure below when it belongs to an installed package.
            insert(canonical.clone(), field)?;
        }
        if field == "OpenCode skills.paths" || field == "OpenCode mcp.cwd" {
            if !canonical.is_dir() {
                return Err(fail(
                    field,
                    "selected directory resource is not a directory",
                ));
            }
            if field == "OpenCode mcp.cwd" {
                current_mcp_working_dir = Some(canonical);
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
        let mut scope = if field == "OpenCode mcp.command" {
            canonical
                .parent()
                .ok_or_else(|| fail(field, "command has no containing scope"))?
                .to_owned()
        } else if canonical.is_dir() {
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
            if field == "OpenCode mcp.command" {
                continue;
            }
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
