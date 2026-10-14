//! Finite native ordinary resource fields. Keep raw documents and every
//! unrelated string intact; these selections are paths, never private payloads.
use super::sources::PlannedSourceOccurrence;
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
fn nested_fields(
    raw: &str,
    tui: bool,
    skip_owned_freshell_mcp: bool,
) -> Result<Vec<(&'static str, String)>, &'static str> {
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
                if skip_owned_freshell_mcp && name == "freshell" {
                    continue;
                }
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
                                result.push((field, argument.clone()));
                            } else {
                                result.push(("OpenCode mcp.command", argument.clone()));
                            }
                        } else if script_file || script_operand {
                            result.push((node_script_field, argument.clone()));
                        }
                    }
                    for (_, field, spelling) in option_resources {
                        result.push((field, spelling));
                    }
                    if let Some(script_index) = script_index {
                        let script = &command[script_index];
                        if is_bun_run_bare_operand(&command, script_index) {
                            result.push(("OpenCode bun run operand", script.clone()));
                        } else if is_bun_run_file_operand(&command, script_index) {
                            result.push(("OpenCode bun run file", script.clone()));
                        }
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

fn shell_directory_variables(source: &str) -> std::collections::BTreeSet<String> {
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
            (valid_name && value.contains("dirname") && value.contains("$0"))
                .then(|| name.to_owned())
        })
        .collect()
}

