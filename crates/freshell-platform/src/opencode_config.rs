//! OpenCode configuration sources and the JSONC dialect used by its pinned CLI.
//!
//! Keep source files as references. The provider reads and merges them in its
//! ordinary order; Freshell writes only its own generated entries.

use serde_json::Value;
use std::path::{Path, PathBuf};

pub const GENERATED_CONFIG_REFERENCE_PREFIX: &str = "FRESHELL_CONFIG_REFERENCE_";
pub const MAX_GENERATED_CONFIG_REFERENCES: usize = 128;
pub fn generated_config_reference_name(ordinal: usize) -> String {
    format!("{GENERATED_CONFIG_REFERENCE_PREFIX}{ordinal}")
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigSource {
    pub path: PathBuf,
    pub kind: ConfigSourceKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigSourceKind {
    GlobalJson,
    GlobalJsonc,
    RootJson,
    RootJsonc,
    ProjectJson,
    ProjectJsonc,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OpencodeConfigPlan {
    pub sources: Vec<ConfigSource>,
    pub user_owns_freshell_mcp: bool,
    pub inline_prepared: bool,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct OwnedConfigEdits {
    pub disable_snapshots: bool,
    pub bash_permission: Option<String>,
    pub freshell_command: Option<Vec<String>>,
}

#[derive(Debug)]
pub enum ConfigError {
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    Malformed {
        path: PathBuf,
    },
    InvalidMcp {
        path: PathBuf,
    },
}

impl std::fmt::Display for ConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Io { path, source } => {
                write!(f, "read OpenCode config {}: {source}", path.display())
            }
            Self::Malformed { path } => write!(
                f,
                "OpenCode config {} contains malformed JSONC or is not an object",
                path.display()
            ),
            Self::InvalidMcp { path } => write!(
                f,
                "OpenCode config {} has a non-object mcp field",
                path.display()
            ),
        }
    }
}

impl std::error::Error for ConfigError {}

/// Discover and validate both filenames in the global and project roots.
/// OpenCode 1.18.21 merges global, project-root, then `.opencode` config,
/// reading JSON before JSONC in each directory.
pub fn prepare_opencode_config(
    project_dir: &Path,
    user_provider_root: &Path,
) -> Result<OpencodeConfigPlan, ConfigError> {
    let candidates = [
        (
            user_provider_root.join("opencode.json"),
            ConfigSourceKind::GlobalJson,
        ),
        (
            user_provider_root.join("opencode.jsonc"),
            ConfigSourceKind::GlobalJsonc,
        ),
        (
            project_dir.join("opencode.json"),
            ConfigSourceKind::RootJson,
        ),
        (
            project_dir.join("opencode.jsonc"),
            ConfigSourceKind::RootJsonc,
        ),
        (
            project_dir.join(".opencode/opencode.json"),
            ConfigSourceKind::ProjectJson,
        ),
        (
            project_dir.join(".opencode/opencode.jsonc"),
            ConfigSourceKind::ProjectJsonc,
        ),
    ];
    let mut sources = Vec::new();
    let mut user_owns_freshell_mcp = false;
    for (path, kind) in candidates {
        if !path.exists() {
            continue;
        }
        let raw = std::fs::read_to_string(&path).map_err(|source| ConfigError::Io {
            path: path.clone(),
            source,
        })?;
        let value = parse_jsonc_object(&raw)
            .ok_or_else(|| ConfigError::Malformed { path: path.clone() })?;
        validate_mcp_field(&value, &path)?;
        if let Some(entry) = value
            .get("mcp")
            .and_then(|m| m.get("freshell"))
            .filter(|entry| !entry.is_null())
        {
            user_owns_freshell_mcp |= kind != ConfigSourceKind::ProjectJson
                || !is_direct_owned_mcp_entry(project_dir, entry);
        }
        sources.push(ConfigSource { path, kind });
    }
    Ok(OpencodeConfigPlan {
        sources,
        user_owns_freshell_mcp,
        inline_prepared: false,
    })
}

fn is_direct_owned_mcp_entry(project_dir: &Path, entry: &Value) -> bool {
    let sidecar = project_dir.join(".opencode/.freshell-mcp-state.json");
    let Ok(raw) = std::fs::read_to_string(sidecar) else {
        return false;
    };
    let Ok(state) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    state.get("createdEntry").and_then(Value::as_bool) == Some(true)
        && state.get("ownedCommand") == entry.get("command")
}

pub fn parse_jsonc_object(raw: &str) -> Option<Value> {
    let value = parse_jsonc_value(raw)?;
    value.is_object().then_some(value)
}

pub fn parse_jsonc_value(raw: &str) -> Option<Value> {
    serde_json::from_str(&jsonc_to_strict_json(raw)).ok()
}

fn validate_mcp_field(value: &Value, path: &Path) -> Result<(), ConfigError> {
    if value
        .get("mcp")
        .is_some_and(|mcp| !mcp.is_null() && !mcp.is_object())
    {
        return Err(ConfigError::InvalidMcp {
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

/// Inspect the retained, accepted raw view without reading its source again.
pub fn source_owns_freshell_mcp(
    raw: &str,
    path: &Path,
    project_dir: &Path,
) -> Result<bool, ConfigError> {
    let value =
        parse_jsonc_object(raw).ok_or_else(|| ConfigError::Malformed { path: path.into() })?;
    validate_mcp_field(&value, path)?;
    let entry = value
        .get("mcp")
        .and_then(|mcp| mcp.get("freshell"))
        .filter(|entry| !entry.is_null());
    Ok(entry.is_some_and(|entry| {
        path != project_dir.join(".opencode/opencode.json")
            || !is_direct_owned_mcp_entry(project_dir, entry)
    }))
}

/// Merge only Freshell-owned keys into the inline lane. The returned document
/// is process-local and must never be serialized into a durable launch plan.
pub fn merge_owned_entries(
    inherited: Option<&str>,
    plan: &OpencodeConfigPlan,
    edits: &OwnedConfigEdits,
) -> Result<String, ConfigError> {
    merge_owned_entries_bounded(inherited, plan, edits, 16 * 1024 * 1024)
}

pub fn merge_owned_entries_bounded(
    inherited: Option<&str>,
    plan: &OpencodeConfigPlan,
    edits: &OwnedConfigEdits,
    limit: usize,
) -> Result<String, ConfigError> {
    let mut config = match inherited.filter(|raw| !raw.is_empty()) {
        Some(raw) => parse_jsonc_object(raw).ok_or_else(|| ConfigError::Malformed {
            path: PathBuf::from("OPENCODE_CONFIG_CONTENT"),
        })?,
        None => serde_json::json!({}),
    };
    validate_mcp_field(&config, Path::new("OPENCODE_CONFIG_CONTENT"))?;
    if edits.disable_snapshots {
        config["snapshot"] = Value::Bool(false);
    }
    if let Some(permission) = &edits.bash_permission {
        let map = config.as_object_mut().expect("validated object");
        let permissions = map
            .entry("permission")
            .or_insert_with(|| serde_json::json!({}));
        let Some(permissions) = permissions.as_object_mut() else {
            return Err(ConfigError::Malformed {
                path: PathBuf::from("OPENCODE_CONFIG_CONTENT"),
            });
        };
        permissions.insert("bash".into(), Value::String(permission.clone()));
    }
    if let Some(command) = &edits.freshell_command {
        let inline_owns_freshell = config
            .get("mcp")
            .and_then(|m| m.get("freshell"))
            .is_some_and(|entry| !entry.is_null());
        if !inline_owns_freshell && !plan.user_owns_freshell_mcp {
            let map = config.as_object_mut().expect("validated object");
            let mcp = map.entry("mcp").or_insert_with(|| serde_json::json!({}));
            let Some(mcp) = mcp.as_object_mut() else {
                return Err(ConfigError::Malformed {
                    path: PathBuf::from("OPENCODE_CONFIG_CONTENT"),
                });
            };
            mcp.insert(
                "freshell".into(),
                serde_json::json!({"type":"local", "command":command}),
            );
        }
    }
    serialize_source_view(&config, limit).map_err(|source| ConfigError::Io {
        path: "OPENCODE_CONFIG_CONTENT".into(),
        source,
    })
}

/// Serialize an effective source without allocating beyond its accepted view.
pub fn serialize_source_view(config: &Value, limit: usize) -> std::io::Result<String> {
    use std::io::Write;
    struct BoundedView {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl Write for BoundedView {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            if self
                .bytes
                .len()
                .checked_add(bytes.len())
                .is_none_or(|size| size > self.limit)
            {
                return Err(std::io::Error::other(
                    "OpenCode effective source-view profile exceeded",
                ));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut view = BoundedView {
        bytes: Vec::new(),
        limit: limit.min(16 * 1024 * 1024),
    };
    serde_json::to_writer(&mut view, config).map_err(std::io::Error::other)?;
    String::from_utf8(view.bytes).map_err(std::io::Error::other)
}

/// Normalize the JSONC accepted by OpenCode's `jsonc-parser` (comments and
/// trailing commas) without changing string literals or accepting dangling
/// block comments.
pub fn jsonc_to_strict_json(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut stripped = String::with_capacity(raw.len());
    let mut i = 0;
    let mut in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            stripped.push(c);
            if c == '\\' && i + 1 < chars.len() {
                stripped.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
        } else if c == '"' {
            in_string = true;
            stripped.push(c);
            i += 1;
        } else if c == '/' && chars.get(i + 1) == Some(&'/') {
            stripped.push(' ');
            i += 2;
            while i < chars.len() && chars[i] != '\n' && chars[i] != '\r' {
                i += 1;
            }
        } else if c == '/' && chars.get(i + 1) == Some(&'*') {
            let start = i;
            stripped.push(' ');
            i += 2;
            let mut closed = false;
            while i < chars.len() {
                if chars[i] == '*' && chars.get(i + 1) == Some(&'/') {
                    i += 2;
                    closed = true;
                    break;
                }
                i += 1;
            }
            if !closed {
                stripped.extend(chars[start..].iter());
            }
        } else {
            stripped.push(c);
            i += 1;
        }
    }

    let chars: Vec<char> = stripped.chars().collect();
    let mut out = String::with_capacity(stripped.len());
    let mut i = 0;
    in_string = false;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if c == '\\' && i + 1 < chars.len() {
                out.push(chars[i + 1]);
                i += 1;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
        } else if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
        } else if c == ',' {
            let mut j = i + 1;
            while matches!(chars.get(j), Some(' ' | '\t' | '\n' | '\r')) {
                j += 1;
            }
            if matches!(chars.get(j), Some('}' | ']')) {
                i += 1;
            } else {
                out.push(c);
                i += 1;
            }
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_preserves_both_sources_and_owned_merge_preserves_user_entries() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let global = temp.path().join("global");
        std::fs::create_dir_all(project.join(".opencode")).unwrap();
        std::fs::create_dir_all(&global).unwrap();
        std::fs::write(global.join("opencode.json"), r#"{"mcp":{"global":{"type":"remote","url":"http://localhost:1"}},"provider":{"demo":{}}}"#).unwrap();
        std::fs::write(
            project.join(".opencode/opencode.json"),
            r#"{"mcp":{"project":{"type":"local","command":["true"]}}}"#,
        )
        .unwrap();
        let jsonc = "{ // kept verbatim\n \"plugin\":[\"file:///user.ts\",], }";
        std::fs::write(project.join(".opencode/opencode.jsonc"), jsonc).unwrap();
        let plan = prepare_opencode_config(&project, &global).unwrap();
        assert_eq!(plan.sources.len(), 3);
        let merged = merge_owned_entries(
            Some("{\"model\":\"demo/m\"}"),
            &plan,
            &OwnedConfigEdits {
                freshell_command: Some(vec!["node".into(), "server.js".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        let config: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(config["model"], "demo/m");
        assert_eq!(
            config["mcp"]["freshell"]["command"],
            serde_json::json!(["node", "server.js"])
        );
        assert_eq!(
            std::fs::read_to_string(project.join(".opencode/opencode.jsonc")).unwrap(),
            jsonc
        );
    }

    #[test]
    fn invalid_inline_is_refused_without_echoing_secret() {
        let error = merge_owned_entries(
            Some("{\"apiKey\":\"secret\","),
            &OpencodeConfigPlan {
                sources: vec![],
                user_owns_freshell_mcp: false,
                inline_prepared: false,
            },
            &OwnedConfigEdits::default(),
        )
        .unwrap_err();
        assert!(error.to_string().contains("OPENCODE_CONFIG_CONTENT"));
        assert!(!error.to_string().contains("secret"));
    }

    #[test]
    fn global_user_freshell_mcp_is_preserved_and_suppresses_generated_entry() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let global = temp.path().join("global");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(&global).unwrap();
        std::fs::write(global.join("opencode.jsonc"), "{ // user server\n\"mcp\":{\"freshell\":{\"type\":\"local\",\"command\":[\"user-server\"]},},}").unwrap();
        let plan = prepare_opencode_config(&project, &global).unwrap();
        assert!(plan.user_owns_freshell_mcp);
        let merged = merge_owned_entries(
            None,
            &plan,
            &OwnedConfigEdits {
                freshell_command: Some(vec!["node".into(), "generated.js".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        let inline: Value = serde_json::from_str(&merged).unwrap();
        assert!(inline.get("mcp").is_none());
        assert!(std::fs::read_to_string(global.join("opencode.jsonc"))
            .unwrap()
            .contains("user-server"));
    }

    #[test]
    fn direct_owned_project_mcp_does_not_block_managed_local_bridge() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        let global = temp.path().join("global");
        std::fs::create_dir_all(project.join(".opencode")).unwrap();
        std::fs::create_dir_all(&global).unwrap();
        let direct_command = serde_json::json!(["node", "/host/freshell-mcp/server.js"]);
        std::fs::write(
            project.join(".opencode/opencode.json"),
            serde_json::json!({"mcp":{"freshell":{"type":"local","command":direct_command}}})
                .to_string(),
        )
        .unwrap();
        std::fs::write(
            project.join(".opencode/.freshell-mcp-state.json"),
            serde_json::json!({"createdEntry":true,"ownedCommand":direct_command,"refCount":1})
                .to_string(),
        )
        .unwrap();
        let plan = prepare_opencode_config(&project, &global).unwrap();
        assert!(!plan.user_owns_freshell_mcp);
        let inline = merge_owned_entries(
            None,
            &plan,
            &OwnedConfigEdits {
                freshell_command: Some(vec!["node".into(), "/opt/freshell-mcp/server.js".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&inline).unwrap()["mcp"]["freshell"]["command"],
            serde_json::json!(["node", "/opt/freshell-mcp/server.js"])
        );
        std::fs::write(
            project.join(".opencode/opencode.json"),
            r#"{"mcp":{"freshell":{"type":"local","command":["user-replacement"]}}}"#,
        )
        .unwrap();
        let changed = prepare_opencode_config(&project, &global).unwrap();
        assert!(changed.user_owns_freshell_mcp);
    }

    #[test]
    fn inline_user_mcp_and_provider_settings_survive_permission_merge() {
        let plan = OpencodeConfigPlan {
            sources: vec![],
            user_owns_freshell_mcp: false,
            inline_prepared: false,
        };
        let raw = "{ // inline user settings\n\"provider\":{\"demo\":{}},\"mcp\":{\"freshell\":{\"type\":\"local\",\"command\":[\"user-command\"]}},\"permission\":{\"edit\":\"ask\"},}";
        let merged = merge_owned_entries(
            Some(raw),
            &plan,
            &OwnedConfigEdits {
                bash_permission: Some("allow".into()),
                freshell_command: Some(vec!["node".into(), "generated.js".into()]),
                ..Default::default()
            },
        )
        .unwrap();
        let config: Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(config["provider"]["demo"], serde_json::json!({}));
        assert_eq!(
            config["mcp"]["freshell"]["command"],
            serde_json::json!(["user-command"])
        );
        assert_eq!(config["permission"]["edit"], "ask");
        assert_eq!(config["permission"]["bash"], "allow");
    }
}

/// Input provenance for one token in the pinned document-level substitution.
/// Expanded paths are transient; never serialize or log this callback input.
pub struct FileToken<'a> {
    pub path: &'a str,
    pub original_span: std::ops::Range<usize>,
    pub variables: Vec<&'a str>,
    pub direct_expression: bool,
    pub ordinal: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransformError {
    SourceLimit,
    ExpansionLimit,
    EventLimit,
    VariableLimit,
}

struct SubstitutionSegment<'a> {
    expanded: std::ops::Range<usize>,
    original: std::ops::Range<usize>,
    variable: Option<&'a str>,
}

const MAX_CONFIG_VIEW_BYTES: usize = 16 * 1024 * 1024;
const MAX_CONFIG_EVENTS: usize = 8192;

fn bounded_append(out: &mut String, piece: &str) -> Result<(), TransformError> {
    if out
        .len()
        .checked_add(piece.len())
        .is_none_or(|n| n > MAX_CONFIG_VIEW_BYTES)
    {
        return Err(TransformError::ExpansionLimit);
    }
    out.push_str(piece);
    Ok(())
}

fn outer_file_end(raw: &str, start: usize) -> Option<usize> {
    if !raw[start..].starts_with("{file:") {
        return None;
    }
    let mut cursor = start + 6;
    while cursor < raw.len() {
        if raw[cursor..].starts_with("{env:") {
            let close = raw[cursor + 5..].find('}')? + cursor + 5;
            cursor = close + 1;
        } else if raw.as_bytes()[cursor] == b'}' {
            return Some(cursor + 1);
        } else {
            cursor += raw[cursor..].chars().next()?.len_utf8();
        }
    }
    None
}

/// OpenCode 1.18.21 performs exactly one raw env pass, then snapshots file
/// matches from the resulting document. Keep raw escapes and full line-prefix
/// context; parsed JSON strings do not reproduce its substitution behavior.
/// Output may contain private child values and is process-only.
pub fn transform_file_tokens<E>(
    raw: &str,
    env: &dyn Fn(&str) -> Option<String>,
    mut file: impl FnMut(FileToken<'_>) -> Result<String, E>,
) -> Result<String, TokenTransformError<E>> {
    use TokenTransformError::{Bound, Selection};
    if raw.len() > MAX_CONFIG_VIEW_BYTES {
        return Err(Bound(TransformError::SourceLimit));
    }
    let mut expanded = String::new();
    let mut segments = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = raw[cursor..].find("{env:") {
        let start = cursor + relative;
        let Some(close_relative) = raw[start + 5..].find('}') else {
            break;
        };
        let close = start + 5 + close_relative;
        let name = &raw[start + 5..close];
        if name.is_empty() {
            cursor = close + 1;
            continue;
        }
        if name.len() > 128 || name.chars().any(char::is_control) {
            return Err(Bound(TransformError::VariableLimit));
        }
        if segments.len() + 2 > MAX_CONFIG_EVENTS {
            return Err(Bound(TransformError::EventLimit));
        }
        let literal_start = segments
            .last()
            .map_or(0, |segment: &SubstitutionSegment<'_>| segment.original.end);
        let begin = expanded.len();
        bounded_append(&mut expanded, &raw[literal_start..start]).map_err(Bound)?;
        segments.push(SubstitutionSegment {
            expanded: begin..expanded.len(),
            original: literal_start..start,
            variable: None,
        });
        let begin = expanded.len();
        if let Some(value) = env(name) {
            bounded_append(&mut expanded, &value).map_err(Bound)?;
        }
        segments.push(SubstitutionSegment {
            expanded: begin..expanded.len(),
            original: start..close + 1,
            variable: Some(name),
        });
        cursor = close + 1;
    }
    let literal_start = segments
        .last()
        .map_or(0, |segment: &SubstitutionSegment<'_>| segment.original.end);
    let begin = expanded.len();
    bounded_append(&mut expanded, &raw[literal_start..]).map_err(Bound)?;
    segments.push(SubstitutionSegment {
        expanded: begin..expanded.len(),
        original: literal_start..raw.len(),
        variable: None,
    });
    let mut out = String::new();
    let mut cursor = 0;
    let mut scan = 0;
    let mut ordinal = 0;
    while let Some(relative) = expanded[scan..].find("{file:") {
        let start = scan + relative;
        let Some(close_relative) = expanded[start + 6..].find('}') else {
            break;
        };
        let end = start + 6 + close_relative + 1;
        scan = end;
        if end == start + 7 {
            continue;
        }
        let line_start = expanded[..start].rfind('\n').map_or(0, |n| n + 1);
        if expanded[line_start..start].trim_start().starts_with("//") {
            continue;
        }
        if ordinal >= MAX_CONFIG_EVENTS {
            return Err(Bound(TransformError::EventLimit));
        }
        let mut original_start = usize::MAX;
        let mut original_end = 0;
        let mut variables = Vec::new();
        for segment in &segments {
            if segment.expanded.start >= end || segment.expanded.end <= start {
                continue;
            }
            let (a, b) = if let Some(variable) = segment.variable {
                if !variables.contains(&variable) {
                    variables.push(variable);
                }
                (segment.original.start, segment.original.end)
            } else {
                (
                    segment.original.start + start.saturating_sub(segment.expanded.start),
                    segment.original.start
                        + (end.min(segment.expanded.end) - segment.expanded.start),
                )
            };
            original_start = original_start.min(a);
            original_end = original_end.max(b);
        }
        let direct_expression = outer_file_end(raw, original_start) == Some(original_end);
        let replacement = file(FileToken {
            path: &expanded[start + 6..end - 1],
            original_span: original_start..original_end,
            variables,
            direct_expression,
            ordinal,
        })
        .map_err(Selection)?;
        bounded_append(&mut out, &expanded[cursor..start]).map_err(Bound)?;
        bounded_append(&mut out, &replacement).map_err(Bound)?;
        cursor = end;
        ordinal += 1;
    }
    bounded_append(&mut out, &expanded[cursor..]).map_err(Bound)?;
    Ok(out)
}

#[derive(Debug)]
pub enum TokenTransformError<E> {
    Bound(TransformError),
    Selection(E),
}

#[cfg(test)]
mod substitution_tests {
    use super::*;
    #[test]
    fn one_pass_preserves_introduced_env_tokens_and_snapshots_file_tokens() {
        let raw = r#"{"x":"{env:INSERT}"}"#;
        let out = transform_file_tokens(
            raw,
            &|name| (name == "INSERT").then(|| "prefix{file:rules}suffix{env:UNEXPANDED}".into()),
            |token| {
                assert!(!token.direct_expression);
                assert_eq!(token.path, "rules");
                assert_eq!(token.variables, vec!["INSERT"]);
                Ok::<_, ()>("{file:replacement}".into())
            },
        )
        .unwrap();
        assert_eq!(
            out,
            r#"{"x":"prefix{file:replacement}suffix{env:UNEXPANDED}"}"#
        );
    }
    #[test]
    fn full_line_comment_prefix_is_preserved_and_empty_variable_matches_native() {
        let raw = "  // {file:missing}\n{\"x\":\"{file:{env:MISSING}}\"}";
        let out = transform_file_tokens::<()>(raw, &|_| None, |_| {
            panic!("comment/empty file cannot select a source")
        })
        .unwrap();
        assert_eq!(out, "  // {file:missing}\n{\"x\":\"{file:}\"}");
    }
    #[test]
    fn nested_file_span_preserves_unrelated_env_tokens_in_controller_template() {
        let raw = r#"{"x":"{file:{env:PATH}}","y":"{env:OTHER}"}"#;
        let mut span = None;
        transform_file_tokens(
            raw,
            &|name| {
                Some(
                    if name == "PATH" {
                        "/approved"
                    } else {
                        "private-child"
                    }
                    .into(),
                )
            },
            |token| {
                assert!(token.direct_expression);
                span = Some(token.original_span);
                Ok::<_, ()>("runtime".into())
            },
        )
        .unwrap();
        assert_eq!(&raw[span.unwrap()], "{file:{env:PATH}}");
    }
}

/// Resolve native path syntax without touching the original controller tree.
/// Hosts compare this candidate only to already approved source aliases.
pub fn file_reference_path(
    path: &str,
    declaring_config: &Path,
    cwd: &Path,
    home: &Path,
) -> PathBuf {
    if let Some(relative) = path.strip_prefix("~/") {
        return lexical_path(&home.join(relative.trim_start_matches('/')));
    }
    if Path::new(path).is_absolute() {
        return path.into();
    }
    let declaring_parent = declaring_config
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty());
    let parent = match declaring_parent {
        Some(parent) if parent.is_absolute() => parent.to_owned(),
        Some(parent) => cwd.join(parent),
        None => cwd.to_owned(),
    };
    // Node path.resolve normalizes '..' before filesystem symlinks are read.
    lexical_path(&parent.join(path))
}

pub fn lexical_path(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                if matches!(result.components().next_back(), Some(Component::Normal(_))) {
                    result.pop();
                } else if !result.has_root() {
                    result.push(component.as_os_str());
                }
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}
