//! Finite native ordinary resource fields. Keep raw documents and every
//! unrelated string intact; these selections are paths, never private payloads.
use std::io::Read;
use std::path::{Path, PathBuf};

const FRESHELL_IMAGE_MCP_SERVER_PATH: &str = "/opt/freshell-mcp/server.js";
const MAX_BUN_PACKAGE_JSON_BYTES: u64 = 16 * 1024 * 1024;
const MAX_NODE_PACKAGE_JSON_BYTES: u64 = 1024 * 1024;

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
fn fields(raw: &str) -> Result<Vec<SelectedField>, &'static str> {
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

struct SelectedField {
    field: &'static str,
    spelling: String,
    node_env_file_argument: Option<NodeEnvFileArgument>,
}

struct NodeEnvFileArgument {
    raw_span: std::ops::Range<usize>,
    option_prefix: String,
}

impl SelectedField {
    fn new(field: &'static str, spelling: String) -> Self {
        Self {
            field,
            spelling,
            node_env_file_argument: None,
        }
    }
}

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
    member_range(raw, members, name).map(|(_, value)| &raw[value.clone()])
}

fn member_range<'a>(
    raw: &'a str,
    members: &'a [ObjectMember],
    name: &str,
) -> Option<&'a ObjectMember> {
    members.iter().rev().find(|(key, _)| {
        // Every ASCII name character can use a six-byte Unicode escape.
        // Bound the finite name before decoding, without excluding valid keys.
        key.len() <= 2 + 6 * name.len()
            && serde_json::from_str::<String>(&raw[key.clone()])
                .ok()
                .as_deref()
                == Some(name)
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
fn nested_fields(
    raw: &str,
    tui: bool,
    skip_owned_freshell_mcp: bool,
) -> Result<Vec<SelectedField>, &'static str> {
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
                            result.push(SelectedField::new("OpenCode attention.sounds", path));
                        }
                    }
                }
            }
        }
    }
    if let Some((_, mcp_range)) = member_range(raw, &top, "mcp") {
        let mcp_base = mcp_range.start;
        let mcp = &raw[mcp_range.clone()];
        // Native Object.entries sees only the last value for each decoded
        // server name. Discard overwritten entries before selecting their cwd.
        let mut names = std::collections::BTreeSet::new();
        let mut winners = Vec::new();
        for (name, range) in object_members(mcp, 0)?.into_iter().rev() {
            let name = serde_json::from_str::<String>(&mcp[name])
                .map_err(|_| "invalid selected MCP server name")?;
            if names.insert(name.clone()) {
                if skip_owned_freshell_mcp && name == "freshell" {
                    continue;
                }
                winners.push((name, range));
            }
        }
        drop(names);
        for (name, range) in winners.into_iter().rev() {
            let entry_base = mcp_base + range.start;
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
            result.push(SelectedField::new("OpenCode mcp.entry", String::new()));
            if let Some(value) = member(entry, &entries, "cwd") {
                if let Some(path) = selected_string(value)? {
                    result.push(SelectedField::new("OpenCode mcp.cwd", path));
                }
            }
            if let Some((_, command_range)) = member_range(entry, &entries, "command") {
                let command_raw = &entry[command_range.clone()];
                let command_spans = string_array_with_spans(command_raw)?;
                let command = command_spans
                    .iter()
                    .map(|(argument, _)| argument.clone())
                    .collect::<Vec<_>>();
                // Freshell's exact server command is supplied by the managed
                // runtime image. Its /opt path is not a host resource to copy.
                let image_command = name == "freshell"
                    && command.len() == 2
                    && command[0] == "node"
                    && command[1] == FRESHELL_IMAGE_MCP_SERVER_PATH;
                if !image_command {
                    let script_index = script_operand_index(&command);
                    let option_resources = node_command_option_resources(&command);
                    let option_resource_indexes = option_resources
                        .iter()
                        .map(|(index, _, _)| *index)
                        .collect::<std::collections::BTreeSet<_>>();
                    let script_runtime =
                        command_uses_script_runtime(command.first().map(String::as_str));
                    let node_script_field =
                        if command_uses_node_module_resolution(command.first().map(String::as_str))
                        {
                            "OpenCode mcp.node-script"
                        } else {
                            "OpenCode mcp.script"
                        };
                    for (index, argument) in command.iter().enumerate() {
                        let bun_run_file =
                            script_index == Some(index) && is_bun_run_file_operand(&command, index);
                        let script_file = if script_runtime {
                            script_index.is_some_and(|script| {
                                index > 0
                                    && index <= script
                                    && is_script_path(argument)
                                    && !option_resource_indexes.contains(&index)
                                    && !is_bun_run_bare_operand(&command, index)
                                    && !bun_run_file
                            })
                        } else {
                            index == 0 && is_script_path(argument)
                        };
                        let script_operand = script_runtime
                            && script_index == Some(index)
                            && !is_bun_run_bare_operand(&command, index)
                            && !bun_run_file;
                        if index == 0 && is_explicit_command_path(argument) {
                            if is_script_path(argument) {
                                let field = if is_node_script_path(argument) {
                                    "OpenCode mcp.node-direct-script"
                                } else {
                                    "OpenCode mcp.direct-script"
                                };
                                result.push(SelectedField::new(field, argument.clone()));
                            } else {
                                result.push(SelectedField::new(
                                    "OpenCode mcp.command",
                                    argument.clone(),
                                ));
                            }
                        } else if script_file || script_operand {
                            result.push(SelectedField::new(node_script_field, argument.clone()));
                        }
                    }
                    for (index, field, spelling) in option_resources {
                        let mut selected = SelectedField::new(field, spelling.clone());
                        if is_mcp_node_option_data_field(field) {
                            let (argument, span) = command_spans
                                .get(index)
                                .ok_or("selected Node env-file argument span unavailable")?;
                            let option_prefix = argument
                                .strip_suffix(&spelling)
                                .ok_or("selected Node env-file option changed during parsing")?
                                .to_owned();
                            selected.node_env_file_argument = Some(NodeEnvFileArgument {
                                raw_span: command_range.start + entry_base + span.start
                                    ..command_range.start + entry_base + span.end,
                                option_prefix,
                            });
                        }
                        result.push(selected);
                    }
                    if let Some(script_index) = script_index {
                        let script = &command[script_index];
                        if is_bun_run_bare_operand(&command, script_index) {
                            result.push(SelectedField::new(
                                "OpenCode bun run operand",
                                script.clone(),
                            ));
                        } else if is_bun_run_file_operand(&command, script_index) {
                            result
                                .push(SelectedField::new("OpenCode bun run file", script.clone()));
                        }
                    }
                }
            }
        }
    }
    Ok(result)
}

fn string_array_with_spans(
    raw: &str,
) -> Result<Vec<(String, std::ops::Range<usize>)>, &'static str> {
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
                result.push((
                    serde_json::from_str(&cursor.raw[start..end])
                        .map_err(|_| "invalid selected command argument")?,
                    start..end,
                ));
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

fn is_bun_run_bare_operand(command: &[String], index: usize) -> bool {
    let Some(executable) = command
        .first()
        .and_then(|executable| Path::new(executable).file_name())
    else {
        return false;
    };
    let executable = executable.to_string_lossy().to_ascii_lowercase();
    let executable = executable.strip_suffix(".exe").unwrap_or(&executable);
    let Some(argument) = command.get(index) else {
        return false;
    };
    executable == "bun"
        && command.get(1).is_some_and(|argument| argument == "run")
        && is_bare_bun_script_name(argument)
}

fn is_bun_run_file_operand(command: &[String], index: usize) -> bool {
    let Some(executable) = command
        .first()
        .and_then(|executable| Path::new(executable).file_name())
    else {
        return false;
    };
    let executable = executable.to_string_lossy().to_ascii_lowercase();
    let executable = executable.strip_suffix(".exe").unwrap_or(&executable);
    executable == "bun"
        && command.get(1).is_some_and(|argument| argument == "run")
        && command
            .get(index)
            .is_some_and(|argument| is_node_script_path(argument))
}

fn bun_run_file_resource_scope(
    command_parent: &Path,
    home: &Path,
    instance_cwd: &Path,
) -> Option<PathBuf> {
    let canonical_home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_owned());
    let canonical_cwd =
        std::fs::canonicalize(instance_cwd).unwrap_or_else(|_| instance_cwd.to_owned());
    // Scripts that live in the mounted project already travel with that
    // workspace. An external script may still be packaged beneath a directory
    // that contains the project, so that ancestor package remains useful as a
    // resource scope; the copy stage excludes the workspace subtree itself.
    if command_parent.starts_with(&canonical_cwd) {
        return None;
    }
    let package_root = command_parent
        .ancestors()
        .take_while(|ancestor| *ancestor != canonical_home && ancestor.parent().is_some())
        .find(|ancestor| ancestor.join("package.json").is_file());
    let is_bounded = |scope: &Path| {
        scope != Path::new("/") && scope != canonical_home && !scope.starts_with(&canonical_cwd)
    };

    // Prefer the nearest package boundary, even when it contains the mounted
    // project. The caller preserves computed package assets while excluding
    // that separately mounted workspace subtree.
    package_root
        .filter(|scope| is_bounded(scope))
        .or_else(|| is_bounded(command_parent).then_some(command_parent))
        .map(Path::to_owned)
}

fn is_bare_bun_script_name(argument: &str) -> bool {
    !argument.is_empty()
        && !argument.starts_with(['-', '.'])
        && !Path::new(argument).is_absolute()
        && !argument.contains(['/', '\\'])
}

fn bun_package_script_root(
    working_dir: &Path,
    script_name: &str,
) -> Result<Option<PathBuf>, &'static str> {
    for directory in working_dir.ancestors().take(64) {
        if directory == Path::new("/") {
            break;
        }
        let manifest = directory.join("package.json");
        let metadata = match std::fs::metadata(&manifest) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err("Bun package.json is unavailable"),
        };
        if !metadata.is_file() {
            return Err("Bun package.json is not a regular file");
        }
        if metadata.len() > MAX_BUN_PACKAGE_JSON_BYTES {
            return Err("Bun package.json exceeds the 16 MiB script lookup limit");
        }
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        std::fs::File::open(&manifest)
            .map_err(|_| "Bun package.json is unreadable")?
            .take(MAX_BUN_PACKAGE_JSON_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "Bun package.json could not be read")?;
        if bytes.len() as u64 > MAX_BUN_PACKAGE_JSON_BYTES {
            return Err("Bun package.json exceeds the 16 MiB script lookup limit");
        }
        let package: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|_| "Bun package.json is not valid JSON")?;
        let has_script = package
            .get("scripts")
            .and_then(serde_json::Value::as_object)
            .is_some_and(|scripts| scripts.contains_key(script_name));
        return Ok(has_script.then(|| directory.to_path_buf()));
    }
    Ok(None)
}

fn is_python_interpreter_name(name: &str) -> bool {
    matches!(name, "python" | "python2" | "python3")
        || name.strip_prefix("python").is_some_and(|version| {
            !version.is_empty()
                && version.split('.').all(|component| {
                    !component.is_empty() && component.bytes().all(|byte| byte.is_ascii_digit())
                })
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
            | "ruby"
            | "bash"
            | "sh"
            | "zsh"
            | "pwsh"
            | "powershell"
    ) || is_python_interpreter_name(executable)
}

fn command_uses_node_module_resolution(executable: Option<&str>) -> bool {
    let Some(executable) = executable.and_then(|executable| Path::new(executable).file_name())
    else {
        return false;
    };
    let executable = executable.to_string_lossy().to_ascii_lowercase();
    let executable = executable.strip_suffix(".exe").unwrap_or(&executable);
    matches!(
        executable,
        "node" | "nodejs" | "bun" | "deno" | "tsx" | "ts-node"
    )
}

fn is_node_script_path(path: &str) -> bool {
    Path::new(path).extension().is_some_and(|extension| {
        matches!(
            extension.to_string_lossy().to_ascii_lowercase().as_str(),
            "js" | "mjs" | "cjs" | "ts" | "mts" | "cts"
        )
    })
}

fn is_mcp_command_path_field(field: &str) -> bool {
    matches!(
        field,
        "OpenCode mcp.command"
            | "OpenCode mcp.script"
            | "OpenCode mcp.node-script"
            | "OpenCode mcp.direct-script"
            | "OpenCode mcp.node-direct-script"
            | "OpenCode mcp.shebang-script"
            | "OpenCode mcp.shebang-node-script"
            | "OpenCode bun run file"
    )
}

fn is_mcp_command_resource_field(field: &str) -> bool {
    is_mcp_command_path_field(field)
        || matches!(
            field,
            "OpenCode mcp.node-option-script"
                | "OpenCode mcp.node-option-data"
                | "OpenCode mcp.node-option-data-optional"
        )
}

fn is_mcp_node_option_script_field(field: &str) -> bool {
    field == "OpenCode mcp.node-option-script"
}

fn is_mcp_node_option_data_field(field: &str) -> bool {
    matches!(
        field,
        "OpenCode mcp.node-option-data" | "OpenCode mcp.node-option-data-optional"
    )
}

fn is_mcp_node_option_optional_data_field(field: &str) -> bool {
    field == "OpenCode mcp.node-option-data-optional"
}

fn is_mcp_script_field(field: &str) -> bool {
    matches!(
        field,
        "OpenCode mcp.script"
            | "OpenCode mcp.node-script"
            | "OpenCode mcp.direct-script"
            | "OpenCode mcp.node-direct-script"
            | "OpenCode mcp.shebang-script"
            | "OpenCode mcp.shebang-node-script"
    )
}

fn is_mcp_node_script_field(field: &str) -> bool {
    matches!(
        field,
        "OpenCode mcp.node-script"
            | "OpenCode mcp.node-direct-script"
            | "OpenCode mcp.shebang-node-script"
    )
}

fn is_mcp_shebang_script_field(field: &str) -> bool {
    matches!(
        field,
        "OpenCode mcp.shebang-script" | "OpenCode mcp.shebang-node-script"
    )
}

fn shebang_interpreter_names(path: &Path) -> Option<Vec<String>> {
    let mut prefix = [0; 4096];
    let file = std::fs::File::open(path).ok()?;
    let length = file.take(prefix.len() as u64).read(&mut prefix).ok()?;
    let first_line = prefix[..length].split(|byte| *byte == b'\n').next()?;
    let shebang = first_line.strip_prefix(b"#!")?;
    Some(
        std::str::from_utf8(shebang)
            .ok()?
            .split_ascii_whitespace()
            .filter_map(|part| Path::new(part).file_name())
            .map(|part| part.to_string_lossy().to_ascii_lowercase())
            .collect(),
    )
}

fn shebang_script_field(path: &Path) -> Option<&'static str> {
    let interpreter_names = shebang_interpreter_names(path)?;
    if interpreter_names
        .iter()
        .any(|name| matches!(name.as_str(), "node" | "nodejs" | "bun" | "deno"))
    {
        Some("OpenCode mcp.shebang-node-script")
    } else {
        Some("OpenCode mcp.shebang-script")
    }
}

fn is_shell_script(path: &Path) -> bool {
    if path
        .extension()
        .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("sh"))
    {
        return true;
    }
    shebang_interpreter_names(path).is_some_and(|names| {
        names.iter().any(|name| {
            matches!(
                name.as_str(),
                "sh" | "bash" | "dash" | "zsh" | "ksh" | "ash"
            )
        })
    })
}

fn is_python_script(path: &Path) -> bool {
    path.extension().is_some_and(|extension| {
        matches!(
            extension.to_string_lossy().to_ascii_lowercase().as_str(),
            "py" | "pyw"
        )
    }) || shebang_interpreter_names(path)
        .is_some_and(|names| names.iter().any(|name| is_python_interpreter_name(name)))
}

fn is_ruby_script(path: &Path) -> bool {
    path.extension()
        .is_some_and(|extension| extension.to_string_lossy().eq_ignore_ascii_case("rb"))
        || shebang_interpreter_names(path)
            .is_some_and(|names| names.iter().any(|name| name == "ruby"))
}

fn direct_script_dependency_scope(command_parent: &Path, home: &Path) -> PathBuf {
    let canonical_home = std::fs::canonicalize(home).unwrap_or_else(|_| home.to_owned());
    if canonical_home != Path::new("/") && command_parent.starts_with(&canonical_home) {
        return canonical_home;
    }
    command_parent
        .parent()
        .filter(|parent| *parent != Path::new("/"))
        .unwrap_or(command_parent)
        .to_owned()
}

