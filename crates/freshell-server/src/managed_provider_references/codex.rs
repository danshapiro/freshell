//! Finite Codex typed inputs, resolved per declaring logical TOML layer.
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    Configuration,
    Instructions,
    CompactPrompt,
    ModelCatalog,
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
                    // Native paths are enable/disable selectors. They remain
                    // in the transported TOML and confer no resource authority.
                    string_field(rule, "path")?;
                }
            }
            if kind != LayerKind::Role {
                let declared = role_paths.iter().cloned().collect();
                let remaining_events = 8192usize
                    .checked_sub(self.inputs.len())
                    .and_then(|value| value.checked_sub(role_paths.len()))
                    .ok_or("Codex selected role event budget exceeded")?;
                let remaining_metadata = (8 * 1024 * 1024usize)
                    .checked_sub(self.metadata_bytes)
                    .and_then(|value| value.checked_sub(role_path_bytes))
                    .ok_or("Codex selected role metadata budget exceeded")?;
                role_paths.extend(discover_role_files(
                    &parent.join("agents"),
                    &declared,
                    remaining_events,
                    remaining_metadata,
                )?);
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

fn discover_role_files(
    root: &Path,
    declared: &std::collections::BTreeSet<PathBuf>,
    max_files: usize,
    max_path_bytes: usize,
) -> Result<Vec<PathBuf>, &'static str> {
    let limits = freshell_platform::provider_environment::CopyLimits::default();
    let mut directories = vec![(root.to_owned(), 0usize)];
    let mut files = Vec::new();
    let mut entries = 0usize;
    let mut metadata_bytes = 0usize;
    let mut selected_bytes = 0usize;
    while let Some((directory, depth)) = directories.pop() {
        if depth > limits.max_depth {
            return Err("Codex agent discovery depth exceeded");
        }
        let children = match std::fs::read_dir(&directory) {
            Ok(children) => children,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && depth == 0 => continue,
            Err(_) => return Err("Codex selected agent directory is unreadable or changed"),
        };
        for child in children {
            entries = entries
                .checked_add(1)
                .ok_or("Codex agent discovery entry count overflow")?;
            if entries > limits.max_entries {
                return Err("Codex agent discovery entry limit exceeded");
            }
            let child = child.map_err(|_| "Codex selected agent directory entry unreadable")?;
            let path = child.path();
            metadata_bytes = metadata_bytes
                .checked_add(path.as_os_str().len())
                .ok_or("Codex agent discovery metadata overflow")?;
            if metadata_bytes > 64 * 1024 * 1024 {
                return Err("Codex agent discovery metadata budget exceeded");
            }
            let kind = child
                .file_type()
                .map_err(|_| "Codex selected agent entry metadata unavailable")?;
            if kind.is_dir() {
                directories.push((path, depth + 1));
            } else if kind.is_file()
                && path
                    .extension()
                    .is_some_and(|extension| extension == "toml")
                && !declared.contains(&path)
            {
                if files.len() >= max_files {
                    return Err("Codex selected role event budget exceeded");
                }
                selected_bytes = selected_bytes
                    .checked_add(path.as_os_str().len())
                    .ok_or("Codex selected role metadata overflow")?;
                if selected_bytes > max_path_bytes {
                    return Err("Codex selected role metadata budget exceeded");
                }
                files.push(path);
            }
        }
    }
    files.sort();
    Ok(files)
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

pub(crate) struct CodexPreparation<'a> {
    pub client: &'a freshell_runtime_client::RuntimeClient,
    pub soul: &'a freshell_runtime_protocol::SoulId,
    pub creation_seed: &'a str,
    pub home: &'a Path,
    pub cwd: &'a Path,
    pub workspace: &'a Path,
    pub original: &'a (dyn Fn(&str) -> Option<String> + Sync),
    pub args: &'a [String],
    pub references: &'a [freshell_runtime_protocol::ProviderSecretReference],
}

