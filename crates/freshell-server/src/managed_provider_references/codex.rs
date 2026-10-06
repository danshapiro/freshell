//! Finite Codex typed inputs, resolved per declaring logical TOML layer.
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    Configuration,
    Instructions,
    CompactPrompt,
    ModelCatalog,
    SkillSelector,
}
pub struct SelectedInput {
    pub logical_path: PathBuf,
    pub canonical_source: PathBuf,
    pub kind: InputKind,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum LayerKind {
    User,
    Project,
    Role,
}
pub struct SourceLayer {
    pub logical_path: PathBuf,
    pub enabled: bool,
    pub kind: LayerKind,
}

pub fn select_inputs(
    layers: &[SourceLayer],
    home: &Path,
    profile: Option<&str>,
) -> Result<Vec<SelectedInput>, &'static str> {
    let mut selection = Selection {
        home,
        profile,
        inputs: Vec::new(),
        active: std::collections::BTreeSet::new(),
        metadata_bytes: 0,
    };
    for layer in layers {
        selection.configuration(&layer.logical_path, layer.enabled, layer.kind, 0)?;
    }
    Ok(selection.inputs)
}

struct Selection<'a> {
    home: &'a Path,
    profile: Option<&'a str>,
    inputs: Vec<SelectedInput>,
    active: std::collections::BTreeSet<(PathBuf, PathBuf)>,
    metadata_bytes: usize,
}

impl Selection<'_> {
    fn add(&mut self, logical_path: PathBuf, kind: InputKind) -> Result<PathBuf, &'static str> {
        if self.inputs.len() >= 8192 {
            return Err("Codex selected input event budget exceeded");
        }
        let canonical_source = std::fs::canonicalize(&logical_path)
            .map_err(|_| "Codex selected input is missing, inaccessible or cyclic")?;
        let metadata = std::fs::metadata(&canonical_source)
            .map_err(|_| "Codex selected input metadata unavailable")?;
        if !metadata.is_file() {
            return Err("Codex selected input must be a regular file");
        }
        self.metadata_bytes = self
            .metadata_bytes
            .checked_add(logical_path.as_os_str().len())
            .and_then(|bytes| bytes.checked_add(canonical_source.as_os_str().len()))
            .ok_or("Codex selected input metadata size overflow")?;
        if self.metadata_bytes > 8 * 1024 * 1024 {
            return Err("Codex selected input metadata budget exceeded");
        }
        self.inputs.push(SelectedInput {
            logical_path,
            canonical_source: canonical_source.clone(),
            kind,
        });
        Ok(canonical_source)
    }

    fn configuration(
        &mut self,
        path: &Path,
        enabled: bool,
        kind: LayerKind,
        depth: usize,
    ) -> Result<(), &'static str> {
        use std::io::Read;
        if depth > 64 {
            return Err("Codex role configuration depth exceeded");
        }
        let logical = normalize(path);
        let canonical = self.add(logical.clone(), InputKind::Configuration)?;
        if !enabled {
            return Ok(());
        }
        let identity = (canonical.clone(), logical.clone());
        if !self.active.insert(identity.clone()) {
            return Err("Codex role configuration cycle detected");
        }
        let result = (|| {
            let mut raw = String::new();
            std::fs::File::open(&canonical)
                .map_err(|_| "Codex selected configuration unreadable")?
                .take(16 * 1024 * 1024 + 1)
                .read_to_string(&mut raw)
                .map_err(|_| "Codex selected configuration is unreadable or not UTF-8")?;
            if raw.len() > 16 * 1024 * 1024 {
                return Err("Codex selected configuration source view exceeded");
            }
            let value: toml::Value =
                toml::from_str(&raw).map_err(|_| "Codex selected configuration TOML is invalid")?;
            let parent = logical
                .parent()
                .ok_or("Codex declaring configuration parent unavailable")?;
            self.file_fields(&value, parent)?;
            if let Some(profile) = self.profile.filter(|_| kind == LayerKind::User) {
                if let Some(value) = value
                    .get("profiles")
                    .and_then(|profiles| profiles.get(profile))
                {
                    self.file_fields(value, parent)?;
                }
            }
            let mut role_paths = Vec::new();
            let mut role_path_bytes = 0usize;
            if let Some(roles) = value.get("agents").and_then(toml::Value::as_table) {
                if roles.len() > 8192 - self.inputs.len() {
                    return Err("Codex selected role event budget exceeded");
                }
                for role in roles.values() {
                    if let Some(path) = string_field(role, "config_file")? {
                        let path = typed_path(path, parent, self.home);
                        role_path_bytes = role_path_bytes
                            .checked_add(path.as_os_str().len())
                            .ok_or("Codex selected role metadata overflow")?;
                        if role_path_bytes > 8 * 1024 * 1024 - self.metadata_bytes {
                            return Err("Codex selected role metadata budget exceeded");
                        }
                        role_paths.push(path);
                    }
                }
            }
            if let Some(rules) = value
                .get("skills")
                .and_then(|skills| skills.get("config"))
                .filter(|_| kind == LayerKind::User)
            {
                let rules = rules
                    .as_array()
                    .ok_or("Codex skills config has an unsupported type")?;
                for rule in rules {
                    if let Some(path) = string_field(rule, "path")? {
                        self.add(
                            typed_path(path, parent, self.home),
                            InputKind::SkillSelector,
                        )?;
                    }
                }
            }
            // Retain only finite edge metadata across recursion. Native TOML
            // documents and raw source views leave scope before loading roles.
            drop(value);
            drop(raw);
            for role in role_paths {
                self.configuration(&role, true, LayerKind::Role, depth + 1)?;
            }
            Ok(())
        })();
        self.active.remove(&identity);
        result
    }

    fn file_fields(&mut self, value: &toml::Value, parent: &Path) -> Result<(), &'static str> {
        for (field, kind) in [
            ("model_instructions_file", InputKind::Instructions),
            ("experimental_compact_prompt_file", InputKind::CompactPrompt),
            ("model_catalog_json", InputKind::ModelCatalog),
        ] {
            if let Some(path) = string_field(value, field)? {
                self.add(typed_path(path, parent, self.home), kind)?;
            }
        }
        Ok(())
    }
}