fn shell_directory_variables(
    source: &str,
    script_parent: &Path,
) -> std::collections::BTreeMap<String, PathBuf> {
    source
        .lines()
        .filter_map(|line| {
            let line = line
                .trim_start()
                .strip_prefix("export ")
                .unwrap_or(line.trim_start());
            let (name, value) = line.split_once('=')?;
            let valid_name = !name.is_empty()
                && name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
            if !valid_name {
                return None;
            }
            let value = value.trim().trim_matches(['"', '\'']);
            let prefix = ["$(dirname \"$0\")", "$(dirname -- \"$0\")"]
                .into_iter()
                .find(|prefix| value.starts_with(prefix))?;
            let suffix = value.strip_prefix(prefix)?;
            if suffix.contains(['$', '*', '?', ';', '&', '|', '\n', '\r']) {
                return None;
            }
            let relative = suffix.strip_prefix('/').unwrap_or(suffix);
            let relative_path = Path::new(relative);
            if relative_path.is_absolute()
                || relative_path.components().any(|component| {
                    !matches!(
                        component,
                        std::path::Component::Normal(_)
                            | std::path::Component::CurDir
                            | std::path::Component::ParentDir
                    )
                })
            {
                return None;
            }
            let directory = script_parent.join(relative_path).canonicalize().ok()?;
            directory.is_dir().then(|| (name.to_owned(), directory))
        })
        .collect()
}

fn shell_changes_to_script_directory<'a>(
    line: &'a str,
    directory_variables: &std::collections::BTreeMap<String, PathBuf>,
    script_parent: &Path,
) -> Option<(PathBuf, &'a str)> {
    const CD_TO_SCRIPT_DIRECTORY: &str = "cd \"$(dirname \"$0\")\"";
    let line = line.trim_start();
    if let Some(remainder) = line.strip_prefix(CD_TO_SCRIPT_DIRECTORY) {
        return Some((
            script_parent.to_owned(),
            shell_command_after_directory_change(remainder)?,
        ));
    }

    let remainder = line.strip_prefix("cd ")?.trim_start();
    let (operand, remainder) = if let Some(quoted) = remainder.strip_prefix('"') {
        let end = quoted.find('"')?;
        (&quoted[..end], &quoted[end + 1..])
    } else {
        let end = remainder
            .find(|character: char| character.is_whitespace() || ";|&".contains(character))
            .unwrap_or(remainder.len());
        (&remainder[..end], &remainder[end..])
    };
    let variable = operand
        .strip_prefix("${")
        .and_then(|value| value.strip_suffix('}'))
        .or_else(|| operand.strip_prefix('$'))?;
    Some((
        directory_variables.get(variable)?.clone(),
        shell_command_after_directory_change(remainder)?,
    ))
}

fn shell_command_after_directory_change(remainder: &str) -> Option<&str> {
    if remainder.trim().is_empty() {
        return Some("");
    }
    let remainder = remainder.trim_start();
    remainder
        .strip_prefix("&&")
        .or_else(|| remainder.strip_prefix(';'))
        .map(str::trim_start)
}

fn shell_executable_name(token: &str) -> String {
    let token = token.trim_matches(['"', '\'']);
    let name = Path::new(token)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    name.strip_suffix(".exe").unwrap_or(&name).to_owned()
}

struct ShellNodeInvocation {
    script_operand: Option<String>,
    file_operands: Vec<(String, bool)>,
    env_file_operands: Vec<(String, std::ops::Range<usize>, bool)>,
}

fn shell_argument_span(
    line: &str,
    span: std::ops::Range<usize>,
) -> (String, std::ops::Range<usize>) {
    let bytes = line.as_bytes();
    let mut start = span.start;
    let mut end = span.end;
    while start < end && matches!(bytes[start], b'"' | b'\'') {
        start += 1;
    }
    while start < end && matches!(bytes[end - 1], b'"' | b'\'') {
        end -= 1;
    }
    while start < end && matches!(bytes[end - 1], b';' | b'&') {
        end -= 1;
    }
    while start < end && matches!(bytes[start], b'"' | b'\'') {
        start += 1;
    }
    while start < end && matches!(bytes[end - 1], b'"' | b'\'') {
        end -= 1;
    }
    (line[start..end].to_owned(), start..end)
}

fn shell_node_invocation(line: &str) -> Option<ShellNodeInvocation> {
    let mut word_spans = Vec::new();
    let mut offset = 0;
    for word in line.split_ascii_whitespace() {
        let start = line[offset..].find(word)? + offset;
        let span = start..start + word.len();
        offset = span.end;
        word_spans.push(span);
    }
    let words = word_spans
        .iter()
        .map(|span| line[span.clone()].trim_matches(['"', '\'']))
        .collect::<Vec<_>>();
    let node_index = words
        .iter()
        .position(|word| matches!(shell_executable_name(word).as_str(), "node" | "nodejs"))?;
    let mut index = node_index + 1;
    const NODE_OPTIONS_WITH_VALUE: [&str; 9] = [
        "-r",
        "--require",
        "--import",
        "--loader",
        "--experimental-loader",
        "--conditions",
        "--env-file",
        "--env-file-if-exists",
        "--inspect-port",
    ];
    const NODE_SCRIPT_FILE_OPTIONS: [&str; 5] = [
        "-r",
        "--require",
        "--import",
        "--loader",
        "--experimental-loader",
    ];
    let mut file_operands = Vec::new();
    let mut env_file_operands = Vec::new();
    while let Some(argument) = words.get(index) {
        if *argument == "--" {
            index += 1;
            break;
        }
        let (option, inline_value) = argument
            .split_once('=')
            .map_or((*argument, None), |(option, value)| (option, Some(value)));
        if NODE_OPTIONS_WITH_VALUE.contains(&option) {
            let operand_index = if inline_value.is_some() {
                index
            } else {
                index + 1
            };
            let raw_span = word_spans.get(operand_index)?.clone();
            let operand_span = if inline_value.is_some() {
                let equals = line[raw_span.clone()].find('=')? + raw_span.start + 1;
                equals..raw_span.end
            } else {
                raw_span
            };
            let (raw_value, value_span) = shell_argument_span(line, operand_span);
            let value = if raw_value.is_empty() {
                inline_value
                    .or_else(|| words.get(index + 1).copied())?
                    .trim_matches(['"', '\''])
                    .to_owned()
            } else {
                raw_value
            };
            let is_script = NODE_SCRIPT_FILE_OPTIONS.contains(&option);
            let is_env_file = matches!(option, "--env-file" | "--env-file-if-exists");
            let is_path = (is_env_file && !value.starts_with('-'))
                || Path::new(&value).is_absolute()
                || value.starts_with("./")
                || value.starts_with("../")
                || value.contains(['$', '*', '?']);
            if is_path && is_script {
                file_operands.push((value.clone(), is_script));
            }
            if is_env_file && is_path {
                env_file_operands.push((value, value_span, option == "--env-file-if-exists"));
            }
            index += if inline_value.is_some() { 1 } else { 2 };
            continue;
        }
        if argument.starts_with('-') {
            index += 1;
            continue;
        }
        break;
    }
    let script_operand = words
        .get(index)
        .map(|argument| argument.trim_end_matches([';', '&']))
        .filter(|argument| {
            !Path::new(argument).is_absolute()
                && !argument.is_empty()
                && !argument.contains(['$', '*', '?'])
                && is_node_script_path(argument)
        })
        .map(str::to_owned);
    Some(ShellNodeInvocation {
        script_operand,
        file_operands,
        env_file_operands,
    })
}

fn shell_source_operand(line: &str) -> Option<String> {
    let line = line.trim_start();
    let rest = if let Some(rest) = line.strip_prefix("source") {
        if !rest.starts_with(char::is_whitespace) {
            return None;
        }
        rest
    } else if let Some(rest) = line.strip_prefix('.') {
        if !rest.starts_with(char::is_whitespace) {
            return None;
        }
        rest
    } else {
        return None;
    }
    .trim_start();
    if let Some(rest) = rest.strip_prefix("\"$(dirname \"$0\")/") {
        let end = rest.find('\"')?;
        return Some(format!("$(dirname \"$0\")/{}", &rest[..end]));
    }
    let first = rest.chars().next()?;
    if first == '\'' || first == '"' {
        let end = rest[1..].find(first)? + 1;
        Some(rest[1..end].to_owned())
    } else {
        rest.split(|character: char| character.is_whitespace() || ";|&".contains(character))
            .next()
            .filter(|operand| !operand.is_empty())
            .map(str::to_owned)
    }
}

fn shell_source_path(
    script_parent: &Path,
    operand: &str,
    directory_variables: &std::collections::BTreeMap<String, PathBuf>,
) -> Result<Option<PathBuf>, &'static str> {
    if operand.starts_with('/') {
        return Ok(None);
    }
    const SCRIPT_DIRECTORY_SUBSTITUTION: &str = "$(dirname \"$0\")/";
    if let Some(relative) = operand.strip_prefix(SCRIPT_DIRECTORY_SUBSTITUTION) {
        if relative.is_empty() || relative.contains(['$', '*', '?']) {
            return Err("direct MCP shell script has an unresolved dynamic source path");
        }
        return Ok(Some(script_parent.join(relative)));
    }
    let mut relative = operand;
    if let Some(variable) = operand.strip_prefix("${") {
        let Some((name, suffix)) = variable.split_once('}') else {
            return Ok(None);
        };
        let base = directory_variables
            .get(name)
            .ok_or("direct MCP shell script has an unresolved dynamic source path")?;
        relative = suffix.strip_prefix('/').unwrap_or(suffix);
        if relative.is_empty() || relative.contains(['$', '*', '?']) {
            return Err("direct MCP shell script has an unresolved dynamic source path");
        }
        return Ok(Some(base.join(relative)));
    } else if let Some(variable) = operand.strip_prefix('$') {
        let (name, suffix) = variable
            .split_once('/')
            .ok_or("direct MCP shell script has an unresolved dynamic source path")?;
        let base = directory_variables
            .get(name)
            .ok_or("direct MCP shell script has an unresolved dynamic source path")?;
        relative = suffix;
        if relative.is_empty() || relative.contains(['$', '*', '?']) {
            return Err("direct MCP shell script has an unresolved dynamic source path");
        }
        return Ok(Some(base.join(relative)));
    }
    if relative.is_empty() || relative.contains(['$', '*', '?']) {
        return Err("direct MCP shell script has an unresolved dynamic source path");
    }
    Ok(Some(script_parent.join(relative)))
}

fn shell_directory_relative_paths(
    line: &str,
    directory_variables: &std::collections::BTreeMap<String, PathBuf>,
    script_parent: &Path,
) -> std::collections::BTreeSet<PathBuf> {
    let mut result = std::collections::BTreeSet::new();
    let mut prefixes = std::collections::BTreeMap::new();
    for (variable, directory) in directory_variables {
        prefixes.insert(format!("${variable}/"), directory.clone());
        prefixes.insert(format!("${{{variable}}}/"), directory.clone());
    }
    prefixes.insert("$(dirname \"$0\")/".to_owned(), script_parent.to_owned());
    for (prefix, directory) in prefixes {
        let mut search_from = 0;
        while search_from < line.len() {
            let Some(relative_start) = line[search_from..].find(&prefix) else {
                break;
            };
            let start = search_from + relative_start;
            let suffix = &line[start + prefix.len()..];
            let length = suffix
                .find(|character: char| character.is_whitespace() || "\"'`;|&)".contains(character))
                .unwrap_or(suffix.len());
            let relative = &suffix[..length];
            let candidate = directory.join(relative);
            if !relative.is_empty()
                && !relative.contains(['$', '*', '?'])
                && candidate.is_file()
                && (!shell_directory_path_is_redirection_target(line, start) || candidate.exists())
            {
                result.insert(candidate);
            }
            search_from = start + prefix.len() + length;
        }
    }
    result
}

fn shell_directory_path_is_redirection_target(line: &str, path_start: usize) -> bool {
    let bytes = line.as_bytes();
    let mut at = 0;
    let mut quote = None;
    let mut quote_start = None;
    let mut escaped = false;
    while at < path_start {
        let byte = bytes[at];
        if escaped {
            escaped = false;
        } else if byte == b'\\' && quote != Some(b'\'') {
            escaped = true;
        } else if let Some(active_quote) = quote {
            if byte == active_quote {
                quote = None;
                quote_start = None;
            }
        } else if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
            quote_start = Some(at);
        }
        at += 1;
    }
    let prefix_end = if quote.is_some() {
        quote_start.unwrap_or(path_start)
    } else {
        path_start
    };
    line[..prefix_end].trim_end().ends_with('>')
}

fn shell_line_invokes_node(line: &str) -> bool {
    let words = line
        .split_ascii_whitespace()
        .map(|word| word.trim_matches(['"', '\'']))
        .collect::<Vec<_>>();
    let mut index = 0;
    while let Some(word) = words.get(index) {
        if matches!(*word, "exec" | "command") || word.contains('=') {
            index += 1;
        } else {
            break;
        }
    }
    let Some(executable) = words.get(index) else {
        return false;
    };
    match shell_executable_name(executable).as_str() {
        "node" | "nodejs" => return true,
        "env" => index += 1,
        _ => return false,
    }

    while let Some(argument) = words.get(index) {
        if matches!(*argument, "-S" | "--split-string") {
            return words
                .get(index + 1)
                .is_some_and(|command| shell_line_invokes_node(command));
        }
        if let Some(command) = argument.strip_prefix("--split-string=") {
            return shell_line_invokes_node(command);
        }
        if matches!(*argument, "-u" | "--unset" | "-C" | "--chdir" | "--argv0") {
            index += 2;
            continue;
        }
        if argument.starts_with('-') || argument.contains('=') {
            index += 1;
            continue;
        }
        return matches!(shell_executable_name(argument).as_str(), "node" | "nodejs");
    }
    false
}

enum JavaScriptToken {
    Identifier(String),
    String(Option<String>),
    Regex,
    Punctuation(u8),
    TemplateBoundary,
}

fn javascript_control_header_closes(tokens: &[JavaScriptToken]) -> bool {
    if !matches!(tokens.last(), Some(JavaScriptToken::Punctuation(b')'))) {
        return false;
    }
    let mut depth = 0usize;
    for (index, token) in tokens.iter().enumerate().rev() {
        match token {
            JavaScriptToken::Punctuation(b')') => depth += 1,
            JavaScriptToken::Punctuation(b'(') => {
                depth -= 1;
                if depth == 0 {
                    return index > 0
                        && matches!(
                            tokens.get(index - 1),
                            Some(JavaScriptToken::Identifier(keyword))
                                if matches!(keyword.as_str(), "for" | "if" | "while" | "with")
                        );
                }
            }
            _ => {}
        }
    }
    false
}

fn javascript_regex_can_start_after(tokens: &[JavaScriptToken]) -> bool {
    match tokens.last() {
        None => true,
        Some(JavaScriptToken::Punctuation(byte)) => {
            matches!(
                byte,
                b'(' | b'['
                    | b'{'
                    | b','
                    | b';'
                    | b':'
                    | b'='
                    | b'!'
                    | b'?'
                    | b'&'
                    | b'|'
                    | b'+'
                    | b'-'
                    | b'*'
                    | b'%'
                    | b'^'
                    | b'~'
                    | b'<'
                    | b'>'
                    | b'/'
            ) || matches!(byte, b')') && javascript_control_header_closes(tokens)
                || matches!(byte, b'+' | b'-')
                    && tokens.len() >= 3
                    && matches!(
                        (tokens.get(tokens.len() - 2), tokens.get(tokens.len() - 3)),
                        (
                            Some(JavaScriptToken::Punctuation(previous)),
                            Some(JavaScriptToken::Identifier(_)
                                | JavaScriptToken::String(_)
                                | JavaScriptToken::Regex)
                        ) if previous == byte
                    )
        }
        Some(JavaScriptToken::Identifier(keyword)) => {
            !matches!(
                tokens.get(tokens.len().saturating_sub(2)),
                Some(JavaScriptToken::Punctuation(b'.'))
            ) && matches!(
                keyword.as_str(),
                "await"
                    | "case"
                    | "delete"
                    | "do"
                    | "else"
                    | "in"
                    | "instanceof"
                    | "new"
                    | "of"
                    | "return"
                    | "throw"
                    | "typeof"
                    | "void"
                    | "yield"
            )
        }
        Some(
            JavaScriptToken::String(_) | JavaScriptToken::Regex | JavaScriptToken::TemplateBoundary,
        ) => false,
    }
}

