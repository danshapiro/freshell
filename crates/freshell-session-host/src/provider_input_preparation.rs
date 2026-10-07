//! Private prepared-source validation before an execution grant is consumed.
use crate::provider_secret_resolution::ResolvedProviderSecrets;
use freshell_runtime_protocol::{ProviderLaunchContext, ProviderPathInputs};
use std::{collections::BTreeMap, path::Path};

fn read_private(root: &Path, relative: &str, limit: usize) -> Result<Vec<u8>, String> {
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
        || std::fs::canonicalize(&path).map_err(|_| "prepared private source unavailable")? != path
    {
        return Err("prepared private source must be a physical stage file".into());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| "prepared private source unreadable")?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "prepared private source read failed")?;
    if bytes.len() > limit {
        return Err("prepared source-view or filesystem metadata profile exceeded".into());
    }
    Ok(bytes)
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
        .validate("opencode")
        .map_err(|error| error.message)?;
    let metadata = read_private(stage, &inputs.manifest.relative_path, 64 * 1024 * 1024)?;
    if format!("{:x}", Sha256::digest(&metadata)) != inputs.manifest.sha256 {
        return Err("prepared source manifest changed before dispatch".into());
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
    let mut views = 0usize;
    for source in manifest.sources {
        let remaining = (64 * 1024 * 1024usize)
            .checked_sub(views)
            .ok_or("source view profile overflow")?;
        let raw = read_private(
            stage,
            &source.unexpanded_relative_path,
            remaining.min(16 * 1024 * 1024),
        )?;
        views = views
            .checked_add(raw.len())
            .ok_or("source view profile overflow")?;
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
    use freshell_platform::opencode_recipe::*;
    use freshell_runtime_protocol::*;
    use sha2::{Digest, Sha256};
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