pub(crate) async fn prepare_managed(
    request: CodexPreparation<'_>,
) -> Result<freshell_runtime_protocol::ProviderLaunchContext, String> {
    let CodexPreparation {
        client,
        soul,
        creation_seed,
        home,
        cwd,
        workspace,
        original,
        args,
        references,
    } = request;
    let codex_home =
        if let Some(selected) = original("CODEX_HOME").filter(|value| !value.is_empty()) {
            let selected = PathBuf::from(selected);
            let path = std::fs::canonicalize(if selected.is_absolute() {
                selected
            } else {
                cwd.join(selected)
            })
            .map_err(|_| {
                "selected CODEX_HOME is unavailable; repair the selected directory and retry"
            })?;
            if !path.is_dir() {
                return Err("selected CODEX_HOME must be a directory".into());
            }
            path
        } else {
            home.join(".codex")
        };
    let named_profile = args
        .windows(2)
        .filter(|pair| matches!(pair[0].as_str(), "--profile" | "-p"))
        .map(|pair| pair[1].clone())
        .next_back();
    let manifest = freshell_platform::codex_inputs::CodexInputManifest {
        version: 1,
        original_home: home.into(),
        cwd: cwd.into(),
        codex_home,
        named_profile,
    };
    let mcp = crate::managed_provider_bootstrap::managed_codex_mcp_args()
        .ok_or("managed Codex MCP preparation unavailable")?;
    let context = freshell_runtime_protocol::ProviderLaunchContext {
        preparation: freshell_runtime_protocol::ProviderPreparation::Codex {
            tui_args: mcp.clone(),
            sidecar_args: mcp,
        },
        config: vec![],
        mcp_capability: None,
        prepared_inputs: None,
    };
    // Ordinary Codex resource roots require exact first-volume authority.
    // This reservation makes no OpenCode native-auth or recovery-loss claim.
    let reservation = client
        .reserve_provider_inputs(soul.clone(), "codex".into(), creation_seed.into())
        .await
        .map_err(|error| error.to_string())?;
    if reservation.provider != "codex"
        || &reservation.soul_id != soul
        || reservation.creation_seed_ref != creation_seed
    {
        return Err("Codex selected resource reservation does not match this creation".into());
    }
    crate::managed_mcp_capability::issue_prepared_provider_context(
        "codex",
        soul,
        home,
        &context,
        crate::managed_mcp_capability::OpencodeEphemeralInput {
            codex_manifest: Some(&manifest),
            cwd: Some(cwd),
            workspace: Some(workspace),
            secret_references: Some(references),
            initial_auth_reservation: Some(&reservation.reservation_id),
            ..Default::default()
        },
    )
}

pub struct Discovery {
    pub manifest: freshell_platform::codex_inputs::CodexInputManifest,
    pub inputs: Vec<SelectedInput>,
    pub resource_roots: Vec<PathBuf>,
}