fn javascript_regex_end(bytes: &[u8], start: usize) -> Result<Option<usize>, &'static str> {
    let mut at = start + 1;
    let mut escaped = false;
    let mut in_character_class = false;
    while at < bytes.len() {
        let byte = bytes[at];
        if byte == b'\n' || byte == b'\r' {
            return Err("direct MCP Node script has an unterminated regular expression");
        }
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == b'[' {
            in_character_class = true;
        } else if byte == b']' {
            in_character_class = false;
        } else if byte == b'/' && !in_character_class {
            at += 1;
            while bytes
                .get(at)
                .is_some_and(|flag| *flag == b'_' || *flag == b'$' || flag.is_ascii_alphanumeric())
            {
                at += 1;
            }
            return Ok(Some(at));
        }
        at += 1;
    }
    Ok(None)
}

const MAX_JAVASCRIPT_TOKENS: usize = 100_000;
const MAX_JAVASCRIPT_TEMPLATE_DEPTH: usize = 64;

fn push_javascript_token(
    tokens: &mut Vec<JavaScriptToken>,
    token: JavaScriptToken,
    token_count: &mut usize,
) -> Result<(), &'static str> {
    *token_count += 1;
    if *token_count > MAX_JAVASCRIPT_TOKENS {
        return Err("direct MCP Node dependency scan exceeds its token bound");
    }
    tokens.push(token);
    Ok(())
}

fn javascript_template_tokens(
    source: &str,
    start: usize,
    depth: usize,
    token_count: &mut usize,
) -> Result<(Vec<JavaScriptToken>, usize), &'static str> {
    if depth >= MAX_JAVASCRIPT_TEMPLATE_DEPTH {
        return Err("direct MCP Node dependency scan exceeds its template nesting bound");
    }
    let bytes = source.as_bytes();
    let mut at = start + 1;
    let mut result = Vec::new();
    while at < bytes.len() {
        if bytes[at] == b'\\' {
            at = (at + 2).min(bytes.len());
        } else if bytes[at] == b'`' {
            at += 1;
            push_javascript_token(&mut result, JavaScriptToken::String(None), token_count)?;
            return Ok((result, at));
        } else if bytes.get(at..at + 2) == Some(b"${") {
            push_javascript_token(&mut result, JavaScriptToken::TemplateBoundary, token_count)?;
            let expression_start = at + 2;
            let (expression, expression_end) =
                javascript_tokens_inner(source, expression_start, true, depth + 1, token_count)?;
            if bytes.get(expression_end) != Some(&b'}') {
                return Err("direct MCP Node script has an incomplete template expression");
            }
            result.extend(expression);
            push_javascript_token(&mut result, JavaScriptToken::TemplateBoundary, token_count)?;
            at = expression_end + 1;
        } else {
            at += 1;
        }
    }
    Err("direct MCP Node script has an unterminated template string")
}

fn javascript_tokens_inner(
    source: &str,
    start: usize,
    stop_at_template_expression_end: bool,
    template_depth: usize,
    token_count: &mut usize,
) -> Result<(Vec<JavaScriptToken>, usize), &'static str> {
    let bytes = source.as_bytes();
    let mut at = start;
    let mut result = Vec::new();
    let mut brace_depth = 0usize;
    while at < bytes.len() {
        if stop_at_template_expression_end && bytes[at] == b'}' && brace_depth == 0 {
            return Ok((result, at));
        }
        if bytes[at].is_ascii_whitespace() {
            at += 1;
            continue;
        }
        if bytes.get(at..at + 2) == Some(b"//") {
            while bytes.get(at).is_some_and(|byte| *byte != b'\n') {
                at += 1;
            }
            continue;
        }
        if bytes.get(at..at + 2) == Some(b"/*") {
            at += 2;
            while at < bytes.len() && bytes.get(at..at + 2) != Some(b"*/") {
                at += 1;
            }
            if at == bytes.len() {
                return Err("direct MCP Node script has an incomplete comment");
            }
            at += 2;
            continue;
        }
        let start = at;
        let byte = bytes[at];
        if byte == b'\'' || byte == b'"' {
            let quote = byte;
            at += 1;
            let content_start = at;
            let mut escaped = false;
            while at < bytes.len() && bytes[at] != quote {
                if bytes[at] == b'\\' {
                    escaped = true;
                    at = (at + 2).min(bytes.len());
                } else {
                    at += 1;
                }
            }
            if at == bytes.len() {
                return Err("direct MCP Node script has an unterminated string");
            }
            let value = (!escaped).then(|| source[content_start..at].to_owned());
            at += 1;
            push_javascript_token(&mut result, JavaScriptToken::String(value), token_count)?;
        } else if byte == b'`' {
            let (template_tokens, template_end) =
                javascript_template_tokens(source, at, template_depth, token_count)?;
            result.extend(template_tokens);
            at = template_end;
        } else if byte == b'/' && javascript_regex_can_start_after(&result) {
            if let Some(end) = javascript_regex_end(bytes, at)? {
                at = end;
                push_javascript_token(&mut result, JavaScriptToken::Regex, token_count)?;
            } else {
                at += 1;
                push_javascript_token(
                    &mut result,
                    JavaScriptToken::Punctuation(byte),
                    token_count,
                )?;
            }
        } else if byte == b'_' || byte == b'$' || byte.is_ascii_alphabetic() {
            at += 1;
            while bytes
                .get(at)
                .is_some_and(|byte| *byte == b'_' || *byte == b'$' || byte.is_ascii_alphanumeric())
            {
                at += 1;
            }
            push_javascript_token(
                &mut result,
                JavaScriptToken::Identifier(source[start..at].to_owned()),
                token_count,
            )?;
        } else {
            if byte == b'{' {
                brace_depth += 1;
            } else if byte == b'}' {
                brace_depth = brace_depth.saturating_sub(1);
            }
            at += 1;
            push_javascript_token(&mut result, JavaScriptToken::Punctuation(byte), token_count)?;
        }
    }
    if stop_at_template_expression_end {
        Err("direct MCP Node script has an incomplete template expression")
    } else {
        Ok((result, at))
    }
}

fn javascript_tokens(source: &str) -> Result<Vec<JavaScriptToken>, &'static str> {
    let mut token_count = 0;
    javascript_tokens_inner(source, 0, false, 0, &mut token_count).map(|(tokens, _)| tokens)
}

fn javascript_deferred_function_tokens(
    tokens: &[JavaScriptToken],
    matching_braces: &[Option<usize>],
) -> std::collections::BTreeSet<usize> {
    let mut matching_parentheses = vec![None; tokens.len()];
    let mut opening_parentheses = vec![None; tokens.len()];
    let mut open_parentheses = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        match token {
            JavaScriptToken::Punctuation(b'(') => open_parentheses.push(index),
            JavaScriptToken::Punctuation(b')') => {
                if let Some(open) = open_parentheses.pop() {
                    matching_parentheses[open] = Some(index);
                    opening_parentheses[index] = Some(open);
                }
            }
            _ => {}
        }
    }

    let immediately_invoked_group = |function_start: usize, body_end: usize| {
        matches!(
            tokens.get(body_end + 1),
            Some(JavaScriptToken::Punctuation(b')'))
        ) && opening_parentheses
            .get(body_end + 1)
            .and_then(|open| *open)
            .is_some_and(|open| {
                open < function_start
                    && matches!(
                        tokens.get(body_end + 2),
                        Some(JavaScriptToken::Punctuation(b'('))
                    )
            })
    };

    let mut deferred_ranges = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        if matches!(token, JavaScriptToken::Identifier(name) if name == "function") {
            let mut cursor = index + 1;
            if matches!(tokens.get(cursor), Some(JavaScriptToken::Punctuation(b'*'))) {
                cursor += 1;
            }
            if matches!(tokens.get(cursor), Some(JavaScriptToken::Identifier(_))) {
                cursor += 1;
            }
            if matches!(tokens.get(cursor), Some(JavaScriptToken::Punctuation(b'('))) {
                if let Some(parameters_end) = matching_parentheses[cursor] {
                    let body = parameters_end + 1;
                    if matches!(tokens.get(body), Some(JavaScriptToken::Punctuation(b'{'))) {
                        if let Some(body_end) = matching_braces[body] {
                            if !immediately_invoked_group(index, body_end) {
                                deferred_ranges.push(body + 1..body_end);
                            }
                        }
                    }
                }
            }
        }

        if matches!(
            (token, tokens.get(index + 1)),
            (
                JavaScriptToken::Punctuation(b'='),
                Some(JavaScriptToken::Punctuation(b'>'))
            )
        ) {
            let body = index + 2;
            if matches!(tokens.get(body), Some(JavaScriptToken::Punctuation(b'{'))) {
                if let Some(body_end) = matching_braces[body] {
                    if !immediately_invoked_group(index, body_end) {
                        deferred_ranges.push(body + 1..body_end);
                    }
                }
            } else {
                let (mut parentheses, mut brackets, mut braces) = (0usize, 0usize, 0usize);
                let mut end = body;
                while end < tokens.len() {
                    match tokens.get(end) {
                        Some(JavaScriptToken::Punctuation(b'(')) => parentheses += 1,
                        Some(JavaScriptToken::Punctuation(b')')) if parentheses == 0 => break,
                        Some(JavaScriptToken::Punctuation(b')')) => parentheses -= 1,
                        Some(JavaScriptToken::Punctuation(b'[')) => brackets += 1,
                        Some(JavaScriptToken::Punctuation(b']')) if brackets == 0 => break,
                        Some(JavaScriptToken::Punctuation(b']')) => brackets -= 1,
                        Some(JavaScriptToken::Punctuation(b'{')) => braces += 1,
                        Some(JavaScriptToken::Punctuation(b'}')) if braces == 0 => break,
                        Some(JavaScriptToken::Punctuation(b'}')) => braces -= 1,
                        Some(JavaScriptToken::Punctuation(b';' | b','))
                            if parentheses == 0 && brackets == 0 && braces == 0 =>
                        {
                            break
                        }
                        _ => {}
                    }
                    end += 1;
                }
                let immediately_invoked =
                    matches!(tokens.get(end), Some(JavaScriptToken::Punctuation(b')')))
                        && opening_parentheses
                            .get(end)
                            .and_then(|open| *open)
                            .is_some_and(|open| {
                                open < index
                                    && matches!(
                                        tokens.get(end + 1),
                                        Some(JavaScriptToken::Punctuation(b'('))
                                    )
                            });
                if !immediately_invoked {
                    deferred_ranges.push(body..end);
                }
            }
        }

        if matches!(token, JavaScriptToken::Punctuation(b')'))
            && matches!(
                tokens.get(index + 1),
                Some(JavaScriptToken::Punctuation(b'{'))
            )
        {
            let Some(open) = opening_parentheses[index] else {
                continue;
            };
            let is_control_body = matches!(
                tokens.get(open.wrapping_sub(1)),
                Some(JavaScriptToken::Identifier(keyword))
                    if matches!(keyword.as_str(), "if" | "for" | "while" | "switch" | "catch" | "with")
            );
            if !is_control_body {
                if let Some(body_end) = matching_braces[index + 1] {
                    deferred_ranges.push(index + 2..body_end);
                }
            }
        }
    }
    deferred_ranges.into_iter().flatten().collect()
}

fn javascript_try_catch_bodies(tokens: &[JavaScriptToken]) -> std::collections::BTreeSet<usize> {
    let mut matching_braces = vec![None; tokens.len()];
    let mut open_braces = Vec::new();
    for (index, token) in tokens.iter().enumerate() {
        match token {
            JavaScriptToken::Punctuation(b'{') => open_braces.push(index),
            JavaScriptToken::Punctuation(b'}') => {
                if let Some(open) = open_braces.pop() {
                    matching_braces[open] = Some(index);
                }
            }
            _ => {}
        }
    }

    let mut result = std::collections::BTreeSet::new();
    for (index, token) in tokens.iter().enumerate() {
        if !matches!(token, JavaScriptToken::Identifier(keyword) if keyword == "try")
            || !matches!(
                tokens.get(index + 1),
                Some(JavaScriptToken::Punctuation(b'{'))
            )
        {
            continue;
        }
        let Some(body_end) = matching_braces[index + 1] else {
            continue;
        };
        if !matches!(tokens.get(body_end + 1), Some(JavaScriptToken::Identifier(keyword)) if keyword == "catch")
        {
            continue;
        }
        let mut catch_body = body_end + 2;
        if matches!(
            tokens.get(catch_body),
            Some(JavaScriptToken::Punctuation(b'('))
        ) {
            let mut depth = 0usize;
            while catch_body < tokens.len() {
                match tokens.get(catch_body) {
                    Some(JavaScriptToken::Punctuation(b'(')) => depth += 1,
                    Some(JavaScriptToken::Punctuation(b')')) => {
                        depth = depth.saturating_sub(1);
                        if depth == 0 {
                            catch_body += 1;
                            break;
                        }
                    }
                    _ => {}
                }
                catch_body += 1;
            }
        }
        if matches!(
            tokens.get(catch_body),
            Some(JavaScriptToken::Punctuation(b'{'))
        ) && matching_braces[catch_body].is_some()
        {
            result.extend(index + 2..body_end);
        }
    }
    let deferred_function_tokens = javascript_deferred_function_tokens(tokens, &matching_braces);
    result.retain(|index| !deferred_function_tokens.contains(index));
    result
}

struct NodeModuleSpecifier {
    value: String,
    missing_is_optional: bool,
}

fn node_relative_module_specifiers(source: &str) -> Result<Vec<NodeModuleSpecifier>, &'static str> {
    let tokens = javascript_tokens(source)?;
    let optional_try_tokens = javascript_try_catch_bodies(&tokens);
    let mut result = std::collections::BTreeMap::<String, bool>::new();
    for (index, token) in tokens.iter().enumerate() {
        let (module, require_resolve) = match token {
            JavaScriptToken::Identifier(name) if name == "require" || name == "import" => {
                let require_resolve = name == "require"
                    && matches!(
                        tokens.get(index + 1),
                        Some(JavaScriptToken::Punctuation(b'.'))
                    )
                    && matches!(
                        tokens.get(index + 2),
                        Some(JavaScriptToken::Identifier(method)) if method == "resolve"
                    )
                    && matches!(
                        tokens.get(index + 3),
                        Some(JavaScriptToken::Punctuation(b'('))
                    );
                if require_resolve {
                    (tokens.get(index + 4), true)
                } else {
                    (
                        match tokens.get(index + 1) {
                            Some(JavaScriptToken::Punctuation(b'(')) => tokens.get(index + 2),
                            Some(JavaScriptToken::String(_)) if name == "import" => {
                                tokens.get(index + 1)
                            }
                            _ => None,
                        },
                        false,
                    )
                }
            }
            JavaScriptToken::Identifier(name) if name == "from" => (tokens.get(index + 1), false),
            _ => (None, false),
        };
        if let Some(JavaScriptToken::String(Some(specifier))) = module {
            if specifier.starts_with("./") || specifier.starts_with("../") {
                let missing_is_optional = require_resolve && optional_try_tokens.contains(&index);
                result
                    .entry(specifier.clone())
                    .and_modify(|prior| *prior &= missing_is_optional)
                    .or_insert(missing_is_optional);
            }
        }
    }
    Ok(result
        .into_iter()
        .map(|(value, missing_is_optional)| NodeModuleSpecifier {
            value,
            missing_is_optional,
        })
        .collect())
}