fn string_field<'a>(value: &'a toml::Value, field: &str) -> Result<Option<&'a str>, &'static str> {
    value
        .get(field)
        .map(|value| {
            value
                .as_str()
                .ok_or("Codex selected typed input has an unsupported type")
        })
        .transpose()
}

fn typed_path(value: &str, parent: &Path, home: &Path) -> PathBuf {
    let selected = if value == "~" {
        home.to_owned()
    } else if let Some(suffix) = value.strip_prefix("~/") {
        home.join(suffix.trim_start_matches('/'))
    } else {
        PathBuf::from(value)
    };
    normalize(&if selected.is_absolute() {
        selected
    } else {
        parent.join(selected)
    })
}

fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other),
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    fn digest(path: &Path) -> String {
        format!("{:x}", Sha256::digest(std::fs::read(path).unwrap()))
    }
    fn layer(path: PathBuf, enabled: bool) -> SourceLayer {
        SourceLayer {
            logical_path: path,
            enabled,
            kind: LayerKind::User,
        }
    }
    #[test]
    fn managed_provider_codex_typed_inputs_keep_each_logical_role_and_profile_origin() {
        let fixture = tempfile::tempdir().unwrap();
        let home = fixture.path().join("home");
        let logical = fixture.path().join("project/.codex");
        let actual = fixture.path().join("storage");
        for path in [&home, &logical, &actual] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::create_dir(logical.join("roles")).unwrap();
        std::fs::create_dir(logical.join("skills")).unwrap();
        std::fs::write(logical.join("instructions.md"), "logical-layer").unwrap();
        std::fs::write(actual.join("instructions.md"), "wrong-storage-origin").unwrap();
        std::fs::write(logical.join("roles/instructions.md"), "logical-role").unwrap();
        std::fs::write(logical.join("profile.md"), "selected-profile").unwrap();
        std::fs::write(logical.join("skills/SKILL.md"), "selected-skill").unwrap();
        std::fs::write(
            actual.join("layer.toml"),
            r#"
model_instructions_file = "./instructions.md"
notify = ["./missing-command", "./missing-argument"]
[mcp_servers.fixture]
command = "./missing-command"
args = ["./missing-argument"]
cwd = "./missing-cwd"
[agents.worker]
config_file = "./roles/worker.toml"
[profiles.chosen]
experimental_compact_prompt_file = "./profile.md"
[profiles.unselected]
model_instructions_file = "./missing-unselected.md"
[[skills.config]]
path = "./skills/SKILL.md"
enabled = false
"#,
        )
        .unwrap();
        std::fs::write(
            actual.join("role.toml"),
            "model_instructions_file='./instructions.md'",
        )
        .unwrap();
        std::os::unix::fs::symlink(actual.join("layer.toml"), logical.join("config.toml")).unwrap();
        std::os::unix::fs::symlink(actual.join("role.toml"), logical.join("roles/worker.toml"))
            .unwrap();
        let selected = select_inputs(
            &[layer(logical.join("config.toml"), true)],
            &home,
            Some("chosen"),
        )
        .unwrap();
        let instructions = selected
            .iter()
            .filter(|input| input.kind == InputKind::Instructions)
            .map(|input| digest(&input.canonical_source))
            .collect::<Vec<_>>();
        assert_eq!(
            instructions,
            vec![
                digest(&logical.join("instructions.md")),
                digest(&logical.join("roles/instructions.md"))
            ]
        );
        assert!(selected
            .iter()
            .any(|input| input.kind == InputKind::CompactPrompt
                && digest(&input.canonical_source) == digest(&logical.join("profile.md"))));
        assert!(selected
            .iter()
            .any(|input| input.kind == InputKind::SkillSelector
                && input.logical_path == logical.join("skills/SKILL.md")));
        assert_eq!(
            std::fs::read_to_string(actual.join("role.toml")).unwrap(),
            "model_instructions_file='./instructions.md'"
        );
    }

    #[test]
    fn managed_provider_codex_typed_inputs_respect_disabled_layers_and_classify_cycles_and_parse_errors(
    ) {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("config.toml");
        std::fs::write(&path, "[agents.loop]\nconfig_file='./config.toml'\n").unwrap();
        assert_eq!(
            select_inputs(&[layer(path.clone(), true)], fixture.path(), None).err(),
            Some("Codex role configuration cycle detected")
        );
        std::fs::write(&path, "model_instructions_file='./missing'\n").unwrap();
        let disabled = select_inputs(&[layer(path.clone(), false)], fixture.path(), None).unwrap();
        assert_eq!(disabled.len(), 1);
        assert!(disabled[0].kind == InputKind::Configuration);
        std::fs::write(
            &path,
            "model_instructions_file='PRIVATE_INVALID_TOML_SENTINEL\n",
        )
        .unwrap();
        let error = select_inputs(&[layer(path, true)], fixture.path(), None)
            .err()
            .unwrap();
        assert_eq!(error, "Codex selected configuration TOML is invalid");
        assert!(!error.contains("PRIVATE_INVALID_TOML_SENTINEL"));
    }

    #[test]
    fn managed_provider_codex_project_layer_cannot_promote_user_profiles_or_skill_rules() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("config.toml");
        std::fs::write(fixture.path().join("project.md"), "project-input").unwrap();
        std::fs::write(
            &path,
            r#"model_instructions_file='./project.md'
[profiles.chosen]
model_instructions_file='./missing-profile-input'
[[skills.config]]
path='./missing-user-only-selector'
"#,
        )
        .unwrap();
        let selected = select_inputs(
            &[SourceLayer {
                logical_path: path,
                enabled: true,
                kind: LayerKind::Project,
            }],
            fixture.path(),
            Some("chosen"),
        )
        .unwrap();
        assert_eq!(selected.len(), 2);
        assert_eq!(
            digest(&selected[1].canonical_source),
            digest(&fixture.path().join("project.md"))
        );
    }
}
