//! Private prepared-source validation before an execution grant is consumed.
use crate::provider_secret_resolution::ResolvedProviderSecrets;
use freshell_runtime_protocol::{ProviderLaunchContext, ProviderPathInputs};
use std::{collections::BTreeMap, path::Path};

pub(crate) fn read_private(root: &Path, relative: &str, limit: usize) -> Result<Vec<u8>, String> {
    use std::io::Read;
    if std::path::Path::new(relative)
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("prepared source has an invalid private relative path".into());
    }
    let path = root.join(relative);
    let metadata =
        std::fs::symlink_metadata(&path).map_err(|_| "prepared private source unavailable")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || metadata.len() > limit as u64
        || std::fs::canonicalize(&path).map_err(|_| "prepared private source unavailable")? != path
    {
        return Err(
            "prepared private source must be a physical stage file within its byte profile".into(),
        );
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&path)
        .map_err(|_| "prepared private source unreadable")?;
    let opened = file
        .metadata()
        .map_err(|_| "prepared private source unavailable")?;
    let modified = metadata
        .modified()
        .map_err(|_| "prepared private source metadata unavailable")?;
    if opened.len() != metadata.len()
        || opened
            .modified()
            .map_err(|_| "prepared private source metadata unavailable")?
            != modified
    {
        return Err(
            "prepared private source changed before reading; retain inputs and reprepare".into(),
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (opened.dev(), opened.ino()) != (metadata.dev(), metadata.ino()) {
            return Err(
                "prepared private source inode changed before reading; retain inputs and reprepare"
                    .into(),
            );
        }
    }
    let length = usize::try_from(metadata.len())
        .map_err(|_| "prepared private source byte profile exceeded")?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(length)
        .map_err(|_| "prepared private source allocation unavailable")?;
    bytes.resize(length, 0);
    file.read_exact(&mut bytes)
        .map_err(|_| "prepared private source read failed")?;
    let mut extra = [0];
    if file
        .read(&mut extra)
        .map_err(|_| "prepared private source completion unavailable")?
        != 0
    {
        return Err(
            "prepared private source grew during reading; retain inputs and reprepare".into(),
        );
    }
    let after = std::fs::symlink_metadata(&path)
        .map_err(|_| "prepared private source unavailable after reading")?;
    if after.file_type().is_symlink()
        || after.len() != metadata.len()
        || after
            .modified()
            .map_err(|_| "prepared private source metadata unavailable")?
            != modified
    {
        return Err(
            "prepared private source changed during reading; retain inputs and reprepare".into(),
        );
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (after.dev(), after.ino()) != (metadata.dev(), metadata.ino()) {
            return Err(
                "prepared private source inode changed during reading; retain inputs and reprepare"
                    .into(),
            );
        }
    }
    Ok(bytes)
}

pub(crate) fn final_claude_source_request(
    context: Option<&ProviderLaunchContext>,
    stage: &Path,
    cwd: &Path,
    home: &Path,
    runtime: freshell_platform::claude_inputs::NativeSourceRuntime,
) -> Result<
    Option<(
        freshell_platform::claude_inputs::observation::ObservationRequest,
        freshell_platform::claude_inputs::observation::NativeObservation,
    )>,
    String,
> {
    use freshell_platform::claude_inputs::{observation::ObservationRequest, ClaudeInputManifest};
    use sha2::{Digest, Sha256};
    let Some(context) = context.filter(|context| context.preparation.provider() == "claude") else {
        return Ok(None);
    };
    let Some(inputs) = context.prepared_inputs.as_ref() else {
        return Ok(None);
    };
    context.validate("claude").map_err(|error| error.message)?;
    let bytes = read_private(stage, &inputs.manifest.relative_path, 64 * 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(&bytes)) != inputs.manifest.sha256 {
        return Err("Claude prepared generation changed; retain inputs and reprepare".into());
    }
    let manifest: ClaudeInputManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "Claude prepared generation is invalid; retain inputs and reprepare")?;
    manifest.validate().map_err(str::to_string)?;
    let plan = manifest
        .accepted_native_plan
        .as_ref()
        .ok_or("Claude native source evidence is unrecorded; retain inputs and reprepare")?;
    let selectors = freshell_runtime_protocol::bounded_json_bytes(
        &manifest.original_selectors(),
        64 * 1024 * 1024,
    )
    .map_err(|_| "Claude original selectors exceed the private profile")?;
    if plan.selector_manifest_sha256 != format!("{:x}", Sha256::digest(selectors))
        || plan.observation.native_source_runtime != runtime
        || plan.observation.cwd != cwd
        || plan.observation.home.as_deref() != Some(home)
    {
        return Err(
            "Claude original selection or native launch view changed; retain inputs and reprepare"
                .into(),
        );
    }
    let request = ObservationRequest {
        version: 1,
        request_id: uuid::Uuid::new_v4().to_string(),
        native_source_runtime: runtime,
        cwd: cwd.into(),
        home: home.into(),
        setting_sources: manifest.setting_sources,
        selector_manifest_sha256: plan.selector_manifest_sha256.clone(),
        plan_revision: plan.plan_revision,
        candidate_binding: None,
    };
    request.validate()?;
    Ok(Some((request, plan.observation.clone())))
}