fn node_relative_resource_specifiers(
    parent: &Path,
    source: &str,
) -> Result<std::collections::BTreeMap<String, bool>, &'static str> {
    let tokens = javascript_tokens(source)?;
    let scopes = javascript_lexical_scopes(&tokens)?;
    let (output_destinations, output_destination_variables) =
        node_output_destination_mask(&tokens, &scopes.token_scope_ids)?;
    let binding_declarations = node_variable_binding_declaration_counts(&tokens, &scopes);
    let mut binding_resolver = JavaScriptBindingResolver::new(&scopes, &binding_declarations);
    let mut output_destination_bindings = std::collections::BTreeSet::new();
    for (name, reference_scope) in &output_destination_variables {
        if let Some(binding_scope) = binding_resolver.resolve(name, *reference_scope)? {
            output_destination_bindings.insert((name.clone(), binding_scope));
        }
    }
    let conditional_aliases = node_conditional_alias_analysis(
        &tokens,
        &scopes,
        &binding_declarations,
        &mut binding_resolver,
    )?;
    conditional_aliases.propagate_to_sources(&mut output_destination_bindings);
    let ambiguous_output_bindings = node_ambiguous_output_bindings(
        &tokens,
        &scopes,
        &output_destinations,
        &mut binding_resolver,
        &conditional_aliases.safe_reference_indices,
    )?;
    let mut ambiguous_output_bindings = ambiguous_output_bindings;
    conditional_aliases.propagate_to_sources(&mut ambiguous_output_bindings);
    let mut result = std::collections::BTreeMap::<String, bool>::new();
    for index in 0..tokens.len() {
        if index >= 2
            && matches!(tokens.get(index - 2), Some(JavaScriptToken::Identifier(_)))
            && matches!(
                tokens.get(index - 1),
                Some(JavaScriptToken::Punctuation(b'.'))
            )
            && matches!(tokens.get(index), Some(JavaScriptToken::Identifier(name)) if name == "join")
            && matches!(
                tokens.get(index + 1),
                Some(JavaScriptToken::Punctuation(b'('))
            )
            && matches!(tokens.get(index + 2), Some(JavaScriptToken::Identifier(name)) if name == "__dirname")
            && matches!(
                tokens.get(index + 3),
                Some(JavaScriptToken::Punctuation(b','))
            )
        {
            let mut cursor = index + 4;
            let mut components = Vec::new();
            let is_closed = loop {
                if let Some(JavaScriptToken::String(Some(component))) = tokens.get(cursor) {
                    components.push(component.as_str());
                    cursor += 1;
                } else {
                    break false;
                }
                match tokens.get(cursor) {
                    Some(JavaScriptToken::Punctuation(b')')) => break true,
                    Some(JavaScriptToken::Punctuation(b',')) => {
                        cursor += 1;
                        if matches!(tokens.get(cursor), Some(JavaScriptToken::Punctuation(b')'))) {
                            break true;
                        }
                    }
                    _ => break false,
                }
            };
            if is_closed && !components.is_empty() {
                let mut relative = PathBuf::new();
                let safe = components.iter().all(|component| {
                    if component.is_empty() || component.contains(['?', '#', '\\', '$', '*']) {
                        return false;
                    }
                    let path = Path::new(component);
                    if path.components().any(|part| {
                        matches!(
                            part,
                            std::path::Component::Prefix(_) | std::path::Component::RootDir
                        )
                    }) {
                        return false;
                    }
                    relative.push(path);
                    true
                });
                if safe && !relative.as_os_str().is_empty() {
                    let relative = relative.to_string_lossy().into_owned();
                    if !output_destinations[index - 2] || parent.join(&relative).exists() {
                        result
                            .entry(relative)
                            .and_modify(|writable| *writable |= output_destinations[index - 2])
                            .or_insert(output_destinations[index - 2]);
                    }
                }
            }
        }
        let Some(JavaScriptToken::Identifier(new_keyword)) = tokens.get(index) else {
            continue;
        };
        let Some(JavaScriptToken::Identifier(url_constructor)) = tokens.get(index + 1) else {
            continue;
        };
        let Some(JavaScriptToken::Punctuation(b'(')) = tokens.get(index + 2) else {
            continue;
        };
        let Some(JavaScriptToken::String(Some(specifier))) = tokens.get(index + 3) else {
            continue;
        };
        let is_import_meta_url = matches!(
            tokens.get(index + 4),
            Some(JavaScriptToken::Punctuation(b','))
        ) && matches!(tokens.get(index + 5), Some(JavaScriptToken::Identifier(name)) if name == "import")
            && matches!(
                tokens.get(index + 6),
                Some(JavaScriptToken::Punctuation(b'.'))
            )
            && matches!(tokens.get(index + 7), Some(JavaScriptToken::Identifier(name)) if name == "meta")
            && matches!(
                tokens.get(index + 8),
                Some(JavaScriptToken::Punctuation(b'.'))
            )
            && matches!(tokens.get(index + 9), Some(JavaScriptToken::Identifier(name)) if name == "url")
            && (matches!(
                tokens.get(index + 10),
                Some(JavaScriptToken::Punctuation(b')'))
            ) || (matches!(
                tokens.get(index + 10),
                Some(JavaScriptToken::Punctuation(b','))
            ) && matches!(
                tokens.get(index + 11),
                Some(JavaScriptToken::Punctuation(b')'))
            )));
        let is_bound_output_destination = node_simple_url_binding_declaration(
            &tokens, index, &scopes,
        )
        .is_some_and(|(name, binding_scope)| {
            output_destination_bindings.contains(&(name.clone(), binding_scope))
                && binding_declarations.get(&(name.clone(), binding_scope)) == Some(&1)
                && !ambiguous_output_bindings.contains(&(name, binding_scope))
        });
        let is_output_destination = output_destinations[index] || is_bound_output_destination;
        if new_keyword == "new"
            && url_constructor == "URL"
            && is_import_meta_url
            && (specifier.starts_with("./") || specifier.starts_with("../"))
            && !specifier.contains(['?', '#', '\\', '$'])
            && (!is_output_destination || parent.join(specifier).exists())
        {
            result
                .entry(specifier.clone())
                .and_modify(|writable| *writable |= is_output_destination)
                .or_insert(is_output_destination);
        }
    }
    Ok(result)
}

struct JavaScriptScopes {
    token_scope_ids: Vec<usize>,
    parent_scope_ids: Vec<Option<usize>>,
    function_scope_ids: std::collections::BTreeSet<usize>,
    parameter_names: std::collections::BTreeMap<usize, std::collections::BTreeSet<String>>,
    parameter_token_indices: std::collections::BTreeSet<usize>,
}

impl JavaScriptScopes {
    fn function_scope_for(&self, mut scope_id: usize) -> usize {
        loop {
            if self.function_scope_ids.contains(&scope_id) {
                return scope_id;
            }
            scope_id = self.parent_scope_ids[scope_id].unwrap_or(0);
        }
    }
}

fn javascript_matching_open_parentheses(tokens: &[JavaScriptToken]) -> Vec<Option<usize>> {
    let mut openings = Vec::new();
    let mut matching_openings = vec![None; tokens.len()];
    for (index, token) in tokens.iter().enumerate() {
        match token {
            JavaScriptToken::Punctuation(b'(') => openings.push(index),
            JavaScriptToken::Punctuation(b')') => {
                if let Some(opening) = openings.pop() {
                    matching_openings[index] = Some(opening);
                }
            }
            _ => {}
        }
    }
    matching_openings
}

fn javascript_arrow_parameter_range(
    tokens: &[JavaScriptToken],
    arrow_index: usize,
    matching_openings: &[Option<usize>],
) -> Option<std::ops::Range<usize>> {
    let previous_index = arrow_index.checked_sub(1)?;
    match tokens.get(previous_index) {
        Some(JavaScriptToken::Identifier(_)) => Some(previous_index..arrow_index),
        Some(JavaScriptToken::Punctuation(b')')) => {
            let opening = matching_openings.get(previous_index).copied().flatten()?;
            Some(opening + 1..previous_index)
        }
        _ => None,
    }
}

fn javascript_scope_header(
    tokens: &[JavaScriptToken],
    brace_index: usize,
    matching_openings: &[Option<usize>],
) -> (bool, Option<std::ops::Range<usize>>) {
    if brace_index >= 2
        && matches!(
            tokens.get(brace_index - 1),
            Some(JavaScriptToken::Punctuation(b'>'))
        )
        && matches!(
            tokens.get(brace_index - 2),
            Some(JavaScriptToken::Punctuation(b'='))
        )
    {
        return (
            true,
            javascript_arrow_parameter_range(tokens, brace_index - 2, matching_openings),
        );
    }

    if brace_index == 0
        || !matches!(
            tokens.get(brace_index - 1),
            Some(JavaScriptToken::Punctuation(b')'))
        )
    {
        return (false, None);
    }
    let close = brace_index - 1;
    let Some(open) = matching_openings.get(close).copied().flatten() else {
        return (false, None);
    };
    let parameters = Some(open + 1..close);
    match open.checked_sub(1).and_then(|index| tokens.get(index)) {
        Some(JavaScriptToken::Identifier(keyword)) if keyword == "catch" => (false, parameters),
        Some(JavaScriptToken::Identifier(keyword))
            if matches!(keyword.as_str(), "if" | "for" | "while" | "switch" | "with") =>
        {
            (false, None)
        }
        Some(JavaScriptToken::Identifier(_)) | Some(JavaScriptToken::String(_)) => {
            (true, parameters)
        }
        Some(JavaScriptToken::Punctuation(b']' | b')')) => (true, parameters),
        _ => (false, None),
    }
}

fn javascript_add_parameter_names(
    tokens: &[JavaScriptToken],
    scope_id: usize,
    parameter_range: std::ops::Range<usize>,
    parameter_names: &mut std::collections::BTreeMap<usize, std::collections::BTreeSet<String>>,
    parameter_token_indices: &mut std::collections::BTreeSet<usize>,
    inspection_budget: &mut usize,
) -> Result<(), &'static str> {
    for index in parameter_range {
        *inspection_budget = inspection_budget.saturating_sub(1);
        if *inspection_budget == 0 {
            return Err("direct MCP Node parameter scan exceeds its token bound");
        }
        if let Some(JavaScriptToken::Identifier(name)) = tokens.get(index) {
            parameter_names
                .entry(scope_id)
                .or_default()
                .insert(name.clone());
            parameter_token_indices.insert(index);
        }
    }
    Ok(())
}

fn javascript_lexical_scopes(tokens: &[JavaScriptToken]) -> Result<JavaScriptScopes, &'static str> {
    let matching_openings = javascript_matching_open_parentheses(tokens);
    let mut token_scope_ids = Vec::with_capacity(tokens.len());
    let mut parent_scope_ids = vec![None];
    let mut function_scope_ids = std::collections::BTreeSet::from([0]);
    let mut parameter_names = std::collections::BTreeMap::new();
    let mut parameter_token_indices = std::collections::BTreeSet::new();
    let mut scope_stack = Vec::new();
    let mut parameter_inspection_budget = MAX_JAVASCRIPT_TOKENS;

    for (index, token) in tokens.iter().enumerate() {
        if matches!(token, JavaScriptToken::Punctuation(b'}')) && scope_stack.pop().is_none() {
            return Err("direct MCP Node script has an unmatched closing brace");
        }
        token_scope_ids.push(scope_stack.last().copied().unwrap_or(0));
        if matches!(token, JavaScriptToken::Punctuation(b'{')) {
            let (is_function_scope, parameters) =
                javascript_scope_header(tokens, index, &matching_openings);
            let parent_scope = scope_stack.last().copied().unwrap_or(0);
            let new_scope = parent_scope_ids.len();
            parent_scope_ids.push(Some(parent_scope));
            if is_function_scope {
                function_scope_ids.insert(new_scope);
            }
            if let Some(parameters) = parameters {
                javascript_add_parameter_names(
                    tokens,
                    new_scope,
                    parameters,
                    &mut parameter_names,
                    &mut parameter_token_indices,
                    &mut parameter_inspection_budget,
                )?;
            }
            scope_stack.push(new_scope);
        }
    }
    if !scope_stack.is_empty() {
        return Err("direct MCP Node script has an unmatched opening brace");
    }

    // A concise arrow expression has no brace scope in the token stream. Add
    // its parameters to the containing scope so a same-name output is treated
    // as shadowed (conservatively for other expressions in that scope too).
    for (index, scope_id) in token_scope_ids
        .iter()
        .enumerate()
        .skip(1)
        .take(tokens.len().saturating_sub(2))
    {
        if !matches!(tokens.get(index), Some(JavaScriptToken::Punctuation(b'=')))
            || !matches!(
                tokens.get(index + 1),
                Some(JavaScriptToken::Punctuation(b'>'))
            )
            || matches!(
                tokens.get(index + 2),
                Some(JavaScriptToken::Punctuation(b'{'))
            )
        {
            continue;
        }
        if let Some(parameters) =
            javascript_arrow_parameter_range(tokens, index, &matching_openings)
        {
            let scope_id = *scope_id;
            javascript_add_parameter_names(
                tokens,
                scope_id,
                parameters,
                &mut parameter_names,
                &mut parameter_token_indices,
                &mut parameter_inspection_budget,
            )?;
        }
    }

    Ok(JavaScriptScopes {
        token_scope_ids,
        parent_scope_ids,
        function_scope_ids,
        parameter_names,
        parameter_token_indices,
    })
}

fn node_variable_binding_scope(kind: &str, scope_id: usize, scopes: &JavaScriptScopes) -> usize {
    if kind == "var" {
        scopes.function_scope_for(scope_id)
    } else {
        scope_id
    }
}

fn node_variable_binding_declaration_counts(
    tokens: &[JavaScriptToken],
    scopes: &JavaScriptScopes,
) -> std::collections::BTreeMap<(String, usize), usize> {
    let mut declarations = std::collections::BTreeMap::new();
    for index in 0..tokens.len().saturating_sub(1) {
        let Some(JavaScriptToken::Identifier(kind)) = tokens.get(index) else {
            continue;
        };
        if !matches!(kind.as_str(), "const" | "let" | "var") {
            continue;
        }
        let Some(JavaScriptToken::Identifier(name)) = tokens.get(index + 1) else {
            continue;
        };
        let scope_id = node_variable_binding_scope(kind, scopes.token_scope_ids[index], scopes);
        *declarations.entry((name.clone(), scope_id)).or_insert(0) += 1;
    }
    for (scope_id, names) in &scopes.parameter_names {
        for name in names {
            *declarations.entry((name.clone(), *scope_id)).or_insert(0) += 1;
        }
    }
    declarations
}

struct JavaScriptBindingResolver<'a> {
    scopes: &'a JavaScriptScopes,
    declarations: &'a std::collections::BTreeMap<(String, usize), usize>,
    resolved: std::collections::BTreeMap<(String, usize), Option<usize>>,
    inspection_budget: usize,
}

impl<'a> JavaScriptBindingResolver<'a> {
    fn new(
        scopes: &'a JavaScriptScopes,
        declarations: &'a std::collections::BTreeMap<(String, usize), usize>,
    ) -> Self {
        Self {
            scopes,
            declarations,
            resolved: std::collections::BTreeMap::new(),
            inspection_budget: MAX_JAVASCRIPT_TOKENS,
        }
    }

    fn resolve(&mut self, name: &str, mut scope_id: usize) -> Result<Option<usize>, &'static str> {
        let cache_key = (name.to_owned(), scope_id);
        if let Some(resolved) = self.resolved.get(&cache_key) {
            return Ok(*resolved);
        }
        let result = loop {
            self.inspection_budget = self.inspection_budget.saturating_sub(1);
            if self.inspection_budget == 0 {
                return Err("direct MCP Node binding resolution exceeds its token bound");
            }
            if self.declarations.contains_key(&(name.to_owned(), scope_id)) {
                break Some(scope_id);
            }
            let Some(parent_scope) = self.scopes.parent_scope_ids[scope_id] else {
                break None;
            };
            scope_id = parent_scope;
        };
        self.resolved.insert(cache_key, result);
        Ok(result)
    }
}

fn node_simple_url_binding_declaration(
    tokens: &[JavaScriptToken],
    index: usize,
    scopes: &JavaScriptScopes,
) -> Option<(String, usize)> {
    if index < 3
        || !matches!(
            tokens.get(index - 1),
            Some(JavaScriptToken::Punctuation(b'='))
        )
    {
        return None;
    }
    let Some(JavaScriptToken::Identifier(name)) = tokens.get(index - 2) else {
        return None;
    };
    let Some(JavaScriptToken::Identifier(kind)) = tokens.get(index - 3) else {
        return None;
    };
    if !matches!(kind.as_str(), "const" | "let" | "var") {
        return None;
    }
    Some((
        name.clone(),
        node_variable_binding_scope(kind, scopes.token_scope_ids[index], scopes),
    ))
}

#[derive(Default)]
struct JavaScriptConditionalAliasAnalysis {
    sources_by_alias: std::collections::BTreeMap<
        JavaScriptBindingKey,
        std::collections::BTreeSet<JavaScriptBindingKey>,
    >,
    safe_reference_indices: std::collections::BTreeSet<usize>,
}

impl JavaScriptConditionalAliasAnalysis {
    fn propagate_to_sources(
        &self,
        bindings: &mut std::collections::BTreeSet<JavaScriptBindingKey>,
    ) {
        let mut pending = bindings.iter().cloned().collect::<Vec<_>>();
        while let Some(alias) = pending.pop() {
            let Some(sources) = self.sources_by_alias.get(&alias) else {
                continue;
            };
            for source in sources {
                if bindings.insert(source.clone()) {
                    pending.push(source.clone());
                }
            }
        }
    }
}

