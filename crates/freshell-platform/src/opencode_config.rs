//! OpenCode configuration sources and the JSONC dialect used by its pinned CLI.
//!
//! Keep source files as references. The provider reads and merges them in its
//! ordinary order; Freshell writes only its own generated entries.

use serde_json::Value;
use std::path::{Path, PathBuf};

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
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
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

/// Merge only Freshell-owned keys into the inline lane. The returned document
/// is process-local and must never be serialized into a durable launch plan.
pub fn merge_owned_entries(
    inherited: Option<&str>,
    plan: &OpencodeConfigPlan,
    edits: &OwnedConfigEdits,
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
    Ok(config.to_string())
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