pub fn prepare(
    context: Option<&ProviderLaunchContext>,
    secrets: &mut ResolvedProviderSecrets,
    frozen: &ProviderPathInputs,
    stage: &Path,
    home: &Path,
) -> Result<BTreeMap<String, String>, String> {
    use freshell_platform::opencode_recipe::{GeneratedFileRecipe, SourceLane, SourceManifest};
    use sha2::{Digest, Sha256};
    let Some(inputs) = context.and_then(|context| context.prepared_inputs.as_ref()) else {
        return if frozen.is_empty() {
            Ok(BTreeMap::new())
        } else {
            Err("private source inputs have no prepared generation".into())
        };
    };
    context
        .ok_or("prepared provider context unavailable")?
        .validate(context.unwrap().preparation.provider())
        .map_err(|error| error.message)?;
    let metadata = read_private(stage, &inputs.manifest.relative_path, 64 * 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(&metadata)) != inputs.manifest.sha256 {
        return Err("prepared source manifest changed before dispatch".into());
    }
    let provider = context.unwrap().preparation.provider();
    if matches!(provider, "codex" | "claude" | "amplifier") {
        if !frozen.is_empty()
            || inputs.manifest.source_count != 0
            || inputs.manifest.alias_count != 0
            || inputs.manifest.recipe_count != 0
            || inputs.indexed_files.is_some()
        {
            return Err("ordinary source context carries foreign private reference inputs".into());
        }
        if provider == "claude" {
            let manifest: freshell_platform::claude_inputs::ClaudeInputManifest =
                serde_json::from_slice(&metadata)
                    .map_err(|_| "prepared Claude discovery metadata invalid")?;
            manifest.validate().map_err(str::to_string)?;
            if let Some(digest) = &manifest.inline_settings_sha256 {
                use freshell_platform::claude_inputs::{
                    settings_with_owned_hooks, INLINE_SETTINGS_SOURCE, MAX_NATIVE_SETTINGS_BYTES,
                };
                let raw = read_private(stage, INLINE_SETTINGS_SOURCE, MAX_NATIVE_SETTINGS_BYTES).map_err(|reason| format!("Claude inline --settings private source (native 2 MiB limit): {reason}"))?;
                if format!("{:x}", Sha256::digest(&raw)) != *digest {
                    return Err("selected Claude inline settings source changed; retain inputs and reprepare before dispatch".into());
                }
                let settings = settings_with_owned_hooks(&raw).map_err(str::to_string)?;
                let bytes = freshell_runtime_protocol::bounded_json_bytes(
                    &settings,
                    MAX_NATIVE_SETTINGS_BYTES,
                )
                .map_err(|_| "combined Claude inline settings exceeds native 2 MiB limit")?;
                secrets.claude_settings_argument = Some(
                    String::from_utf8(bytes)
                        .map_err(|_| "prepared Claude inline settings is not UTF-8")?,
                );
            }
            if manifest.settings_file.is_some() {
                let selected = manifest.settings_origin.as_ref().ok_or("selected Claude settings declaring origin is unrecorded; retain inputs and reprepare before dispatch")?;
                let destination = manifest.runtime_path(selected);
                if !inputs
                    .config_binds
                    .iter()
                    .any(|bind| Path::new(&bind.logical_destination) == destination)
                {
                    return Err("selected Claude settings has no accepted config bind".into());
                }
                secrets.claude_settings_argument = Some(
                    destination
                        .to_str()
                        .ok_or("selected Claude settings destination is not UTF-8")?
                        .into(),
                );
            }
            return Ok(BTreeMap::new());
        }
        if provider == "amplifier" {
            let manifest: freshell_platform::amplifier_inputs::AmplifierInputManifest =
                serde_json::from_slice(&metadata)
                    .map_err(|_| "prepared Amplifier discovery metadata invalid")?;
            manifest.validate().map_err(str::to_string)?;
            return Ok(BTreeMap::new());
        }
        let manifest: freshell_platform::codex_inputs::CodexInputManifest =
            serde_json::from_slice(&metadata)
                .map_err(|_| "prepared Codex discovery metadata invalid")?;
        manifest.validate().map_err(str::to_string)?;
        let mut generated = BTreeMap::new();
        generated.insert(
            "CODEX_HOME".into(),
            manifest
                .runtime_home()
                .to_str()
                .ok_or("native Codex home is not UTF-8")?
                .into(),
        );
        return Ok(generated);
    }
    let manifest: SourceManifest = serde_json::from_slice(&metadata)
        .map_err(|_| "prepared source manifest metadata invalid")?;
    if manifest.version != 1
        || manifest.sources.len() > 8192
        || manifest.files.len() > 128
        || manifest.frozen_inputs.len() > 128
    {
        return Err("prepared source metadata profile exceeded".into());
    }
    manifest.require_known_discovery_roles().map_err(|_| "prepared native discovery role is unrecorded; retain inputs and reprepare before dispatch".to_string())?;
    if frozen.iter().any(|(name, _)| {
        !manifest
            .frozen_inputs
            .iter()
            .any(|approved| approved == name)
    }) || manifest
        .frozen_inputs
        .iter()
        .any(|name| frozen.get(name).is_none())
    {
        return Err("configuration reference selection changed; frozen input binding is unavailable or changed; reprepare before dispatch".into());
    }
    let names = manifest
        .sources
        .iter()
        .flat_map(|source| source.referenced_variables.iter().cloned())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    freshell_platform::native_auth_exchange::validate_keys(&names).map_err(str::to_string)?;
    let auth = if let Some((_, raw)) = secrets
        .provider_files
        .iter()
        .find(|(relative, _)| *relative == ".local/share/opencode/auth.json")
    {
        let raw =
            std::str::from_utf8(raw).map_err(|_| "selected typed auth source is not UTF-8")?;
        freshell_platform::provider_environment_grants::resolve_opencode_auth_environment(
            raw, &names,
        )
        .map_err(|error| error.to_string())?
    } else {
        freshell_platform::native_auth_exchange::read_selected_native_auth(home, &names)
            .map_err(str::to_string)?
    };
    let plan = freshell_platform::opencode_config::OpencodeConfigPlan {
        sources: vec![],
        user_owns_freshell_mcp: manifest.user_owns_freshell_mcp,
        inline_prepared: manifest
            .sources
            .iter()
            .any(|source| source.lane == SourceLane::Inline),
    };
    let mut generated = BTreeMap::new();
    let mut budget = frozen.clone();
    if manifest.native_source_flags.len() > 3 {
        return Err("prepared native source selector profile exceeded".into());
    }
    for flag in &manifest.native_source_flags {
        let name = flag.kind.variable();
        let has_bind = inputs.config_binds.iter().any(|bind| {
            std::path::Path::new(&bind.logical_destination)
                == freshell_platform::opencode_config::lexical_path(std::path::Path::new(
                    &flag.runtime_destination,
                ))
        });
        let approved = if flag.kind
            == freshell_platform::opencode_recipe::NativeSourceFlagKind::Directory
        {
            flag.source_ordinal.is_none()
                && inputs.resource_mounts.iter().any(|mount| {
                    mount.logical_destination == flag.runtime_destination
                        && mount.kind == freshell_runtime_protocol::ProviderResourceKind::Directory
                })
        } else if let Some(ordinal) = flag.source_ordinal {
            manifest
                .sources
                .get(usize::from(ordinal))
                .is_some_and(|source| {
                    source.native_destination.as_deref() == Some(flag.runtime_destination.as_str())
                        && match flag.kind {
                            freshell_platform::opencode_recipe::NativeSourceFlagKind::Main => {
                                source.lane == SourceLane::Main
                            }
                            freshell_platform::opencode_recipe::NativeSourceFlagKind::Tui => {
                                source.lane == SourceLane::Tui
                            }
                            freshell_platform::opencode_recipe::NativeSourceFlagKind::Directory => {
                                false
                            }
                        }
                        && (source.original_form || has_bind)
                })
        } else {
            has_bind
        };
        if !approved || generated.contains_key(name) || secrets.environment.contains_key(name) {
            return Err("prepared native source selector has no approved config bind or collides with child input".into());
        }
        budget
            .insert(name.into(), flag.runtime_destination.clone())
            .map_err(|error| error.message)?;
        generated.insert(name.into(), flag.runtime_destination.clone());
    }
    for source in manifest.sources {
        // Each occurrence owns only this iteration's raw/expanded/output views.
        // Preserve native lane evaluation, but release those charges when the
        // iteration ends. Only returned child strings and their validation map
        // survive; the shared input profile bounds each map to 256 KiB.
        let retained_view_bytes = budget
            .iter()
            .map(|(_, value)| value.len())
            .chain(generated.values().map(String::len))
            .try_fold(0usize, |bytes, length| bytes.checked_add(length))
            .ok_or("source view profile overflow")?;
        let remaining =
            (freshell_platform::provider_input_profiles::MAX_SIMULTANEOUS_SOURCE_VIEW_BYTES
                as usize)
                .checked_sub(retained_view_bytes)
                .ok_or("source view profile overflow")?;
        // Raw is at most 16 MiB. The shared transformer checks its two live
        // effective views against 32 MiB before appending. Together with the
        // bounded retained maps, these fit the 64 MiB simultaneous profile.
        let raw = read_private(
            stage,
            &source.unexpanded_relative_path,
            remaining
                .min(freshell_platform::provider_input_profiles::MAX_SOURCE_VIEW_BYTES as usize),
        )?;
        let raw = String::from_utf8(raw).map_err(|_| "prepared source is not UTF-8")?;
        let recipe = GeneratedFileRecipe {
            generated_name: source.generated_name.clone().unwrap_or_default(),
            unexpanded_source: raw,
            declaring_config: source.logical_path,
            cwd: manifest.cwd.clone(),
            original_home: manifest.original_home.clone(),
            occurrences: source.occurrences,
        };
        let lookup = |name: &str| {
            if source.lane == SourceLane::Main {
                auth.get(name)
                    .map(String::as_str)
                    .or_else(|| secrets.environment.get(name).map(String::as_str))
                    .or_else(|| frozen.get(name))
                    .map(str::to_string)
            } else {
                secrets
                    .environment
                    .get(name)
                    .map(String::as_str)
                    .or_else(|| frozen.get(name))
                    .map(str::to_string)
            }
        };
        let value = if source.generated_name.is_some() {
            freshell_platform::opencode_recipe::evaluate(&recipe, &lookup)
        } else {
            freshell_platform::opencode_recipe::evaluate_document(&recipe, &lookup)
        }
        .map_err(str::to_string)?;
        if source.lane == SourceLane::Inline {
            let template = String::from_utf8(read_private(
                stage,
                &source.template_relative_path,
                64 * 1024,
            )?)
            .map_err(|_| "prepared inline source is not UTF-8")?;
            if source.template_sha256.as_deref()
                != Some(format!("{:x}", Sha256::digest(template.as_bytes())).as_str())
            {
                return Err("prepared inline template changed before dispatch; reprepare the source generation".into());
            }
            if generated.contains_key("OPENCODE_CONFIG_CONTENT")
                || secrets.environment.contains_key("OPENCODE_CONFIG_CONTENT")
            {
                return Err("prepared inline source collides with another child source".into());
            }
            budget
                .insert("OPENCODE_CONFIG_CONTENT".into(), template.clone())
                .map_err(|error| error.message)?;
            generated.insert("OPENCODE_CONFIG_CONTENT".into(), template);
        }
        if let Some(name) = source.generated_name {
            if secrets.environment.contains_key(&name)
                || auth.contains_key(&name)
                || frozen.get(&name).is_some()
                || generated.contains_key(&name)
            {
                return Err(
                    "generated source input collides with a child credential or source input"
                        .into(),
                );
            }
            budget
                .insert(name.clone(), value.clone())
                .map_err(|error| error.message)?;
            generated.insert(name, value);
        }
        if source.original_form {
            for name in source.path_variables {
                if let Some(value) = frozen.get(&name) {
                    generated.entry(name).or_insert_with(|| value.into());
                }
            }
        }
    }
    secrets.opencode_plan = Some(plan);
    Ok(generated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn provider_secret_private_reader_rejects_oversize_before_payload_read() {
        use std::io::Read;
        let owned = tempfile::tempdir().unwrap();
        let private = owned.path().join("metadata");
        let native = owned.path().join("native-history.jsonl");
        std::fs::write(&native, b"synthetic-native-store-preserved").unwrap();
        let old_access = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1);
        for limit in [
            freshell_runtime_protocol::MAX_CONTROL_FRAME_BYTES,
            freshell_platform::claude_inputs::MAX_NATIVE_SETTINGS_BYTES,
            64 * 1024 * 1024,
        ] {
            let mut file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(true)
                .open(&private)
                .unwrap();
            file.set_len(limit as u64).unwrap();
            let accepted = read_private(owned.path(), "metadata", limit).unwrap();
            assert_eq!(
                accepted.len(),
                limit,
                "inclusive physical file limit must remain supported"
            );
            drop(accepted);
            file.set_len(limit as u64 + 1).unwrap();
            file.set_times(std::fs::FileTimes::new().set_accessed(old_access))
                .unwrap();
            file.read_exact(&mut [0u8; 1]).unwrap();
            assert_ne!(
                std::fs::metadata(&private).unwrap().accessed().unwrap(),
                old_access,
                "fixture must report actual reads"
            );
            file.set_times(std::fs::FileTimes::new().set_accessed(old_access))
                .unwrap();
            assert!(read_private(owned.path(), "metadata", limit).is_err());
            assert_eq!(
                std::fs::metadata(&private).unwrap().accessed().unwrap(),
                old_access,
                "host must reject oversized private metadata before reading its payload"
            );
            assert_eq!(
                std::fs::read(&native).unwrap(),
                b"synthetic-native-store-preserved"
            );
        }
    }
    use freshell_platform::opencode_recipe::*;
    use freshell_runtime_protocol::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn provider_secret_repeated_native_source_views_release_live_storage_between_occurrences() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let stage = owned.path().join("stage");
        std::fs::create_dir(&home).unwrap();
        std::fs::create_dir_all(stage.join(".freshell/source-views")).unwrap();
        let limit = 16 * 1024 * 1024;
        // Native-valid source at the inclusive per-view limit. Padding remains
        // raw JSON whitespace, rather than an invalid synthetic schema field.
        let mut raw =
            r#"{"agent":{"liveCapacity":{"description":"native-source-nonce"}}}"#.to_string();
        raw.push_str(&" ".repeat(limit - raw.len()));
        assert_eq!(raw.len(), limit);
        let decoded: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            decoded["agent"]["liveCapacity"]["description"],
            "native-source-nonce"
        );
        let relative = ".freshell/source-views/source";
        std::fs::write(stage.join(relative), &raw).unwrap();
        let original_digest = Sha256::digest(raw.as_bytes());
        let sources = (0..8)
            .map(|index| SourceView {
                logical_path: home.join(format!("alias-{index}/opencode.jsonc")),
                discovery_role: DiscoveryRole::Global,
                native_destination: None,
                lane: if index == 7 {
                    SourceLane::Tui
                } else {
                    SourceLane::Main
                },
                unexpanded_relative_path: relative.into(),
                template_relative_path: relative.into(),
                template_sha256: Some(format!("{original_digest:x}")),
                generated_name: None,
                occurrences: vec![],
                referenced_variables: vec![],
                path_variables: vec![],
                original_form: true,
            })
            .collect();
        let mut manifest = SourceManifest {
            version: 1,
            cwd: home.clone(),
            original_home: home.clone(),
            global_config_root: None,
            sources,
            files: vec![],
            frozen_inputs: vec![],
            user_owns_freshell_mcp: false,
            native_source_flags: vec![],
            resource_roots: vec![],
            rebind_enabled: true,
            inline_edits: Default::default(),
        };
        let bytes = bounded_json_bytes(&manifest, 64 * 1024 * 1024).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        let generation = format!("grant-{}", uuid::Uuid::new_v4());
        let context: ProviderLaunchContext = serde_json::from_value(serde_json::json!({
            "preparation":{"opencode":{"project_config":[],"tui_config":null,"tui_source":null,"inline_config":false}},
            "mcpCapability":{"grantId":generation,"endpoint":"http://host.docker.internal:4000","providerRelativePath":".freshell/mcp-capability.json"},
            "preparedInputs":{"generationId":generation,"manifest":{"relativePath":".freshell/input-manifest.json","sha256":format!("{:x}",Sha256::digest(&bytes)),"sourceCount":0,"aliasCount":0,"recipeCount":0}}
        })).unwrap();
        let mut secrets = ResolvedProviderSecrets::default();
        let generated = prepare(Some(&context), &mut secrets, &ProviderPathInputs::default(), &stage, &home)
            .expect("128 MiB cumulative reads of eight 16 MiB occurrences fit the simultaneous view profile");
        assert!(
            generated.is_empty(),
            "direct native sources must not become child environment values"
        );
        assert!(secrets.opencode_plan.is_some());
        assert_eq!(
            Sha256::digest(std::fs::read(stage.join(relative)).unwrap()),
            original_digest
        );
        assert_eq!(
            std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
            bytes
        );
        // Real over-limit view fails before dispatch, without publishing a plan
        // or changing accepted native data and the generation manifest.
        std::fs::write(stage.join(relative), format!("{raw} ")).unwrap();
        let mut refused = ResolvedProviderSecrets::default();
        let error = prepare(
            Some(&context),
            &mut refused,
            &ProviderPathInputs::default(),
            &stage,
            &home,
        )
        .unwrap_err();
        assert!(error.contains("byte profile"), "{error}");
        assert!(refused.opencode_plan.is_none());
        assert_eq!(
            std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
            bytes
        );
        // A complete raw view can fit while its actual env expansion cannot.
        // Refuse that expansion before a plan becomes a dispatch target.
        let prefix = r#"{"agent":{"liveCapacity":{"description":"{env:VALUE}"#;
        let suffix = "\"}}}";
        let expansion_raw = format!(
            "{prefix}{}{suffix}",
            "x".repeat(limit - prefix.len() - suffix.len())
        );
        assert_eq!(expansion_raw.len(), limit);
        assert!(serde_json::from_str::<serde_json::Value>(&expansion_raw).is_ok());
        std::fs::write(stage.join(relative), &expansion_raw).unwrap();
        for source in &mut manifest.sources {
            source.referenced_variables = vec!["VALUE".into()];
        }
        let bytes = bounded_json_bytes(&manifest, 64 * 1024 * 1024).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        let mut context = context;
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        let mut refused = ResolvedProviderSecrets::default();
        refused
            .environment
            .insert("VALUE".into(), "v".repeat(64 * 1024));
        let error = prepare(
            Some(&context),
            &mut refused,
            &ProviderPathInputs::default(),
            &stage,
            &home,
        )
        .unwrap_err();
        assert!(error.contains("recipe profile limit"), "{error}");
        assert!(refused.opencode_plan.is_none());
        assert_eq!(
            std::fs::read_to_string(stage.join(relative)).unwrap(),
            expansion_raw
        );
        assert_eq!(
            std::fs::read(stage.join(".freshell/input-manifest.json")).unwrap(),
            bytes
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn provider_secret_actual_merged_profile_reaches_guarded_child() {
        const GENERATED: &str = "FRESHELL_CONFIG_REFERENCE_0";
        const RECEIPT: &str = "HOST_MERGED_PROFILE=";
        if std::env::var_os(GENERATED).is_some() {
            let received: BTreeMap<String, String> = std::env::vars().collect();
            ProviderPathInputs::new(received.clone()).unwrap();
            let parsed: serde_json::Value = serde_json::from_str(&received[GENERATED]).unwrap();
            assert!(parsed["value"]
                .as_str()
                .unwrap()
                .contains("{file:/home/freshell/provider/.freshell/references/0}"));
            let total: usize = received
                .iter()
                .map(|(name, value)| name.len() + value.len())
                .sum();
            println!(
                "{RECEIPT}{}",
                serde_json::json!({"names":received.len(),"total":total,"maxValue":received.values().map(String::len).max().unwrap()})
            );
            return;
        }
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        std::fs::create_dir(&home).unwrap();
        let destination = "/home/freshell/provider/.freshell/references/0";
        let total_value_limit = 256 * 1024 - 127 * (128 + 1920) - GENERATED.len();
        let mut prior = Vec::new();
        for (ordinal, frozen_count, input_bytes, generated_bytes, accepted) in [
            (0, 127, 1920, total_value_limit, true),
            (1, 127, 1920, total_value_limit + 1, false),
            (2, 128, 16, 128, false),
            (3, 1, 16, 64 * 1024, true),
            (4, 1, 16, 64 * 1024 + 1, false),
        ] {
            let stage = owned.path().join(format!("attempt-{ordinal}"));
            std::fs::create_dir_all(stage.join(".freshell/source-views")).unwrap();
            let controller = owned.path().join(format!("original-{ordinal}"));
            std::fs::create_dir(&controller).unwrap();
            std::fs::write(controller.join("rules"), b"PRIVATE_MERGED_PROFILE_PAYLOAD").unwrap();
            let input = format!(
                "{}{{file:rules}}",
                "x".repeat(input_bytes - "{file:rules}".len())
            );
            let frozen = ProviderPathInputs::new(
                (0..frozen_count)
                    .map(|index| (format!("N{index:0127}"), input.clone()))
                    .collect(),
            )
            .unwrap();
            let names = frozen
                .iter()
                .map(|(name, _)| name.to_owned())
                .collect::<Vec<_>>();
            let expanded = input.replace("{file:rules}", &format!("{{file:{destination}}}"));
            let minimum = serde_json::json!({"value":expanded}).to_string().len();
            let generated_raw = serde_json::json!({"value":format!("{{env:{}}}{}",names[0],"p".repeat(generated_bytes - minimum))}).to_string();
            let shared_raw = serde_json::Value::Object(
                names
                    .iter()
                    .enumerate()
                    .map(|(index, name)| {
                        (
                            format!("field-{index:03}"),
                            serde_json::Value::String(format!("{{env:{name}}}")),
                        )
                    })
                    .collect(),
            )
            .to_string();
            let approved = controller.join("rules");
            let occurrence = |index| ApprovedFileOccurrence {
                ordinal: index,
                approved_alias: approved.clone(),
                runtime_destination: destination.into(),
            };
            let sources = (0..3)
                .map(|index| {
                    let raw = if index == 0 {
                        &generated_raw
                    } else {
                        &shared_raw
                    };
                    let relative = format!(".freshell/source-views/source-{index}");
                    std::fs::write(stage.join(&relative), raw).unwrap();
                    SourceView {
                        logical_path: controller.join(if index == 0 {
                            "generated.json"
                        } else {
                            "shared.json"
                        }),
                        discovery_role: DiscoveryRole::Workspace,
                        native_destination: None,
                        lane: if index == 2 {
                            SourceLane::Tui
                        } else {
                            SourceLane::Main
                        },
                        unexpanded_relative_path: relative,
                        template_relative_path: format!(".freshell/templates/source-{index}"),
                        template_sha256: None,
                        generated_name: (index == 0).then(|| GENERATED.into()),
                        occurrences: if index == 0 {
                            vec![occurrence(0)]
                        } else {
                            (0..frozen_count).map(occurrence).collect()
                        },
                        referenced_variables: if index == 0 {
                            vec![names[0].clone()]
                        } else {
                            names.clone()
                        },
                        path_variables: if index == 0 {
                            vec![names[0].clone()]
                        } else {
                            names.clone()
                        },
                        original_form: index != 0,
                    }
                })
                .collect();
            let manifest = SourceManifest {
                version: 1,
                cwd: controller,
                original_home: home.clone(),
                global_config_root: None,
                sources,
                files: vec![SelectedSourceFile {
                    source_id: 0,
                    canonical_source: approved.clone(),
                }],
                frozen_inputs: names,
                user_owns_freshell_mcp: true,
                native_source_flags: vec![],
                resource_roots: vec![],
                rebind_enabled: true,
                inline_edits: Default::default(),
            };
            let bytes = bounded_json_bytes(&manifest, 64 * 1024 * 1024).unwrap();
            std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
            let generation = format!("grant-{}", uuid::Uuid::new_v4());
            let context:ProviderLaunchContext = serde_json::from_value(serde_json::json!({
                "preparation":{"opencode":{"project_config":[],"tui_config":null,"tui_source":null,"inline_config":false}},
                "mcpCapability":{"grantId":generation,"endpoint":"http://host.docker.internal:4000","providerRelativePath":".freshell/mcp-capability.json"},
                "preparedInputs":{"generationId":generation,"manifest":{"relativePath":".freshell/input-manifest.json","sha256":format!("{:x}",Sha256::digest(&bytes)),"sourceCount":1,"aliasCount":0,"recipeCount":1},
                    "indexedFiles":{"volumeName":indexed_provider_volume_name(&SoulId::new(),&generation),"aliases":[]}}
            })).unwrap();
            let mut secrets = ResolvedProviderSecrets::default();
            let result = prepare(Some(&context), &mut secrets, &frozen, &stage, &home);
            if accepted {
                let environment = result.unwrap();
                assert_eq!(environment.len(), frozen_count + 1);
                assert_eq!(environment[GENERATED].len(), generated_bytes);
                assert!(frozen
                    .iter()
                    .all(|(name, value)| environment.get(name).map(String::as_str) == Some(value)));
                let binary = std::env::current_exe().unwrap();
                let args: Vec<String> = vec!["--exact".into(),"provider_input_preparation::tests::provider_secret_actual_merged_profile_reaches_guarded_child".into(),"--nocapture".into()];
                let mut command = std::process::Command::new(binary);
                command.args(&args).env_clear().envs(&environment);
                freshell_platform::provider_exec::check_command(&command, false, &[]).unwrap();
                let output = command.output().unwrap();
                assert!(
                    output.status.success(),
                    "guarded merged-profile child failed"
                );
                let stdout = String::from_utf8(output.stdout).unwrap();
                let receipt: serde_json::Value = serde_json::from_str(
                    stdout
                        .lines()
                        .find_map(|line| line.split_once(RECEIPT).map(|(_, value)| value))
                        .unwrap(),
                )
                .unwrap();
                let total = environment
                    .iter()
                    .map(|(name, value)| name.len() + value.len())
                    .sum::<usize>();
                assert_eq!(
                    receipt,
                    serde_json::json!({"names":environment.len(),"total":total,"maxValue":environment.values().map(String::len).max().unwrap()})
                );
                println!("HOST_MERGED_PROFILE_QUALIFIED={receipt}");
                if ordinal == 0 {
                    assert_eq!(total, 256 * 1024);
                    prior = (0..3)
                        .map(|index| stage.join(format!(".freshell/source-views/source-{index}")))
                        .chain([stage.join(".freshell/input-manifest.json"), approved])
                        .map(|path| {
                            let bytes = std::fs::read(&path).unwrap();
                            (path, bytes)
                        })
                        .collect();
                }
            } else {
                let error = result.err().unwrap();
                assert!(error.contains("profile") || error.contains("64 KiB"));
                assert!(!error.contains("PRIVATE_MERGED_PROFILE_PAYLOAD"));
                assert!(secrets.opencode_plan.is_none());
                for (path, bytes) in &prior {
                    assert_eq!(std::fs::read(path).unwrap(), *bytes);
                }
            }
        }
    }

    #[tokio::test]
    async fn provider_secret_claude_final_source_gate_blocks_unrecorded_generation_and_keeps_private_inputs(
    ) {
        let owned = tempfile::tempdir().unwrap();
        std::fs::create_dir(owned.path().join(".freshell")).unwrap();
        let manifest = serde_json::json!({
            "version":1,"nativeSourceRuntime":"terminal",
            "originalHome":owned.path(),"cwd":owned.path(),"workspace":owned.path(),
            "settingSources":["local"],"pluginDirs":[],
        });
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(owned.path().join(".freshell/input-manifest.json"), &bytes).unwrap();
        let generation = format!("grant-{}", uuid::Uuid::new_v4());
        let context: ProviderLaunchContext = serde_json::from_value(serde_json::json!({
            "preparation":{"claude":{"mcp_args":[]}},
            "mcpCapability":{"grantId":generation,"endpoint":"http://host.docker.internal:4000",
                "providerRelativePath":".freshell/mcp-capability.json"},
            "preparedInputs":{"generationId":generation,"manifest":{
                "relativePath":".freshell/input-manifest.json","sha256":format!("{:x}",Sha256::digest(&bytes)),
                "sourceCount":0,"aliasCount":0,"recipeCount":0}}
        })).unwrap();
        let error = final_claude_source_request(Some(&context), owned.path(), owned.path(), owned.path(),
            freshell_platform::claude_inputs::NativeSourceRuntime::Terminal)
            .expect_err("a prepared Claude generation without actual source evidence must block before dispatch");
        assert!(error.contains("retain inputs and reprepare"), "{error}");
        let error = crate::claude_source_observation::verify_final(
            Some(&context),
            owned.path(),
            owned.path(),
            owned.path(),
            unsafe { libc::getuid() },
            unsafe { libc::getgid() },
            freshell_platform::claude_inputs::NativeSourceRuntime::Terminal,
        )
        .await
        .expect_err("the actual final host gate cannot bypass unrecorded native source evidence");
        assert_eq!(error.code, RuntimeErrorCode::HostUnreachable);
        assert!(
            error.message.contains("retain inputs and reprepare"),
            "{error:?}"
        );
        assert_eq!(
            std::fs::read(owned.path().join(".freshell/input-manifest.json")).unwrap(),
            bytes
        );
        assert!(final_claude_source_request(
            None,
            owned.path(),
            owned.path(),
            owned.path(),
            freshell_platform::claude_inputs::NativeSourceRuntime::Terminal
        )
        .unwrap()
        .is_none());
    }
    #[test]
    fn provider_secret_claude_final_source_request_keeps_enriched_origin_and_frozen_original_selectors(
    ) {
        use freshell_platform::claude_inputs::{
            observation::observe, AcceptedNativeSourcePlan, ClaudeInputManifest,
            ClaudeSettingSource, NativeSourceRuntime,
        };
        for runtime in [NativeSourceRuntime::Terminal, NativeSourceRuntime::Sdk] {
            let owned = tempfile::tempdir().unwrap();
            let original_home = owned.path().join("original-home");
            let home = owned.path().join("provider-home");
            let workspace = owned.path().join("workspace");
            let cwd = workspace.join("nested");
            let stage = owned.path().join("stage");
            for directory in [&original_home, &home, &cwd, &stage.join(".freshell")] {
                std::fs::create_dir_all(directory).unwrap();
            }
            let selected = original_home.join("selected.json");
            let selected_bytes = br#"{"env":{"SYNTHETIC_PRIVATE":"frozen-original-selector"}}"#;
            std::fs::write(&selected, selected_bytes).unwrap();
            let mut manifest = ClaudeInputManifest {
                version: 1,
                native_source_runtime: Some(runtime),
                original_home: original_home.clone(),
                cwd: cwd.clone(),
                workspace: workspace.clone(),
                config_root: None,
                settings_file: Some(selected.clone()),
                settings_origin: None,
                inline_settings_sha256: None,
                setting_sources: vec![ClaudeSettingSource::Local],
                plugin_dirs: vec![],
                accepted_native_plan: None,
            };
            let original = freshell_runtime_protocol::bounded_json_bytes(
                &manifest.original_selectors(),
                64 * 1024 * 1024,
            )
            .unwrap();
            let observed = observe(&cwd, &home, runtime, &manifest.setting_sources).unwrap();
            assert_eq!(observed.uid, unsafe { libc::getuid() });
            manifest.settings_origin = Some(std::fs::canonicalize(&selected).unwrap());
            manifest.accepted_native_plan = Some(AcceptedNativeSourcePlan {
                selector_manifest_sha256: format!("{:x}", Sha256::digest(original)),
                plan_revision: 0,
                observation: observed.clone(),
            });
            let bytes =
                freshell_runtime_protocol::bounded_json_bytes(&manifest, 64 * 1024 * 1024).unwrap();
            std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
            let generation = format!("grant-{}", uuid::Uuid::new_v4());
            let mut context: ProviderLaunchContext = serde_json::from_value(serde_json::json!({
                "preparation":{"claude":{"mcp_args":[]}},
                "mcpCapability":{"grantId":generation,"endpoint":"http://host.docker.internal:4000",
                    "providerRelativePath":".freshell/mcp-capability.json"},
                "preparedInputs":{"generationId":generation,"manifest":{
                    "relativePath":".freshell/input-manifest.json","sha256":format!("{:x}",Sha256::digest(&bytes)),
                    "sourceCount":0,"aliasCount":0,"recipeCount":0}}
            })).unwrap();
            std::fs::rename(&original_home, owned.path().join("preserved-original-home")).unwrap();
            let (request, expected) =
                final_claude_source_request(Some(&context), &stage, &cwd, &home, runtime)
                    .unwrap()
                    .expect("accepted selection does not rescan unavailable original sources");
            let actual = observe(
                &request.cwd,
                &request.home,
                request.native_source_runtime,
                &request.setting_sources,
            )
            .unwrap();
            expected.require_same_selection(&actual).unwrap();
            assert_eq!(expected, observed);
            assert!(final_claude_source_request(
                Some(&context),
                &stage,
                &workspace,
                &home,
                runtime
            )
            .is_err());
            // A new descriptor SHA cannot authorize changing frozen original selectors.
            manifest.cwd = workspace.clone();
            let changed =
                freshell_runtime_protocol::bounded_json_bytes(&manifest, 64 * 1024 * 1024).unwrap();
            std::fs::write(stage.join(".freshell/input-manifest.json"), &changed).unwrap();
            context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
                format!("{:x}", Sha256::digest(changed));
            let error = final_claude_source_request(Some(&context), &stage, &cwd, &home, runtime)
                .unwrap_err();
            assert!(error.contains("retain inputs and reprepare"));
            assert!(!error.contains("frozen-original-selector"));
            assert_eq!(
                std::fs::read(owned.path().join("preserved-original-home/selected.json")).unwrap(),
                selected_bytes
            );
        }
    }

    #[test]
    fn provider_secret_claude_inline_settings_consumes_accepted_private_source() {
        use freshell_platform::claude_inputs::{ClaudeInputManifest, INLINE_SETTINGS_SOURCE};
        let owned = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(owned.path().join(".freshell/source-views")).unwrap();
        let raw = br#"{"env":{"FLAG_NONCE":"inline-selected"},"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"echo configured"}]}]}}"#;
        std::fs::write(owned.path().join(INLINE_SETTINGS_SOURCE), raw).unwrap();
        let manifest = ClaudeInputManifest {
            version: 1,
            accepted_native_plan: None,
            native_source_runtime: Some(
                freshell_platform::claude_inputs::NativeSourceRuntime::Terminal,
            ),
            original_home: "/absent-home".into(),
            cwd: "/absent-cwd".into(),
            workspace: "/absent-cwd".into(),
            config_root: None,
            settings_file: None,
            settings_origin: None,
            inline_settings_sha256: Some(format!("{:x}", Sha256::digest(raw))),
            setting_sources: vec![],
            plugin_dirs: vec![],
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(owned.path().join(".freshell/input-manifest.json"), &bytes).unwrap();
        let capability = McpCapabilityReference {
            grant_id: format!("grant-{}", uuid::Uuid::new_v4()),
            endpoint: "http://host.docker.internal:4000".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude { mcp_args: vec![] },
            config: vec![],
            prepared_inputs: Some(PreparedProviderInputs {
                generation_id: capability.grant_id.clone(),
                initial_auth_reservation: None,
                manifest: ProviderInputManifestReference {
                    relative_path: ".freshell/input-manifest.json".into(),
                    sha256: format!("{:x}", Sha256::digest(&bytes)),
                    source_count: 0,
                    alias_count: 0,
                    recipe_count: 0,
                },
                config_binds: vec![],
                resource_mounts: vec![],
                indexed_files: None,
            }),
            mcp_capability: Some(capability),
        };
        let mut secrets = ResolvedProviderSecrets::default();
        prepare(
            Some(&context),
            &mut secrets,
            &ProviderPathInputs::default(),
            owned.path(),
            owned.path(),
        )
        .unwrap();
        let argument = secrets.claude_settings_argument.as_deref().expect("accepted inline settings must reach the native child argument without a guessed file origin");
        let output = std::process::Command::new("node").args(["-e", "const s=JSON.parse(process.argv[1]);process.stdout.write([s.env.FLAG_NONCE,s.hooks.SessionStart[0].hooks[0].command,s.hooks.SessionStart.length,s.hooks.Stop.length].join(':'))", argument]).output().unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"inline-selected:echo configured:2:1");
        assert!(!serde_json::to_string(&context)
            .unwrap()
            .contains("inline-selected"));
        assert!(secrets.environment.is_empty());
        std::fs::write(
            owned.path().join(INLINE_SETTINGS_SOURCE),
            b"{\"env\":{\"FLAG_NONCE\":\"changed-private-source\"}}",
        )
        .unwrap();
        let mut changed = ResolvedProviderSecrets::default();
        let error = prepare(
            Some(&context),
            &mut changed,
            &ProviderPathInputs::default(),
            owned.path(),
            owned.path(),
        )
        .err()
        .unwrap();
        assert!(error.contains("source changed"));
        assert!(!error.contains("changed-private-source"));
        assert!(changed.claude_settings_argument.is_none());
        std::fs::write(
            owned.path().join(INLINE_SETTINGS_SOURCE),
            vec![b' '; freshell_platform::claude_inputs::MAX_NATIVE_SETTINGS_BYTES + 1],
        )
        .unwrap();
        let mut oversized = ResolvedProviderSecrets::default();
        assert!(prepare(
            Some(&context),
            &mut oversized,
            &ProviderPathInputs::default(),
            owned.path(),
            owned.path()
        )
        .is_err());
        assert!(oversized.claude_settings_argument.is_none());
    }

    #[test]
    fn provider_secret_claude_prepared_manifest_validates_without_original_controller_tree() {
        let owned = tempfile::tempdir().unwrap();
        std::fs::create_dir(owned.path().join(".freshell")).unwrap();
        let manifest = freshell_platform::claude_inputs::ClaudeInputManifest {
            version: 1,
            accepted_native_plan: None,
            native_source_runtime: Some(
                freshell_platform::claude_inputs::NativeSourceRuntime::Terminal,
            ),
            original_home: "/absent-original-home".into(),
            cwd: "/absent-original-workspace".into(),
            workspace: "/absent-original-workspace".into(),
            config_root: None,
            settings_file: None,
            settings_origin: None,
            inline_settings_sha256: None,
            setting_sources: freshell_platform::claude_inputs::default_setting_sources(),
            plugin_dirs: vec!["/absent-original-plugin".into()],
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(owned.path().join(".freshell/input-manifest.json"), &bytes).unwrap();
        let capability = McpCapabilityReference {
            grant_id: format!("grant-{}", uuid::Uuid::new_v4()),
            endpoint: "http://host.docker.internal:4000".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let mut context = ProviderLaunchContext {
            preparation: ProviderPreparation::Claude { mcp_args: vec![] },
            config: vec![],
            prepared_inputs: Some(PreparedProviderInputs {
                generation_id: capability.grant_id.clone(),
                initial_auth_reservation: None,
                manifest: ProviderInputManifestReference {
                    relative_path: ".freshell/input-manifest.json".into(),
                    sha256: format!("{:x}", Sha256::digest(&bytes)),
                    source_count: 0,
                    alias_count: 0,
                    recipe_count: 0,
                },
                config_binds: vec![],
                resource_mounts: vec![],
                indexed_files: None,
            }),
            mcp_capability: Some(capability),
        };
        let mut secrets = ResolvedProviderSecrets::default();
        let generated=prepare(Some(&context),&mut secrets,&ProviderPathInputs::default(),owned.path(),owned.path())
            .expect("Claude source origins validate from accepted private metadata, without rescanning controller paths");
        assert!(generated.is_empty());
        assert!(
            secrets.opencode_plan.is_none(),
            "ordinary Claude cannot gain OpenCode source/auth semantics"
        );
        context
            .prepared_inputs
            .as_mut()
            .unwrap()
            .manifest
            .source_count = 1;
        assert!(
            prepare(
                Some(&context),
                &mut secrets,
                &ProviderPathInputs::default(),
                owned.path(),
                owned.path()
            )
            .is_err(),
            "foreign source recipes cannot enter ordinary Claude metadata"
        );
        context
            .prepared_inputs
            .as_mut()
            .unwrap()
            .manifest
            .source_count = 0;
        let mut selected = manifest;
        selected.settings_file = Some("/absent-original-home/selected-settings.json".into());
        let bytes = serde_json::to_vec(&selected).unwrap();
        std::fs::write(owned.path().join(".freshell/input-manifest.json"), &bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        let error = prepare(
            Some(&context),
            &mut secrets,
            &ProviderPathInputs::default(),
            owned.path(),
            owned.path(),
        )
        .err()
        .unwrap();
        assert!(error.contains("declaring origin is unrecorded"));
        assert!(error.contains("retain inputs"));
        assert!(secrets.claude_settings_argument.is_none());
        selected.settings_origin = Some("/absent-original-home/declaring-settings.json".into());
        let bytes = serde_json::to_vec(&selected).unwrap();
        std::fs::write(owned.path().join(".freshell/input-manifest.json"), &bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        context
            .prepared_inputs
            .as_mut()
            .unwrap()
            .config_binds
            .push(ProviderConfigBind {
                source_relative_path: ".freshell/templates/claude-0".into(),
                logical_destination: "/home/freshell/provider/declaring-settings.json".into(),
                effective_destination: "/home/freshell/provider/declaring-settings.json".into(),
            });
        std::fs::create_dir(owned.path().join(".freshell/templates")).unwrap();
        std::fs::write(owned.path().join(".freshell/templates/claude-0"), b"{}").unwrap();
        prepare(Some(&context), &mut secrets, &ProviderPathInputs::default(), owned.path(), owned.path()).expect("a recorded native declaring origin is consumed without reading the unavailable original controller tree");
        assert_eq!(
            secrets.claude_settings_argument.as_deref(),
            Some("/home/freshell/provider/declaring-settings.json")
        );
    }

    #[test]
    fn provider_secret_amplifier_prepared_manifest_validates_without_original_controller_tree() {
        let owned = tempfile::tempdir().unwrap();
        std::fs::create_dir(owned.path().join(".freshell")).unwrap();
        let manifest = freshell_platform::amplifier_inputs::AmplifierInputManifest {
            version: 1,
            original_home: "/absent-original-home".into(),
            cwd: "/absent-original-workspace".into(),
            workspace: "/absent-original-workspace".into(),
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(owned.path().join(".freshell/input-manifest.json"), &bytes).unwrap();
        let capability = McpCapabilityReference {
            grant_id: format!("grant-{}", uuid::Uuid::new_v4()),
            endpoint: "http://host.docker.internal:4000".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let mut context = ProviderLaunchContext {
            preparation: ProviderPreparation::Amplifier {
                bundle: "default".into(),
                resume_args: vec![],
            },
            config: vec![],
            prepared_inputs: Some(PreparedProviderInputs {
                generation_id: capability.grant_id.clone(),
                initial_auth_reservation: None,
                manifest: ProviderInputManifestReference {
                    relative_path: ".freshell/input-manifest.json".into(),
                    sha256: format!("{:x}", Sha256::digest(&bytes)),
                    source_count: 0,
                    alias_count: 0,
                    recipe_count: 0,
                },
                config_binds: vec![],
                resource_mounts: vec![],
                indexed_files: None,
            }),
            mcp_capability: Some(capability),
        };
        let mut secrets = ResolvedProviderSecrets::default();
        let generated=prepare(Some(&context),&mut secrets,&ProviderPathInputs::default(),owned.path(),owned.path())
            .expect("Amplifier source origins validate from accepted private metadata, without rescanning controller paths");
        assert!(generated.is_empty());
        assert!(
            secrets.opencode_plan.is_none(),
            "ordinary Amplifier cannot gain OpenCode source/auth semantics"
        );
        context
            .prepared_inputs
            .as_mut()
            .unwrap()
            .manifest
            .source_count = 1;
        assert!(
            prepare(
                Some(&context),
                &mut secrets,
                &ProviderPathInputs::default(),
                owned.path(),
                owned.path()
            )
            .is_err(),
            "foreign source recipes cannot enter ordinary Amplifier metadata"
        );
    }

    #[test]
    fn provider_secret_codex_prepared_manifest_retains_native_home_without_original_tree() {
        let owned = tempfile::tempdir().unwrap();
        std::fs::create_dir(owned.path().join(".freshell")).unwrap();
        let manifest = freshell_platform::codex_inputs::CodexInputManifest {
            version: 1,
            original_home: "/absent-original-home".into(),
            cwd: "/absent-original-workspace".into(),
            codex_home: "/absent-original-home/custom-codex".into(),
            named_profile: Some("selected".into()),
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(owned.path().join(".freshell/input-manifest.json"), &bytes).unwrap();
        let capability = McpCapabilityReference {
            grant_id: format!("grant-{}", uuid::Uuid::new_v4()),
            endpoint: "http://host.docker.internal:4000".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let context = ProviderLaunchContext {
            preparation: ProviderPreparation::Codex {
                tui_args: vec![],
                sidecar_args: vec![],
            },
            config: vec![],
            prepared_inputs: Some(PreparedProviderInputs {
                generation_id: capability.grant_id.clone(),
                initial_auth_reservation: None,
                manifest: ProviderInputManifestReference {
                    relative_path: ".freshell/input-manifest.json".into(),
                    sha256: format!("{:x}", Sha256::digest(&bytes)),
                    source_count: 0,
                    alias_count: 0,
                    recipe_count: 0,
                },
                config_binds: vec![],
                resource_mounts: vec![],
                indexed_files: None,
            }),
            mcp_capability: Some(capability),
        };
        let mut secrets = ResolvedProviderSecrets::default();
        let generated = prepare(
            Some(&context),
            &mut secrets,
            &ProviderPathInputs::default(),
            owned.path(),
            owned.path(),
        )
        .expect(
            "accepted native Codex inputs must validate without reading original controller paths",
        );
        assert_eq!(
            generated.get("CODEX_HOME").unwrap(),
            "/home/freshell/provider/.codex"
        );
        std::fs::write(
            owned.path().join(".freshell/input-manifest.json"),
            b"changed",
        )
        .unwrap();
        assert!(prepare(
            Some(&context),
            &mut secrets,
            &ProviderPathInputs::default(),
            owned.path(),
            owned.path()
        )
        .unwrap_err()
        .contains("changed"));
    }

    #[test]
    fn provider_secret_prepared_recipe_consumes_private_frozen_inputs_without_original_tree() {
        let owned = tempfile::tempdir().unwrap();
        let stage = owned.path().join("stage");
        let home = owned.path().join("home");
        std::fs::create_dir_all(stage.join(".freshell/source-views")).unwrap();
        std::fs::create_dir(&home).unwrap();
        let raw = r#"{"instructions":["{env:INSERT}"]}"#;
        std::fs::write(stage.join(".freshell/source-views/source-0"), raw).unwrap();
        let mut manifest = SourceManifest {
            resource_roots: vec![],
            version: 1,
            cwd: "/original-unavailable/project".into(),
            original_home: "/original-unavailable/home".into(),
            global_config_root: None,
            sources: vec![SourceView {
                discovery_role: DiscoveryRole::Workspace,
                logical_path: "/original-unavailable/project/opencode.json".into(),
                native_destination: Some("/original-unavailable/project/opencode.json".into()),
                lane: SourceLane::Main,
                unexpanded_relative_path: ".freshell/source-views/source-0".into(),
                template_relative_path: ".freshell/templates/source-0".into(),
                template_sha256: None,
                generated_name: Some("FRESHELL_CONFIG_REFERENCE_0".into()),
                occurrences: vec![ApprovedFileOccurrence {
                    ordinal: 0,
                    approved_alias: "/original-unavailable/payload/rules".into(),
                    runtime_destination: "/home/freshell/provider/.freshell/references/0".into(),
                }],
                referenced_variables: vec!["INSERT".into()],
                path_variables: vec!["INSERT".into()],
                original_form: false,
            }],
            frozen_inputs: vec!["INSERT".into()],
            user_owns_freshell_mcp: true,
            inline_edits: Default::default(),
            rebind_enabled: true,
            native_source_flags: vec![NativeSourceFlag {
                kind: NativeSourceFlagKind::Main,
                source_ordinal: Some(0),
                runtime_destination: "/original-unavailable/project/opencode.json".into(),
            }],
            files: vec![SelectedSourceFile {
                source_id: 0,
                canonical_source: "/original-unavailable/payload/rules".into(),
            }],
        };
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        let capability = McpCapabilityReference {
            grant_id: format!("grant-{}", uuid::Uuid::new_v4()),
            endpoint: "http://host.docker.internal:4000".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let mut context = ProviderLaunchContext {
            prepared_inputs: Some(PreparedProviderInputs {
                generation_id: capability.grant_id.clone(),
                initial_auth_reservation: None,
                manifest: ProviderInputManifestReference {
                    relative_path: ".freshell/input-manifest.json".into(),
                    sha256: format!("{:x}", Sha256::digest(&bytes)),
                    source_count: 1,
                    alias_count: 0,
                    recipe_count: 1,
                },
                config_binds: vec![ProviderConfigBind {
                    source_relative_path: ".freshell/templates/source-0".into(),
                    logical_destination: "/original-unavailable/project/opencode.json".into(),
                    effective_destination: "/original-unavailable/project/opencode.json".into(),
                }],
                resource_mounts: vec![],
                indexed_files: Some(IndexedProviderFiles {
                    volume_name: indexed_provider_volume_name(&SoulId::new(), &capability.grant_id),
                    aliases: vec![],
                }),
            }),
            preparation: ProviderPreparation::Opencode {
                project_config: vec![],
                tui_config: None,
                tui_source: None,
                inline_config: false,
            },
            mcp_capability: Some(capability),
            config: vec![],
        };
        let frozen = ProviderPathInputs::new(BTreeMap::from([(
            "INSERT".into(),
            "PRIVATE_PREFIX{file:/original-unavailable/payload/rules}PRIVATE_SUFFIX".into(),
        )]))
        .unwrap();
        let mut secrets = ResolvedProviderSecrets::default();
        let generated = prepare(Some(&context), &mut secrets, &frozen, &stage, &home).unwrap();
        assert!(secrets.opencode_plan.is_some(), "the accepted source plan must reach provider preparation without rescanning mounted templates");
        assert!(
            secrets
                .opencode_plan
                .as_ref()
                .unwrap()
                .user_owns_freshell_mcp
        );
        let value=generated.get("FRESHELL_CONFIG_REFERENCE_0").expect("host must generate the selected native child source from private path inputs before dispatch");
        let expected = r#"{"instructions":["PRIVATE_PREFIX{file:/home/freshell/provider/.freshell/references/0}PRIVATE_SUFFIX"]}"#;
        assert_eq!(value, expected);
        assert_eq!(generated.get("OPENCODE_CONFIG").map(String::as_str),
            Some("/original-unavailable/project/opencode.json"),
            "an explicitly selected native source must be delivered to the actual child environment");
        assert!(!generated.contains_key("INSERT"),"independent generated recipes do not forward an original ambient variable into the native child");
        let current_bytes = serde_json::to_vec(&manifest).unwrap();
        let mut legacy: serde_json::Value = serde_json::from_slice(&current_bytes).unwrap();
        legacy["sources"][0]
            .as_object_mut()
            .unwrap()
            .remove("discoveryRole");
        let bytes = serde_json::to_vec(&legacy).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        let error = prepare(Some(&context), &mut secrets, &frozen, &stage, &home)
            .err()
            .unwrap_or_default();
        assert!(
            error.contains("discovery role"),
            "a role-less prepared source must block before the execution grant is consumed"
        );
        std::fs::write(stage.join(".freshell/input-manifest.json"), &current_bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&current_bytes));
        // Original-form shared configurations have approved native source
        // identity but deliberately no replacement config bind.
        manifest.sources[0].original_form = true;
        manifest.sources[0].generated_name = None;
        let binds = std::mem::take(&mut context.prepared_inputs.as_mut().unwrap().config_binds);
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        let original = prepare(Some(&context), &mut secrets, &frozen, &stage, &home)
            .expect("native selection of an approved original-form source cannot require a replacement bind");
        assert_eq!(
            original.get("OPENCODE_CONFIG").map(String::as_str),
            Some("/original-unavailable/project/opencode.json")
        );
        let approved_flag = manifest.native_source_flags[0].clone();
        for invalid in [0, 1, 2] {
            manifest.native_source_flags[0] = approved_flag.clone();
            match invalid {
                0 => {
                    manifest.native_source_flags[0].runtime_destination =
                        "/unapproved/source.json".into()
                }
                1 => manifest.native_source_flags[0].source_ordinal = Some(42),
                _ => manifest.native_source_flags[0].kind = NativeSourceFlagKind::Tui,
            }
            let bytes = serde_json::to_vec(&manifest).unwrap();
            std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
            context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
                format!("{:x}", Sha256::digest(&bytes));
            let error = prepare(Some(&context), &mut secrets, &frozen, &stage, &home).unwrap_err();
            assert!(!error.contains("/unapproved/source.json"));
        }
        manifest.native_source_flags[0] = approved_flag;
        manifest.sources[0].original_form = false;
        manifest.sources[0].generated_name = Some("FRESHELL_CONFIG_REFERENCE_0".into());
        context.prepared_inputs.as_mut().unwrap().config_binds = binds;
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        std::fs::create_dir_all(stage.join(".freshell/templates")).unwrap();
        let inline_template = "{env:FRESHELL_CONFIG_REFERENCE_0}";
        std::fs::write(stage.join(".freshell/templates/source-0"), inline_template).unwrap();
        manifest.sources[0].lane = SourceLane::Inline;
        manifest.sources[0].template_sha256 =
            Some(format!("{:x}", Sha256::digest(inline_template.as_bytes())));
        let native_flags = std::mem::take(&mut manifest.native_source_flags);
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        let inline = prepare(Some(&context), &mut secrets, &frozen, &stage, &home).unwrap();
        assert_eq!(
            inline.get("OPENCODE_CONFIG_CONTENT").map(String::as_str),
            Some(inline_template)
        );
        assert!(secrets.opencode_plan.as_ref().unwrap().inline_prepared);
        std::fs::write(
            stage.join(".freshell/templates/source-0"),
            r#"{"instructions":["{file:/unapproved/private-file}"]}"#,
        )
        .unwrap();
        assert!(prepare(Some(&context), &mut secrets, &frozen, &stage, &home).is_err(), "changed inline template must fail before an unapproved file can reach the native child");
        manifest.sources[0].lane = SourceLane::Main;
        manifest.sources[0].template_sha256 = None;
        manifest.native_source_flags = native_flags;
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        let changed = ProviderPathInputs::new(BTreeMap::from([(
            "INSERT".into(),
            "{file:/different-unapproved/rules}".into(),
        )]))
        .unwrap();
        assert!(prepare(Some(&context),&mut secrets,&changed,&stage,&home).is_err(),"changed lexical selection must fail without canonicalizing or reading an unavailable original tree");
        assert_eq!(
            std::fs::read_to_string(stage.join(".freshell/source-views/source-0")).unwrap(),
            raw
        );
        // Direct sources are filesystem documents, not generated child env values.
        // A complete accepted file reference remains valid in a source above 64 KiB.
        let large_raw = format!("{}{}", " ".repeat(128 * 1024), raw);
        std::fs::write(stage.join(".freshell/source-views/source-0"), &large_raw).unwrap();
        manifest.sources[0].generated_name = None;
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        let generated = prepare(Some(&context), &mut secrets, &frozen, &stage, &home)
            .expect("direct source must use the 16 MiB document profile");
        assert_eq!(generated.len(), 1);
        assert!(generated.contains_key("OPENCODE_CONFIG"));
        assert_eq!(
            std::fs::read(stage.join(".freshell/source-views/source-0")).unwrap(),
            large_raw.as_bytes()
        );
        let document_limit = 16 * 1024 * 1024;
        let occurrences = std::mem::take(&mut manifest.sources[0].occurrences);
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        let at_limit = format!("{}{{}}", " ".repeat(document_limit - 2));
        std::fs::write(stage.join(".freshell/source-views/source-0"), &at_limit).unwrap();
        assert!(prepare(Some(&context), &mut secrets, &frozen, &stage, &home).is_ok());
        std::fs::write(
            stage.join(".freshell/source-views/source-0"),
            format!(" {at_limit}"),
        )
        .unwrap();
        assert!(
            prepare(Some(&context), &mut secrets, &frozen, &stage, &home).is_err(),
            "direct source growth above the 16 MiB profile must fail before dispatch"
        );
        std::fs::write(stage.join(".freshell/source-views/source-0"), &large_raw).unwrap();

        manifest.sources[0].occurrences = occurrences;
        manifest.sources[0].generated_name = Some("FRESHELL_CONFIG_REFERENCE_0".into());
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        assert!(
            prepare(Some(&context), &mut secrets, &frozen, &stage, &home)
                .unwrap_err()
                .contains("64 KiB"),
            "generated child values retain the declared stricter limit"
        );
        manifest.native_source_flags[0].runtime_destination =
            "/unapproved/native/config.json".into();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        std::fs::write(stage.join(".freshell/input-manifest.json"), &bytes).unwrap();
        context.prepared_inputs.as_mut().unwrap().manifest.sha256 =
            format!("{:x}", Sha256::digest(&bytes));
        let error = prepare(Some(&context), &mut secrets, &frozen, &stage, &home).unwrap_err();
        assert!(error.contains("approved config bind"));
        assert!(!error.contains("/unapproved/native/config.json"));
    }
}