fn node_conditional_alias_analysis(
    tokens: &[JavaScriptToken],
    scopes: &JavaScriptScopes,
    binding_declarations: &std::collections::BTreeMap<JavaScriptBindingKey, usize>,
    resolver: &mut JavaScriptBindingResolver<'_>,
) -> Result<JavaScriptConditionalAliasAnalysis, &'static str> {
    let mut analysis = JavaScriptConditionalAliasAnalysis::default();
    for index in 0..tokens.len().saturating_sub(7) {
        let Some(JavaScriptToken::Identifier(kind)) = tokens.get(index) else {
            continue;
        };
        if !matches!(kind.as_str(), "const" | "let" | "var") {
            continue;
        }
        let Some(JavaScriptToken::Identifier(alias_name)) = tokens.get(index + 1) else {
            continue;
        };
        if !matches!(
            tokens.get(index + 2),
            Some(JavaScriptToken::Punctuation(b'='))
        ) || !matches!(tokens.get(index + 3), Some(JavaScriptToken::Identifier(_)))
            || !matches!(
                tokens.get(index + 4),
                Some(JavaScriptToken::Punctuation(b'?'))
            )
            || !matches!(tokens.get(index + 5), Some(JavaScriptToken::Identifier(_)))
            || !matches!(
                tokens.get(index + 6),
                Some(JavaScriptToken::Punctuation(b':'))
            )
            || !matches!(tokens.get(index + 7), Some(JavaScriptToken::Identifier(_)))
            || !javascript_conditional_alias_initializer_terminates(tokens, index + 8)
        {
            continue;
        }

        let alias_scope = node_variable_binding_scope(kind, scopes.token_scope_ids[index], scopes);
        let alias_key = (alias_name.clone(), alias_scope);
        if binding_declarations.get(&alias_key) != Some(&1) {
            continue;
        }
        let Some(JavaScriptToken::Identifier(source_a_name)) = tokens.get(index + 5) else {
            continue;
        };
        let Some(JavaScriptToken::Identifier(source_b_name)) = tokens.get(index + 7) else {
            continue;
        };
        let Some(source_a_scope) =
            resolver.resolve(source_a_name, scopes.token_scope_ids[index + 5])?
        else {
            continue;
        };
        let Some(source_b_scope) =
            resolver.resolve(source_b_name, scopes.token_scope_ids[index + 7])?
        else {
            continue;
        };
        let source_a_key = (source_a_name.clone(), source_a_scope);
        let source_b_key = (source_b_name.clone(), source_b_scope);
        if binding_declarations.get(&source_a_key) != Some(&1)
            || binding_declarations.get(&source_b_key) != Some(&1)
        {
            continue;
        }

        analysis
            .sources_by_alias
            .entry(alias_key)
            .or_default()
            .extend([source_a_key, source_b_key]);
        analysis
            .safe_reference_indices
            .extend([index + 3, index + 5, index + 7]);
    }
    Ok(analysis)
}

fn javascript_conditional_alias_initializer_terminates(
    tokens: &[JavaScriptToken],
    next_index: usize,
) -> bool {
    // Tokenization drops whitespace, so a following statement's identifier is
    // the bounded ASI signal for this simple initializer. `in` and
    // `instanceof` can still continue the expression; member/call/operator
    // continuations stay fail-closed below.
    match tokens.get(next_index) {
        None | Some(JavaScriptToken::Punctuation(b';' | b',' | b'}')) => true,
        Some(JavaScriptToken::Identifier(keyword)) => {
            !matches!(keyword.as_str(), "in" | "instanceof")
        }
        _ => false,
    }
}

fn node_ambiguous_output_bindings(
    tokens: &[JavaScriptToken],
    scopes: &JavaScriptScopes,
    output_destinations: &[bool],
    resolver: &mut JavaScriptBindingResolver<'_>,
    conditional_alias_references: &std::collections::BTreeSet<usize>,
) -> Result<std::collections::BTreeSet<(String, usize)>, &'static str> {
    let mut ambiguous = std::collections::BTreeSet::new();
    for (index, token) in tokens.iter().enumerate() {
        let JavaScriptToken::Identifier(name) = token else {
            continue;
        };
        if output_destinations[index]
            || conditional_alias_references.contains(&index)
            || scopes.parameter_token_indices.contains(&index)
            || is_javascript_variable_declaration_name(tokens, index)
            || matches!(
                tokens.get(index.checked_sub(1).unwrap_or(usize::MAX)),
                Some(JavaScriptToken::Punctuation(b'.'))
            )
            || javascript_is_object_property_key(tokens, index)
            || javascript_is_safe_property_read(tokens, index)
        {
            continue;
        }
        if let Some(binding_scope) = resolver.resolve(name, scopes.token_scope_ids[index])? {
            ambiguous.insert((name.clone(), binding_scope));
        }
    }
    Ok(ambiguous)
}

fn is_javascript_variable_declaration_name(tokens: &[JavaScriptToken], index: usize) -> bool {
    index > 0
        && matches!(
            tokens.get(index - 1),
            Some(JavaScriptToken::Identifier(keyword))
                if matches!(keyword.as_str(), "const" | "let" | "var")
        )
}

fn javascript_is_object_property_key(tokens: &[JavaScriptToken], index: usize) -> bool {
    matches!(
        tokens.get(index + 1),
        Some(JavaScriptToken::Punctuation(b':'))
    ) && matches!(
        tokens.get(index.checked_sub(1).unwrap_or(usize::MAX)),
        Some(JavaScriptToken::Punctuation(b'{' | b','))
    )
}

fn javascript_is_safe_property_read(tokens: &[JavaScriptToken], index: usize) -> bool {
    if !matches!(
        tokens.get(index + 1),
        Some(JavaScriptToken::Punctuation(b'.'))
    ) || !matches!(tokens.get(index + 2), Some(JavaScriptToken::Identifier(_)))
    {
        return false;
    }

    let mut expression_start = index;
    while expression_start > 0
        && matches!(
            tokens.get(expression_start - 1),
            Some(JavaScriptToken::Punctuation(b'('))
        )
    {
        expression_start -= 1;
    }
    if matches!(
        tokens.get(expression_start.checked_sub(1).unwrap_or(usize::MAX)),
        Some(JavaScriptToken::Identifier(keyword)) if keyword == "delete"
    ) || matches!(
        (
            tokens.get(expression_start.checked_sub(2).unwrap_or(usize::MAX)),
            tokens.get(expression_start.checked_sub(1).unwrap_or(usize::MAX)),
        ),
        (
            Some(JavaScriptToken::Punctuation(b'+' | b'-')),
            Some(JavaScriptToken::Punctuation(b'+' | b'-')),
        )
    ) {
        return false;
    }

    let mut expression_end = index + 3;
    while matches!(
        tokens.get(expression_end),
        Some(JavaScriptToken::Punctuation(b')'))
    ) {
        expression_end += 1;
    }
    if matches!(
        tokens.get(expression_end),
        Some(JavaScriptToken::Punctuation(
            b'(' | b'['
                | b'.'
                | b'+'
                | b'-'
                | b'*'
                | b'/'
                | b'%'
                | b'&'
                | b'|'
                | b'^'
                | b'<'
                | b'>'
                | b'='
        ))
    ) {
        return false;
    }
    true
}

type JavaScriptBindingKey = (String, usize);
type JavaScriptOutputDestinationAnalysis =
    (Vec<bool>, std::collections::BTreeSet<JavaScriptBindingKey>);

fn node_output_destination_mask(
    tokens: &[JavaScriptToken],
    scope_ids: &[usize],
) -> Result<JavaScriptOutputDestinationAnalysis, &'static str> {
    const OUTPUT_CALLS: [(&str, usize); 15] = [
        ("appendFile", 0),
        ("appendFileSync", 0),
        ("createWriteStream", 0),
        ("mkdir", 0),
        ("mkdirSync", 0),
        ("writeFile", 0),
        ("writeFileSync", 0),
        ("copyFile", 1),
        ("copyFileSync", 1),
        ("link", 1),
        ("linkSync", 1),
        ("rename", 1),
        ("renameSync", 1),
        ("symlink", 1),
        ("symlinkSync", 1),
    ];
    let mut ranges = Vec::new();
    let mut direct_variables = std::collections::BTreeSet::new();
    let mut inspection_budget = MAX_JAVASCRIPT_TOKENS;
    for (index, token) in tokens.iter().enumerate() {
        let JavaScriptToken::Identifier(name) = token else {
            continue;
        };
        let Some((_, destination_argument)) = OUTPUT_CALLS
            .iter()
            .find(|(output_call, _)| *output_call == name)
        else {
            continue;
        };
        if !matches!(
            tokens.get(index + 1),
            Some(JavaScriptToken::Punctuation(b'('))
        ) {
            continue;
        }
        let destination_argument = *destination_argument;
        let mut argument_index = 0usize;
        let mut start = index + 2;
        let mut end = None;
        let mut parentheses = 0usize;
        let mut brackets = 0usize;
        let mut braces = 0usize;
        for (cursor, token) in tokens.iter().enumerate().skip(start) {
            inspection_budget = inspection_budget.saturating_sub(1);
            if inspection_budget == 0 {
                return Err("direct MCP Node output scan exceeds its token bound");
            }
            match token {
                JavaScriptToken::Punctuation(b'(') => parentheses += 1,
                JavaScriptToken::Punctuation(b')')
                    if parentheses == 0 && brackets == 0 && braces == 0 =>
                {
                    if argument_index == destination_argument {
                        end = Some(cursor);
                    }
                    break;
                }
                JavaScriptToken::Punctuation(b')') => parentheses = parentheses.saturating_sub(1),
                JavaScriptToken::Punctuation(b'[') => brackets += 1,
                JavaScriptToken::Punctuation(b']') => brackets = brackets.saturating_sub(1),
                JavaScriptToken::Punctuation(b'{') => braces += 1,
                JavaScriptToken::Punctuation(b'}') => braces = braces.saturating_sub(1),
                JavaScriptToken::Punctuation(b',')
                    if parentheses == 0 && brackets == 0 && braces == 0 =>
                {
                    if argument_index == destination_argument {
                        end = Some(cursor);
                        break;
                    }
                    argument_index += 1;
                    start = cursor + 1;
                }
                _ => {}
            }
        }
        if let Some(end) = end.filter(|end| *end > start) {
            if end == start + 1 {
                if let Some(JavaScriptToken::Identifier(name)) = tokens.get(start) {
                    direct_variables.insert((name.clone(), scope_ids[start]));
                }
            }
            ranges.push(start..end);
        }
    }
    ranges.sort_unstable_by_key(|range| range.start);
    let mut merged = Vec::<std::ops::Range<usize>>::new();
    for range in ranges {
        if let Some(previous) = merged.last_mut() {
            if range.start <= previous.end {
                previous.end = previous.end.max(range.end);
                continue;
            }
        }
        merged.push(range);
    }
    let mut result = vec![false; tokens.len()];
    for range in merged {
        result[range].fill(true);
    }
    Ok((result, direct_variables))
}

fn read_node_package_manifest(
    directory: &Path,
) -> Result<Option<(PathBuf, Option<PathBuf>)>, &'static str> {
    let manifest = directory.join("package.json");
    let metadata = match std::fs::metadata(&manifest) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("direct MCP Node package.json metadata is unavailable"),
    };
    if !metadata.is_file() {
        return Err("direct MCP Node package.json is not a regular file");
    }
    if metadata.len() > MAX_NODE_PACKAGE_JSON_BYTES {
        return Err("direct MCP Node package.json exceeds its read limit");
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    std::fs::File::open(&manifest)
        .map_err(|_| "direct MCP Node package.json is unreadable")?
        .take(MAX_NODE_PACKAGE_JSON_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "direct MCP Node package.json could not be read")?;
    if bytes.len() as u64 > MAX_NODE_PACKAGE_JSON_BYTES {
        return Err("direct MCP Node package.json exceeds its read limit");
    }
    let package: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|_| "direct MCP Node package.json is not valid JSON")?;
    let main = package
        .get("main")
        .and_then(serde_json::Value::as_str)
        .filter(|main| !main.is_empty())
        .map(|main| directory.join(main));
    Ok(Some((manifest, main)))
}

fn resolve_node_relative_module(
    parent: &Path,
    specifier: &str,
) -> Result<Option<Vec<PathBuf>>, &'static str> {
    fn resolve(
        base: &Path,
        depth: usize,
        visited_directories: &std::collections::BTreeSet<PathBuf>,
    ) -> Result<Option<Vec<PathBuf>>, &'static str> {
        const EXTENSIONS: [&str; 8] = ["js", "mjs", "cjs", "json", "node", "ts", "mts", "cts"];
        if depth > 8 {
            return Err("direct MCP Node package main resolution exceeds its depth bound");
        }
        if base.is_file() {
            return Ok(Some(vec![base.to_owned()]));
        }
        if base.extension().is_none() {
            for extension in EXTENSIONS {
                let candidate = base.with_extension(extension);
                if candidate.is_file() {
                    return Ok(Some(vec![candidate]));
                }
            }
        }
        if !base.is_dir() {
            return Ok(None);
        }

        let canonical_directory = std::fs::canonicalize(base).unwrap_or_else(|_| base.to_owned());
        if visited_directories.contains(&canonical_directory) {
            return Ok(None);
        }
        let mut next_visited_directories = visited_directories.clone();
        next_visited_directories.insert(canonical_directory);

        let package = read_node_package_manifest(base)?;
        if let Some((manifest, Some(main))) = package.as_ref() {
            if let Some(mut files) = resolve(main, depth + 1, &next_visited_directories)? {
                files.insert(0, manifest.clone());
                return Ok(Some(files));
            }
        }

        for index in ["index.js", "index.mjs", "index.cjs", "index.json"] {
            let candidate = base.join(index);
            if candidate.is_file() {
                let mut files = vec![candidate];
                if let Some((manifest, _)) = package {
                    files.insert(0, manifest);
                }
                return Ok(Some(files));
            }
        }
        Ok(None)
    }

    resolve(
        &parent.join(specifier),
        0,
        &std::collections::BTreeSet::new(),
    )
}

fn python_import_statements(source: &str) -> Vec<String> {
    fn parenthesis_delta(source: &str) -> isize {
        source.chars().fold(0, |depth, character| match character {
            '(' => depth + 1,
            ')' => depth - 1,
            _ => depth,
        })
    }

    let mut statements = Vec::new();
    let mut pending: Option<(String, isize)> = None;
    for raw_line in source.lines() {
        let line = raw_line.split('#').next().unwrap_or_default().trim();
        if line.is_empty() {
            continue;
        }
        if let Some((statement, depth)) = &mut pending {
            statement.push(' ');
            statement.push_str(line);
            *depth += parenthesis_delta(line);
            if *depth <= 0 {
                statements.push(std::mem::take(statement));
                pending = None;
            }
            continue;
        }
        let is_parenthesized_import = line.starts_with("from ")
            && line
                .split_once(" import ")
                .is_some_and(|(_, imported)| imported.trim_start().starts_with('('));
        let depth = parenthesis_delta(line);
        if is_parenthesized_import && depth > 0 {
            pending = Some((line.to_owned(), depth));
        } else {
            statements.push(line.to_owned());
        }
    }
    if let Some((statement, _)) = pending {
        statements.push(statement);
    }
    statements
}

fn python_import_specifiers(source: &str) -> std::collections::BTreeSet<String> {
    fn is_identifier(name: &str) -> bool {
        !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    }

    fn is_module_name(name: &str, allow_relative: bool) -> bool {
        let dots = name.bytes().take_while(|byte| *byte == b'.').count();
        if dots > 0 {
            if !allow_relative {
                return false;
            }
            let remainder = &name[dots..];
            return remainder.is_empty() || remainder.split('.').all(is_identifier);
        }
        !name.is_empty() && name.split('.').all(is_identifier)
    }

    let mut result = std::collections::BTreeSet::new();
    for statement in python_import_statements(source) {
        let statement = statement.trim();
        if let Some(imports) = statement.strip_prefix("import ") {
            for item in imports.split(',') {
                let name = item.split_ascii_whitespace().next().unwrap_or_default();
                if is_module_name(name, false) {
                    result.insert(name.to_owned());
                }
            }
        } else if let Some(imports) = statement.strip_prefix("from ") {
            let Some((module, imported)) = imports.split_once(" import ") else {
                continue;
            };
            let module = module.trim();
            if !is_module_name(module, true) {
                continue;
            }
            let imported = imported
                .trim()
                .trim_start_matches('(')
                .trim_end_matches(')');
            if module.bytes().all(|byte| byte == b'.') {
                for item in imported.split(',') {
                    let name = item
                        .trim()
                        .split_ascii_whitespace()
                        .next()
                        .unwrap_or_default();
                    if is_identifier(name) {
                        result.insert(format!("{module}{name}"));
                    }
                }
                continue;
            }
            result.insert(module.to_owned());
            for item in imported.split(',') {
                let name = item
                    .trim()
                    .split_ascii_whitespace()
                    .next()
                    .unwrap_or_default();
                if is_identifier(name) {
                    result.insert(format!("{module}.{name}"));
                }
            }
        }
    }
    result
}