fn shell_changes_to_script_directory(line: &str) -> Option<&str> {
    const CD_TO_SCRIPT_DIRECTORY: &str = "cd \"$(dirname \"$0\")\"";
    let line = line.trim_start();
    let remainder = line.strip_prefix(CD_TO_SCRIPT_DIRECTORY)?;
    if remainder.is_empty() {
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
}

fn shell_node_invocation(line: &str) -> Option<ShellNodeInvocation> {
    let words = line
        .split_ascii_whitespace()
        .map(|word| word.trim_matches(['"', '\'']))
        .collect::<Vec<_>>();
    let node_index = words
        .iter()
        .position(|word| matches!(shell_executable_name(word).as_str(), "node" | "nodejs"))?;
    let mut index = node_index + 1;
    const NODE_OPTIONS_WITH_VALUE: [&str; 8] = [
        "-r",
        "--require",
        "--import",
        "--loader",
        "--experimental-loader",
        "--conditions",
        "--env-file",
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
    while let Some(argument) = words.get(index) {
        if *argument == "--" {
            index += 1;
            break;
        }
        let (option, inline_value) = argument
            .split_once('=')
            .map_or((*argument, None), |(option, value)| (option, Some(value)));
        if NODE_OPTIONS_WITH_VALUE.contains(&option) {
            let value = inline_value.or_else(|| words.get(index + 1).copied());
            if let Some(value) = value {
                let value = value.trim_end_matches([';', '&']);
                let is_script = NODE_SCRIPT_FILE_OPTIONS.contains(&option);
                let is_path = (option == "--env-file" && !value.starts_with('-'))
                    || Path::new(value).is_absolute()
                    || value.starts_with("./")
                    || value.starts_with("../")
                    || value.contains(['$', '*', '?']);
                if is_path && (is_script || option == "--env-file") {
                    file_operands.push((value.to_owned(), is_script));
                }
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
    directory_variables: &std::collections::BTreeSet<String>,
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
        if !directory_variables.contains(name) {
            return Err("direct MCP shell script has an unresolved dynamic source path");
        }
        relative = suffix.strip_prefix('/').unwrap_or(suffix);
    } else if let Some(variable) = operand.strip_prefix('$') {
        let (name, suffix) = variable
            .split_once('/')
            .ok_or("direct MCP shell script has an unresolved dynamic source path")?;
        if !directory_variables.contains(name) {
            return Err("direct MCP shell script has an unresolved dynamic source path");
        }
        relative = suffix;
    }
    if relative.is_empty() || relative.contains(['$', '*', '?']) {
        return Err("direct MCP shell script has an unresolved dynamic source path");
    }
    Ok(Some(script_parent.join(relative)))
}

fn shell_directory_relative_paths(
    line: &str,
    directory_variables: &std::collections::BTreeSet<String>,
    script_parent: &Path,
) -> std::collections::BTreeSet<String> {
    let mut result = std::collections::BTreeSet::new();
    let mut prefixes = std::collections::BTreeSet::new();
    for variable in directory_variables {
        prefixes.insert(format!("${variable}/"));
        prefixes.insert(format!("${{{variable}}}/"));
    }
    prefixes.insert("$(dirname \"$0\")/".to_owned());
    for prefix in prefixes {
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
            if !relative.is_empty()
                && !relative.contains(['$', '*', '?'])
                && (!shell_directory_path_is_redirection_target(line, start)
                    || script_parent.join(relative).exists())
            {
                result.insert(relative.to_owned());
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

fn node_relative_module_specifiers(source: &str) -> Result<Vec<String>, &'static str> {
    let tokens = javascript_tokens(source)?;
    let mut result = std::collections::BTreeSet::new();
    for (index, token) in tokens.iter().enumerate() {
        let module = match token {
            JavaScriptToken::Identifier(name) if name == "require" || name == "import" => {
                match tokens.get(index + 1) {
                    Some(JavaScriptToken::Punctuation(b'(')) => tokens.get(index + 2),
                    Some(JavaScriptToken::String(_)) if name == "import" => tokens.get(index + 1),
                    _ => None,
                }
            }
            JavaScriptToken::Identifier(name) if name == "from" => tokens.get(index + 1),
            _ => None,
        };
        if let Some(JavaScriptToken::String(Some(specifier))) = module {
            if specifier.starts_with("./") || specifier.starts_with("../") {
                result.insert(specifier.clone());
            }
        }
    }
    Ok(result.into_iter().collect())
}

fn node_relative_resource_specifiers(
    parent: &Path,
    source: &str,
) -> Result<std::collections::BTreeMap<String, bool>, &'static str> {
    let tokens = javascript_tokens(source)?;
    let output_destinations = node_output_destination_mask(&tokens)?;
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
        if new_keyword == "new"
            && url_constructor == "URL"
            && is_import_meta_url
            && (specifier.starts_with("./") || specifier.starts_with("../"))
            && !specifier.contains(['?', '#', '\\', '$'])
            && (!output_destinations[index] || parent.join(specifier).exists())
        {
            result
                .entry(specifier.clone())
                .and_modify(|writable| *writable |= output_destinations[index])
                .or_insert(output_destinations[index]);
        }
    }
    Ok(result)
}

fn node_output_destination_mask(tokens: &[JavaScriptToken]) -> Result<Vec<bool>, &'static str> {
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
    Ok(result)
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
                    let files = resolve_node_relative_module(parent, &specifier)?
                        .ok_or("direct MCP Node relative module is missing")?;
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
    result: &mut std::collections::BTreeSet<PathBuf>,
    resource_path_bytes: &mut usize,
    writable_resources: &mut std::collections::BTreeSet<PathBuf>,
    field: &'static str,
) -> Result<(), ResourceError> {
    const MAX_SCRIPT_BYTES: u64 = 1024 * 1024;
    const MAX_SCRIPT_FILES: usize = 256;
    let fail = |cause| ResourceError { field, cause };
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
        let directory_variables = shell_directory_variables(&source);
        if directory_variables.len() > 128 {
            return Err(fail(
                "direct MCP shell dependency closure exceeds its variable bound",
            ));
        }
        let script_parent = canonical
            .parent()
            .ok_or_else(|| fail("direct MCP shell script has no containing directory"))?;
        let mut working_directory_is_script_parent = false;
        for line in source
            .lines()
            .filter(|line| !line.trim_start().starts_with('#'))
        {
            let node_line = if let Some(remainder) = shell_changes_to_script_directory(line) {
                working_directory_is_script_parent = true;
                remainder
            } else {
                if line.trim_start().starts_with("cd ") {
                    working_directory_is_script_parent = false;
                }
                line
            };
            let mut candidates = std::collections::BTreeMap::new();
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
            for relative in
                shell_directory_relative_paths(line, &directory_variables, script_parent)
            {
                let parse_as_node_script = invokes_node && is_node_script_path(&relative);
                candidates
                    .entry(script_parent.join(relative))
                    .and_modify(|kind: &mut (bool, bool)| kind.1 |= parse_as_node_script)
                    .or_insert((false, parse_as_node_script));
            }
            if working_directory_is_script_parent && invokes_node {
                if let Some(invocation) = node_invocation {
                    if let Some(relative) = invocation.script_operand {
                        candidates
                            .entry(script_parent.join(relative))
                            .and_modify(|kind: &mut (bool, bool)| kind.1 = true)
                            .or_insert((false, true));
                    }
                    for (operand, parse_as_node_script) in invocation.file_operands {
                        if operand.contains(['$', '*', '?']) {
                            return Err(fail(
                                "direct MCP Node option has an unresolved dynamic file path",
                            ));
                        }
                        let path = Path::new(&operand);
                        let candidate = if path.is_absolute() {
                            path.to_owned()
                        } else {
                            script_parent.join(path)
                        };
                        candidates
                            .entry(candidate)
                            .and_modify(|kind: &mut (bool, bool)| kind.1 |= parse_as_node_script)
                            .or_insert((false, parse_as_node_script));
                    }
                }
            }
            for (candidate, (parse_as_script, parse_as_node_script)) in candidates {
                let dependency = checked(&candidate, field, declaring)?;
                if !dependency.is_file() {
                    return Err(fail("direct MCP shell source is not a regular file"));
                }
                if !dependency.starts_with(scope) {
                    return Err(fail(
                        "direct MCP shell source escapes its selected script scope",
                    ));
                }
                insert_resource(
                    result,
                    resource_path_bytes,
                    dependency.clone(),
                    field,
                    declaring,
                )?;
                if parse_as_node_script {
                    insert_installed_package_ancestor_resources(
                        &dependency,
                        scope,
                        declaring,
                        result,
                        resource_path_bytes,
                        field,
                    )?;
                    insert_direct_script_dependencies(
                        &dependency,
                        scope,
                        declaring,
                        DirectScriptResources {
                            paths: result,
                            path_bytes: resource_path_bytes,
                            writable_files: writable_resources,
                        },
                        field,
                        ScriptDependencyRuntime::Node,
                    )?;
                }
                pending.push((dependency, parse_as_script));
            }
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

pub struct ResourceSelection {
    pub resources: Vec<PathBuf>,
    pub variables: Vec<String>,
    pub writable_resources: std::collections::BTreeSet<PathBuf>,
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
pub fn select(
    source: &PlannedSourceOccurrence,
    home: &Path,
    global: Option<&Path>,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> Result<ResourceSelection, ResourceError> {
    let declaring = &source.source.logical_path;
    let fail = |field: &'static str, cause: &'static str| ResourceError { field, cause };
    let mut result = std::collections::BTreeSet::new();
    let mut resource_path_bytes = 0usize;
    let mut writable_resources = std::collections::BTreeSet::new();
    let mut variables = std::collections::BTreeSet::new();
    let raw = source.references.unexpanded_source();
    let skip_owned_freshell_mcp =
        source.source.lane == super::sources::SourceLane::Main && !source.user_owns_freshell_mcp;
    let mut selections = fields(raw).map_err(|cause| fail("OpenCode resource", cause))?;
    selections.extend(
        nested_fields(
            raw,
            source.source.lane == super::sources::SourceLane::Tui,
            skip_owned_freshell_mcp,
        )
        .map_err(|cause| fail("OpenCode resource", cause))?,
    );
    let mut current_mcp_working_dir: Option<PathBuf> = None;
    let mut current_mcp_resource_path: Option<PathBuf> = None;
    for (field, spelling) in selections {
        let mut field = field;
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
            let working_dir = current_mcp_resource_path
                .as_deref()
                .unwrap_or(&source.instance_cwd);
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
                path = declaring
                    .parent()
                    .unwrap_or(&source.instance_cwd)
                    .join(path);
            } else if field == "OpenCode skills.paths" || field == "OpenCode mcp.cwd" {
                path = source.instance_cwd.join(path);
            } else if is_mcp_command_resource_field(field) {
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
                let canonical_is_covered = current_mcp_working_dir
                    .as_deref()
                    .filter(|working_dir| canonical.starts_with(working_dir));
                let path_is_covered =
                    canonical_is_covered.is_some_and(|working_dir| path.starts_with(working_dir));
                if !path_is_covered {
                    insert_resource(
                        &mut result,
                        &mut resource_path_bytes,
                        path.clone(),
                        field,
                        declaring,
                    )?;
                }
                if path != canonical && canonical_is_covered.is_none() {
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
                    bun_run_file_resource_scope(command_parent, home, &source.instance_cwd)
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
                        &mut result,
                        &mut resource_path_bytes,
                        &mut writable_resources,
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
                            &mut result,
                            &mut resource_path_bytes,
                            &mut writable_resources,
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
    })
}