pub fn discover(
    manifest: freshell_platform::codex_inputs::CodexInputManifest,
) -> Result<Discovery, &'static str> {
    manifest.validate()?;
    let mut layers = Vec::new();
    let mut preceding = toml::Value::Table(Default::default());
    let base = manifest.codex_home.join("config.toml");
    if exists(&base)? {
        let value = read_config(&base)?;
        if let Some(name) = &manifest.named_profile {
            if value.get("profile").and_then(toml::Value::as_str) == Some(name.as_str())
                || value
                    .get("profiles")
                    .and_then(|profiles| profiles.get(name))
                    .is_some()
            {
                return Err("Codex named profile conflicts with legacy profile settings");
            }
        }
        merge(&mut preceding, value);
        layers.push(SourceLayer {
            logical_path: base,
            enabled: true,
            kind: LayerKind::User,
        });
    }
    if let Some(name) = &manifest.named_profile {
        let path = manifest.codex_home.join(format!("{name}.config.toml"));
        // A selected named configuration is required, unlike an absent base.
        merge(&mut preceding, read_config(&path)?);
        layers.push(SourceLayer {
            logical_path: path,
            enabled: true,
            kind: LayerKind::User,
        });
    }
    let markers: Vec<String> = if let Some(value) = preceding.get("project_root_markers") {
        value
            .as_array()
            .ok_or("Codex project markers must be an array")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_owned)
                    .ok_or("Codex project marker must be a string")
            })
            .collect::<Result<_, _>>()?
    } else {
        vec![".git".into()]
    };
    let root = manifest
        .cwd
        .ancestors()
        .find(|directory| markers.iter().any(|marker| directory.join(marker).exists()))
        .unwrap_or(&manifest.cwd);
    let mut directories = manifest
        .cwd
        .ancestors()
        .take_while(|directory| directory.starts_with(root))
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    directories.reverse();
    let mut resources = Vec::new();
    for path in [
        manifest.codex_home.join("AGENTS.md"),
        manifest.codex_home.join("rules"),
        manifest.codex_home.join("skills"),
        manifest.original_home.join(".agents/skills"),
    ] {
        if exists(&path)? {
            resources.push(path);
        }
    }
    for directory in &directories {
        let folder = directory.join(".codex");
        if exists(&folder)?
            && normalize(&folder) != normalize(&manifest.codex_home)
            && std::fs::canonicalize(&folder).ok()
                != std::fs::canonicalize(&manifest.codex_home).ok()
        {
            if !std::fs::metadata(&folder)
                .map_err(|_| "Codex project root is unreadable")?
                .is_dir()
            {
                return Err("Codex project config root must be a directory");
            }
            let skills = folder.join("skills");
            if exists(&skills)? {
                resources.push(skills);
            }
            let path = folder.join("config.toml");
            if exists(&path)? {
                layers.push(SourceLayer {
                    logical_path: path,
                    enabled: trusted(&preceding, directory, root),
                    kind: LayerKind::Project,
                });
            }
        }
        let skills = directory.join(".agents/skills");
        if exists(&skills)? {
            resources.push(skills);
        }
    }
    // User configuration alone selects installed plugins. Project tables do
    // not change the selection. Copy complete installed package/data units.
    if let Some(plugins) = preceding.get("plugins").and_then(toml::Value::as_table) {
        for (identity, value) in plugins {
            if value.get("enabled").and_then(toml::Value::as_bool) != Some(true) {
                continue;
            }
            let (plugin, market) = identity
                .split_once('@')
                .ok_or("Codex installed plugin identity is invalid")?;
            if [plugin, market].iter().any(|part| {
                part.is_empty()
                    || Path::new(part)
                        .components()
                        .any(|component| !matches!(component, std::path::Component::Normal(_)))
            }) {
                return Err("Codex installed plugin identity is invalid");
            }
            let cache = manifest
                .codex_home
                .join("plugins/cache")
                .join(market)
                .join(plugin);
            if !exists(&cache)? {
                return Err(
                    "Codex selected installed plugin is unavailable; repair installation and retry",
                );
            }
            resources.push(cache);
            let data = manifest
                .codex_home
                .join("plugins/data")
                .join(format!("{plugin}-{market}"));
            if exists(&data)? {
                resources.push(data);
            }
        }
    }
    let legacy = if manifest.named_profile.is_none() {
        preceding.get("profile").and_then(toml::Value::as_str)
    } else {
        None
    };
    let inputs = select_inputs(&layers, &manifest.original_home, legacy)?;
    resources.sort();
    resources.dedup();
    Ok(Discovery {
        manifest,
        inputs,
        resource_roots: resources,
    })
}
fn exists(path: &Path) -> Result<bool, &'static str> {
    match std::fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("Codex selected resource is inaccessible; repair permissions and retry"),
    }
}
fn read_config(path: &Path) -> Result<toml::Value, &'static str> {
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| "Codex selected configuration is unavailable")?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Codex selected configuration is unreadable")?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err("Codex selected configuration source view exceeded");
    }
    let raw =
        std::str::from_utf8(&bytes).map_err(|_| "Codex selected configuration is not UTF-8")?;
    toml::from_str(raw).map_err(|_| "Codex selected configuration TOML is invalid")
}
fn merge(target: &mut toml::Value, value: toml::Value) {
    if let (Some(target), Some(value)) = (target.as_table_mut(), value.as_table()) {
        for (key, value) in value {
            if let Some(existing) = target.get_mut(key) {
                merge(existing, value.clone());
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    } else {
        *target = value;
    }
}
fn trusted(value: &toml::Value, directory: &Path, root: &Path) -> bool {
    let Some(projects) = value.get("projects") else {
        return false;
    };
    let mut paths = vec![directory.to_path_buf()];
    if let Ok(canonical) = std::fs::canonicalize(directory) {
        paths.push(canonical);
    }
    paths.push(root.to_path_buf());
    if let Ok(canonical) = std::fs::canonicalize(root) {
        paths.push(canonical);
    }
    // Linked worktrees share the root checkout's trust selection.
    if let Ok(gitfile) = std::fs::read_to_string(root.join(".git")) {
        if let Some(gitdir) = gitfile.trim().strip_prefix("gitdir: ") {
            let path = normalize(&root.join(gitdir));
            if let Some(checkout) = path
                .ancestors()
                .find(|path| path.file_name() == Some(std::ffi::OsStr::new(".git")))
                .and_then(Path::parent)
            {
                paths.push(checkout.to_path_buf());
            }
        }
    }
    for path in paths {
        if let Some(trust) = path
            .to_str()
            .and_then(|key| projects.get(key))
            .and_then(|project| project.get("trust_level"))
            .and_then(toml::Value::as_str)
        {
            return trust == "trusted";
        }
    }
    false
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
    fn managed_provider_codex_skill_path_selectors_do_not_create_resource_authority() {
        let owned = tempfile::tempdir().unwrap();
        let config = owned.path().join("config.toml");
        std::fs::write(
            &config,
            "[[skills.config]]\npath = 'absent-skill'\nenabled = false\n",
        )
        .unwrap();
        let inputs = select_inputs(&[layer(config,true)],owned.path(),None).expect("native disabled path selectors do not require an existing file or grant a new skill discovery root");
        assert_eq!(inputs.len(), 1);
        assert!(inputs
            .iter()
            .all(|input| input.kind == InputKind::Configuration));
    }

    #[test]
    fn managed_provider_codex_discovered_roles_keep_nested_instruction_origins() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join(".codex");
        let nested = root.join("agents/nested");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(root.join("config.toml"), "model='synthetic-model'").unwrap();
        std::fs::write(root.join("agents/z.toml"),"name='z'\ndescription='synthetic role'\ndeveloper_instructions='synthetic developer'\nmodel_instructions_file='./z.md'\n").unwrap();
        std::fs::write(nested.join("a.toml"),"name='a'\ndescription='synthetic role'\ndeveloper_instructions='synthetic developer'\nmodel_instructions_file='./a.md'\n").unwrap();
        std::fs::write(root.join("agents/z.md"), b"Z_INSTRUCTIONS").unwrap();
        std::fs::write(nested.join("a.md"), b"A_NESTED_INSTRUCTIONS").unwrap();
        std::fs::write(nested.join("not-a-role.json"), b"not a TOML role").unwrap();
        let selected = select_inputs(
            &[layer(root.join("config.toml"), true)],
            fixture.path(),
            None,
        )
        .unwrap();
        let instructions = selected
            .iter()
            .filter(|input| input.kind == InputKind::Instructions)
            .map(|input| digest(&input.canonical_source))
            .collect::<Vec<_>>();
        assert_eq!(instructions,vec![digest(&nested.join("a.md")),digest(&root.join("agents/z.md"))],
            "native recursive role discovery must retain each role's declaring parent in sorted file order");
        assert_eq!(
            select_inputs(
                &[layer(root.join("config.toml"), false)],
                fixture.path(),
                None
            )
            .unwrap()
            .len(),
            1,
            "disabled project configuration must not activate its discovered role inputs"
        );
    }

    #[test]
    fn managed_provider_codex_discovered_roles_exclude_declared_files_and_bound_metadata() {
        let fixture = tempfile::tempdir().unwrap();
        let agents = fixture.path().join("agents");
        std::fs::create_dir(&agents).unwrap();
        let role = agents.join("declared.toml");
        std::fs::write(&role, "model_instructions_file='./instructions.md'").unwrap();
        std::fs::write(
            agents.join("instructions.md"),
            b"SYNTHETIC_ROLE_INSTRUCTIONS",
        )
        .unwrap();
        let config = fixture.path().join("config.toml");
        std::fs::write(
            &config,
            "[agents.worker]\nconfig_file='./agents/declared.toml'\n",
        )
        .unwrap();
        let selected = select_inputs(&[layer(config, true)], fixture.path(), None).unwrap();
        assert_eq!(
            selected
                .iter()
                .filter(|input| input.kind == InputKind::Instructions)
                .count(),
            1,
            "explicit role must not be selected again through discovery"
        );
        assert!(discover_role_files(&agents, &std::collections::BTreeSet::new(), 0, 1024).is_err());
        assert!(discover_role_files(&agents, &std::collections::BTreeSet::new(), 1, 0).is_err());
        assert!(discover_role_files(
            &fixture.path().join("absent"),
            &std::collections::BTreeSet::new(),
            0,
            0
        )
        .unwrap()
        .is_empty());
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
        assert!(
            !selected
                .iter()
                .any(|input| input.logical_path == logical.join("skills/SKILL.md")),
            "a skill path selector cannot grant ordinary file/resource authority"
        );
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