fn resolve_python_local_modules(parent: &Path, specifier: &str) -> Vec<PathBuf> {
    let relative_levels = specifier.bytes().take_while(|byte| *byte == b'.').count();
    let module = &specifier[relative_levels..];
    let root = if relative_levels == 0 {
        parent
    } else if let Some(root) = parent.ancestors().nth(relative_levels - 1) {
        root
    } else {
        return Vec::new();
    };
    let components = if module.is_empty() {
        Vec::new()
    } else {
        module.split('.').collect::<Vec<_>>()
    };
    if components
        .iter()
        .any(|component| component.is_empty() || component.contains(['/', '\\']))
    {
        return Vec::new();
    }
    let mut result = std::collections::BTreeSet::new();
    let mut package = root.to_owned();
    for component in &components[..components.len().saturating_sub(1)] {
        package.push(component);
        let init = package.join("__init__.py");
        if init.is_file() {
            result.insert(init);
        }
    }
    let mut module_path = root.to_owned();
    for component in &components {
        module_path.push(component);
    }
    let candidates = if components.is_empty() {
        vec![root.join("__init__.py")]
    } else {
        vec![
            module_path.with_extension("py"),
            module_path.with_extension("pyw"),
            module_path.join("__init__.py"),
        ]
    };
    for candidate in candidates {
        if candidate.is_file() {
            result.insert(candidate);
        }
    }
    result.into_iter().collect()
}

fn ruby_relative_require_specifiers(source: &str) -> Result<Vec<String>, &'static str> {
    let mut result = std::collections::BTreeSet::new();
    for line in source.lines() {
        let statement = line.trim_start();
        let Some(mut operand) = statement.strip_prefix("require_relative") else {
            continue;
        };
        if operand
            .chars()
            .next()
            .is_some_and(|character| !character.is_ascii_whitespace() && character != '(')
        {
            continue;
        }
        operand = operand
            .trim_start()
            .strip_prefix('(')
            .unwrap_or(operand.trim_start());
        operand = operand.trim_start();
        let Some(quote) = operand
            .chars()
            .next()
            .filter(|quote| matches!(quote, '\'' | '"'))
        else {
            return Err("direct MCP Ruby script has a dynamic require_relative path");
        };
        let end = operand[1..]
            .find(quote)
            .ok_or("direct MCP Ruby script has an unterminated require_relative path")?
            + 1;
        let specifier = &operand[1..end];
        if specifier.is_empty() || specifier.contains(['$', '#', '*', '?']) {
            return Err("direct MCP Ruby script has a dynamic require_relative path");
        }
        result.insert(specifier.to_owned());
    }
    Ok(result.into_iter().collect())
}

fn resolve_ruby_relative_module(parent: &Path, specifier: &str) -> Option<PathBuf> {
    let base = parent.join(specifier);
    [base.clone(), base.with_extension("rb")]
        .into_iter()
        .find(|candidate| candidate.is_file())
}

#[derive(Clone, Copy)]
enum ScriptDependencyRuntime {
    Node,
    Python,
    Ruby,
}

struct ScriptDependencySelection<'a> {
    runtime: ScriptDependencyRuntime,
    covered_directory: Option<&'a Path>,
}

struct ScriptDependencyPath {
    path: PathBuf,
    parse_as_script: bool,
    writable: bool,
}

struct DirectScriptResources<'a> {
    paths: &'a mut std::collections::BTreeSet<PathBuf>,
    path_bytes: &'a mut usize,
    writable_files: &'a mut std::collections::BTreeSet<PathBuf>,
}

struct ShellScriptSelection<'a> {
    default_working_directory: &'a Path,
    covered_directory: Option<&'a Path>,
    workspace_directory: Option<&'a Path>,
}

struct ShellScriptResources<'a> {
    paths: &'a mut std::collections::BTreeSet<PathBuf>,
    path_bytes: &'a mut usize,
    writable_resources: &'a mut std::collections::BTreeSet<PathBuf>,
    node_env_files: &'a mut Vec<NodeEnvFileSelection>,
}

fn direct_script_dependency_paths(
    parent: &Path,
    entry_point_import_root: &Path,
    source: &str,
    runtime: ScriptDependencyRuntime,
) -> Result<Vec<ScriptDependencyPath>, &'static str> {
    match runtime {
        ScriptDependencyRuntime::Node => {
            let mut result = std::collections::BTreeMap::<PathBuf, (bool, bool)>::new();
            {
                let mut record = |path: PathBuf, imported_module: bool, writable: bool| {
                    let parse_as_script = is_script_dependency_source(&path, runtime)
                        || (imported_module && path.extension().is_none());
                    result
                        .entry(path)
                        .and_modify(|selected| {
                            selected.0 |= parse_as_script;
                            selected.1 |= writable;
                        })
                        .or_insert((parse_as_script, writable));
                };
                for specifier in node_relative_module_specifiers(source)? {
                    let Some(files) = resolve_node_relative_module(parent, &specifier.value)?
                    else {
                        if specifier.missing_is_optional {
                            continue;
                        }
                        return Err("direct MCP Node relative module is missing");
                    };
                    for file in files {
                        record(file, true, false);
                    }
                }
                for (specifier, writable) in node_relative_resource_specifiers(parent, source)? {
                    record(parent.join(specifier), false, writable);
                }
            }
            Ok(result
                .into_iter()
                .map(|(path, (parse_as_script, writable))| ScriptDependencyPath {
                    path,
                    parse_as_script,
                    writable,
                })
                .collect())
        }
        ScriptDependencyRuntime::Python => Ok(python_import_specifiers(source)
            .into_iter()
            .flat_map(|specifier| {
                let import_root = if specifier.starts_with('.') {
                    parent
                } else {
                    entry_point_import_root
                };
                resolve_python_local_modules(import_root, &specifier)
            })
            .map(|path| ScriptDependencyPath {
                parse_as_script: is_script_dependency_source(&path, runtime),
                path,
                writable: false,
            })
            .collect()),
        ScriptDependencyRuntime::Ruby => ruby_relative_require_specifiers(source)?
            .into_iter()
            .map(|specifier| {
                let path = resolve_ruby_relative_module(parent, &specifier)
                    .ok_or("direct MCP Ruby relative module is missing")?;
                Ok(ScriptDependencyPath {
                    parse_as_script: is_script_dependency_source(&path, runtime),
                    path,
                    writable: false,
                })
            })
            .collect(),
    }
}

fn is_script_dependency_source(path: &Path, runtime: ScriptDependencyRuntime) -> bool {
    let Some(extension) = path.extension() else {
        return false;
    };
    let extension = extension.to_string_lossy();
    match runtime {
        ScriptDependencyRuntime::Node => is_node_script_path(&format!("file.{extension}")),
        ScriptDependencyRuntime::Python => {
            matches!(extension.to_ascii_lowercase().as_str(), "py" | "pyw")
        }
        ScriptDependencyRuntime::Ruby => extension.eq_ignore_ascii_case("rb"),
    }
}

fn insert_direct_script_dependencies(
    script: &Path,
    scope: &Path,
    declaring: &Path,
    resources: DirectScriptResources<'_>,
    field: &'static str,
    runtime: ScriptDependencyRuntime,
) -> Result<(), ResourceError> {
    insert_direct_script_dependencies_covered(
        script,
        scope,
        declaring,
        resources,
        field,
        ScriptDependencySelection {
            runtime,
            covered_directory: None,
        },
    )
}

fn insert_direct_script_dependencies_covered(
    script: &Path,
    scope: &Path,
    declaring: &Path,
    resources: DirectScriptResources<'_>,
    field: &'static str,
    selection: ScriptDependencySelection<'_>,
) -> Result<(), ResourceError> {
    const MAX_SCRIPT_BYTES: u64 = 1024 * 1024;
    const MAX_SCRIPT_FILES: usize = 256;
    let fail = |cause| ResourceError { field, cause };
    let entry_point = checked(script, field, declaring).map_err(|error| fail(error.cause))?;
    let entry_point_import_root = entry_point
        .parent()
        .ok_or_else(|| fail("direct MCP script has no entry-point import root"))?
        .to_owned();
    let mut pending = vec![script.to_owned()];
    let mut visited = std::collections::BTreeSet::new();
    let mut parsed = std::collections::BTreeSet::new();
    let mut total_bytes = 0u64;
    while let Some(current) = pending.pop() {
        let canonical = checked(&current, field, declaring)?;
        if !canonical.is_file() || !visited.insert(canonical.clone()) {
            continue;
        }
        if !parsed.insert(canonical.clone()) {
            continue;
        }
        if parsed.len() > MAX_SCRIPT_FILES {
            return Err(fail(
                "direct MCP dependency closure exceeds its entry bound",
            ));
        }
        let metadata = std::fs::metadata(&canonical)
            .map_err(|_| fail("direct MCP script metadata unavailable"))?;
        total_bytes = total_bytes.saturating_add(metadata.len());
        if metadata.len() > MAX_SCRIPT_BYTES || total_bytes > MAX_SCRIPT_BYTES {
            return Err(fail("direct MCP dependency closure exceeds its byte bound"));
        }
        let source = std::fs::read_to_string(&canonical)
            .map_err(|_| fail("direct MCP script is not readable UTF-8"))?;
        let parent = canonical
            .parent()
            .ok_or_else(|| fail("direct MCP script has no containing directory"))?;
        for candidate in direct_script_dependency_paths(
            parent,
            &entry_point_import_root,
            &source,
            selection.runtime,
        )
        .map_err(fail)?
        {
            let dependency = checked(&candidate.path, field, declaring)?;
            let dependency_is_file = dependency.is_file();
            if !dependency_is_file && !dependency.is_dir() {
                return Err(fail(
                    "direct MCP dependency is neither a regular file nor directory",
                ));
            }
            if !dependency.starts_with(scope) {
                return Err(fail(
                    "direct MCP dependency escapes its selected script scope",
                ));
            }
            if candidate.writable && dependency_is_file {
                resources.writable_files.insert(dependency.clone());
            }
            let alias = freshell_platform::opencode_config::lexical_path(&candidate.path);
            if alias != dependency {
                if !alias.starts_with(scope) {
                    return Err(fail(
                        "direct MCP dependency alias escapes its selected script scope",
                    ));
                }
                if checked(&alias, field, declaring)? != dependency {
                    return Err(fail(
                        "direct MCP dependency changed while resolving its alias",
                    ));
                }
                if !selection
                    .covered_directory
                    .is_some_and(|directory| alias.starts_with(directory))
                {
                    insert_resource(
                        &mut *resources.paths,
                        &mut *resources.path_bytes,
                        alias,
                        field,
                        declaring,
                    )?;
                }
            }
            if !selection
                .covered_directory
                .is_some_and(|directory| dependency.starts_with(directory))
            {
                insert_resource(
                    &mut *resources.paths,
                    &mut *resources.path_bytes,
                    dependency.clone(),
                    field,
                    declaring,
                )?;
            }
            if dependency_is_file && candidate.parse_as_script {
                pending.push(dependency);
            }
        }
    }
    Ok(())
}

fn insert_shell_script_dependencies(
    script: &Path,
    scope: &Path,
    declaring: &Path,
    selection: ShellScriptSelection<'_>,
    resources: ShellScriptResources<'_>,
    field: &'static str,
) -> Result<(), ResourceError> {
    const MAX_SCRIPT_BYTES: u64 = 1024 * 1024;
    const MAX_SCRIPT_FILES: usize = 256;
    let fail = |cause| ResourceError { field, cause };
    let default_working_directory_scope =
        std::fs::canonicalize(selection.default_working_directory).ok();
    let mut pending = vec![(script.to_owned(), true)];
    let mut visited = std::collections::BTreeSet::new();
    let mut parsed = std::collections::BTreeSet::new();
    let mut total_bytes = 0u64;
    while let Some((current, parse_as_script)) = pending.pop() {
        let canonical = checked(&current, field, declaring)?;
        if !canonical.is_file() {
            continue;
        }
        if !visited.insert(canonical.clone()) && !parse_as_script {
            continue;
        }
        let parse_as_script = parse_as_script || is_shell_script(&canonical);
        if !parse_as_script || !parsed.insert(canonical.clone()) {
            continue;
        }
        if parsed.len() > MAX_SCRIPT_FILES {
            return Err(fail(
                "direct MCP shell dependency closure exceeds its entry bound",
            ));
        }
        let metadata = std::fs::metadata(&canonical)
            .map_err(|_| fail("direct MCP shell script metadata unavailable"))?;
        total_bytes = total_bytes.saturating_add(metadata.len());
        if metadata.len() > MAX_SCRIPT_BYTES || total_bytes > MAX_SCRIPT_BYTES {
            return Err(fail(
                "direct MCP shell dependency closure exceeds its byte bound",
            ));
        }
        let source = std::fs::read_to_string(&canonical)
            .map_err(|_| fail("direct MCP shell script is not readable UTF-8"))?;
        let script_parent = canonical
            .parent()
            .ok_or_else(|| fail("direct MCP shell script has no containing directory"))?;
        let directory_variables = shell_directory_variables(&source, script_parent);
        if directory_variables.len() > 128 {
            return Err(fail(
                "direct MCP shell dependency closure exceeds its variable bound",
            ));
        }
        let mut working_directory = Some(selection.default_working_directory.to_owned());
        let mut source_offset = 0usize;
        for full_line in source.split_inclusive('\n') {
            let line = full_line
                .strip_suffix('\n')
                .unwrap_or(full_line)
                .strip_suffix('\r')
                .unwrap_or(full_line.strip_suffix('\n').unwrap_or(full_line));
            if line.trim_start().starts_with('#') {
                source_offset += full_line.len();
                continue;
            }
            let node_line = if let Some((directory, remainder)) =
                shell_changes_to_script_directory(line, &directory_variables, script_parent)
            {
                working_directory = Some(directory);
                remainder
            } else {
                if line.trim_start().starts_with("cd ") {
                    working_directory = None;
                }
                line
            };
            let node_line_offset = source_offset + line.len().saturating_sub(node_line.len());
            let mut candidates = std::collections::BTreeMap::new();
            let mut env_file_candidates = std::collections::BTreeMap::<
                PathBuf,
                Vec<(String, std::ops::Range<usize>, Option<PathBuf>)>,
            >::new();
            if let Some(operand) = shell_source_operand(line) {
                if let Some(candidate) =
                    shell_source_path(script_parent, &operand, &directory_variables)
                        .map_err(fail)?
                {
                    candidates.insert(candidate, (true, false));
                }
            }
            let invokes_node = shell_line_invokes_node(node_line);
            let node_invocation = invokes_node
                .then(|| shell_node_invocation(node_line))
                .flatten();
            for candidate in
                shell_directory_relative_paths(line, &directory_variables, script_parent)
            {
                let parse_as_node_script =
                    invokes_node && is_node_script_path(&candidate.to_string_lossy());
                candidates
                    .entry(candidate)
                    .and_modify(|kind: &mut (bool, bool)| kind.1 |= parse_as_node_script)
                    .or_insert((false, parse_as_node_script));
            }
            if invokes_node {
                if let Some(invocation) = node_invocation {
                    let ShellNodeInvocation {
                        script_operand,
                        file_operands,
                        env_file_operands,
                    } = invocation;
                    if let Some(relative) = script_operand {
                        let path = Path::new(&relative);
                        let candidate = if path.is_absolute() {
                            Some(path.to_owned())
                        } else {
                            working_directory
                                .as_deref()
                                .map(|directory| directory.join(path))
                        };
                        if let Some(candidate) = candidate {
                            candidates
                                .entry(candidate)
                                .and_modify(|kind: &mut (bool, bool)| kind.1 = true)
                                .or_insert((false, true));
                        }
                    }
                    for (operand, parse_as_node_script) in file_operands {
                        if operand.contains(['$', '*', '?']) {
                            return Err(fail(
                                "direct MCP Node option has an unresolved dynamic file path",
                            ));
                        }
                        let path = Path::new(&operand);
                        let candidate = if path.is_absolute() {
                            Some(path.to_owned())
                        } else {
                            working_directory
                                .as_deref()
                                .map(|directory| directory.join(path))
                        };
                        if let Some(candidate) = candidate {
                            candidates
                                .entry(candidate)
                                .and_modify(|kind: &mut (bool, bool)| {
                                    kind.1 |= parse_as_node_script
                                })
                                .or_insert((false, parse_as_node_script));
                        }
                    }
                    for (operand, argument_span, optional) in env_file_operands {
                        if operand.contains(['$', '*', '?']) {
                            return Err(fail(
                                "direct MCP Node option has an unresolved dynamic file path",
                            ));
                        }
                        let path = Path::new(&operand);
                        let candidate = if path.is_absolute() {
                            path.to_owned()
                        } else {
                            working_directory
                                .as_deref()
                                .ok_or_else(|| {
                                    fail("direct MCP Node env-file has an unresolved working directory")
                                })?
                                .join(path)
                        };
                        if optional
                            && std::fs::symlink_metadata(&candidate)
                                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
                        {
                            continue;
                        }
                        env_file_candidates
                            .entry(candidate.clone())
                            .or_default()
                            .push((
                                operand,
                                node_line_offset + argument_span.start
                                    ..node_line_offset + argument_span.end,
                                working_directory.clone(),
                            ));
                    }
                }
            }
            for (candidate, (parse_as_script, parse_as_node_script)) in candidates {
                let dependency = checked(&candidate, field, declaring)?;
                if !dependency.is_file() {
                    return Err(fail("direct MCP shell source is not a regular file"));
                }
                if !dependency.starts_with(scope)
                    && !default_working_directory_scope
                        .as_ref()
                        .is_some_and(|directory| dependency.starts_with(directory))
                    && !selection
                        .workspace_directory
                        .is_some_and(|directory| dependency.starts_with(directory))
                {
                    return Err(fail(
                        "direct MCP shell source escapes its selected script scope",
                    ));
                }
                if !selection
                    .covered_directory
                    .is_some_and(|directory| dependency.starts_with(directory))
                {
                    insert_resource(
                        resources.paths,
                        resources.path_bytes,
                        dependency.clone(),
                        field,
                        declaring,
                    )?;
                }
                if parse_as_node_script {
                    let dependency_scope = std::iter::once(scope)
                        .chain(default_working_directory_scope.as_deref())
                        .chain(selection.workspace_directory)
                        .filter(|directory| dependency.starts_with(directory))
                        .max_by_key(|directory| directory.components().count())
                        .unwrap_or(scope);
                    insert_installed_package_ancestor_resources_covered(
                        &dependency,
                        scope,
                        declaring,
                        resources.paths,
                        resources.path_bytes,
                        field,
                        selection.covered_directory,
                    )?;
                    insert_direct_script_dependencies_covered(
                        &dependency,
                        dependency_scope,
                        declaring,
                        DirectScriptResources {
                            paths: &mut *resources.paths,
                            path_bytes: &mut *resources.path_bytes,
                            writable_files: &mut *resources.writable_resources,
                        },
                        field,
                        ScriptDependencySelection {
                            runtime: ScriptDependencyRuntime::Node,
                            covered_directory: selection.covered_directory,
                        },
                    )?;
                }
                pending.push((dependency, parse_as_script));
            }
            for (candidate, arguments) in env_file_candidates {
                let dependency = checked(&candidate, field, declaring)?;
                if !dependency.is_file() {
                    return Err(fail("direct MCP Node env file is not a regular file"));
                }
                if !dependency.starts_with(scope)
                    && !default_working_directory_scope
                        .as_ref()
                        .is_some_and(|directory| dependency.starts_with(directory))
                    && !selection
                        .workspace_directory
                        .is_some_and(|directory| dependency.starts_with(directory))
                {
                    return Err(fail(
                        "direct MCP Node env file escapes its selected script scope",
                    ));
                }
                if selection.workspace_directory.is_some_and(|workspace| {
                    canonical.starts_with(workspace) && dependency.starts_with(workspace)
                }) {
                    continue;
                }
                for (expected_operand, argument_span, working_directory) in arguments {
                    let alias = selection
                        .workspace_directory
                        .filter(|workspace| canonical.starts_with(workspace))
                        .filter(|workspace| !dependency.starts_with(workspace))
                        .and_then(|_| {
                            let directory = working_directory?.canonicalize().ok()?;
                            if !dependency.starts_with(&directory) {
                                return None;
                            }
                            let operand = Path::new(&expected_operand);
                            if operand.is_absolute() {
                                return None;
                            }
                            let mut relative_path = PathBuf::new();
                            for component in operand.components() {
                                match component {
                                    std::path::Component::Normal(part) => relative_path.push(part),
                                    std::path::Component::CurDir => {}
                                    _ => return None,
                                }
                            }
                            (!relative_path.as_os_str().is_empty())
                                .then_some((directory, relative_path))
                        });
                    let rewrite = alias.map_or_else(
                        || NodeEnvFileRewrite::ShellScriptArgument {
                            script_source: canonical.clone(),
                            argument_span: argument_span.clone(),
                            expected_operand: expected_operand.clone(),
                        },
                        |(working_directory, relative_path)| {
                            NodeEnvFileRewrite::ShellWorkingDirectoryAlias {
                                working_directory,
                                relative_path,
                            }
                        },
                    );
                    resources.node_env_files.push(NodeEnvFileSelection {
                        canonical_source: dependency.clone(),
                        selected_alias: candidate.clone(),
                        rewrite,
                    });
                }
            }
            source_offset += full_line.len();
        }
    }
    Ok(())
}

fn script_operand_index(command: &[String]) -> Option<usize> {
    let executable = command
        .first()?
        .rsplit(['/', '\\'])
        .next()?
        .to_ascii_lowercase();
    let executable = executable.strip_suffix(".exe").unwrap_or(&executable);
    if !command_uses_script_runtime(Some(executable)) {
        return None;
    }
    let mut index = 1;
    if matches!(executable, "bun" | "deno") && command.get(index).is_some_and(|arg| arg == "run") {
        index += 1;
    }
    while index < command.len() {
        let argument = command[index].as_str();
        if argument == "--" {
            return command
                .get(index + 1)
                .filter(|argument| !argument.is_empty())
                .map(|_| index + 1);
        }
        let option = argument.split_once('=').map_or(argument, |(name, _)| name);
        if matches!(executable, "node" | "nodejs" | "bun" | "tsx" | "ts-node") {
            if matches!(option, "-e" | "--eval" | "-p" | "--print") {
                return None;
            }
            if matches!(
                option,
                "-r" | "--require"
                    | "--import"
                    | "--loader"
                    | "--experimental-loader"
                    | "--conditions"
                    | "--title"
                    | "--redirect-warnings"
                    | "--diagnostic-dir"
                    | "--env-file"
                    | "--env-file-if-exists"
                    | "--watch-path"
                    | "--tsconfig"
            ) && !argument.contains('=')
            {
                index = (index + 2).min(command.len());
                continue;
            }
        } else if is_python_interpreter_name(executable) {
            if matches!(argument, "-c" | "-m") {
                return None;
            }
            if matches!(argument, "-W" | "-X") {
                index = (index + 2).min(command.len());
                continue;
            }
            if argument == "-" {
                return None;
            }
        } else if executable == "ruby" {
            if argument == "-e" {
                return None;
            }
            if matches!(argument, "-r" | "-I" | "-C" | "-E" | "-F") {
                index = (index + 2).min(command.len());
                continue;
            }
        } else if matches!(executable, "bash" | "sh" | "zsh") {
            if argument == "-c" {
                return None;
            }
            if matches!(
                argument,
                "-o" | "+o" | "-O" | "+O" | "--rcfile" | "--init-file"
            ) {
                index = (index + 2).min(command.len());
                continue;
            }
        } else if matches!(executable, "pwsh" | "powershell") {
            if matches!(argument.to_ascii_lowercase().as_str(), "-command" | "-c") {
                return None;
            }
            if matches!(argument.to_ascii_lowercase().as_str(), "-file" | "-f") {
                return (index + 1 < command.len()).then_some(index + 1);
            }
            if matches!(
                argument.to_ascii_lowercase().as_str(),
                "-executionpolicy"
                    | "-workingdirectory"
                    | "-inputformat"
                    | "-outputformat"
                    | "-configurationname"
                    | "-configurationfile"
            ) {
                index = (index + 2).min(command.len());
                continue;
            }
        }
        if argument.starts_with('-') || argument.is_empty() {
            index += 1;
            continue;
        }
        return Some(index);
    }
    None
}

fn node_command_option_resources(command: &[String]) -> Vec<(usize, &'static str, String)> {
    let Some(executable) = command
        .first()
        .and_then(|argument| Path::new(argument).file_name())
    else {
        return Vec::new();
    };
    let executable = executable.to_string_lossy().to_ascii_lowercase();
    if !matches!(
        executable.strip_suffix(".exe").unwrap_or(&executable),
        "node" | "nodejs"
    ) {
        return Vec::new();
    }

    let script_index = script_operand_index(command).unwrap_or(command.len());
    let mut result = Vec::new();
    let mut index = 1;
    while index < script_index {
        let argument = &command[index];
        if argument == "--" {
            break;
        }
        let (option, inline_value) = argument
            .split_once('=')
            .map_or((argument.as_str(), None), |(option, value)| {
                (option, Some(value))
            });
        let field = match option {
            "-r" | "--require" | "--import" | "--loader" | "--experimental-loader" => {
                Some("OpenCode mcp.node-option-script")
            }
            "--env-file" => Some("OpenCode mcp.node-option-data"),
            "--env-file-if-exists" => Some("OpenCode mcp.node-option-data-optional"),
            _ => None,
        };
        if let Some(field) = field {
            let (operand_index, value) = if let Some(value) = inline_value {
                (index, value)
            } else if index + 1 < script_index {
                (index + 1, command[index + 1].as_str())
            } else {
                index += 1;
                continue;
            };
            let path_like = if is_mcp_node_option_data_field(field) {
                !value.is_empty()
            } else {
                is_explicit_command_path(value) || value.contains('\\')
            };
            if path_like {
                result.push((operand_index, field, value.to_owned()));
            }
            index = if inline_value.is_some() {
                index + 1
            } else {
                index + 2
            };
            continue;
        }
        index += 1;
    }
    result
}

fn resource_array(
    cursor: &mut Cursor<'_>,
    field: &'static str,
    result: &mut Vec<SelectedField>,
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
                result.push(SelectedField::new(
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

pub(super) struct ResourceSelection {
    pub resources: Vec<PathBuf>,
    pub variables: Vec<String>,
    pub writable_resources: std::collections::BTreeSet<PathBuf>,
    pub node_env_files: Vec<NodeEnvFileSelection>,
}

pub(super) enum NodeEnvFileRewrite {
    ConfigArgument {
        argument_span: std::ops::Range<usize>,
        option_prefix: String,
    },
    ShellScriptArgument {
        script_source: PathBuf,
        argument_span: std::ops::Range<usize>,
        expected_operand: String,
    },
    ShellWorkingDirectoryAlias {
        working_directory: PathBuf,
        relative_path: PathBuf,
    },
}

pub(super) struct NodeEnvFileSelection {
    pub canonical_source: PathBuf,
    pub selected_alias: PathBuf,
    pub rewrite: NodeEnvFileRewrite,
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

fn insert_resource(
    result: &mut std::collections::BTreeSet<PathBuf>,
    resource_path_bytes: &mut usize,
    path: PathBuf,
    field: &'static str,
    declaring: &Path,
) -> Result<(), ResourceError> {
    if path.is_dir() {
        let resource_leaf = path
            .file_name()
            .map(|leaf| leaf.to_string_lossy().into_owned());
        tracing::info!(
            event = "provider.opencode.resource.directory_selected",
            field,
            resource_leaf,
            source_config_leaf = declaring
                .file_name()
                .map(|leaf| leaf.to_string_lossy().into_owned()),
            source_config_parent_leaf = declaring
                .parent()
                .and_then(Path::file_name)
                .map(|leaf| leaf.to_string_lossy().into_owned()),
            source_config_grandparent_leaf = declaring
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .map(|leaf| leaf.to_string_lossy().into_owned()),
            resource_parent_leaf = path
                .parent()
                .and_then(Path::file_name)
                .map(|leaf| leaf.to_string_lossy().into_owned()),
            resource_grandparent_leaf = path
                .parent()
                .and_then(Path::parent)
                .and_then(Path::file_name)
                .map(|leaf| leaf.to_string_lossy().into_owned()),
            "Selected OpenCode directory resource"
        );
    }
    if !result.contains(&path) {
        let bytes = path.as_os_str().len();
        if result.len() >= 100_000
            || bytes > (64 * 1024 * 1024usize).saturating_sub(*resource_path_bytes)
        {
            return Err(ResourceError {
                field,
                cause: "configured resource selection exceeds shared entry or metadata profile",
            });
        }
        *resource_path_bytes += bytes;
        result.insert(path);
    }
    Ok(())
}

fn insert_installed_package_ancestor_resources(
    scope: &Path,
    home: &Path,
    declaring: &Path,
    result: &mut std::collections::BTreeSet<PathBuf>,
    resource_path_bytes: &mut usize,
    field: &'static str,
) -> Result<(), ResourceError> {
    insert_installed_package_ancestor_resources_covered(
        scope,
        home,
        declaring,
        result,
        resource_path_bytes,
        field,
        None,
    )
}

fn insert_installed_package_ancestor_resources_covered(
    scope: &Path,
    home: &Path,
    declaring: &Path,
    result: &mut std::collections::BTreeSet<PathBuf>,
    resource_path_bytes: &mut usize,
    field: &'static str,
    covered_directory: Option<&Path>,
) -> Result<(), ResourceError> {
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
                    if covered_directory.is_some_and(|directory| candidate.starts_with(directory)) {
                        continue;
                    }
                    checked(&candidate, field, declaring)?;
                    insert_resource(result, resource_path_bytes, candidate, field, declaring)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => {
                    return Err(ResourceError {
                        field,
                        cause: "installed plugin lookup context is unavailable",
                    })
                }
            }
        }
        if ancestor == home {
            break;
        }
    }
    Ok(())
}

/// Return complete ordinary units and native installed ancestor lookup units.
/// Exact mounts retain native field spellings and their declaring origins.
pub(super) fn select(
    source: &super::sources::SourceOccurrence,
    raw: &str,
    instance_cwd: &Path,
    user_owns_freshell_mcp: bool,
    home: &Path,
    global: Option<&Path>,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<ResourceSelection, ResourceError> {
    let declaring = &source.logical_path;
    let fail = |field: &'static str, cause: &'static str| ResourceError { field, cause };
    let workspace_directory = std::fs::canonicalize(instance_cwd).ok();
    let mut result = std::collections::BTreeSet::new();
    let mut resource_path_bytes = 0usize;
    let mut writable_resources = std::collections::BTreeSet::new();
    let mut node_env_files = Vec::new();
    let mut variables = std::collections::BTreeSet::new();
    let skip_owned_freshell_mcp =
        source.lane == super::sources::SourceLane::Main && !user_owns_freshell_mcp;
    let mut selections = fields(raw).map_err(|cause| fail("OpenCode resource", cause))?;
    selections.extend(
        nested_fields(
            raw,
            source.lane == super::sources::SourceLane::Tui,
            skip_owned_freshell_mcp,
        )
        .map_err(|cause| fail("OpenCode resource", cause))?,
    );
    let mut current_mcp_working_dir: Option<PathBuf> = None;
    let mut current_mcp_resource_path: Option<PathBuf> = None;
    for selected in selections {
        let SelectedField {
            mut field,
            spelling,
            node_env_file_argument,
        } = selected;
        if field == "OpenCode mcp.entry" {
            current_mcp_working_dir = None;
            current_mcp_resource_path = None;
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
        if field == "OpenCode bun run operand" {
            let working_dir = current_mcp_resource_path.as_deref().unwrap_or(instance_cwd);
            if is_bare_bun_script_name(&spelling) {
                if let Some(package_root) = bun_package_script_root(working_dir, &spelling)
                    .map_err(|cause| fail("OpenCode mcp.command", cause))?
                {
                    let canonical_package_root =
                        checked(&package_root, "OpenCode mcp.command", declaring)?;
                    if !canonical_package_root.is_dir() {
                        return Err(fail(
                            "OpenCode mcp.command",
                            "Bun package script root is not a directory",
                        ));
                    }
                    let canonical_home = std::fs::canonicalize(home).ok();
                    let canonical_working_dir = current_mcp_working_dir
                        .clone()
                        .or_else(|| std::fs::canonicalize(working_dir).ok());
                    if canonical_package_root == Path::new("/")
                        || (canonical_home.as_deref() == Some(canonical_package_root.as_path())
                            && canonical_working_dir.as_deref()
                                != Some(canonical_package_root.as_path()))
                    {
                        return Err(fail(
                            "OpenCode mcp.command",
                            "Bun package script requires copying an unbounded account or system root",
                        ));
                    }
                    if let Some(cwd_resource_path) = &current_mcp_resource_path {
                        if cwd_resource_path != &package_root
                            && cwd_resource_path.starts_with(&package_root)
                            && result.remove(cwd_resource_path)
                        {
                            resource_path_bytes = resource_path_bytes
                                .saturating_sub(cwd_resource_path.as_os_str().len());
                        }
                    }
                    insert_resource(
                        &mut result,
                        &mut resource_path_bytes,
                        package_root.clone(),
                        "OpenCode mcp.command",
                        declaring,
                    )?;
                    insert_installed_package_ancestor_resources(
                        &package_root,
                        home,
                        declaring,
                        &mut result,
                        &mut resource_path_bytes,
                        "OpenCode mcp.command",
                    )?;
                    continue;
                }
            }
            field = if is_node_script_path(&spelling) {
                "OpenCode bun run file"
            } else if is_script_path(&spelling) {
                "OpenCode mcp.script"
            } else {
                "OpenCode mcp.command"
            };
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
        } else if field == "OpenCode mcp.cwd" || is_mcp_command_resource_field(field) {
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
                instance_cwd
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
                    insert_resource(
                        &mut result,
                        &mut resource_path_bytes,
                        selected,
                        field,
                        declaring,
                    )?;
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
                path = declaring.parent().unwrap_or(instance_cwd).join(path);
            } else if field == "OpenCode skills.paths" || field == "OpenCode mcp.cwd" {
                path = instance_cwd.join(path);
            } else if is_mcp_command_resource_field(field) {
                path = if let Some(working_dir) = &current_mcp_working_dir {
                    working_dir.join(path)
                } else {
                    instance_cwd
                        .ancestors()
                        .map(|base| base.join(&path))
                        .find(|candidate| std::fs::symlink_metadata(candidate).is_ok())
                        .unwrap_or_else(|| instance_cwd.join(path))
                };
            } else {
                path = instance_cwd
                    .ancestors()
                    .map(|base| base.join(&path))
                    .find(|candidate| std::fs::symlink_metadata(candidate).is_ok())
                    .unwrap_or_else(|| instance_cwd.join(path));
            }
        }
        if matches!(
            field,
            "OpenCode skills.paths" | "OpenCode mcp.cwd" | "OpenCode attention.sounds"
        ) || is_mcp_command_resource_field(field)
        {
            // Native resolution resolution normalizes .. before deciding
            // whether the selected resource is supplied by the workspace.
            path = freshell_platform::opencode_config::lexical_path(&path);
        }
        if is_mcp_node_option_optional_data_field(field)
            && std::fs::symlink_metadata(&path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            variables.extend(names.into_inner());
            continue;
        }
        let canonical = checked(&path, field, declaring)?;
        if field == "OpenCode mcp.command" {
            if let Some(script_field) = shebang_script_field(&canonical) {
                field = script_field;
            }
        }
        variables.extend(names.into_inner());
        if field == "OpenCode instructions" || field == "OpenCode attention.sounds" {
            if !canonical.is_file() {
                return Err(fail(field, "selected file resource is not a regular file"));
            }
            insert_resource(
                &mut result,
                &mut resource_path_bytes,
                path,
                field,
                declaring,
            )?;
            continue;
        }
        if is_mcp_node_option_script_field(field) || is_mcp_node_option_data_field(field) {
            if !canonical.is_file() {
                return Err(fail(
                    field,
                    "selected Node option resource is not a regular file",
                ));
            }
            if is_mcp_node_option_data_field(field) {
                let argument = node_env_file_argument.ok_or_else(|| {
                    fail(field, "selected Node env-file argument span unavailable")
                })?;
                node_env_files.push(NodeEnvFileSelection {
                    canonical_source: canonical,
                    selected_alias: path,
                    rewrite: NodeEnvFileRewrite::ConfigArgument {
                        argument_span: argument.raw_span,
                        option_prefix: argument.option_prefix,
                    },
                });
                continue;
            }

            if path != canonical
                && std::fs::symlink_metadata(&path)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                insert_resource(
                    &mut result,
                    &mut resource_path_bytes,
                    path,
                    field,
                    declaring,
                )?;
            }
            let command_parent = canonical
                .parent()
                .ok_or_else(|| fail(field, "Node option has no containing directory"))?;
            let dependency_scope = direct_script_dependency_scope(command_parent, home);
            let covered_directory = current_mcp_working_dir
                .as_deref()
                .filter(|working_dir| canonical.starts_with(working_dir));
            if let Some(working_dir) = covered_directory {
                insert_installed_package_ancestor_resources_covered(
                    &canonical,
                    home,
                    declaring,
                    &mut result,
                    &mut resource_path_bytes,
                    field,
                    Some(working_dir),
                )?;
                insert_direct_script_dependencies_covered(
                    &canonical,
                    &dependency_scope,
                    declaring,
                    DirectScriptResources {
                        paths: &mut result,
                        path_bytes: &mut resource_path_bytes,
                        writable_files: &mut writable_resources,
                    },
                    field,
                    ScriptDependencySelection {
                        runtime: ScriptDependencyRuntime::Node,
                        covered_directory: Some(working_dir),
                    },
                )?;
            } else {
                insert_installed_package_ancestor_resources(
                    &canonical,
                    home,
                    declaring,
                    &mut result,
                    &mut resource_path_bytes,
                    field,
                )?;
                insert_direct_script_dependencies(
                    &canonical,
                    &dependency_scope,
                    declaring,
                    DirectScriptResources {
                        paths: &mut result,
                        path_bytes: &mut resource_path_bytes,
                        writable_files: &mut writable_resources,
                    },
                    field,
                    ScriptDependencyRuntime::Node,
                )?;
                insert_resource(
                    &mut result,
                    &mut resource_path_bytes,
                    canonical,
                    field,
                    declaring,
                )?;
            }
            continue;
        }
        if is_mcp_command_path_field(field) {
            if !canonical.is_file() {
                return Err(fail(
                    field,
                    "selected MCP command file is not a regular file",
                ));
            }
            // The server's selected cwd is already copied as a directory.
            // Avoid an overlapping file/package mount for a script it contains;
            // besides being redundant, that shape cannot be authorized by the
            // closed launch fixture. Canonical resolution keeps symlinks that
            // escape the cwd on the explicit-resource path below.
            if path != canonical
                && std::fs::symlink_metadata(&path)
                    .is_ok_and(|metadata| metadata.file_type().is_symlink())
            {
                // The provider must have both the resolved target used for
                // dependency discovery and the original command alias used
                // by OpenCode's launch argv.
                insert_resource(
                    &mut result,
                    &mut resource_path_bytes,
                    path.clone(),
                    field,
                    declaring,
                )?;
            }
            if current_mcp_working_dir
                .as_ref()
                .is_some_and(|working_dir| canonical.starts_with(working_dir))
            {
                if is_shell_script(&canonical) {
                    let command_parent = canonical
                        .parent()
                        .ok_or_else(|| fail(field, "command has no containing scope"))?;
                    let dependency_scope = direct_script_dependency_scope(command_parent, home);
                    let working_directory =
                        current_mcp_working_dir.as_deref().unwrap_or(instance_cwd);
                    insert_shell_script_dependencies(
                        &canonical,
                        &dependency_scope,
                        declaring,
                        ShellScriptSelection {
                            default_working_directory: working_directory,
                            covered_directory: current_mcp_working_dir.as_deref(),
                            workspace_directory: workspace_directory.as_deref(),
                        },
                        ShellScriptResources {
                            paths: &mut result,
                            path_bytes: &mut resource_path_bytes,
                            writable_resources: &mut writable_resources,
                            node_env_files: &mut node_env_files,
                        },
                        field,
                    )?;
                }
                continue;
            }
            let command_parent = canonical
                .parent()
                .ok_or_else(|| fail(field, "command has no containing scope"))?;
            let dependency_scope = direct_script_dependency_scope(command_parent, home);
            if field == "OpenCode bun run file" {
                insert_installed_package_ancestor_resources(
                    &canonical,
                    home,
                    declaring,
                    &mut result,
                    &mut resource_path_bytes,
                    field,
                )?;
                insert_direct_script_dependencies(
                    &canonical,
                    &dependency_scope,
                    declaring,
                    DirectScriptResources {
                        paths: &mut result,
                        path_bytes: &mut resource_path_bytes,
                        writable_files: &mut writable_resources,
                    },
                    field,
                    ScriptDependencyRuntime::Node,
                )?;
                if let Some(resource_scope) =
                    bun_run_file_resource_scope(command_parent, home, instance_cwd)
                {
                    // Bun scripts can compute local asset paths at runtime, so
                    // preserve their bounded package (or containing) directory.
                    // Static dependencies outside that directory remain exact
                    // selected resources, while covered children travel once
                    // in the complete directory unit.
                    let covered = result
                        .iter()
                        .filter(|path| {
                            path.as_path() != resource_scope && path.starts_with(&resource_scope)
                        })
                        .cloned()
                        .collect::<Vec<_>>();
                    for path in covered {
                        result.remove(&path);
                        resource_path_bytes =
                            resource_path_bytes.saturating_sub(path.as_os_str().len());
                    }
                    insert_resource(
                        &mut result,
                        &mut resource_path_bytes,
                        resource_scope,
                        field,
                        declaring,
                    )?;
                } else {
                    // HOME, system roots, and the mounted project are not
                    // bounded external copy units. Keep exact/static closure.
                    insert_resource(
                        &mut result,
                        &mut resource_path_bytes,
                        canonical,
                        field,
                        declaring,
                    )?;
                }
                continue;
            }
            if let Some(package_root) = command_parent
                .ancestors()
                .take_while(|ancestor| *ancestor != home && ancestor.parent().is_some())
                .find(|ancestor| ancestor.join("package.json").is_file())
            {
                let package_root = package_root.to_owned();
                insert_resource(
                    &mut result,
                    &mut resource_path_bytes,
                    package_root.clone(),
                    field,
                    declaring,
                )?;
                insert_installed_package_ancestor_resources(
                    &package_root,
                    home,
                    declaring,
                    &mut result,
                    &mut resource_path_bytes,
                    field,
                )?;
                continue;
            }
            if is_mcp_shebang_script_field(field) {
                insert_resource(
                    &mut result,
                    &mut resource_path_bytes,
                    canonical.clone(),
                    field,
                    declaring,
                )?;
                if is_mcp_node_script_field(field) {
                    insert_installed_package_ancestor_resources(
                        &canonical,
                        home,
                        declaring,
                        &mut result,
                        &mut resource_path_bytes,
                        field,
                    )?;
                    insert_direct_script_dependencies(
                        &canonical,
                        &dependency_scope,
                        declaring,
                        DirectScriptResources {
                            paths: &mut result,
                            path_bytes: &mut resource_path_bytes,
                            writable_files: &mut writable_resources,
                        },
                        field,
                        ScriptDependencyRuntime::Node,
                    )?;
                }
                if is_shell_script(&canonical) {
                    insert_shell_script_dependencies(
                        &canonical,
                        &dependency_scope,
                        declaring,
                        ShellScriptSelection {
                            default_working_directory: current_mcp_working_dir
                                .as_deref()
                                .unwrap_or(instance_cwd),
                            covered_directory: None,
                            workspace_directory: workspace_directory.as_deref(),
                        },
                        ShellScriptResources {
                            paths: &mut result,
                            path_bytes: &mut resource_path_bytes,
                            writable_resources: &mut writable_resources,
                            node_env_files: &mut node_env_files,
                        },
                        field,
                    )?;
                }
                if is_python_script(&canonical) {
                    insert_direct_script_dependencies(
                        &canonical,
                        &dependency_scope,
                        declaring,
                        DirectScriptResources {
                            paths: &mut result,
                            path_bytes: &mut resource_path_bytes,
                            writable_files: &mut writable_resources,
                        },
                        field,
                        ScriptDependencyRuntime::Python,
                    )?;
                }
                if is_ruby_script(&canonical) {
                    insert_direct_script_dependencies(
                        &canonical,
                        &dependency_scope,
                        declaring,
                        DirectScriptResources {
                            paths: &mut result,
                            path_bytes: &mut resource_path_bytes,
                            writable_files: &mut writable_resources,
                        },
                        field,
                        ScriptDependencyRuntime::Ruby,
                    )?;
                }
                continue;
            }
            if is_mcp_script_field(field) {
                let canonical_home = std::fs::canonicalize(home).ok();
                if command_parent == Path::new("/")
                    || canonical_home.as_deref() == Some(command_parent)
                {
                    // HOME and the filesystem root cannot be copied as a
                    // script's containing directory. Select the entry point
                    // itself and only its bounded language-specific closure.
                    insert_resource(
                        &mut result,
                        &mut resource_path_bytes,
                        canonical.clone(),
                        field,
                        declaring,
                    )?;
                    if is_mcp_node_script_field(field) {
                        insert_installed_package_ancestor_resources(
                            &canonical,
                            home,
                            declaring,
                            &mut result,
                            &mut resource_path_bytes,
                            field,
                        )?;
                        insert_direct_script_dependencies(
                            &canonical,
                            &dependency_scope,
                            declaring,
                            DirectScriptResources {
                                paths: &mut result,
                                path_bytes: &mut resource_path_bytes,
                                writable_files: &mut writable_resources,
                            },
                            field,
                            ScriptDependencyRuntime::Node,
                        )?;
                    }
                    if canonical_home.as_deref() == Some(command_parent)
                        && is_shell_script(&canonical)
                    {
                        insert_shell_script_dependencies(
                            &canonical,
                            &dependency_scope,
                            declaring,
                            ShellScriptSelection {
                                default_working_directory: current_mcp_working_dir
                                    .as_deref()
                                    .unwrap_or(instance_cwd),
                                covered_directory: None,
                                workspace_directory: workspace_directory.as_deref(),
                            },
                            ShellScriptResources {
                                paths: &mut result,
                                path_bytes: &mut resource_path_bytes,
                                writable_resources: &mut writable_resources,
                                node_env_files: &mut node_env_files,
                            },
                            field,
                        )?;
                    }
                    if is_python_script(&canonical) {
                        insert_direct_script_dependencies(
                            &canonical,
                            &dependency_scope,
                            declaring,
                            DirectScriptResources {
                                paths: &mut result,
                                path_bytes: &mut resource_path_bytes,
                                writable_files: &mut writable_resources,
                            },
                            field,
                            ScriptDependencyRuntime::Python,
                        )?;
                    }
                    if is_ruby_script(&canonical) {
                        insert_direct_script_dependencies(
                            &canonical,
                            &dependency_scope,
                            declaring,
                            DirectScriptResources {
                                paths: &mut result,
                                path_bytes: &mut resource_path_bytes,
                                writable_files: &mut writable_resources,
                            },
                            field,
                            ScriptDependencyRuntime::Ruby,
                        )?;
                    }
                    continue;
                }
                if is_mcp_node_script_field(field) {
                    insert_installed_package_ancestor_resources(
                        command_parent,
                        home,
                        declaring,
                        &mut result,
                        &mut resource_path_bytes,
                        field,
                    )?;
                    insert_direct_script_dependencies(
                        &canonical,
                        &dependency_scope,
                        declaring,
                        DirectScriptResources {
                            paths: &mut result,
                            path_bytes: &mut resource_path_bytes,
                            writable_files: &mut writable_resources,
                        },
                        field,
                        ScriptDependencyRuntime::Node,
                    )?;
                }
                // A standalone script may import sibling files without a
                // package manifest. Copy its containing directory as the
                // bounded module-resolution unit; copy_environment enforces
                // the shared entry and byte caps before publication.
                insert_resource(
                    &mut result,
                    &mut resource_path_bytes,
                    command_parent.to_owned(),
                    field,
                    declaring,
                )?;
                continue;
            }
            // A runtime executable without a package manifest is an exact-file
            // resource. Selecting its parent could copy system directories.
            insert_resource(
                &mut result,
                &mut resource_path_bytes,
                canonical,
                field,
                declaring,
            )?;
            continue;
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
                current_mcp_resource_path = Some(path.clone());
            }
            insert_resource(
                &mut result,
                &mut resource_path_bytes,
                path,
                field,
                declaring,
            )?;
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
        insert_resource(
            &mut result,
            &mut resource_path_bytes,
            scope.clone(),
            field,
            declaring,
        )?;
        insert_installed_package_ancestor_resources(
            &scope,
            home,
            declaring,
            &mut result,
            &mut resource_path_bytes,
            field,
        )?;
    }
    Ok(ResourceSelection {
        resources: result.into_iter().collect(),
        variables: variables.into_iter().collect(),
        writable_resources,
        node_env_files,
    })
}
