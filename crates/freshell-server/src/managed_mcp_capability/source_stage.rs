//! Stage source views in the grant's private filesystem before publication.
use super::{private_directory, write_private_bytes};
use crate::managed_provider_references::sources::{PlannedSourceOccurrence, SourceLane};
use freshell_platform::{
    opencode_recipe::{SelectedSourceFile, SourceManifest, SourceView},
    provider_input_profiles::MAX_SOURCE_VIEW_BYTES,
};
use std::{collections::BTreeMap, path::Path};

#[cfg(test)]
mod configured_resource_tests {
    use super::*;
    use crate::managed_provider_references::sources::*;
    use freshell_platform::provider_environment::{copy_environment, CopySelection};

    fn execute_selected_resource_with_path(
        path: &Path,
        path_prefix: Option<&Path>,
    ) -> std::io::Result<std::process::Output> {
        let inherited_path = std::env::var_os("PATH").unwrap_or_default();
        let search_path = if let Some(prefix) = path_prefix {
            let paths = std::iter::once(prefix.to_owned())
                .chain(std::env::split_paths(&inherited_path))
                .collect::<Vec<_>>();
            std::env::join_paths(paths).expect("the test PATH entries must be valid")
        } else {
            inherited_path
        };
        let mut command = std::process::Command::new(path);
        command.env_clear().env("PATH", search_path);
        // Retain this consumer's isolated environment while retrying a brief
        // executable-copy race. A shebang's `/usr/bin/env` can report ETXTBSY
        // in stderr after the script process itself has already started.
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(500);
        loop {
            match command.output() {
                Err(error)
                    if error.raw_os_error() == Some(libc::ETXTBSY)
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                Ok(output)
                    if !output.status.success()
                        && output
                            .stderr
                            .windows(b"Text file busy".len())
                            .any(|window| window == b"Text file busy")
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
                result => return result,
            }
        }
    }

    fn execute_selected_resource(path: &Path) -> std::io::Result<std::process::Output> {
        execute_selected_resource_with_path(path, None)
    }

    fn copy_selected_units_through_provider(
        owned_root: &Path,
        units: &[(
            std::path::PathBuf,
            freshell_runtime_protocol::ProviderResourceMount,
        )],
    ) -> std::path::PathBuf {
        let stage = owned_root.join("stage");
        let stage_selections = units
            .iter()
            .map(|(source, mount)| CopySelection {
                source: source.clone(),
                destination_relative: mount.stage_relative_path.clone().into(),
            })
            .collect::<Vec<_>>();
        copy_environment(&stage_selections, &stage, &[], Default::default()).unwrap();

        let host = owned_root.join("host");
        let host_selections = units
            .iter()
            .map(|(_, mount)| CopySelection {
                source: stage.join(&mount.stage_relative_path),
                destination_relative: mount.provider_relative_path.clone().into(),
            })
            .collect::<Vec<_>>();
        copy_environment(&host_selections, &host, &[], Default::default()).unwrap();

        let provider = owned_root.join("provider");
        let provider_selections = units
            .iter()
            .map(|(_, mount)| CopySelection {
                source: host.join(&mount.provider_relative_path),
                destination_relative: Path::new(&mount.effective_destination)
                    .strip_prefix(owned_root)
                    .map(Path::to_path_buf)
                    .or_else(|_| {
                        Path::new(&mount.effective_destination)
                            .strip_prefix("/home/freshell/provider")
                            .map(|relative| Path::new(".provider-home").join(relative))
                    })
                    .expect("test provider destinations must map into the temporary root"),
            })
            .collect::<Vec<_>>();
        copy_environment(&provider_selections, &provider, &[], Default::default()).unwrap();
        provider
    }

    fn plan_and_stage_direct_mcp_command(
        owned_root: &Path,
        home: &Path,
        workspace: &Path,
        command: &Path,
    ) -> (Vec<PlannedSourceOccurrence>, std::path::PathBuf) {
        plan_and_stage_mcp_command_for_resource(
            owned_root,
            home,
            workspace,
            &[command.to_string_lossy().into_owned()],
            command,
        )
    }

    fn plan_and_stage_mcp_command_for_resource(
        owned_root: &Path,
        home: &Path,
        workspace: &Path,
        command: &[String],
        selected_resource: &Path,
    ) -> (Vec<PlannedSourceOccurrence>, std::path::PathBuf) {
        plan_and_stage_mcp_command_for_resource_with_cwd(
            owned_root,
            home,
            workspace,
            command,
            selected_resource,
            None,
        )
    }

    fn plan_and_stage_mcp_command_for_resource_with_cwd(
        owned_root: &Path,
        home: &Path,
        workspace: &Path,
        command: &[String],
        selected_resource: &Path,
        mcp_cwd: Option<&Path>,
    ) -> (Vec<PlannedSourceOccurrence>, std::path::PathBuf) {
        let config = workspace.join("opencode.json");
        let mut mcp_entry = serde_json::json!({
            "type": "local",
            "command": command,
        });
        if let Some(mcp_cwd) = mcp_cwd {
            mcp_entry["cwd"] = serde_json::json!(mcp_cwd.to_string_lossy());
        }
        std::fs::write(
            &config,
            serde_json::json!({ "mcp": { "direct": mcp_entry } }).to_string(),
        )
        .unwrap();
        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            workspace,
            home,
            &|_, _, _| None,
        )
        .unwrap();
        let units =
            resource_units(home, &home.join(".config/opencode"), workspace, &plan, None).unwrap();
        let selected_resource = selected_resource.canonicalize().unwrap();
        let effective_destination = units
            .iter()
            .find(|(source, _)| {
                source == &selected_resource
                    || (source.is_dir() && selected_resource.starts_with(source))
            })
            .map(|(source, mount)| {
                Path::new(&mount.effective_destination)
                    .join(selected_resource.strip_prefix(source).unwrap())
            })
            .expect("the selected MCP script must be in the resource plan");
        let effective_destination = effective_destination.as_path();
        let provider_relative = effective_destination
            .strip_prefix(owned_root)
            .map(Path::to_path_buf)
            .or_else(|_| {
                effective_destination
                    .strip_prefix("/home/freshell/provider")
                    .map(|relative| Path::new(".provider-home").join(relative))
            })
            .expect("the test provider destination must map into the temporary root");
        let provider = copy_selected_units_through_provider(owned_root, &units);
        (plan, provider.join(provider_relative))
    }

    fn execute_with_home_hidden(
        owned_root: &Path,
        home: &Path,
        provider_command: &Path,
    ) -> std::process::Output {
        execute_with_home_hidden_using_path(owned_root, home, provider_command, None)
    }

    fn execute_with_home_hidden_using_path(
        owned_root: &Path,
        home: &Path,
        provider_command: &Path,
        path_prefix: Option<&Path>,
    ) -> std::process::Output {
        let hidden_home = owned_root.join("home-hidden");
        std::fs::rename(home, &hidden_home).unwrap();
        let output = execute_selected_resource_with_path(provider_command, path_prefix);
        std::fs::rename(&hidden_home, home).unwrap();
        output.unwrap()
    }

    fn execute_node_with_home_hidden(
        owned_root: &Path,
        home: &Path,
        provider_script: &Path,
    ) -> std::process::Output {
        let hidden_home = owned_root.join("home-hidden");
        std::fs::rename(home, &hidden_home).unwrap();
        let output = std::process::Command::new("node")
            .arg(provider_script)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output();
        std::fs::rename(&hidden_home, home).unwrap();
        output.unwrap()
    }

    fn execute_node_command_with_home_hidden(
        owned_root: &Path,
        home: &Path,
        arguments: &[String],
    ) -> std::process::Output {
        let hidden_home = owned_root.join("home-hidden");
        std::fs::rename(home, &hidden_home).unwrap();
        let output = std::process::Command::new("node")
            .args(arguments)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output();
        std::fs::rename(&hidden_home, home).unwrap();
        output.unwrap()
    }

    #[test]
    fn managed_provider_keeps_external_indexed_payloads_out_of_persistent_generation() {
        fn tree_contains_bytes(path: &Path, expected: &[u8]) -> bool {
            std::fs::read_dir(path).unwrap().any(|entry| {
                let entry = entry.unwrap();
                let metadata = entry.metadata().unwrap();
                if metadata.is_dir() {
                    tree_contains_bytes(&entry.path(), expected)
                } else {
                    std::fs::read(entry.path())
                        .unwrap()
                        .windows(expected.len())
                        .any(|window| window == expected)
                }
            })
        }

        use crate::managed_mcp_capability::OpencodeEphemeralInput;
        use crate::managed_provider_references::sources::{
            plan_opencode_sources, DiscoveryRole, SourceOccurrence,
        };

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let external = owned.path().join("external");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&external).unwrap();
        let selected = external.join("absolute-rule.txt");
        std::fs::write(&selected, "PRIVATE_CONFIG_REFERENCE_CONTENT").unwrap();
        let config = home.join("opencode.json");
        let raw = serde_json::json!({"agent":{"fixture":{"prompt":format!("{{file:{}}}", selected.display())}}}).to_string();
        std::fs::write(&config, &raw).unwrap();
        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config.clone(),
                lane: SourceLane::Main,
                role: DiscoveryRole::Home,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        let stage_root = owned.path().join("provider-generation");
        std::fs::create_dir(&stage_root).unwrap();

        stage(
            &stage_root,
            &home,
            &workspace,
            &plan,
            OpencodeEphemeralInput::default(),
        )
        .unwrap();

        assert!(
            selected.is_file(),
            "the durable grant remains a path reference"
        );
        assert!(
            !stage_root.join(".freshell/indexed-source-files").exists(),
            "referenced file contents must flow through the existing tmpfs publisher, not persist in the provider generation"
        );
        assert!(
            !tree_contains_bytes(&stage_root, b"PRIVATE_CONFIG_REFERENCE_CONTENT"),
            "referenced bytes must not be copied elsewhere in the persistent provider generation"
        );

        std::fs::write(stage_root.join(".freshell/resource-mounts.json"), b"[]").unwrap();
        let secret_references = [freshell_runtime_protocol::ProviderSecretReference {
            source_path: selected.display().to_string(),
            profile: freshell_runtime_protocol::ProviderSecretProfile::OpencodeConfigurationFile,
            provider_relative_path: Some(".freshell/references/0".into()),
        }];
        let capability = freshell_runtime_protocol::McpCapabilityReference {
            grant_id: "grant-indexed-source".into(),
            endpoint: "http://host.docker.internal:3344".into(),
            provider_relative_path: ".freshell/mcp-capability.json".into(),
            host_gateway_address: None,
        };
        let prepared = describe(
            DescriptionRoots {
                root: &stage_root,
                home: &home,
                config_root: None,
                workspace: &workspace,
            },
            &plan,
            &freshell_runtime_protocol::SoulId::parse("soul-indexed-source").unwrap(),
            &capability,
            None,
            &secret_references,
        )
        .unwrap();
        prepared.validate_references(&secret_references).unwrap();
        assert!(prepared
            .indexed_files
            .as_ref()
            .unwrap()
            .staged_source_paths
            .is_none());
    }

    #[test]
    fn managed_provider_duplicate_resource_members_select_only_native_winners_after_both_copies() {
        use std::os::unix::fs::PermissionsExt;
        let owned = match std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR") {
            Some(root) => tempfile::tempdir_in(root).unwrap(),
            None => tempfile::tempdir().unwrap(),
        };
        let home = owned.path().join("home");
        let cwd = owned.path().join("workspace");
        let selected = owned.path().join("external/selected");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&cwd).unwrap();
        std::fs::create_dir_all(selected.join("node_modules/dependency")).unwrap();
        std::fs::write(
            selected.join("node_modules/dependency/index.js"),
            "module.exports='winning-dependency';",
        )
        .unwrap();
        std::fs::write(selected.join("resource"), "winning-resource").unwrap();
        std::fs::write(
            selected.join("SKILL.md"),
            "---\nname: winning\ndescription: winning skill\n---\nExecute run.\n",
        )
        .unwrap();
        std::fs::write(selected.join("run"), "#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');process.stdout.write(fs.readFileSync(path.join(__dirname,'resource'),'utf8')+':'+require('dependency'));").unwrap();
        std::fs::set_permissions(selected.join("run"), std::fs::Permissions::from_mode(0o755))
            .unwrap();
        let instruction = owned.path().join("external/selected.md");
        std::fs::write(&instruction, "winning-instruction").unwrap();
        let config = home.join("opencode.jsonc");
        let plugin =
            serde_json::to_string(&format!("file://{}", selected.join("run").display())).unwrap();
        let instruction_json = serde_json::to_string(&instruction).unwrap();
        let skills_json = serde_json::to_string(&selected).unwrap();
        let obsolete = owned.path().join("obsolete-missing");
        let obsolete_json = serde_json::to_string(&obsolete).unwrap();
        let cases = [
            format!(
                r#"{{"plugin":[{obsolete_json}],"plu\u0067in":[[{plugin},{{"instructions":["/unselected-options"]}}]]}}"#
            ),
            format!(
                r#"{{"instructions":[{obsolete_json}],/* final wins */"\u0069\u006e\u0073\u0074\u0072\u0075\u0063\u0074\u0069\u006f\u006e\u0073":[{instruction_json}]}}"#
            ),
            format!(
                r#"{{"skills":{{"paths":[{obsolete_json}]}},"skills":{{"paths":[{skills_json}]}}}}"#
            ),
            format!(r#"{{"skills":{{"paths":[{obsolete_json}],"pa\u0074hs":[{skills_json}]}}}}"#),
            format!(
                r#"{{"mcp":{{"same":{{"type":"local","cwd":{obsolete_json}}},"sa\u006de":{{"type":"local","cwd":{skills_json},"command":["node","run"]}}}}}}"#
            ),
        ];
        for (index, raw) in cases.iter().enumerate() {
            std::fs::write(&config, raw).unwrap();
            let plan = plan_opencode_sources(
                vec![SourceOccurrence {
                    logical_path: config.clone(),
                    canonical_source: config.clone(),
                    lane: SourceLane::Main,
                    role: DiscoveryRole::Home,
                }],
                &cwd,
                &home,
                &|_, _, _| None,
            )
            .unwrap_or_else(|e| {
                panic!(
                    "native winning member must discard obsolete target: {} {}",
                    e.field, e.cause
                )
            });
            assert_eq!(plan[0].configured_resources.len(), 1);
            assert!(!plan[0].configured_resources.contains(&obsolete));
            let units =
                resource_units(&home, &home.join(".config/opencode"), &cwd, &plan, None).unwrap();
            let stage = owned.path().join(format!("stage-{index}"));
            let host = owned.path().join(format!("host-{index}"));
            copy_environment(
                &units
                    .iter()
                    .map(|(source, mount)| CopySelection {
                        source: source.clone(),
                        destination_relative: mount.stage_relative_path.clone().into(),
                    })
                    .collect::<Vec<_>>(),
                &stage,
                &[],
                Default::default(),
            )
            .unwrap();
            copy_environment(
                &units
                    .iter()
                    .map(|(_, mount)| CopySelection {
                        source: stage.join(&mount.stage_relative_path),
                        destination_relative: mount.provider_relative_path.clone().into(),
                    })
                    .collect::<Vec<_>>(),
                &host,
                &[],
                Default::default(),
            )
            .unwrap();
            let unit = units
                .iter()
                .find(|(source, _)| source == if index == 1 { &instruction } else { &selected })
                .unwrap();
            let projected = host.join(&unit.1.provider_relative_path);
            let hidden = owned.path().join("hidden-original");
            std::fs::rename(owned.path().join("external"), &hidden).unwrap();
            if index == 1 {
                assert_eq!(std::fs::read(&projected).unwrap(), b"winning-instruction");
            } else {
                // A concurrent fork can retain this owned copy's writer until
                // exec closes it. Exercise that exact transient spawn error.
                let writer = std::fs::OpenOptions::new()
                    .write(true)
                    .open(projected.join("run"))
                    .unwrap();
                let release = std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                    drop(writer);
                });
                let result = execute_selected_resource(&projected.join("run"));
                release.join().unwrap();
                let output = result.unwrap();
                assert!(
                    output.status.success(),
                    "winning resource/dependency executable failed: {output:?}"
                );
                assert_eq!(output.stdout, b"winning-resource:winning-dependency");
                assert!(std::fs::read_to_string(projected.join("SKILL.md"))
                    .unwrap()
                    .contains("name: winning"));
                if index == 0 {
                    let writer = std::fs::OpenOptions::new()
                        .write(true)
                        .open(projected.join("run"))
                        .unwrap();
                    let started = std::time::Instant::now();
                    let blocked = execute_selected_resource(&projected.join("run"));
                    drop(writer);
                    assert_eq!(blocked.unwrap_err().raw_os_error(), Some(libc::ETXTBSY));
                    assert!(started.elapsed() < std::time::Duration::from_secs(2));
                    std::fs::set_permissions(
                        projected.join("run"),
                        std::fs::Permissions::from_mode(0o600),
                    )
                    .unwrap();
                    assert_eq!(
                        execute_selected_resource(&projected.join("run"))
                            .unwrap_err()
                            .kind(),
                        std::io::ErrorKind::PermissionDenied
                    );
                    std::fs::set_permissions(
                        projected.join("run"),
                        std::fs::Permissions::from_mode(0o755),
                    )
                    .unwrap();
                }
            }
            std::fs::rename(&hidden, owned.path().join("external")).unwrap();
            assert_eq!(std::fs::read_to_string(&config).unwrap(), *raw);
        }
        for field in [
            "plugin",
            "instructions",
            "skills-object",
            "skills-paths",
            "mcp-name",
        ] {
            for final_missing in [false, true] {
                let final_value = if final_missing {
                    format!("[{obsolete_json}]")
                } else {
                    "[]".into()
                };
                let raw = match field {
                    "plugin" | "instructions" => {
                        format!(r#"{{"{field}":[{instruction_json}],"{field}":{final_value}}}"#)
                    }
                    "skills-object" => format!(
                        r#"{{"skills":{{"paths":[{skills_json}]}},"skills":{{"paths":{final_value}}}}}"#
                    ),
                    "mcp-name" => {
                        let winner = if final_missing {
                            format!(r#"{{"type":"local","cwd":{obsolete_json}}}"#)
                        } else {
                            r#"{"type":"remote","url":"https://example.test/mcp","enabled":false}"#
                                .into()
                        };
                        format!(
                            r#"{{"mcp":{{"same":{{"type":"local","cwd":{obsolete_json}}},"\u0073\u0061\u006d\u0065":{winner}}}}}"#
                        )
                    }
                    _ => {
                        format!(r#"{{"skills":{{"paths":[{skills_json}],"paths":{final_value}}}}}"#)
                    }
                };
                std::fs::write(&config, &raw).unwrap();
                let result = plan_opencode_sources(
                    vec![SourceOccurrence {
                        logical_path: config.clone(),
                        canonical_source: config.clone(),
                        lane: SourceLane::Main,
                        role: DiscoveryRole::Home,
                    }],
                    &cwd,
                    &home,
                    &|_, _, _| None,
                );
                if final_missing {
                    let error = result
                        .err()
                        .expect("missing final member must prevent publication");
                    assert!(error.cause.contains("missing"));
                    assert_eq!(error.declaring_source, config);
                } else {
                    assert!(result
                        .unwrap()
                        .iter()
                        .all(|source| source.configured_resources.is_empty()));
                }
                assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
            }
        }
    }

    #[test]
    fn managed_provider_configured_external_resources_fail_before_publication_when_unavailable() {
        use std::os::unix::fs::PermissionsExt;
        let owned = tempfile::tempdir().unwrap();
        let config = owned.path().join("opencode.json");
        let resource = owned.path().join("unavailable-resource.mjs");
        for field in ["plugin", "instructions"] {
            for unreadable in [false, true] {
                if unreadable {
                    std::fs::write(&resource, "resource").unwrap();
                    std::fs::set_permissions(&resource, std::fs::Permissions::from_mode(0o0))
                        .unwrap();
                }
                let raw = serde_json::to_string(&serde_json::json!({field:[resource]})).unwrap();
                std::fs::write(&config, &raw).unwrap();
                let plan = plan_opencode_sources(
                    vec![SourceOccurrence {
                        logical_path: config.clone(),
                        canonical_source: config.clone(),
                        lane: SourceLane::Main,
                        role: DiscoveryRole::Workspace,
                    }],
                    owned.path(),
                    owned.path(),
                    &|_, _, _| None,
                );
                if unreadable {
                    std::fs::set_permissions(&resource, std::fs::Permissions::from_mode(0o600))
                        .unwrap();
                    std::fs::remove_file(&resource).unwrap();
                }
                let error = plan
                    .err()
                    .expect("selected unavailable ordinary resource must prevent preparation");
                assert_eq!(
                    error.field,
                    if field == "plugin" {
                        "OpenCode plugin"
                    } else {
                        "OpenCode instructions"
                    }
                );
                assert_eq!(error.declaring_source, config);
                assert!(error
                    .cause
                    .contains(if unreadable { "unreadable" } else { "missing" }));
                assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
                assert!(!owned.path().join("stage").exists());
            }
        }
    }
    #[test]
    fn managed_provider_configured_resources_keep_field_and_relative_instruction_origins() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let cwd = owned.path().join("workspace/nested");
        let global = owned.path().join("xdg/opencode");
        let plugin = global.join("plugins/selected");
        for directory in [
            &home,
            &cwd,
            &plugin,
            &cwd.join("rules"),
            &cwd.parent().unwrap().join("rules"),
        ] {
            std::fs::create_dir_all(directory).unwrap();
        }
        std::fs::write(plugin.join("index.mjs"), "export default ()=>({});").unwrap();
        std::fs::write(
            cwd.join("rules/selected.md"),
            "nearest selected instruction",
        )
        .unwrap();
        std::fs::write(
            cwd.parent().unwrap().join("rules/unselected.md"),
            "ancestor must not be selected",
        )
        .unwrap();
        let config = global.join("opencode.jsonc");
        let raw = r#"{ // retain raw native spellings and unrelated options
"plugin":[["file:///home/freshell/provider/.config/opencode/plugins/selected/index.mjs",{"instructions":["/unselected/missing"],"path":"{env:UNRELATED}"}]],
"instructions":["{env:RULE_PATTERN}"],}"#;
        std::fs::write(&config, raw).unwrap();
        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Global,
            }],
            &cwd,
            &home,
            &|_, _, name| match name {
                "RULE_PATTERN" => Some("rules/*.md".into()),
                "UNRELATED" => Some("ordinary option value".into()),
                _ => None,
            },
        )
        .unwrap();
        assert_eq!(
            plan[0].configured_resources,
            vec![cwd.join("rules/selected.md")]
        );
        assert_eq!(plan[0].references.path_variables, vec!["RULE_PATTERN"]);
        assert_eq!(plan[0].references.unexpanded_source(), raw);
    }
    #[test]
    fn managed_provider_sound_and_mcp_cwd_consume_external_closure_after_both_copies() {
        use std::os::unix::fs::PermissionsExt;
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let cwd = owned.path().join("workspace/nested");
        let external = owned.path().join("external");
        let tool = external.join("tool");
        for path in [&home, &cwd, &tool.join("node_modules/dependency")] {
            std::fs::create_dir_all(path).unwrap();
        }
        let sound = external.join("selected.wav");
        std::fs::write(&sound, b"RIFF-selected-wave-bytes").unwrap();
        std::fs::set_permissions(&sound, std::fs::Permissions::from_mode(0o644)).unwrap();
        std::fs::write(tool.join("resource"), "mcp-resource").unwrap();
        std::fs::write(
            tool.join("node_modules/dependency/index.js"),
            "module.exports='mcp-dependency';",
        )
        .unwrap();
        std::fs::write(tool.join("server.cjs"), "const fs=require('node:fs');process.stdout.write(fs.readFileSync('resource','utf8')+':'+require('dependency')+':'+fs.readFileSync(process.argv[2],'utf8'));").unwrap();
        let config = external.join("tui.jsonc");
        for (ordinal, spelling) in [
            sound.display().to_string(),
            reqwest::Url::from_file_path(&sound).unwrap().to_string(),
            "./selected.wav".into(),
            "../external/selected.wav".into(),
        ]
        .into_iter()
        .enumerate()
        {
            let config = if ordinal == 3 {
                cwd.parent().unwrap().join("tui.jsonc")
            } else {
                config.clone()
            };
            let raw = format!("{{ // selected finite native fields\n\"attention\":{{\"sounds\":{{\"default\":{}}}}},\"mcp\":{{\"probe\":{{\"type\":\"local\",\"command\":[\"node\",\"server.cjs\"],\"cwd\":\"../../external/tool\"}},\"disabled\":{{\"type\":\"local\",\"enabled\":false,\"cwd\":\"/missing-disabled\"}},\"remote\":{{\"type\":\"remote\",\"cwd\":\"/missing-remote\"}}}}}}", serde_json::to_string(&spelling).unwrap());
            std::fs::write(&config, &raw).unwrap();
            let plan = plan_opencode_sources(
                vec![SourceOccurrence {
                    logical_path: config.clone(),
                    canonical_source: config.clone(),
                    lane: SourceLane::Tui,
                    role: DiscoveryRole::Workspace,
                }],
                &cwd,
                &home,
                &|_, _, _| None,
            )
            .unwrap();
            let units = resource_units(
                &home,
                &home.join(".config/opencode"),
                &owned.path().join("workspace"),
                &plan,
                None,
            )
            .unwrap();
            let sound_unit = units
                .iter()
                .find(|(source, _)| source == &sound)
                .expect("selected attention sound must be transported");
            let tool_unit = units
                .iter()
                .find(|(source, _)| source == &tool)
                .expect("local MCP cwd must transport the whole directory");
            let stage = owned.path().join(format!("stage-{ordinal}"));
            let host = owned.path().join(format!("host-{ordinal}"));
            let selections = units
                .iter()
                .map(|(source, unit)| CopySelection {
                    source: source.clone(),
                    destination_relative: unit.stage_relative_path.clone().into(),
                })
                .collect::<Vec<_>>();
            copy_environment(&selections, &stage, &[], Default::default()).unwrap();
            let selections = units
                .iter()
                .map(|(_, unit)| CopySelection {
                    source: stage.join(&unit.stage_relative_path),
                    destination_relative: unit.provider_relative_path.clone().into(),
                })
                .collect::<Vec<_>>();
            copy_environment(&selections, &host, &[], Default::default()).unwrap();
            let hidden = owned.path().join("hidden-external");
            std::fs::rename(&external, &hidden).unwrap();
            let output = std::process::Command::new("node")
                .arg("server.cjs")
                .arg(host.join(&sound_unit.1.provider_relative_path))
                .current_dir(host.join(&tool_unit.1.provider_relative_path))
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap())
                .output()
                .unwrap();
            std::fs::rename(&hidden, &external).unwrap();
            assert!(output.status.success(), "MCP cwd consumer must execute its dependencies/resources and read the sound after both copies: {:?}",output.stderr);
            assert_eq!(
                output.stdout,
                b"mcp-resource:mcp-dependency:RIFF-selected-wave-bytes"
            );
            assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
            assert_eq!(
                std::fs::metadata(&sound).unwrap().permissions().mode() & 0o777,
                0o644
            );
        }
    }

    #[test]
    fn absolute_mcp_shebang_command_runs_after_all_resource_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let external = owned.path().join("external");
        let command = external.join("mcp-executable");
        for path in [&home, &workspace, &external] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(
            &command,
            "#!/bin/sh\nprintf 'absolute MCP executable started\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {
                    "absolute": { "type": "local", "command": [command] },
                },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        let canonical_command = command.canonicalize().unwrap();
        assert!(plan[0].configured_resources.contains(&canonical_command));
        assert!(!plan[0]
            .configured_resources
            .contains(&external.canonicalize().unwrap()));

        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_command = provider.join(command.strip_prefix(owned.path()).unwrap());
        assert_ne!(
            std::fs::metadata(&provider_command)
                .unwrap()
                .permissions()
                .mode()
                & 0o100,
            0,
            "the managed command must remain executable by its owner after every provider resource copy"
        );
        let hidden = owned.path().join("external-hidden");
        std::fs::rename(&external, &hidden).unwrap();
        let output = execute_selected_resource(&provider_command);
        std::fs::rename(&hidden, &external).unwrap();
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "the copied absolute MCP command must start: {:?}",
            output.stderr
        );
        assert_eq!(output.stdout, b"absolute MCP executable started\n");
    }

    #[test]
    fn absolute_mcp_symlink_command_preserves_launch_alias_after_resource_copies() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.sh");
        let target = home.join("tools/start.sh");
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(&target, "#!/bin/sh\nprintf 'symlink command started\\n'\n").unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        symlink("tools/start.sh", &command).unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": { "direct": { "type": "local", "command": [command] } },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        assert!(
            plan[0].configured_resources.contains(&command),
            "the absolute command alias must remain available at the configured launch path"
        );
        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_command = provider.join(".provider-home/mcp.sh");
        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"symlink command started\n");
    }

    #[test]
    fn mcp_cwd_does_not_hide_absolute_command_symlink_alias() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let project = workspace.join("project");
        let command = home.join("mcp.sh");
        let target = project.join("start.sh");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            &target,
            "#!/bin/sh\nprintf 'cwd symlink command started\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        symlink("../workspace/project/start.sh", &command).unwrap();
        let config = workspace.join("opencode.json");
        let raw = format!(
            r#"{{"mcp":{{"direct":{{"type":"local","cwd":{},"command":[{}]}}}}}}"#,
            serde_json::to_string(project.to_str().unwrap()).unwrap(),
            serde_json::to_string(command.to_str().unwrap()).unwrap(),
        );
        std::fs::write(&config, raw).unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        assert!(
            plan[0].configured_resources.contains(&command),
            "mcp.cwd may cover the resolved target but must not remove the configured HOME alias"
        );

        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_command = provider.join(".provider-home/mcp.sh");
        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"cwd symlink command started\n");
    }

    #[test]
    fn direct_executable_script_in_home_runs_after_all_resource_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.sh");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        let helper = home.join("helper.sh");
        std::fs::write(
            &command,
            "#!/bin/sh\nSCRIPT_DIR=$(dirname \"$0\")\n. \"$SCRIPT_DIR/helper.sh\"\nprintf '%s\\n' \"$MCP_HELPER_RESULT\"\n",
        )
        .unwrap();
        std::fs::write(&helper, "MCP_HELPER_RESULT='home sibling helper loaded'\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": { "direct": { "type": "local", "command": [command] } },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        assert!(plan[0]
            .configured_resources
            .contains(&command.canonicalize().unwrap()));
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()),
            "a direct script in HOME must retain its explicitly sourced sibling without selecting all of HOME");
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_command = provider.join(".provider-home/mcp.sh");
        let hidden_home = owned.path().join("home-hidden");
        std::fs::rename(&home, &hidden_home).unwrap();
        let output = execute_selected_resource(&provider_command);
        std::fs::rename(&hidden_home, &home).unwrap();
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "the direct executable selected under HOME must still start: {:?}",
            output.stderr
        );
        assert_eq!(output.stdout, b"home sibling helper loaded\n");
    }

    #[test]
    fn extensionless_mcp_shebang_script_loads_sibling_after_all_resource_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = home.join("tools");
        let command = tools.join("start");
        let helper = tools.join("helper.sh");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/bin/sh\nSCRIPT_DIR=$(dirname \"$0\")\n. \"$SCRIPT_DIR/helper.sh\"\nprintf '%s\\n' \"$MCP_HELPER_RESULT\"\n",
        )
        .unwrap();
        std::fs::write(
            &helper,
            "MCP_HELPER_RESULT='extensionless sibling helper loaded'\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": { "direct": { "type": "local", "command": [command] } },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        assert!(plan[0]
            .configured_resources
            .contains(&command.canonicalize().unwrap()));
        assert!(
            plan[0]
                .configured_resources
                .contains(&helper.canonicalize().unwrap()),
            "an extensionless executable shebang command must retain its sourced sibling"
        );
        assert!(
            !plan[0]
                .configured_resources
                .contains(&tools.canonicalize().unwrap()),
            "a direct command must not copy unrelated siblings from its containing directory"
        );

        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_command = provider.join(".provider-home/tools/start");
        let hidden_home = owned.path().join("home-hidden");
        std::fs::rename(&home, &hidden_home).unwrap();
        let output = execute_selected_resource(&provider_command);
        std::fs::rename(&hidden_home, &home).unwrap();
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "the extensionless managed shebang command must load its sibling helper: {:?}",
            output.stderr
        );
        assert_eq!(output.stdout, b"extensionless sibling helper loaded\n");
    }

    #[test]
    fn direct_node_script_in_home_loads_relative_module_after_all_resource_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("start");
        let helper = home.join("helper.js");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env node\nprocess.stdout.write(require('./helper.js'))\n",
        )
        .unwrap();
        std::fs::write(
            &helper,
            "module.exports = 'node sibling helper loaded\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": { "direct": { "type": "local", "command": [command] } },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()),
            "an account-home Node script must retain its imported sibling without selecting all of HOME");
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_command = provider.join(".provider-home/start");
        let hidden_home = owned.path().join("home-hidden");
        std::fs::rename(&home, &hidden_home).unwrap();
        let output = execute_selected_resource(&provider_command);
        std::fs::rename(&hidden_home, &home).unwrap();
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "the managed Node command must load its selected relative module: {:?}",
            output.stderr
        );
        assert_eq!(output.stdout, b"node sibling helper loaded\n");
    }

    #[test]
    fn direct_node_script_scanner_ignores_quotes_inside_regex_literals() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.js");
        let helper = home.join("helper.js");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            r#"const quote = /require\(['"]\.\/missing/;
if (false) /'/;
process.stdout.write(require('./helper.js'))
"#,
        )
        .unwrap();
        std::fs::write(&helper, "module.exports = 'regex scanner loaded\\n'\n").unwrap();

        let (plan, provider_script) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()));

        let output = execute_node_with_home_hidden(owned.path(), &home, &provider_script);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"regex scanner loaded\n");
    }

    #[test]
    fn direct_node_script_scans_template_expression_relative_import_after_all_copies() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.js");
        let helper = home.join("helper.js");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "process.stdout.write(`raw require('./missing.js') ${`nested ${({ helper: require('./helper.js') }).helper}`}`)\n",
        )
        .unwrap();
        std::fs::write(&helper, "module.exports = 'template helper loaded\\n'\n").unwrap();

        let (plan, provider_script) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()));

        let output = execute_node_with_home_hidden(owned.path(), &home, &provider_script);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(
            output.stdout,
            b"raw require('./missing.js') nested template helper loaded\n"
        );
    }

    #[test]
    fn direct_node_script_in_home_keeps_path_join_data_after_all_resource_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.js");
        let schema = home.join("assets/schema.json");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(schema.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env node\nconst fs = require('node:fs');\nconst path = require('node:path');\nprocess.stdout.write(fs.readFileSync(path.join(__dirname, 'assets', 'schema.json'), 'utf8'));\n",
        )
        .unwrap();
        std::fs::write(&schema, "path.join schema loaded\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_script) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(
            plan[0]
                .configured_resources
                .contains(&schema.canonicalize().unwrap()),
            "a statically named sibling read with path.join(__dirname, ...) must be selected"
        );
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let output = execute_with_home_hidden(owned.path(), &home, &provider_script);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"path.join schema loaded\n");
    }

    #[test]
    fn direct_node_command_stages_inline_and_separated_file_options() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("server.mjs");
        let preload = home.join("preload.cjs");
        let preload_helper = home.join("preload-helper.cjs");
        let imported = home.join("imported.mjs");
        let loader = home.join("loader.mjs");
        let experimental_loader = home.join("experimental-loader.mjs");
        let env_file = home.join(".env");
        let second_env_file = home.join(".env.local");
        let optional_env_file = home.join(".env.optional");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(&command, "if (globalThis.managedPreload !== 'loaded' || globalThis.managedPreloadHelper !== 'loaded' || globalThis.managedImport !== 'loaded' || process.env.MANAGED_ENV_FILE !== 'loaded' || process.env.MANAGED_ENV_FILE_LOCAL !== 'loaded') process.exit(1);\nprocess.stdout.write('command options staged\\n');\n").unwrap();
        std::fs::write(
            &preload,
            "require('./preload-helper.cjs');\nglobalThis.managedPreload = 'loaded';\n",
        )
        .unwrap();
        std::fs::write(
            &preload_helper,
            "globalThis.managedPreloadHelper = 'loaded';\n",
        )
        .unwrap();
        std::fs::write(&imported, "globalThis.managedImport = 'loaded';\n").unwrap();
        std::fs::write(&loader, "export async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); }\n").unwrap();
        std::fs::write(&experimental_loader, "export async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); }\n").unwrap();
        std::fs::write(&env_file, "MANAGED_ENV_FILE=loaded\n").unwrap();
        std::fs::write(&second_env_file, "MANAGED_ENV_FILE_LOCAL=loaded\n").unwrap();

        let option_arguments = vec![
            "node".to_owned(),
            format!("--require={}", preload.display()),
            "--import".to_owned(),
            imported.to_string_lossy().into_owned(),
            format!("--loader={}", loader.display()),
            "--experimental-loader".to_owned(),
            experimental_loader.to_string_lossy().into_owned(),
            format!("--env-file={}", env_file.display()),
            "--env-file".to_owned(),
            second_env_file.to_string_lossy().into_owned(),
            format!("--env-file-if-exists={}", optional_env_file.display()),
            command.to_string_lossy().into_owned(),
        ];
        let (plan, _) = plan_and_stage_mcp_command_for_resource(
            owned.path(),
            &home,
            &workspace,
            &option_arguments,
            &command,
        );
        for required in [
            &preload,
            &preload_helper,
            &imported,
            &loader,
            &experimental_loader,
            &env_file,
            &second_env_file,
        ] {
            assert!(
                plan[0]
                    .configured_resources
                    .contains(&required.canonicalize().unwrap()),
                "direct Node command option resource omitted {}",
                required.display()
            );
        }
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));
        assert!(!plan[0].configured_resources.contains(
            &optional_env_file
                .canonicalize()
                .unwrap_or(optional_env_file.clone())
        ));

        let provider = copy_selected_units_through_provider(
            owned.path(),
            &resource_units(
                &home,
                &home.join(".config/opencode"),
                &workspace,
                &plan,
                None,
            )
            .unwrap(),
        );
        let staged = |path: &Path| {
            provider
                .join(".provider-home")
                .join(path.strip_prefix(&home).unwrap())
        };
        let arguments = vec![
            format!("--require={}", staged(&preload).display()),
            "--import".to_owned(),
            staged(&imported).to_string_lossy().into_owned(),
            format!("--loader={}", staged(&loader).display()),
            "--experimental-loader".to_owned(),
            staged(&experimental_loader).to_string_lossy().into_owned(),
            format!("--env-file={}", staged(&env_file).display()),
            "--env-file".to_owned(),
            staged(&second_env_file).to_string_lossy().into_owned(),
            format!(
                "--env-file-if-exists={}",
                staged(&optional_env_file).display()
            ),
            staged(&command).to_string_lossy().into_owned(),
        ];
        let output = execute_node_command_with_home_hidden(owned.path(), &home, &arguments);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"command options staged\n");
    }

    #[test]
    fn direct_node_command_options_inside_mcp_cwd_use_the_directory_copy() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let mcp_cwd = home.join("tools");
        let command = mcp_cwd.join("server.js");
        let preload = mcp_cwd.join("preload.cjs");
        let env_file = mcp_cwd.join(".env");
        std::fs::create_dir_all(&mcp_cwd).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "if (globalThis.cwdPreload !== 'loaded' || process.env.MANAGED_CWD_ENV !== 'loaded') process.exit(1);\nprocess.stdout.write('cwd options loaded\\n');\n",
        )
        .unwrap();
        std::fs::write(&preload, "globalThis.cwdPreload = 'loaded';\n").unwrap();
        std::fs::write(&env_file, "MANAGED_CWD_ENV=loaded\n").unwrap();
        let command_arguments = vec![
            "node".to_owned(),
            "--require=./preload.cjs".to_owned(),
            "--env-file=.env".to_owned(),
            "server.js".to_owned(),
        ];

        let (plan, _) = plan_and_stage_mcp_command_for_resource_with_cwd(
            owned.path(),
            &home,
            &workspace,
            &command_arguments,
            &command,
            Some(&mcp_cwd),
        );
        let canonical_cwd = mcp_cwd.canonicalize().unwrap();
        assert!(plan[0].configured_resources.contains(&canonical_cwd));
        for covered in [&command, &preload, &env_file] {
            assert!(
                !plan[0]
                    .configured_resources
                    .contains(&covered.canonicalize().unwrap()),
                "MCP cwd should supply {} without an overlapping exact-file mount",
                covered.display()
            );
        }

        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let cwd_mount = units
            .iter()
            .find(|(source, _)| source == &canonical_cwd)
            .map(|(_, mount)| mount)
            .expect("selected MCP cwd must have a provider resource mount");
        let provider_relative = Path::new(&cwd_mount.effective_destination)
            .strip_prefix(owned.path())
            .map(Path::to_path_buf)
            .or_else(|_| {
                Path::new(&cwd_mount.effective_destination)
                    .strip_prefix("/home/freshell/provider")
                    .map(|relative| Path::new(".provider-home").join(relative))
            })
            .expect("test MCP cwd destination must map into the provider root");
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_cwd = provider.join(provider_relative);
        assert!(provider_cwd.is_dir(), "{}", provider_cwd.display());

        let hidden_home = owned.path().join("home-hidden");
        std::fs::rename(&home, &hidden_home).unwrap();
        let output = std::process::Command::new("node")
            .args(["--require=./preload.cjs", "--env-file=.env", "server.js"])
            .current_dir(&provider_cwd)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output();
        std::fs::rename(&hidden_home, &home).unwrap();
        let output = output.unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"cwd options loaded\n");
    }

    #[test]
    fn nested_direct_script_keeps_writable_sibling_mount_under_selected_directory() {
        use freshell_platform::opencode_recipe::{DiscoveryRole, DiscoveryRoot};

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let script_directory = home.join("mcp");
        let command = script_directory.join("server.mjs");
        let state_file = script_directory.join("state.json");
        std::fs::create_dir_all(&script_directory).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "import fs from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nfs.appendFileSync(path.join(__dirname, 'state.json'), ' + runtime state');\nprocess.stdout.write('nested state updated\\n');\n",
        )
        .unwrap();
        std::fs::write(&state_file, "initial state").unwrap();

        let (plan, _) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        let canonical_state = state_file.canonicalize().unwrap();
        assert!(plan[0]
            .configured_writable_resources
            .contains(&canonical_state));
        let previous_units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let previous_state_mount = previous_units
            .iter()
            .find(|(source, mount)| {
                source == &canonical_state
                    && mount.kind == freshell_runtime_protocol::ProviderResourceKind::File
                    && mount.effective_destination == "/home/freshell/provider/mcp/state.json"
            })
            .map(|(_, mount)| mount.clone())
            .expect("the initial generation needs a writable state mount");
        let selected_directory = DiscoveryRoot {
            logical_path: script_directory.clone(),
            role: DiscoveryRole::Home,
        };
        let mut units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            Some(std::slice::from_ref(&selected_directory)),
        )
        .unwrap();
        merge_recovery_resource_mounts(
            &mut units,
            &previous_units
                .iter()
                .map(|(_, mount)| mount.clone())
                .collect::<Vec<_>>(),
        )
        .unwrap();
        let state_mount = units
            .iter()
            .find(|(source, mount)| {
                source == &canonical_state
                    && mount.kind == freshell_runtime_protocol::ProviderResourceKind::File
            })
            .expect("writable state beneath a selected directory needs an exact file mount");
        assert!(state_mount.1.writable);
        assert_eq!(
            state_mount.1.provider_relative_path, previous_state_mount.provider_relative_path,
            "recovery must reuse the exact writable file's provider subpath"
        );

        let directory_mount = units
            .iter()
            .find(|(source, mount)| {
                source == &script_directory.canonicalize().unwrap()
                    && mount.kind == freshell_runtime_protocol::ProviderResourceKind::Directory
                    && mount
                        .effective_destination
                        .starts_with("/home/freshell/provider")
            })
            .map(|(_, mount)| mount)
            .expect("the selected script directory needs a directory mount");
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_script_directory = provider.join(".provider-home").join(
            Path::new(&directory_mount.effective_destination)
                .strip_prefix("/home/freshell/provider")
                .unwrap(),
        );
        let output = execute_node_with_home_hidden(
            owned.path(),
            &home,
            &provider_script_directory.join("server.mjs"),
        );
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"nested state updated\n");
        assert_eq!(
            std::fs::read(provider_script_directory.join("state.json")).unwrap(),
            b"initial state + runtime state"
        );
    }

    #[test]
    fn direct_node_script_does_not_stage_absent_sibling_write_targets() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("writer.mjs");
        let path_output = home.join("generated-path.json");
        let url_output = home.join("generated-url.json");
        let append_output = home.join("existing-output.txt");
        let append_url_output = home.join("existing-url-output.txt");
        let append_variable_url_output = home.join("existing-url-variable-output.txt");
        let append_nested_url_output = home.join("existing-nested-url-variable-output.txt");
        let append_deleted_property_url_output =
            home.join("existing-deleted-property-url-output.txt");
        let append_conditional_alias_url_output =
            home.join("existing-conditional-alias-url-output.txt");
        let append_harmless_conditional_alias_url_output =
            home.join("existing-harmless-conditional-alias-url-output.txt");
        let append_conditional_alias_write_source_a =
            home.join("existing-conditional-alias-write-a.txt");
        let append_conditional_alias_write_source_b =
            home.join("existing-conditional-alias-write-b.txt");
        let append_parenthesized_property_url_output =
            home.join("existing-parenthesized-property-url-output.txt");
        let append_let_variable_url_output = home.join("existing-let-url-variable-output.txt");
        let append_var_variable_url_output = home.join("existing-var-url-variable-output.txt");
        let reassigned_url_output = home.join("existing-reassigned-url-output.txt");
        let unrelated_url_output = home.join("existing-unrelated-url-output.txt");
        let copy_source = home.join("copy-source.txt");
        let copy_output = home.join("copy-output.txt");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "import fs from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nfs.writeFileSync(path.join(__dirname, 'generated-path.json'), 'path output');\nfs.writeFileSync(new URL('./generated-url.json', import.meta.url), 'url output');\nfs.appendFileSync(path.join(__dirname, 'existing-output.txt'), ' appended');\nfs.appendFileSync(new URL('./existing-url-output.txt', import.meta.url), ' appended');\nconst stateUrl = new URL('./existing-url-variable-output.txt', import.meta.url);\nconsole.error(stateUrl.href);\nfs.appendFileSync(stateUrl, ' appended');\nconst nestedStateUrl = new URL('./existing-nested-url-variable-output.txt', import.meta.url);\nif (true) { fs.appendFileSync(nestedStateUrl, ' appended'); }\nconst deletedPropertyUrl = new URL('./existing-deleted-property-url-output.txt', import.meta.url);\ndelete deletedPropertyUrl.href;\nfs.appendFileSync(deletedPropertyUrl, ' appended');\nlet letUrl = new URL('./existing-let-url-variable-output.txt', import.meta.url);\nfs.appendFileSync(letUrl, ' appended');\nvar varUrl = new URL('./existing-var-url-variable-output.txt', import.meta.url);\nfs.appendFileSync(varUrl, ' appended');\nlet reassignedUrl = new URL('./existing-reassigned-url-output.txt', import.meta.url);\nreassignedUrl = new URL('./existing-reassigned-url-output.txt', import.meta.url);\nfs.appendFileSync(reassignedUrl, ' appended');\nconst url = new URL('./existing-unrelated-url-output.txt', import.meta.url);\nfunction writeParameter(url) { fs.appendFileSync(url, ' appended'); }\nfs.copyFileSync(path.join(__dirname, 'copy-source.txt'), path.join(__dirname, 'copy-output.txt'));\nprocess.stdout.write(__dirname + '\\n');\n",
        )
        .unwrap();
        let mut command_file = std::fs::OpenOptions::new()
            .append(true)
            .open(&command)
            .unwrap();
        std::io::Write::write_all(
            &mut command_file,
            b"\nconst parenthesizedPropertyUrl = new URL('./existing-parenthesized-property-url-output.txt', import.meta.url);\n(parenthesizedPropertyUrl.href) = new URL('./existing-unrelated-url-output.txt', import.meta.url).href;\nfs.appendFileSync(parenthesizedPropertyUrl, ' appended');\nconst conditionalOutputUrl = new URL('./existing-conditional-alias-url-output.txt', import.meta.url);\nconst fallbackUrl = new URL('./existing-unrelated-url-output.txt', import.meta.url);\nconst selectedUrl = true ? conditionalOutputUrl : fallbackUrl;\nselectedUrl.href = new URL('./existing-unrelated-url-output.txt', import.meta.url).href;\nif (false) fs.appendFileSync(conditionalOutputUrl, ' appended');\nconst harmlessConditionalOutputUrl = new URL('./existing-harmless-conditional-alias-url-output.txt', import.meta.url);\nconst harmlessSelectedUrl = true ? harmlessConditionalOutputUrl : fallbackUrl\nconsole.error(harmlessSelectedUrl.href);\nif (false) fs.appendFileSync(harmlessConditionalOutputUrl, ' appended');\nconst conditionalWriteSourceA = new URL('./existing-conditional-alias-write-a.txt', import.meta.url);\nconst conditionalWriteSourceB = new URL('./existing-conditional-alias-write-b.txt', import.meta.url);\nconst conditionalWriteUrl = true ? conditionalWriteSourceA : conditionalWriteSourceB;\nfs.appendFileSync(conditionalWriteUrl, ' appended');\n",
        )
        .unwrap();
        std::fs::write(&append_output, "existing").unwrap();
        std::fs::write(&append_url_output, "url existing").unwrap();
        std::fs::write(&append_variable_url_output, "url variable existing").unwrap();
        std::fs::write(&append_nested_url_output, "nested url variable existing").unwrap();
        std::fs::write(
            &append_deleted_property_url_output,
            "deleted property URL existing",
        )
        .unwrap();
        std::fs::write(
            &append_conditional_alias_url_output,
            "conditional alias URL existing",
        )
        .unwrap();
        std::fs::write(
            &append_harmless_conditional_alias_url_output,
            "harmless conditional alias URL existing",
        )
        .unwrap();
        std::fs::write(
            &append_conditional_alias_write_source_a,
            "conditional alias write source A existing",
        )
        .unwrap();
        std::fs::write(
            &append_conditional_alias_write_source_b,
            "conditional alias write source B existing",
        )
        .unwrap();
        std::fs::write(
            &append_parenthesized_property_url_output,
            "parenthesized property URL existing",
        )
        .unwrap();
        std::fs::write(&append_let_variable_url_output, "let url variable existing").unwrap();
        std::fs::write(&append_var_variable_url_output, "var url variable existing").unwrap();
        std::fs::write(&reassigned_url_output, "reassigned url existing").unwrap();
        std::fs::write(&unrelated_url_output, "unrelated url existing").unwrap();
        std::fs::write(&copy_source, "copy input").unwrap();

        let (plan, provider_script) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        for output in [&path_output, &url_output] {
            assert!(
                !plan[0]
                    .configured_resources
                    .contains(&output.canonicalize().unwrap_or_else(|_| output.clone())),
                "a prospective write destination must not be a required staged input"
            );
        }
        assert!(plan[0]
            .configured_resources
            .contains(&append_output.canonicalize().unwrap()));
        for output in [
            &append_url_output,
            &append_variable_url_output,
            &append_nested_url_output,
            &append_parenthesized_property_url_output,
            &append_let_variable_url_output,
            &append_var_variable_url_output,
            &reassigned_url_output,
            &unrelated_url_output,
            &append_conditional_alias_url_output,
            &append_harmless_conditional_alias_url_output,
            &append_conditional_alias_write_source_a,
            &append_conditional_alias_write_source_b,
        ] {
            assert!(plan[0]
                .configured_resources
                .contains(&output.canonicalize().unwrap()));
        }
        assert!(plan[0]
            .configured_resources
            .contains(&copy_source.canonicalize().unwrap()));
        assert!(!plan[0].configured_resources.contains(
            &copy_output
                .canonicalize()
                .unwrap_or_else(|_| copy_output.clone())
        ));

        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        for output in [
            &append_output,
            &append_url_output,
            &append_variable_url_output,
            &append_nested_url_output,
            &append_let_variable_url_output,
            &append_var_variable_url_output,
            &append_harmless_conditional_alias_url_output,
            &append_conditional_alias_write_source_a,
            &append_conditional_alias_write_source_b,
        ] {
            let canonical = output.canonicalize().unwrap();
            let mounts = units
                .iter()
                .filter(|(source, mount)| {
                    source == &canonical
                        && mount.kind == freshell_runtime_protocol::ProviderResourceKind::File
                })
                .collect::<Vec<_>>();
            assert!(
                !mounts.is_empty(),
                "existing static output must be an exact file mount"
            );
            assert!(
                mounts.iter().all(|(_, mount)| mount.writable),
                "{} should be writable for a direct URL output",
                output.display()
            );
        }
        let unrelated_url_mounts = units
            .iter()
            .filter(|(source, mount)| {
                source == &unrelated_url_output.canonicalize().unwrap()
                    && mount.kind == freshell_runtime_protocol::ProviderResourceKind::File
            })
            .collect::<Vec<_>>();
        assert!(!unrelated_url_mounts.is_empty());
        assert!(unrelated_url_mounts
            .iter()
            .all(|(_, mount)| !mount.writable));
        let conditional_alias_url_mounts = units
            .iter()
            .filter(|(source, mount)| {
                source == &append_conditional_alias_url_output.canonicalize().unwrap()
                    && mount.kind == freshell_runtime_protocol::ProviderResourceKind::File
            })
            .collect::<Vec<_>>();
        assert!(!conditional_alias_url_mounts.is_empty());
        assert!(conditional_alias_url_mounts
            .iter()
            .all(|(_, mount)| !mount.writable));
        let deleted_property_url_mounts = units
            .iter()
            .filter(|(source, mount)| {
                source == &append_deleted_property_url_output.canonicalize().unwrap()
                    && mount.kind == freshell_runtime_protocol::ProviderResourceKind::File
            })
            .collect::<Vec<_>>();
        assert!(!deleted_property_url_mounts.is_empty());
        assert!(deleted_property_url_mounts
            .iter()
            .all(|(_, mount)| !mount.writable));
        let parenthesized_property_url_mounts = units
            .iter()
            .filter(|(source, mount)| {
                source
                    == &append_parenthesized_property_url_output
                        .canonicalize()
                        .unwrap()
                    && mount.kind == freshell_runtime_protocol::ProviderResourceKind::File
            })
            .collect::<Vec<_>>();
        assert!(!parenthesized_property_url_mounts.is_empty());
        assert!(parenthesized_property_url_mounts
            .iter()
            .all(|(_, mount)| !mount.writable));
        let reassigned_url_mounts = units
            .iter()
            .filter(|(source, mount)| {
                source == &reassigned_url_output.canonicalize().unwrap()
                    && mount.kind == freshell_runtime_protocol::ProviderResourceKind::File
            })
            .collect::<Vec<_>>();
        assert!(!reassigned_url_mounts.is_empty());
        assert!(reassigned_url_mounts
            .iter()
            .all(|(_, mount)| !mount.writable));
        let copy_source_mounts = units
            .iter()
            .filter(|(source, mount)| {
                source == &copy_source.canonicalize().unwrap()
                    && mount.kind == freshell_runtime_protocol::ProviderResourceKind::File
            })
            .collect::<Vec<_>>();
        assert!(!copy_source_mounts.is_empty());
        assert!(copy_source_mounts.iter().all(|(_, mount)| !mount.writable));

        let output = execute_node_with_home_hidden(owned.path(), &home, &provider_script);
        assert!(output.status.success(), "{:?}", output.stderr);
        let provider_script_directory = std::fs::canonicalize(&provider_script)
            .unwrap()
            .parent()
            .unwrap()
            .to_owned();
        assert_eq!(
            output.stdout,
            format!("{}\n", provider_script_directory.display()).as_bytes()
        );
        let staged_path_output = provider_script_directory.join("generated-path.json");
        let staged_url_output = provider_script_directory.join("generated-url.json");
        let staged_append_output = provider_script_directory.join("existing-output.txt");
        let staged_append_url_output = provider_script_directory.join("existing-url-output.txt");
        let staged_append_variable_url_output =
            provider_script_directory.join("existing-url-variable-output.txt");
        let staged_copy_output = provider_script_directory.join("copy-output.txt");
        assert_eq!(
            std::fs::read(&staged_path_output).unwrap_or_else(|error| panic!(
                "failed to read {} beside {}: {error}; entries: {:?}; staged script: {:?}; stdout: {:?}",
                staged_path_output.display(),
                provider_script.display(),
                std::fs::read_dir(&provider_script_directory)
                    .unwrap()
                    .map(|entry| entry.unwrap().file_name())
                    .collect::<Vec<_>>(),
                std::fs::read_to_string(&provider_script),
                output.stdout
            )),
            b"path output"
        );
        assert_eq!(std::fs::read(&staged_url_output).unwrap(), b"url output");
        assert_eq!(
            std::fs::read(&staged_append_output).unwrap(),
            b"existing appended"
        );
        assert_eq!(
            std::fs::read(&staged_append_url_output).unwrap(),
            b"url existing appended"
        );
        assert_eq!(
            std::fs::read(&staged_append_variable_url_output).unwrap(),
            b"url variable existing appended"
        );
        assert_eq!(std::fs::read(&staged_copy_output).unwrap(), b"copy input");
    }

    #[test]
    fn direct_node_script_in_nested_home_directory_keeps_relative_module_closure() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp/bin/server.js");
        let helper = home.join("mcp/lib/helper.js");
        let nested = home.join("mcp/lib/nested.js");
        std::fs::create_dir_all(command.parent().unwrap()).unwrap();
        std::fs::create_dir_all(helper.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "process.stdout.write(require('../lib/helper.js'))\n",
        )
        .unwrap();
        std::fs::write(&helper, "module.exports = require('./nested.js')\n").unwrap();
        std::fs::write(&nested, "module.exports = 'nested module loaded\\n'\n").unwrap();

        let command_args = vec!["node".to_owned(), command.to_string_lossy().into_owned()];
        let (plan, provider_script) = plan_and_stage_mcp_command_for_resource(
            owned.path(),
            &home,
            &workspace,
            &command_args,
            &command,
        );
        for required in [&helper, &nested] {
            assert!(
                plan[0]
                    .configured_resources
                    .contains(&required.canonicalize().unwrap()),
                "the nested Node command closure omitted {}",
                required.display()
            );
        }

        let output = execute_node_with_home_hidden(owned.path(), &home, &provider_script);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"nested module loaded\n");
    }

    #[test]
    fn direct_node_script_recurses_into_extensionless_imported_module() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.js");
        let helper = home.join("helper");
        let nested = home.join("nested.js");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(&command, "process.stdout.write(require('./helper'))\n").unwrap();
        std::fs::write(&helper, "module.exports = require('./nested.js')\n").unwrap();
        std::fs::write(
            &nested,
            "module.exports = 'extensionless module loaded\\n'\n",
        )
        .unwrap();

        let command_args = vec!["node".to_owned(), command.to_string_lossy().into_owned()];
        let (plan, provider_script) = plan_and_stage_mcp_command_for_resource(
            owned.path(),
            &home,
            &workspace,
            &command_args,
            &command,
        );
        for required in [&helper, &nested] {
            assert!(
                plan[0]
                    .configured_resources
                    .contains(&required.canonicalize().unwrap()),
                "the Node scanner omitted {} from the imported closure",
                required.display()
            );
        }

        let output = execute_node_with_home_hidden(owned.path(), &home, &provider_script);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"extensionless module loaded\n");
    }

    #[test]
    fn direct_node_script_keeps_imported_symlink_alias_after_all_resource_copies() {
        use std::os::unix::fs::symlink;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.js");
        let helper = home.join("helper.js");
        let helper_target = home.join("shared/helper.js");
        let helper_directory = home.join("linked-dir");
        let helper_directory_target = home.join("shared-dir");
        let helper_directory_index = helper_directory.join("index.js");
        let helper_directory_index_target = helper_directory_target.join("index.js");
        std::fs::create_dir_all(helper_target.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&helper_directory_target).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "process.stdout.write(require('./helper.js') + require('./linked-dir'))\n",
        )
        .unwrap();
        std::fs::write(
            &helper_target,
            "module.exports = 'symlinked file loaded|'\n",
        )
        .unwrap();
        std::fs::write(
            &helper_directory_index_target,
            "module.exports = 'symlinked directory loaded\\n'\n",
        )
        .unwrap();
        symlink(&helper_target, &helper).unwrap();
        symlink(&helper_directory_target, &helper_directory).unwrap();

        let command_args = vec!["node".to_owned(), command.to_string_lossy().into_owned()];
        let (plan, provider_script) = plan_and_stage_mcp_command_for_resource(
            owned.path(),
            &home,
            &workspace,
            &command_args,
            &command,
        );
        assert!(
            plan[0].configured_resources.contains(&helper),
            "the Node closure must preserve the imported symlink alias"
        );
        assert!(plan[0]
            .configured_resources
            .contains(&helper_target.canonicalize().unwrap()));
        assert!(
            plan[0]
                .configured_resources
                .contains(&helper_directory_index),
            "the Node closure must preserve the imported path through a symlinked directory"
        );
        assert!(plan[0]
            .configured_resources
            .contains(&helper_directory_index_target.canonicalize().unwrap()));

        let output = execute_node_with_home_hidden(owned.path(), &home, &provider_script);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(
            output.stdout,
            b"symlinked file loaded|symlinked directory loaded\n"
        );
    }

    #[test]
    fn versioned_python_command_stages_script_and_sibling_after_all_resource_copies() {
        use std::os::unix::fs::symlink;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.py");
        let helper = home.join("helper.py");
        let bin = owned.path().join("bin");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(&command, "import helper\nprint(helper.VALUE)\n").unwrap();
        std::fs::write(&helper, "VALUE = 'versioned command loaded'\n").unwrap();

        let inherited_path = std::env::var_os("PATH").unwrap_or_default();
        let interpreter = std::env::split_paths(&inherited_path)
            .map(|directory| directory.join("python3"))
            .find(|candidate| candidate.is_file())
            .expect("python3 is required by the existing direct Python script test");
        symlink(
            std::fs::canonicalize(interpreter).unwrap(),
            bin.join("python3.12"),
        )
        .unwrap();

        let command_args = vec![
            "python3.12".to_owned(),
            command.to_string_lossy().into_owned(),
        ];
        let (plan, provider_script) = plan_and_stage_mcp_command_for_resource(
            owned.path(),
            &home,
            &workspace,
            &command_args,
            &command,
        );
        for required in [&command, &helper] {
            assert!(
                plan[0]
                    .configured_resources
                    .contains(&required.canonicalize().unwrap()),
                "the versioned Python command closure omitted {}",
                required.display()
            );
        }
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let hidden_home = owned.path().join("home-hidden");
        std::fs::rename(&home, &hidden_home).unwrap();
        let search_path = std::iter::once(bin.clone())
            .chain(std::env::split_paths(&inherited_path))
            .collect::<Vec<_>>();
        let search_path = std::env::join_paths(search_path).unwrap();
        let output = std::process::Command::new("python3.12")
            .arg(&provider_script)
            .env_clear()
            .env("PATH", search_path)
            .output();
        std::fs::rename(&hidden_home, &home).unwrap();
        let output = output.unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"versioned command loaded\n");
    }

    #[test]
    fn direct_node_script_in_home_keeps_home_node_modules_after_all_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("start");
        let dependency = home.join("node_modules/home-fixture/index.js");
        std::fs::create_dir_all(dependency.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env node\nprocess.stdout.write(require('home-fixture'))\n",
        )
        .unwrap();
        std::fs::write(
            &dependency,
            "module.exports = 'home node_modules loaded\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&home.join("node_modules").canonicalize().unwrap()));
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"home node_modules loaded\n");
    }

    #[test]
    fn direct_node_script_in_home_keeps_static_import_meta_url_data_after_all_copies() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.mjs");
        let schema = home.join("schema.json");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "import { readFileSync } from 'node:fs';\nprocess.stdout.write(readFileSync(new URL('./schema.json', import.meta.url,), 'utf8'));\n",
        )
        .unwrap();
        std::fs::write(&schema, "static schema loaded\n").unwrap();

        let (plan, provider_script) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&schema.canonicalize().unwrap()));
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let hidden_home = owned.path().join("home-hidden");
        std::fs::rename(&home, &hidden_home).unwrap();
        let output = std::process::Command::new("node")
            .arg(&provider_script)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output();
        std::fs::rename(&hidden_home, &home).unwrap();
        let output = output.unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"static schema loaded\n");
    }

    #[test]
    fn direct_node_script_in_home_keeps_static_import_meta_url_directory_after_all_copies() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.mjs");
        let templates = home.join("templates");
        std::fs::create_dir_all(&templates).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "import { readdirSync } from 'node:fs';\nprocess.stdout.write(readdirSync(new URL('./templates/', import.meta.url)).join(','));\n",
        )
        .unwrap();
        std::fs::write(templates.join("welcome.md"), "welcome").unwrap();

        let (plan, provider_script) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&templates.canonicalize().unwrap()));
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let hidden_home = owned.path().join("home-hidden");
        std::fs::rename(&home, &hidden_home).unwrap();
        let output = std::process::Command::new("node")
            .arg(&provider_script)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output();
        std::fs::rename(&hidden_home, &home).unwrap();
        let output = output.unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"welcome.md");
    }

    #[test]
    fn shell_mcp_wrapper_stages_and_runs_node_server_module_closure() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = home.join("tools");
        let command = tools.join("start");
        let server = tools.join("server.js");
        let helper = tools.join("helper.cjs");
        let package = tools.join("node_modules/shell-fixture");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/bin/sh\nSCRIPT_DIR=$(dirname \"$0\")\nexec env node \"$SCRIPT_DIR/server.js\"\n",
        )
        .unwrap();
        std::fs::write(
            &server,
            "const helper = require('./helper.cjs');\nconst installed = require('shell-fixture');\nprocess.stdout.write(`${helper}:${installed}\\n`);\n",
        )
        .unwrap();
        std::fs::write(&helper, "module.exports = 'sibling-loaded';\n").unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"shell-fixture","main":"index.cjs"}"#,
        )
        .unwrap();
        std::fs::write(
            package.join("index.cjs"),
            "module.exports = 'package-loaded';\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        for required in [&command, &server, &helper, &tools.join("node_modules")] {
            assert!(
                plan[0]
                    .configured_resources
                    .contains(&required.canonicalize().unwrap()),
                "shell-launched Node closure omitted {}",
                required.display()
            );
        }
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"sibling-loaded:package-loaded\n");
    }

    #[test]
    fn shell_mcp_wrapper_stages_node_preload_before_server_script() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("start");
        let preload = home.join("preload.js");
        let preload_helper = home.join("preload-helper.js");
        let second_preload = home.join("second-preload.js");
        let imported_preload = home.join("preload.mjs");
        let loader = home.join("loader.mjs");
        let env_file = home.join(".env");
        let server = home.join("server.js");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/bin/sh\ncd \"$(dirname \"$0\")\" && exec node -r ./preload.js --require=./second-preload.js --import ./preload.mjs --loader=./loader.mjs --env-file=.env server.js\n",
        )
        .unwrap();
        std::fs::write(
            &preload,
            "require('./preload-helper.js');\nglobalThis.managedPreload = 'loaded';\n",
        )
        .unwrap();
        std::fs::write(
            &preload_helper,
            "globalThis.managedPreloadHelper = 'loaded';\n",
        )
        .unwrap();
        std::fs::write(
            &second_preload,
            "globalThis.managedSecondPreload = 'loaded';\n",
        )
        .unwrap();
        std::fs::write(
            &imported_preload,
            "globalThis.managedImportedPreload = 'loaded';\n",
        )
        .unwrap();
        std::fs::write(
            &loader,
            "export async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); }\n",
        )
        .unwrap();
        std::fs::write(&env_file, "MANAGED_ENV_FILE=loaded\n").unwrap();
        std::fs::write(
            &server,
            "if (globalThis.managedPreload !== 'loaded' || globalThis.managedPreloadHelper !== 'loaded' || globalThis.managedSecondPreload !== 'loaded' || globalThis.managedImportedPreload !== 'loaded' || process.env.MANAGED_ENV_FILE !== 'loaded') process.exit(1);\nprocess.stdout.write('preload staged\\n');\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        for required in [
            &preload,
            &preload_helper,
            &second_preload,
            &imported_preload,
            &loader,
            &env_file,
        ] {
            assert!(
                plan[0]
                    .configured_resources
                    .contains(&required.canonicalize().unwrap()),
                "Node option dependency omitted {}",
                required.display()
            );
        }
        assert!(plan[0]
            .configured_resources
            .contains(&server.canonicalize().unwrap()));

        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"preload staged\n");
    }

    #[test]
    fn home_shell_wrapper_stages_node_script_after_changing_to_its_directory() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("start");
        let server = home.join("server.js");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/bin/sh\ncd \"$(dirname \"$0\")\" && exec node server.js\n",
        )
        .unwrap();
        std::fs::write(
            &server,
            "process.stdout.write('cd-relative server started\\n');\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(
            plan[0]
                .configured_resources
                .contains(&server.canonicalize().unwrap()),
            "a Node file run after cd to the wrapper directory must be selected"
        );

        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"cd-relative server started\n");
    }

    #[test]
    fn node_command_script_in_home_keeps_home_node_modules_after_all_copies() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.js");
        let dependency = home.join("node_modules/home-fixture/index.js");
        std::fs::create_dir_all(dependency.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(&command, "process.stdout.write(require('home-fixture'))\n").unwrap();
        std::fs::write(
            &dependency,
            "module.exports = 'runtime node_modules loaded\\n'\n",
        )
        .unwrap();

        let command_args = vec!["node".to_owned(), command.to_string_lossy().into_owned()];
        let (plan, provider_script) = plan_and_stage_mcp_command_for_resource(
            owned.path(),
            &home,
            &workspace,
            &command_args,
            &command,
        );
        assert!(plan[0]
            .configured_resources
            .contains(&home.join("node_modules").canonicalize().unwrap()));
        assert!(plan[0]
            .configured_resources
            .contains(&command.canonicalize().unwrap()));
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let hidden_home = owned.path().join("home-hidden");
        std::fs::rename(&home, &hidden_home).unwrap();
        let output = std::process::Command::new("node")
            .arg(&provider_script)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output();
        std::fs::rename(&hidden_home, &home).unwrap();
        let output = output.unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"runtime node_modules loaded\n");
    }

    #[test]
    fn node_shebang_javascript_script_in_home_keeps_home_node_modules_after_all_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("mcp.js");
        let dependency = home.join("node_modules/home-fixture/index.js");
        std::fs::create_dir_all(dependency.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env node\nprocess.stdout.write(require('home-fixture'))\n",
        )
        .unwrap();
        std::fs::write(
            &dependency,
            "module.exports = 'javascript shebang node_modules loaded\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&home.join("node_modules").canonicalize().unwrap()));
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"javascript shebang node_modules loaded\n");
    }

    #[test]
    fn direct_node_script_loads_parent_relative_module_after_all_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let external = owned.path().join("external");
        let command = external.join("mcp/bin/start");
        let helper = external.join("mcp/lib/helper.js");
        std::fs::create_dir_all(command.parent().unwrap()).unwrap();
        std::fs::create_dir_all(helper.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env node\nprocess.stdout.write(require('../lib/helper.js'))\n",
        )
        .unwrap();
        std::fs::write(
            &helper,
            "module.exports = 'parent-relative module loaded\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()));
        assert!(!plan[0]
            .configured_resources
            .contains(&external.join("mcp").canonicalize().unwrap()));

        let hidden_external = owned.path().join("external-hidden");
        std::fs::rename(&external, &hidden_external).unwrap();
        let output = execute_selected_resource(&provider_command).unwrap();
        std::fs::rename(&hidden_external, &external).unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"parent-relative module loaded\n");
    }

    #[test]
    fn direct_node_script_resolves_directory_package_main_after_all_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let external = owned.path().join("external");
        let command = external.join("mcp/bin/start");
        let package = external.join("mcp/helpers");
        let manifest = package.join("package.json");
        let entry = package.join("lib/entry.cjs");
        std::fs::create_dir_all(command.parent().unwrap()).unwrap();
        std::fs::create_dir_all(entry.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env node\nprocess.stdout.write(require('../helpers'))\n",
        )
        .unwrap();
        std::fs::write(&manifest, r#"{"main":"lib/entry.cjs"}"#).unwrap();
        std::fs::write(
            &entry,
            "module.exports = 'directory package main loaded\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&manifest.canonicalize().unwrap()));
        assert!(plan[0]
            .configured_resources
            .contains(&entry.canonicalize().unwrap()));
        let hidden_external = owned.path().join("external-hidden");
        std::fs::rename(&external, &hidden_external).unwrap();
        let output = execute_selected_resource(&provider_command).unwrap();
        std::fs::rename(&hidden_external, &external).unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"directory package main loaded\n");
    }

    #[test]
    fn direct_node_script_falls_back_to_index_for_directory_package_main_dot() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let external = owned.path().join("external");
        let command = external.join("mcp/bin/start");
        let package = external.join("mcp/helpers");
        let manifest = package.join("package.json");
        let index = package.join("index.js");
        std::fs::create_dir_all(command.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env node\nprocess.stdout.write(require('../helpers'))\n",
        )
        .unwrap();
        std::fs::write(&manifest, r#"{"main":"."}"#).unwrap();
        std::fs::write(
            &index,
            "module.exports = 'directory index fallback loaded\\n'\n",
        )
        .unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&manifest.canonicalize().unwrap()));
        assert!(plan[0]
            .configured_resources
            .contains(&index.canonicalize().unwrap()));
        let hidden_external = owned.path().join("external-hidden");
        std::fs::rename(&external, &hidden_external).unwrap();
        let output = execute_selected_resource(&provider_command).unwrap();
        std::fs::rename(&hidden_external, &external).unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"directory index fallback loaded\n");
    }

    #[test]
    fn direct_python_shebang_loads_sibling_module_after_all_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = home.join("tools");
        let command = tools.join("start");
        let helper = tools.join("helper.py");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env python3\nimport helper\nprint(helper.VALUE)\n",
        )
        .unwrap();
        std::fs::write(&helper, "VALUE = 'python sibling loaded'\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()));
        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"python sibling loaded\n");
    }

    #[test]
    fn direct_python_package_relative_import_loads_nested_module_after_all_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = home.join("tools");
        let package = tools.join("pkg");
        let command = tools.join("start");
        let helper = package.join("helper.py");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env python3\nimport pkg\nprint(pkg.helper.VALUE)\n",
        )
        .unwrap();
        std::fs::write(package.join("__init__.py"), "from . import helper\n").unwrap();
        std::fs::write(&helper, "VALUE = 'nested package helper loaded'\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()));
        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"nested package helper loaded\n");
    }

    #[test]
    fn direct_python_absolute_package_import_uses_entry_point_import_root() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let package = home.join("pkg");
        let command = home.join("start");
        let helper = package.join("helper.py");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env python3\nimport pkg\nprint(pkg.helper.VALUE)\n",
        )
        .unwrap();
        std::fs::write(package.join("__init__.py"), "from pkg import helper\n").unwrap();
        std::fs::write(&helper, "VALUE = 'absolute package helper loaded'\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()));
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"absolute package helper loaded\n");
    }

    #[test]
    fn direct_python_multiline_package_import_loads_nested_module_after_all_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = home.join("tools");
        let package = tools.join("pkg");
        let command = tools.join("start");
        let helper = package.join("helper.py");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env python3\nimport pkg\nprint(pkg.helper.VALUE)\n",
        )
        .unwrap();
        std::fs::write(
            package.join("__init__.py"),
            "from . import (\n    helper,\n)\n",
        )
        .unwrap();
        std::fs::write(&helper, "VALUE = 'multiline package helper loaded'\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()));
        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"multiline package helper loaded\n");
    }

    #[test]
    fn direct_python_versioned_shebang_loads_sibling_module_after_all_copies() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = home.join("tools");
        let command = tools.join("start");
        let helper = tools.join("helper.py");
        let bin = owned.path().join("bin");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env python3.12\nimport helper\nprint(helper.VALUE)\n",
        )
        .unwrap();
        std::fs::write(&helper, "VALUE = 'versioned python loaded'\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let inherited_path = std::env::var_os("PATH").unwrap_or_default();
        let interpreter = std::env::split_paths(&inherited_path)
            .map(|directory| directory.join("python3"))
            .find(|candidate| candidate.is_file())
            .expect("python3 is required by the existing direct Python script test");
        symlink(
            std::fs::canonicalize(interpreter).unwrap(),
            bin.join("python3.12"),
        )
        .unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()));
        let output =
            execute_with_home_hidden_using_path(owned.path(), &home, &provider_command, Some(&bin));
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"versioned python loaded\n");
    }

    #[test]
    fn direct_ruby_shebang_keeps_relative_module_after_all_copies() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = home.join("tools");
        let command = tools.join("start");
        let helper = tools.join("helper.rb");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/usr/bin/env ruby\nrequire_relative 'helper'\nputs VALUE\n",
        )
        .unwrap();
        std::fs::write(&helper, "VALUE = 'ruby sibling loaded'\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()));
        assert!(provider_command.is_file());
        assert!(provider_command.with_file_name("helper.rb").is_file());
        assert!(!plan[0]
            .configured_resources
            .contains(&home.canonicalize().unwrap()));

        let bin = owned.path().join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let ruby_available = std::process::Command::new("ruby")
            .arg("--version")
            .output()
            .is_ok_and(|output| output.status.success());
        if !ruby_available {
            let ruby_shim = bin.join("ruby");
            std::fs::write(
                &ruby_shim,
                "#!/bin/sh\nscript=\"$1\"\ngrep -F \"require_relative 'helper'\" \"$script\" >/dev/null || exit 10\ngrep -F \"VALUE = 'ruby sibling loaded'\" \"$(dirname \"$script\")/helper.rb\" >/dev/null || exit 11\nprintf 'ruby sibling loaded\\n'\n",
            )
            .unwrap();
            std::fs::set_permissions(&ruby_shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let output = execute_with_home_hidden_using_path(
            owned.path(),
            &home,
            &provider_command,
            (!ruby_available).then_some(bin.as_path()),
        );
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"ruby sibling loaded\n");
    }

    #[test]
    fn shell_shebang_keeps_binary_support_resources_without_parsing_them() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = home.join("tools");
        let command = tools.join("start");
        let data = tools.join("data.bin");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/bin/sh\nSCRIPT_DIR=$(dirname \"$0\")\ncat \"$SCRIPT_DIR/data.bin\"\n",
        )
        .unwrap();
        let expected = [0, 0xff, 0x81, b'R', b'I', b'F', b'F'];
        std::fs::write(&data, expected).unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&data.canonicalize().unwrap()));
        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, expected);
    }

    #[test]
    fn direct_shell_script_does_not_stage_absent_sibling_redirection_targets() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let command = home.join("writer");
        let generated = home.join("generated.txt");
        let existing_output = home.join("existing.txt");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/bin/sh\nSCRIPT_DIR=$(dirname \"$0\")\nprintf 'created by shell\\n' > \"$SCRIPT_DIR/generated.txt\"\nprintf 'appended by shell\\n' >> \"$SCRIPT_DIR/generated.txt\"\nprintf ' appended' >> \"$SCRIPT_DIR/existing.txt\"\n",
        )
        .unwrap();
        std::fs::write(&existing_output, "existing").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(
            !plan[0].configured_resources.contains(
                &generated
                    .canonicalize()
                    .unwrap_or_else(|_| generated.clone())
            ),
            "a shell redirection destination must not be a required staged input"
        );
        assert!(plan[0]
            .configured_resources
            .contains(&existing_output.canonicalize().unwrap()));

        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(
            std::fs::read(provider_command.with_file_name("generated.txt")).unwrap(),
            b"created by shell\nappended by shell\n"
        );
        assert_eq!(
            std::fs::read(provider_command.with_file_name("existing.txt")).unwrap(),
            b"existing appended"
        );
    }

    #[test]
    fn shell_shebang_keeps_binary_support_resource_from_inline_dirname_expression() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = home.join("tools");
        let command = tools.join("start");
        let data = tools.join("data.bin");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(&command, "#!/bin/sh\ncat \"$(dirname \"$0\")/data.bin\"\n").unwrap();
        let expected = [0, 0xff, 0x81, b'R', b'I', b'F', b'F'];
        std::fs::write(&data, expected).unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&data.canonicalize().unwrap()));
        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, expected);
    }

    #[test]
    fn shell_shebang_resolves_nested_quote_dirname_source_expression() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = home.join("tools");
        let command = tools.join("start");
        let helper = tools.join("helper.sh");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/bin/bash\nsource \"$(dirname \"$0\")/helper.sh\"\nprintf '%s\\n' \"$VALUE\"\n",
        )
        .unwrap();
        std::fs::write(&helper, "VALUE='nested quote source loaded'\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();

        let (plan, provider_command) =
            plan_and_stage_direct_mcp_command(owned.path(), &home, &workspace, &command);
        assert!(plan[0]
            .configured_resources
            .contains(&helper.canonicalize().unwrap()));
        let output = execute_with_home_hidden(owned.path(), &home, &provider_command);
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"nested quote source loaded\n");
    }

    #[test]
    fn direct_mcp_shell_script_loads_sibling_after_home_copy() {
        use std::os::unix::fs::PermissionsExt;

        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let tools = home.join("tools");
        let command = tools.join("start.sh");
        let helper = tools.join("helper.sh");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            &command,
            "#!/bin/sh\nSCRIPT_DIR=$(dirname \"$0\")\n. \"$SCRIPT_DIR/helper.sh\"\nprintf '%s\\n' \"$MCP_HELPER_RESULT\"\n",
        )
        .unwrap();
        std::fs::write(&helper, "MCP_HELPER_RESULT='sibling shell helper loaded'\n").unwrap();
        std::fs::set_permissions(&command, std::fs::Permissions::from_mode(0o755)).unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": { "direct": { "type": "local", "command": [command] } },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        assert!(
            plan[0]
                .configured_resources
                .contains(&tools.canonicalize().unwrap()),
            "a direct MCP script must retain its bounded sibling-resource directory"
        );

        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_command = provider.join(".provider-home/tools/start.sh");
        let hidden_home = owned.path().join("home-hidden");
        std::fs::rename(&home, &hidden_home).unwrap();
        let output = execute_selected_resource(&provider_command);
        std::fs::rename(&hidden_home, &home).unwrap();
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "the directly launched managed script must load its sibling helper: {:?}",
            output.stderr
        );
        assert_eq!(output.stdout, b"sibling shell helper loaded\n");
    }

    #[test]
    fn standalone_mcp_script_imports_sibling_after_all_resource_copies() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let external = owned.path().join("external");
        let command = external.join("server.js");
        let helper = external.join("handler.js");
        for path in [&home, &workspace, &external] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(&command, "process.stdout.write(require('./handler.js'))\n").unwrap();
        std::fs::write(&helper, "module.exports = 'sibling MCP helper loaded'\n").unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {
                    "standalone": {
                        "type": "local",
                        "command": ["node", command],
                    },
                },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        let canonical_external = external.canonicalize().unwrap();
        assert!(
            plan[0].configured_resources.contains(&canonical_external),
            "a standalone script must select its bounded sibling-import directory"
        );
        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_command = provider.join(command.strip_prefix(owned.path()).unwrap());
        let provider_helper = provider.join(helper.strip_prefix(owned.path()).unwrap());
        assert!(
            provider_helper.is_file(),
            "the sibling import must be copied"
        );

        let hidden = owned.path().join("external-hidden");
        std::fs::rename(&external, &hidden).unwrap();
        let output = std::process::Command::new("node")
            .arg(&provider_command)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .output();
        std::fs::rename(&hidden, &external).unwrap();
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "the staged MCP script must load its copied sibling: {:?}",
            output.stderr
        );
        assert_eq!(output.stdout, b"sibling MCP helper loaded");
    }

    #[test]
    fn standalone_node_mcp_script_loads_dependency_from_home_node_modules() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let script_dir = home.join("scripts");
        let node_modules = home.join("node_modules");
        let dependency = node_modules.join("parent-dependency");
        let command = script_dir.join("server.js");
        for path in [&script_dir, &dependency, &workspace] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(
            &command,
            "process.stdout.write(require('parent-dependency'))\n",
        )
        .unwrap();
        std::fs::write(
            dependency.join("index.js"),
            "module.exports = 'ancestor MCP dependency loaded'\n",
        )
        .unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {
                    "standalone": { "type": "local", "command": ["node", command] },
                },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        assert!(
            plan[0]
                .configured_resources
                .contains(&node_modules.canonicalize().unwrap()),
            "the standalone Node script must select ancestor node_modules"
        );
        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_command = provider.join(".provider-home/scripts/server.js");

        let hidden_home = owned.path().join("home-hidden");
        std::fs::rename(&home, &hidden_home).unwrap();
        let output = std::process::Command::new("node")
            .arg(&provider_command)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .output();
        std::fs::rename(&hidden_home, &home).unwrap();
        let output = output.unwrap();
        assert!(
            output.status.success(),
            "the managed Node script must resolve its copied ancestor dependency: {:?}",
            output.stderr
        );
        assert_eq!(output.stdout, b"ancestor MCP dependency loaded");
    }

    #[test]
    fn bun_package_script_dependency_in_parent_node_modules_runs_after_both_copies() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let external = owned.path().join("external");
        let package = external.join("mcp-package");
        let nested_cwd = package.join("nested");
        let dependency = external.join("node_modules/parent-dependency");
        for path in [&home, &workspace, &nested_cwd, &dependency] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(
            package.join("package.json"),
            r#"{"scripts":{"mcp.js":"node ./server.js"}}"#,
        )
        .unwrap();
        std::fs::write(
            package.join("server.js"),
            "process.stdout.write(require('parent-dependency'))\n",
        )
        .unwrap();
        std::fs::write(
            dependency.join("index.js"),
            "module.exports='parent dependency loaded'\n",
        )
        .unwrap();
        let config = workspace.join("opencode.json");
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": {
                    "package-script": {
                        "type": "local",
                        "cwd": nested_cwd,
                        "command": ["bun", "run", "mcp.js"],
                    },
                },
            })
            .to_string(),
        )
        .unwrap();

        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        let selected = &plan[0].configured_resources;
        assert!(selected.contains(&package.canonicalize().unwrap()));
        assert!(selected.contains(&external.join("node_modules").canonicalize().unwrap()));
        assert!(!selected.contains(&nested_cwd.canonicalize().unwrap()));

        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let stage = owned.path().join("stage");
        let host = owned.path().join("host");
        let stage_selections = units
            .iter()
            .map(|(source, mount)| CopySelection {
                source: source.clone(),
                destination_relative: mount.stage_relative_path.clone().into(),
            })
            .collect::<Vec<_>>();
        copy_environment(&stage_selections, &stage, &[], Default::default()).unwrap();
        let host_selections = units
            .iter()
            .map(|(_, mount)| CopySelection {
                source: stage.join(&mount.stage_relative_path),
                destination_relative: mount.provider_relative_path.clone().into(),
            })
            .collect::<Vec<_>>();
        copy_environment(&host_selections, &host, &[], Default::default()).unwrap();

        // Managed mounts retain the selected resources' original relative
        // topology, so package resolution can walk from the package into its
        // parent's node_modules directory.
        let provider = owned.path().join("provider");
        let provider_selections = units
            .iter()
            .map(|(_, mount)| CopySelection {
                source: host.join(&mount.provider_relative_path),
                destination_relative: Path::new(&mount.effective_destination)
                    .strip_prefix(owned.path())
                    .unwrap()
                    .to_path_buf(),
            })
            .collect::<Vec<_>>();
        copy_environment(&provider_selections, &provider, &[], Default::default()).unwrap();
        let staged_package = provider.join(package.strip_prefix(owned.path()).unwrap());
        let staged_manifest: serde_json::Value =
            serde_json::from_slice(&std::fs::read(staged_package.join("package.json")).unwrap())
                .unwrap();
        let staged_script = staged_manifest["scripts"]["mcp.js"].as_str().unwrap();
        let hidden = owned.path().join("hidden-external");
        std::fs::rename(&external, &hidden).unwrap();
        // Execute the package manifest's actual command after both copy
        // stages, without making the Rust test depend on a host Bun install.
        let output = std::process::Command::new("sh")
            .args(["-c", staged_script])
            .current_dir(&staged_package)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .output()
            .unwrap();
        std::fs::rename(&hidden, &external).unwrap();
        assert!(
            output.status.success(),
            "the staged Bun package script must resolve its parent-installed dependency: {:?}",
            output.stderr
        );
        assert_eq!(output.stdout, b"parent dependency loaded");
    }

    #[test]
    fn bun_run_file_preserves_preload_module_operand_after_all_copies() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let preload_package = owned.path().join("external/preload-package");
        let package = owned.path().join("external/server-package");
        let preload = preload_package.join("preload.mjs");
        let server = package.join("server.mjs");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&preload_package).unwrap();
        std::fs::create_dir_all(&package).unwrap();
        std::fs::write(&preload, "globalThis.fixturePreloadLoaded = true;\n").unwrap();
        std::fs::write(
            &server,
            "if (!globalThis.fixturePreloadLoaded) process.exit(7); process.stdout.write('preload loaded');\n",
        )
        .unwrap();
        let command = vec![
            "bun".to_owned(),
            "run".to_owned(),
            "--import".to_owned(),
            preload.to_string_lossy().into_owned(),
            server.to_string_lossy().into_owned(),
        ];

        let (plan, provider_server) = plan_and_stage_mcp_command_for_resource(
            owned.path(),
            &home,
            &workspace,
            &command,
            &server,
        );
        let canonical_preload = preload.canonicalize().unwrap();
        assert!(
            plan[0].configured_resources.iter().any(|selected| {
                selected == &canonical_preload
                    || (selected.is_dir() && canonical_preload.starts_with(selected))
            }),
            "Bun's --import preload module must be selected as a configured resource"
        );

        let hidden = owned.path().join("external-hidden");
        std::fs::rename(owned.path().join("external"), &hidden).unwrap();
        let provider_preload = provider_server
            .parent()
            .and_then(Path::parent)
            .unwrap()
            .join("preload-package/preload.mjs");
        assert!(
            provider_preload.is_file(),
            "the preload must survive both copies"
        );
        let output = std::process::Command::new("node")
            .arg("--import")
            .arg(provider_preload)
            .arg(&provider_server)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output();
        std::fs::rename(&hidden, owned.path().join("external")).unwrap();
        let output = output.unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"preload loaded");
    }

    #[cfg(unix)]
    #[test]
    fn external_bun_run_file_keeps_computed_sibling_assets_after_all_copies() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let external = owned.path().join("external");
        let workspace = external.join("project");
        let tools = external.join("tools");
        let local_package = workspace.join("packages/local-package");
        let local_package_link = external.join("node_modules/local-package");
        let server = tools.join("server.mjs");
        let workspace_worker = tools.join("workspace-worker.mjs");
        let schema = external.join("schema.json");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::create_dir_all(&local_package).unwrap();
        std::fs::create_dir_all(local_package_link.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink("../project/packages/local-package", &local_package_link)
            .unwrap();
        std::os::unix::fs::symlink(
            "../project/packages/local-package/worker.mjs",
            &workspace_worker,
        )
        .unwrap();
        std::fs::write(
            workspace.join("workspace-data.txt"),
            "workspace stays mounted\n",
        )
        .unwrap();
        std::fs::write(
            local_package.join("package.json"),
            r#"{"type":"module","exports":"./index.js"}"#,
        )
        .unwrap();
        std::fs::write(
            local_package.join("index.js"),
            "export const marker = 'workspace-linked-package';\n",
        )
        .unwrap();
        std::fs::write(
            local_package.join("schema.json"),
            r#"{"nonce":"workspace-script-sibling-loaded"}"#,
        )
        .unwrap();
        std::fs::write(
            local_package.join("worker.mjs"),
            "import { readFileSync } from 'node:fs';\nconst schema = JSON.parse(readFileSync(new URL('./schema.json', import.meta.url), 'utf8'));\nexport const sibling = schema.nonce;\n",
        )
        .unwrap();
        std::fs::write(external.join("package.json"), r#"{"type":"module"}"#).unwrap();
        std::fs::write(
            &server,
            "import { readFileSync } from 'node:fs';\nimport path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nimport { marker } from 'local-package';\nimport { sibling } from './workspace-worker.mjs';\nconst scriptDir = path.dirname(fileURLToPath(import.meta.url));\nprocess.stdout.write(marker + ':' + sibling + ':' + readFileSync(path.join(scriptDir, '../schema.json'), 'utf8'));\n",
        )
        .unwrap();
        std::fs::write(&schema, "computed sibling schema loaded\n").unwrap();
        let command = vec![
            "bun".to_owned(),
            "run".to_owned(),
            server.to_string_lossy().into_owned(),
        ];

        let config = workspace.join(".opencode/opencode.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": { "computed-asset": { "type": "local", "command": command } },
            })
            .to_string(),
        )
        .unwrap();
        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        assert!(
            plan[0]
                .configured_resources
                .contains(&external.canonicalize().unwrap()),
            "an external Bun script must retain its bounded package directory for computed resources"
        );
        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let filtered = tempfile::tempdir_in(owned.path()).unwrap();
        let mut units = units;
        filter_workspace_from_enclosing_resource_units(
            &mut units,
            "opencode",
            &workspace,
            filtered.path(),
            &[],
        )
        .unwrap();
        let provider = copy_selected_units_through_provider(owned.path(), &units);
        let provider_server = provider
            .join(external.strip_prefix(owned.path()).unwrap())
            .join("tools/server.mjs");
        let provider_workspace = provider.join(workspace.strip_prefix(owned.path()).unwrap());
        assert!(provider_server.is_file());
        assert!(
            !provider_workspace.join("workspace-data.txt").exists(),
            "the enclosing package copy must leave workspace data out"
        );
        assert!(
            provider_workspace.join(".opencode/opencode.json").is_file(),
            "a separately selected workspace config must survive the package exclusion: {units:?}"
        );

        let hidden = owned.path().join("external-hidden");
        std::fs::rename(&external, &hidden).unwrap();
        let output = std::process::Command::new("node")
            .arg(&provider_server)
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output();
        std::fs::rename(&hidden, &external).unwrap();
        let output = output.unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(
            output.stdout,
            b"workspace-linked-package:workspace-script-sibling-loaded:computed sibling schema loaded\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn controller_filters_workspace_reached_through_package_symlink() {
        let owned = tempfile::tempdir().unwrap();
        let package = owned.path().join("external");
        let workspace = owned.path().join("checkout/project");
        let filtered = tempfile::tempdir_in(owned.path()).unwrap();
        std::fs::create_dir_all(package.join("node_modules")).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::write(
            workspace.join("index.mjs"),
            "export const nonce = 'separately-mounted-workspace-loaded';\n",
        )
        .unwrap();
        std::fs::write(
            workspace.join("workspace-data.txt"),
            "private workspace data\n",
        )
        .unwrap();
        std::os::unix::fs::symlink(&workspace, package.join("project")).unwrap();
        std::os::unix::fs::symlink("../project", package.join("node_modules/project")).unwrap();
        std::fs::write(package.join("package.json"), r#"{"type":"module"}"#).unwrap();
        std::fs::write(
            package.join("server.mjs"),
            "import { nonce } from './node_modules/project/index.mjs';\nprocess.stdout.write(nonce + '\\n');\n",
        )
        .unwrap();
        let mount = freshell_runtime_protocol::ProviderResourceMount {
            stage_relative_path: ".freshell/resource-units/root-symlink".into(),
            provider_relative_path: ".freshell/provider-roots/root-symlink".into(),
            logical_destination: package.to_string_lossy().into_owned(),
            effective_destination: package.to_string_lossy().into_owned(),
            kind: freshell_runtime_protocol::ProviderResourceKind::Directory,
            writable: false,
        };
        let mut units = vec![(package.clone(), mount)];

        filter_workspace_from_enclosing_resource_units(
            &mut units,
            "opencode",
            &workspace,
            filtered.path(),
            &[],
        )
        .unwrap();

        assert_ne!(units[0].0, package, "the symlinked workspace is filtered");
        let filtered_package = &units[0].0;
        assert!(std::fs::symlink_metadata(filtered_package.join("project"))
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            std::fs::canonicalize(filtered_package.join("project")).unwrap(),
            workspace.canonicalize().unwrap(),
            "the separately mounted workspace remains reachable through its alias"
        );
        let output = std::process::Command::new("node")
            .arg(filtered_package.join("server.mjs"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output()
            .unwrap();
        assert!(output.status.success(), "{:?}", output.stderr);
        assert_eq!(output.stdout, b"separately-mounted-workspace-loaded\n");

        let final_stage = filtered.path().join("managed-stage");
        freshell_platform::provider_environment::copy_environment_excluding_subtree(
            &[freshell_platform::provider_environment::CopySelection {
                source: filtered_package.clone(),
                destination_relative: "resource".into(),
            }],
            &final_stage,
            &[],
            &workspace,
            Default::default(),
        )
        .unwrap();
        let final_package = final_stage.join("resource");
        assert_eq!(
            std::fs::canonicalize(final_package.join("project")).unwrap(),
            workspace.canonicalize().unwrap(),
            "the final controller stage preserves the separate workspace link"
        );
        let output = std::process::Command::new("node")
            .arg(final_package.join("server.mjs"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap_or_default())
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        assert_eq!(output.stdout, b"separately-mounted-workspace-loaded\n");
    }

    #[test]
    fn filtering_shared_home_and_workspace_resource_keeps_one_copy_source() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let external = home.join("external");
        let workspace = external.join("project");
        let tools = external.join("tools");
        let server = tools.join("server.mjs");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&workspace).unwrap();
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::write(&server, "process.stdout.write('ok');\n").unwrap();
        std::fs::write(external.join("package.json"), r#"{"type":"module"}"#).unwrap();
        let config = workspace.join(".opencode/opencode.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        std::fs::write(
            &config,
            serde_json::json!({
                "mcp": { "shared-package": { "type": "local", "command": [
                    "bun", "run", server.to_string_lossy()
                ] } },
            })
            .to_string(),
        )
        .unwrap();
        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config,
                lane: SourceLane::Main,
                role: DiscoveryRole::Workspace,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        let mut units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        let canonical_package = external.canonicalize().unwrap();
        let shared_stage_path = units
            .iter()
            .find(|(source, _)| source == &canonical_package)
            .expect("the package resource must be selected")
            .1
            .stage_relative_path
            .clone();
        assert_eq!(
            units
                .iter()
                .filter(|(_, mount)| mount.stage_relative_path == shared_stage_path)
                .count(),
            2,
            "the package is exposed as HOME and workspace aliases"
        );
        let filtered = tempfile::tempdir_in(owned.path()).unwrap();
        filter_workspace_from_enclosing_resource_units(
            &mut units,
            "opencode",
            &workspace,
            filtered.path(),
            &[],
        )
        .unwrap();

        let selections = resource_copy_selections(&units).unwrap();
        assert_eq!(
            selections.len(),
            2,
            "the shared package and selected workspace config are each copied once"
        );
        let aliases = units
            .iter()
            .filter(|(_, mount)| mount.stage_relative_path == shared_stage_path)
            .map(|(source, _)| source)
            .collect::<Vec<_>>();
        assert_eq!(
            aliases[0], aliases[1],
            "both aliases share one filtered source"
        );
    }

    #[cfg(unix)]
    #[test]
    fn workspace_filter_copy_failure_emits_structured_controller_event() {
        use std::sync::{Arc, Mutex};
        use tracing_subscriber::prelude::*;

        #[derive(Clone, Default)]
        struct Capture(Arc<Mutex<Vec<std::collections::BTreeMap<String, String>>>>);
        impl tracing::field::Visit for Capture {
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                self.0
                    .lock()
                    .unwrap()
                    .last_mut()
                    .unwrap()
                    .insert(field.name().into(), format!("{value:?}"));
            }

            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                self.0
                    .lock()
                    .unwrap()
                    .last_mut()
                    .unwrap()
                    .insert(field.name().into(), value.into());
            }
        }
        impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Capture {
            fn on_event(
                &self,
                event: &tracing::Event<'_>,
                _: tracing_subscriber::layer::Context<'_, S>,
            ) {
                self.0.lock().unwrap().push(Default::default());
                event.record(&mut self.clone());
            }
        }

        let owned = tempfile::tempdir().unwrap();
        let resource = owned.path().join("external");
        let workspace = resource.join("project");
        std::fs::create_dir_all(&workspace).unwrap();
        std::os::unix::fs::symlink("missing-target", resource.join("dangling-resource")).unwrap();
        let stage_path = ".freshell/resource-units/root-test";
        let mut units = vec![(
            resource,
            freshell_runtime_protocol::ProviderResourceMount {
                stage_relative_path: stage_path.into(),
                provider_relative_path: ".freshell/provider-roots/root-test".into(),
                logical_destination: "/tmp/external".into(),
                effective_destination: "/tmp/external".into(),
                kind: freshell_runtime_protocol::ProviderResourceKind::Directory,
                writable: false,
            },
        )];
        let capture = Capture::default();
        let dispatcher =
            tracing::Dispatch::new(tracing_subscriber::registry().with(capture.clone()));

        let error = tracing::dispatcher::with_default(&dispatcher, || {
            filter_workspace_from_enclosing_resource_units(
                &mut units,
                "opencode",
                &workspace,
                &owned.path().join("filtered"),
                &[],
            )
        })
        .unwrap_err();

        assert!(error.contains("failed to bound enclosing provider resource"));
        let events = capture.0.lock().unwrap();
        let failed = events
            .iter()
            .find(|fields| {
                fields
                    .get("event")
                    .is_some_and(|event| event.contains("provider.environment.copy.failed"))
            })
            .expect("filtering failures emit the standard copy failure event");
        assert!(failed
            .get("stage")
            .is_some_and(|value| value.contains("controller")));
        assert!(failed
            .get("provider")
            .is_some_and(|value| value.contains("opencode")));
        assert!(failed
            .get("resource_stage_path")
            .is_some_and(|value| value.contains(stage_path)));
        assert!(failed
            .get("resource_source_leaf")
            .is_some_and(|value| value.contains("external")));
        assert!(failed
            .get("relative_path")
            .is_some_and(|value| value.contains("resource/dangling-resource")));
        assert!(failed.contains_key("operation"));
        assert!(failed.contains_key("corrective_message"));
        let serialized = format!("{events:?}");
        assert!(
            !serialized.contains(&owned.path().to_string_lossy().to_string()),
            "structured resource failures must not log physical source paths"
        );
    }

    #[test]
    fn managed_provider_nested_attention_and_literal_tilde_keep_native_origins_after_both_copies() {
        for scenario in ["nested", "top-replacement", "tilde"] {
            let owned = tempfile::tempdir().unwrap();
            let home = owned.path().join("home");
            let cwd = owned.path().join("external/instance");
            let parent = owned.path().join("external/tui");
            let sound = parent.join(if scenario == "tilde" {
                "~/selected.wav"
            } else {
                "selected.wav"
            });
            let tool = cwd.join("~/tool");
            for path in [
                &home,
                &cwd,
                &parent,
                sound.parent().unwrap(),
                &tool.join("node_modules/dependency"),
            ] {
                std::fs::create_dir_all(path).unwrap();
            }
            std::fs::write(&sound, "native-sound").unwrap();
            std::fs::write(home.join("selected.wav"), "wrong-home-sound").unwrap();
            std::fs::create_dir_all(home.join("tool")).unwrap();
            std::fs::write(home.join("tool/resource"), "wrong-home-tool").unwrap();
            std::fs::write(tool.join("resource"), "native-resource").unwrap();
            std::fs::write(
                tool.join("node_modules/dependency/index.js"),
                "module.exports='native-dependency';",
            )
            .unwrap();
            std::fs::write(tool.join("server.cjs"), "const fs=require('node:fs');process.stdout.write(fs.readFileSync('resource','utf8')+':'+require('dependency')+':'+fs.readFileSync(process.argv[2],'utf8'));").unwrap();
            let spelling = if scenario == "tilde" {
                "~/selected.wav"
            } else {
                "./selected.wav"
            };
            let attention = serde_json::json!({"sounds":{"default":spelling}});
            let mut document = serde_json::json!({"tui":{"attention":attention},"mcp":{"probe":{"type":"local","command":["node","server.cjs"],"cwd":"~/tool"}}});
            if scenario == "top-replacement" {
                document["tui"]["attention"] =
                    serde_json::json!({"sounds":{"question":"./unselected-missing.wav"}});
                document["attention"] = attention;
            }
            let raw = document.to_string();
            let config = parent.join("tui.jsonc");
            std::fs::write(&config, &raw).unwrap();
            let make_plan = || {
                plan_opencode_sources(
                    vec![SourceOccurrence {
                        logical_path: config.clone(),
                        canonical_source: config.clone(),
                        lane: SourceLane::Tui,
                        role: DiscoveryRole::Workspace,
                    }],
                    &cwd,
                    &home,
                    &|_, _, _| None,
                )
            };
            let plan =
                make_plan().expect("effective nested attention and cwd select native origins");
            let units = resource_units(
                &home,
                &home.join(".config/opencode"),
                &owned.path().join("workspace"),
                &plan,
                None,
            )
            .unwrap();
            let sound_unit = units
                .iter()
                .find(|(source, _)| source == &sound)
                .expect("native-origin sound transported");
            let tool_unit = units
                .iter()
                .find(|(source, _)| source == &tool)
                .expect("literal tilde cwd transports complete directory");
            let stage = owned.path().join("stage");
            let host = owned.path().join("host");
            let selections = units
                .iter()
                .map(|(source, unit)| CopySelection {
                    source: source.clone(),
                    destination_relative: unit.stage_relative_path.clone().into(),
                })
                .collect::<Vec<_>>();
            copy_environment(&selections, &stage, &[], Default::default()).unwrap();
            let selections = units
                .iter()
                .map(|(_, unit)| CopySelection {
                    source: stage.join(&unit.stage_relative_path),
                    destination_relative: unit.provider_relative_path.clone().into(),
                })
                .collect::<Vec<_>>();
            copy_environment(&selections, &host, &[], Default::default()).unwrap();
            let hidden = owned.path().join("hidden-external");
            std::fs::rename(owned.path().join("external"), &hidden).unwrap();
            let output = std::process::Command::new("node")
                .arg("server.cjs")
                .arg(host.join(&sound_unit.1.provider_relative_path))
                .current_dir(host.join(&tool_unit.1.provider_relative_path))
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap())
                .output()
                .unwrap();
            std::fs::rename(&hidden, owned.path().join("external")).unwrap();
            assert!(
                output.status.success(),
                "native-origin two-copy executable consumer failed: {:?}",
                output.stderr
            );
            assert_eq!(
                output.stdout,
                b"native-resource:native-dependency:native-sound"
            );
            assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
            std::fs::remove_file(&sound).unwrap();
            assert_eq!(
                make_plan()
                    .err()
                    .expect("missing native sound must refuse despite HOME decoy")
                    .field,
                "OpenCode attention.sounds"
            );
            std::fs::write(&sound, "native-sound").unwrap();
            std::fs::rename(&tool, owned.path().join("hidden-tool")).unwrap();
            assert_eq!(
                make_plan()
                    .err()
                    .expect("missing native cwd must refuse despite HOME decoy")
                    .field,
                "OpenCode mcp.cwd"
            );
        }
    }

    #[test]
    fn managed_provider_sound_and_mcp_cwd_refuse_unavailable_selected_resources() {
        use std::os::unix::fs::PermissionsExt;
        let owned = tempfile::tempdir().unwrap();
        let config = owned.path().join("tui.jsonc");
        for field in ["sound", "cwd"] {
            for case in ["missing", "unreadable", "cyclic", "wrong-type"] {
                let target = owned.path().join(format!("{field}-{case}"));
                match case {
                    "cyclic" => std::os::unix::fs::symlink(&target, &target).unwrap(),
                    "missing" => {}
                    _ if (field == "cwd") != (case == "wrong-type") => {
                        std::fs::create_dir(&target).unwrap()
                    }
                    _ => std::fs::write(&target, "resource").unwrap(),
                }
                if case == "unreadable" {
                    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o0))
                        .unwrap();
                }
                let raw=if field=="sound" {serde_json::json!({"attention":{"sounds":{"question":target}}})} else {serde_json::json!({"mcp":{"probe":{"type":"local","command":["node","server.cjs"],"cwd":target}}})}.to_string();
                std::fs::write(&config, &raw).unwrap();
                let result = plan_opencode_sources(
                    vec![SourceOccurrence {
                        logical_path: config.clone(),
                        canonical_source: config.clone(),
                        lane: SourceLane::Tui,
                        role: DiscoveryRole::Workspace,
                    }],
                    owned.path(),
                    owned.path(),
                    &|_, _, _| None,
                );
                if case == "unreadable" {
                    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o700))
                        .unwrap();
                }
                let error = result
                    .err()
                    .expect("selected unavailable sound/cwd must block preparation");
                assert_eq!(
                    error.field,
                    if field == "sound" {
                        "OpenCode attention.sounds"
                    } else {
                        "OpenCode mcp.cwd"
                    }
                );
                assert_eq!(error.declaring_source, config);
                assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
                assert!(!owned.path().join("stage").exists());
            }
        }
    }

    #[test]
    fn managed_provider_configured_skill_paths_execute_whole_directory_after_both_copies() {
        use std::os::unix::fs::PermissionsExt;
        let owned = match std::env::var_os("FRESHELL_TEST_EXECUTABLE_TMP_DIR") {
            Some(root) => tempfile::tempdir_in(root).unwrap(),
            None => tempfile::tempdir().unwrap(),
        };
        let home = owned.path().join("home");
        let cwd = owned.path().join("workspace/nested");
        let skill_root = owned.path().join("external-skills");
        let skill = skill_root.join("probe");
        for path in [&home, &cwd, &skill.join("scripts/node_modules/dependency")] {
            std::fs::create_dir_all(path).unwrap();
        }
        let skill_document = "---\nname: external-probe\ndescription: external selected skill\n---\nRun the adjacent executable.\n";
        std::fs::write(skill.join("SKILL.md"), skill_document).unwrap();
        std::fs::write(skill.join("scripts/resource"), "skill-resource").unwrap();
        std::fs::write(
            skill.join("scripts/node_modules/dependency/index.js"),
            "module.exports='skill-dependency';",
        )
        .unwrap();
        std::fs::write(skill.join("scripts/run"), "#!/usr/bin/env node\nconst fs=require('node:fs'),path=require('node:path');process.stdout.write(fs.readFileSync(path.join(__dirname,'resource'),'utf8')+':'+require('dependency'));").unwrap();
        std::fs::set_permissions(
            skill.join("scripts/run"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        let home_skill_root = home.join("selected-skills");
        std::os::unix::fs::symlink(&skill_root, &home_skill_root).unwrap();
        let config = home.join("opencode.jsonc");
        for spelling in [
            skill_root.to_str().unwrap(),
            "../../external-skills",
            "~/selected-skills",
        ] {
            let raw = format!("{{ // native selected field\n\"skills\":{{\"paths\":[{}],\"urls\":[\"https://example.invalid/skills\"]}},\"unrelated\":{{\"skills\":{{\"paths\":[\"/missing-unselected\"]}}}}}}", serde_json::to_string(spelling).unwrap());
            std::fs::write(&config, &raw).unwrap();
            let plan = plan_opencode_sources(
                vec![SourceOccurrence {
                    logical_path: config.clone(),
                    canonical_source: config.clone(),
                    lane: SourceLane::Main,
                    role: DiscoveryRole::Home,
                }],
                &cwd,
                &home,
                &|_, _, _| None,
            )
            .unwrap();
            let units = resource_units(
                &home,
                &home.join(".config/opencode"),
                &owned.path().join("workspace"),
                &plan,
                None,
            )
            .unwrap();
            let unit = units.iter().find(|(source, _)| source == &skill_root)
                .unwrap_or_else(|| panic!("configured external skills.paths selects its whole directory for {spelling}; selected {:?}", plan[0].configured_resources));
            let stage = owned.path().join("controller-stage");
            let host = owned.path().join("provider-home");
            copy_environment(
                &[CopySelection {
                    source: unit.0.clone(),
                    destination_relative: unit.1.stage_relative_path.clone().into(),
                }],
                &stage,
                &[],
                Default::default(),
            )
            .unwrap();
            copy_environment(
                &[CopySelection {
                    source: stage.join(&unit.1.stage_relative_path),
                    destination_relative: unit.1.provider_relative_path.clone().into(),
                }],
                &host,
                &[],
                Default::default(),
            )
            .unwrap();
            let projected = host.join(&unit.1.provider_relative_path).join("probe");
            let hidden = owned.path().join("hidden-original-skills");
            std::fs::rename(&skill_root, &hidden).unwrap();
            let output = execute_selected_resource(&projected.join("scripts/run")).unwrap();
            std::fs::rename(&hidden, &skill_root).unwrap();
            assert!(output.status.success(), "copied selected skill executable must consume installed dependencies and adjacent resources");
            assert_eq!(output.stdout, b"skill-resource:skill-dependency");
            assert_eq!(
                std::fs::read_to_string(projected.join("SKILL.md")).unwrap(),
                skill_document
            );
            assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
        }
    }

    #[test]
    fn managed_provider_configured_skill_paths_reject_unavailable_or_non_directory_selection() {
        use std::os::unix::fs::PermissionsExt;
        let owned = tempfile::tempdir().unwrap();
        let config = owned.path().join("opencode.json");
        let missing = owned.path().join("missing");
        let file = owned.path().join("file");
        let unreadable = owned.path().join("unreadable");
        let cyclic = owned.path().join("cyclic");
        std::fs::write(&file, "not a directory").unwrap();
        std::fs::create_dir(&unreadable).unwrap();
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o0)).unwrap();
        std::os::unix::fs::symlink(&cyclic, &cyclic).unwrap();
        for selected in [&missing, &file, &unreadable, &cyclic] {
            let raw = serde_json::json!({"skills":{"paths":[selected],"urls":["https://example.invalid/skills"]}}).to_string();
            std::fs::write(&config, &raw).unwrap();
            let result = plan_opencode_sources(
                vec![SourceOccurrence {
                    logical_path: config.clone(),
                    canonical_source: config.clone(),
                    lane: SourceLane::Main,
                    role: DiscoveryRole::Workspace,
                }],
                owned.path(),
                owned.path(),
                &|_, _, _| None,
            );
            let error = result
                .err()
                .expect("selected skill directory must be available before publication");
            assert_eq!(error.field, "OpenCode skills.paths");
            assert_eq!(error.declaring_source, config);
            assert_eq!(std::fs::read_to_string(&config).unwrap(), raw);
        }
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[test]
    fn managed_provider_configured_external_resources_execute_complete_transport() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let package = owned.path().join("external/package");
        for path in [&home, &workspace, &package.join("node_modules/dependency")] {
            std::fs::create_dir_all(path).unwrap();
        }
        std::fs::write(package.join("package.json"), r#"{"type":"module"}"#).unwrap();
        std::fs::write(package.join("helper.mjs"), "export default 'adjacent';").unwrap();
        std::fs::write(package.join("resource"), "resource").unwrap();
        std::fs::write(
            package.join("node_modules/dependency/package.json"),
            r#"{"type":"module","exports":"./index.mjs"}"#,
        )
        .unwrap();
        std::fs::write(
            package.join("node_modules/dependency/index.mjs"),
            "export default 'dependency';",
        )
        .unwrap();
        std::fs::write(package.join("index.mjs"), "import fs from 'node:fs';import helper from './helper.mjs';import dependency from 'dependency';console.log(helper+':'+dependency+':'+fs.readFileSync(new URL('./resource',import.meta.url),'utf8'));").unwrap();
        let instructions = owned.path().join("external/instructions.md");
        std::fs::write(&instructions, "instruction-resource").unwrap();
        let config = home.join("opencode.jsonc");
        let raw = format!("{{ // preserve comments\n\"plugin\":[[{},{{\"unrelated\":\"/unselected/path\"}}]],\"instructions\":[{}],}}", serde_json::to_string(&format!("file://{}",package.join("index.mjs").display())).unwrap(), serde_json::to_string(&instructions).unwrap());
        std::fs::write(&config, &raw).unwrap();
        let plan = plan_opencode_sources(
            vec![SourceOccurrence {
                logical_path: config.clone(),
                canonical_source: config.clone(),
                lane: SourceLane::Main,
                role: DiscoveryRole::Home,
            }],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        let units = resource_units(
            &home,
            &home.join(".config/opencode"),
            &workspace,
            &plan,
            None,
        )
        .unwrap();
        assert!(
            units.iter().any(|(source, _)| source == &package),
            "ordinary file-URL plugin must select its complete package"
        );
        assert!(
            units.iter().any(|(source, _)| source == &instructions),
            "ordinary instruction file must be transported"
        );
        let stage = owned.path().join("stage");
        copy_environment(
            &units
                .iter()
                .map(|(source, mount)| CopySelection {
                    source: source.clone(),
                    destination_relative: mount.stage_relative_path.clone().into(),
                })
                .collect::<Vec<_>>(),
            &stage,
            &[],
            Default::default(),
        )
        .unwrap();
        let plugin = units.iter().find(|(source, _)| source == &package).unwrap();
        let hidden = owned.path().join("hidden-original-resources");
        std::fs::rename(owned.path().join("external"), &hidden).unwrap();
        let output = std::process::Command::new("node")
            .arg(stage.join(&plugin.1.stage_relative_path).join("index.mjs"))
            .env_clear()
            .env("PATH", std::env::var_os("PATH").unwrap())
            .output()
            .unwrap();
        std::fs::rename(&hidden, owned.path().join("external")).unwrap();
        assert!(
            output.status.success(),
            "transported dependency and adjacent imports must execute"
        );
        assert_eq!(output.stdout, b"adjacent:dependency:resource\n");
        let instruction = units
            .iter()
            .find(|(source, _)| source == &instructions)
            .unwrap();
        assert_eq!(
            std::fs::read(stage.join(&instruction.1.stage_relative_path)).unwrap(),
            b"instruction-resource"
        );
        assert_eq!(std::fs::read_to_string(config).unwrap(), raw);
    }

    #[test]
    fn resource_mount_identity_does_not_shift_when_another_root_is_added() {
        use freshell_platform::opencode_recipe::{DiscoveryRole, DiscoveryRoot};

        let owned = tempfile::tempdir().unwrap();
        let extra = owned.path().join("a-extra-resource");
        let home = owned.path().join("z-provider-home");
        let global = home.join(".config/opencode");
        let workspace = owned.path().join("workspace");
        for path in [&extra, &global, &workspace] {
            std::fs::create_dir_all(path).unwrap();
        }
        let global_root = DiscoveryRoot {
            logical_path: global.clone(),
            role: DiscoveryRole::Global,
        };
        let extra_root = DiscoveryRoot {
            logical_path: extra,
            role: DiscoveryRole::Home,
        };

        let before = resource_units(
            &home,
            &global,
            &workspace,
            &[],
            Some(std::slice::from_ref(&global_root)),
        )
        .unwrap();
        let after = resource_units(
            &home,
            &global,
            &workspace,
            &[],
            Some(&[extra_root, global_root]),
        )
        .unwrap();
        let before_global = before
            .iter()
            .find(|(_, mount)| mount.logical_destination.ends_with("/.config/opencode"))
            .unwrap();
        let after_global = after
            .iter()
            .find(|(_, mount)| mount.logical_destination.ends_with("/.config/opencode"))
            .unwrap();
        assert_eq!(
            before_global.1.provider_relative_path, after_global.1.provider_relative_path,
            "adding a different resource root must not reassign the provider-owned subpath"
        );
    }

    #[test]
    fn recovery_reuses_matching_home_mount_and_retains_dropped_home_directories() {
        use freshell_runtime_protocol::{ProviderResourceKind, ProviderResourceMount};

        let previous = ProviderResourceMount {
            stage_relative_path: ".freshell/resource-units/root-legacy".into(),
            provider_relative_path: ".freshell/provider-roots/root-legacy".into(),
            logical_destination: "/home/freshell/provider/.config/opencode".into(),
            effective_destination: "/home/freshell/provider/.config/opencode".into(),
            kind: ProviderResourceKind::Directory,
            writable: false,
        };
        let mut current = vec![(
            "/synthetic/current-opencode-root".into(),
            ProviderResourceMount {
                stage_relative_path: ".freshell/resource-units/root-new".into(),
                provider_relative_path: ".freshell/provider-roots/root-new".into(),
                logical_destination: previous.logical_destination.clone(),
                effective_destination: previous.effective_destination.clone(),
                kind: ProviderResourceKind::Directory,
                writable: false,
            },
        )];
        let retained =
            merge_recovery_resource_mounts(&mut current, std::slice::from_ref(&previous)).unwrap();
        assert_eq!(
            current[0].1.stage_relative_path,
            previous.stage_relative_path
        );
        assert_eq!(
            current[0].1.provider_relative_path,
            previous.provider_relative_path
        );
        assert!(
            retained.is_empty(),
            "the current alias already retains this root"
        );

        let mut no_current_roots = Vec::new();
        let retained =
            merge_recovery_resource_mounts(&mut no_current_roots, std::slice::from_ref(&previous))
                .unwrap();
        assert_eq!(retained, vec![previous]);
    }

    #[test]
    fn recovery_rejects_nested_retained_and_current_directory_mounts() {
        use freshell_runtime_protocol::{ProviderResourceKind, ProviderResourceMount};

        let mount = |name: &str, destination: &str| ProviderResourceMount {
            stage_relative_path: format!(".freshell/resource-units/{name}"),
            provider_relative_path: format!(".freshell/provider-roots/{name}"),
            logical_destination: destination.into(),
            effective_destination: destination.into(),
            kind: ProviderResourceKind::Directory,
            writable: false,
        };

        for (current_destination, previous_destination) in [
            (
                "/home/freshell/provider/.config/opencode/plugins",
                "/home/freshell/provider/.config/opencode",
            ),
            (
                "/home/freshell/provider/.config/opencode",
                "/home/freshell/provider/.config/opencode/plugins",
            ),
        ] {
            let previous = mount("previous", previous_destination);
            let mut current = vec![(
                "/synthetic/current-resource".into(),
                mount("current", current_destination),
            )];
            let error =
                merge_recovery_resource_mounts(&mut current, std::slice::from_ref(&previous))
                    .expect_err("nested directory mount roots must preserve the prior generation");
            assert!(error.contains("overlapping") && error.contains("reprepare"));
        }

        let previous = mount("previous", "/home/freshell/provider/.config/opencode");
        let mut prefix_sibling = vec![(
            "/synthetic/current-resource".into(),
            mount("current", "/home/freshell/provider/.config/opencode-extra"),
        )];
        let retained =
            merge_recovery_resource_mounts(&mut prefix_sibling, std::slice::from_ref(&previous))
                .unwrap();
        assert_eq!(retained, vec![previous]);
    }

    #[test]
    fn recovery_resource_copy_selections_deduplicate_shared_alias_subpaths() {
        use freshell_runtime_protocol::{ProviderResourceKind, ProviderResourceMount};

        let owned = tempfile::tempdir().unwrap();
        let source = owned.path().join("shared");
        std::fs::create_dir(&source).unwrap();
        std::fs::write(source.join("resource.txt"), "shared-resource").unwrap();
        let mount = |destination: &str| ProviderResourceMount {
            stage_relative_path: ".freshell/resource-units/root-shared".into(),
            provider_relative_path: ".freshell/provider-roots/root-shared".into(),
            logical_destination: destination.into(),
            effective_destination: destination.into(),
            kind: ProviderResourceKind::Directory,
            writable: false,
        };
        let mut aliases = vec![(source, mount("/workspace/current"))];
        let prior = mount("/home/freshell/provider/.config/opencode");
        let retained =
            merge_recovery_resource_mounts(&mut aliases, std::slice::from_ref(&prior)).unwrap();
        assert_eq!(retained, vec![prior]);
        let source = current_source_for_resource_mount(&aliases, &retained[0])
            .expect("the selected alias already supplies this physical subpath");
        aliases.push((source, retained[0].clone()));

        let selections = resource_copy_selections(&aliases).unwrap();
        assert_eq!(aliases.len(), 2, "both aliases must remain mountable");
        assert_eq!(selections.len(), 1, "the shared staged tree is copied once");
        let stage = owned.path().join("stage");
        copy_environment(&selections, &stage, &[], Default::default()).unwrap();
        assert_eq!(
            std::fs::read_to_string(
                stage
                    .join(".freshell/resource-units/root-shared")
                    .join("resource.txt")
            )
            .unwrap(),
            "shared-resource"
        );
    }
}

/// Selected discovery roots are complete writable units, independent of the
/// private rewritten configuration leaves mounted inside them.
pub(super) fn resource_units(
    home: &Path,
    global: &Path,
    workspace: &Path,
    plan: &[PlannedSourceOccurrence],
    accepted_roots: Option<&[freshell_platform::opencode_recipe::DiscoveryRoot]>,
) -> Result<
    Vec<(
        std::path::PathBuf,
        freshell_runtime_protocol::ProviderResourceMount,
    )>,
    String,
> {
    use freshell_runtime_protocol::{ProviderResourceKind, ProviderResourceMount};
    use sha2::{Digest, Sha256};
    let mut roots = BTreeMap::new();
    let writable_resources = plan
        .iter()
        .flat_map(|source| source.configured_writable_resources.iter().cloned())
        .collect::<std::collections::BTreeSet<_>>();
    for root in accepted_roots.unwrap_or_default() {
        if root.role == crate::managed_provider_references::sources::DiscoveryRole::Unknown {
            return Err("selected resource discovery role is unrecorded".into());
        }
        let canonical = std::fs::canonicalize(&root.logical_path)
            .map_err(|_| "selected OpenCode resource root is unavailable, dangling or cyclic")?;
        if !canonical.is_dir() {
            return Err("selected OpenCode resource root must be a directory".into());
        }
        roots.insert((root.logical_path.clone(), root.role), canonical);
    }
    for source in plan {
        if source.source.lane == SourceLane::Inline {
            continue;
        }
        let Some(parent) = source.source.logical_path.parent() else {
            continue;
        };
        if parent == global || parent.file_name() != Some(std::ffi::OsStr::new(".opencode")) {
            continue;
        }
        let canonical = std::fs::canonicalize(parent)
            .map_err(|_| "selected OpenCode resource root is unavailable, dangling or cyclic")?;
        if !canonical.is_dir() {
            return Err("selected OpenCode resource root must be a directory".into());
        }
        roots.insert((parent.to_path_buf(), source.source.role), canonical);
    }
    for source in plan {
        for logical in &source.configured_resources {
            // The mounted workspace already supplies its native paths. External
            // paths and relocated HOME inputs need complete owned projections.
            if logical.starts_with(workspace) {
                continue;
            }
            let mut roles =
                vec![crate::managed_provider_references::sources::DiscoveryRole::Workspace];
            if logical.starts_with(global) {
                roles.push(crate::managed_provider_references::sources::DiscoveryRole::Global);
            } else if logical.starts_with(home) {
                roles.push(crate::managed_provider_references::sources::DiscoveryRole::Home);
            }
            for role in roles {
                if roots
                    .keys()
                    .any(|(root, root_role)| *root_role == role && logical.starts_with(root))
                {
                    continue;
                }
                let canonical = std::fs::canonicalize(logical)
                    .map_err(|_| "selected OpenCode configured resource is unavailable")?;
                roots.insert((logical.clone(), role), canonical);
            }
        }
    }
    // A containing directory supplies ordinary child inputs, but its writable
    // projection cannot preserve an exact file across provider refresh. Keep
    // every existing static write target as its own file root even when a
    // selected directory already covers that path.
    for writable in &writable_resources {
        if writable.starts_with(workspace) {
            continue;
        }
        let canonical = std::fs::canonicalize(writable)
            .map_err(|_| "selected OpenCode writable resource is unavailable")?;
        if canonical != *writable || !canonical.is_file() {
            return Err("selected OpenCode writable resource changed during preparation".into());
        }
        let mut roles = vec![crate::managed_provider_references::sources::DiscoveryRole::Workspace];
        if writable.starts_with(global) {
            roles.push(crate::managed_provider_references::sources::DiscoveryRole::Global);
        } else if writable.starts_with(home) {
            roles.push(crate::managed_provider_references::sources::DiscoveryRole::Home);
        }
        for role in roles {
            roots.insert((writable.clone(), role), canonical.clone());
        }
    }
    let mut units = Vec::new();
    let mut identities = BTreeMap::<std::path::PathBuf, String>::new();
    for ((logical, role), canonical) in roots {
        let name = if let Some(name) = identities.get(&canonical) {
            name.clone()
        } else {
            let canonical_text = canonical
                .to_str()
                .ok_or("selected OpenCode resource root is not UTF-8")?;
            let name = format!("root-{:x}", Sha256::digest(canonical_text.as_bytes()));
            identities.insert(canonical.clone(), name.clone());
            name
        };
        let kind = if canonical.is_file() {
            ProviderResourceKind::File
        } else {
            ProviderResourceKind::Directory
        };
        let writable =
            kind == ProviderResourceKind::File && writable_resources.contains(&canonical);
        let name = if kind == ProviderResourceKind::File {
            format!("{name}/source")
        } else {
            name
        };
        let destination = freshell_platform::opencode_config::lexical_path(
            &crate::managed_provider_references::sources::runtime_directory_destination(
                home, global, &logical, role,
            ),
        );
        let effective = if destination.starts_with("/home/freshell/provider")
            || !logical.starts_with(workspace)
        {
            // HOME is a new physical graph. Ancestor links outside the mounted
            // workspace are also absent there, so mount their logical roots
            // directly without modifying the original user topology.
            destination.clone()
        } else {
            crate::managed_provider_references::sources::runtime_directory_destination(
                home, global, &canonical, role,
            )
        };
        units.push((
            canonical,
            ProviderResourceMount {
                stage_relative_path: format!(".freshell/resource-units/{name}"),
                provider_relative_path: format!(".freshell/provider-roots/{name}"),
                logical_destination: destination
                    .to_str()
                    .ok_or("resource destination is not UTF-8")?
                    .into(),
                effective_destination: effective
                    .to_str()
                    .ok_or("resource destination is not UTF-8")?
                    .into(),
                kind,
                writable,
            },
        ));
    }
    Ok(units)
}

/// Preserve managed OpenCode HOME aliases across recovery. Resource contents
/// live under provider-volume subpaths, so dropping a no-longer-selected alias
/// would hide provider-created files left beside the previously selected data.
pub(super) fn merge_recovery_resource_mounts(
    current: &mut [(
        std::path::PathBuf,
        freshell_runtime_protocol::ProviderResourceMount,
    )],
    previous: &[freshell_runtime_protocol::ProviderResourceMount],
) -> Result<Vec<freshell_runtime_protocol::ProviderResourceMount>, String> {
    use freshell_runtime_protocol::{ProviderResourceKind, ProviderResourceMount};
    const PROVIDER_HOME: &str = "/home/freshell/provider";

    fn paired_resource_paths(mount: &ProviderResourceMount) -> bool {
        let Some(stage) = mount
            .stage_relative_path
            .strip_prefix(".freshell/resource-units/")
        else {
            return false;
        };
        let Some(provider) = mount
            .provider_relative_path
            .strip_prefix(".freshell/provider-roots/")
        else {
            return false;
        };
        stage == provider
            && !stage.is_empty()
            && [
                Path::new(&mount.stage_relative_path),
                Path::new(&mount.provider_relative_path),
            ]
            .iter()
            .all(|path| {
                !path.is_absolute()
                    && path
                        .components()
                        .all(|part| matches!(part, std::path::Component::Normal(_)))
            })
    }

    for (_, mount) in current.iter_mut() {
        if let Some(prior) = previous
            .iter()
            .find(|prior| prior.effective_destination == mount.effective_destination)
        {
            if prior.kind != mount.kind || !paired_resource_paths(prior) {
                return Err(
                    "prior OpenCode resource mount changed type or identity; retain inputs and reprepare"
                        .into(),
                );
            }
            mount.stage_relative_path = prior.stage_relative_path.clone();
            mount.provider_relative_path = prior.provider_relative_path.clone();
        }
    }

    let current_destinations = current
        .iter()
        .map(|(_, mount)| mount.effective_destination.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut retained_destinations = std::collections::HashSet::new();
    let mut retained = Vec::new();
    for prior in previous {
        if current_destinations.contains(prior.effective_destination.as_str())
            || prior.kind != ProviderResourceKind::Directory
            || !Path::new(&prior.effective_destination).starts_with(PROVIDER_HOME)
        {
            continue;
        }
        if !paired_resource_paths(prior) {
            return Err(
                "prior OpenCode resource mount identity is invalid; retain inputs and reprepare"
                    .into(),
            );
        }
        if retained_destinations.insert(prior.effective_destination.clone()) {
            retained.push(prior.clone());
        }
    }
    let merged = current
        .iter()
        .map(|(_, mount)| mount)
        .chain(retained.iter())
        .collect::<Vec<_>>();
    for (index, left) in merged.iter().enumerate() {
        if left.kind != ProviderResourceKind::Directory {
            continue;
        }
        for right in merged.iter().skip(index + 1) {
            if right.kind != ProviderResourceKind::Directory
                || left.effective_destination == right.effective_destination
            {
                continue;
            }
            let left_path = Path::new(&left.effective_destination);
            let right_path = Path::new(&right.effective_destination);
            if left_path.starts_with(right_path) || right_path.starts_with(left_path) {
                return Err(
                    "overlapping retained OpenCode resource mount destinations; retain inputs and reprepare"
                        .into(),
                );
            }
        }
    }
    Ok(retained)
}

/// Build one physical staging copy per accepted resource subpath while leaving
/// every logical alias descriptor available for the runtime mount plan.
pub(super) fn resource_copy_selections(
    units: &[(
        std::path::PathBuf,
        freshell_runtime_protocol::ProviderResourceMount,
    )],
) -> Result<Vec<freshell_platform::provider_environment::CopySelection>, String> {
    use freshell_platform::provider_environment::CopySelection;
    let mut sources = BTreeMap::<std::path::PathBuf, std::path::PathBuf>::new();
    let mut selections = Vec::new();
    for (source, mount) in units {
        let destination = Path::new(&mount.stage_relative_path).to_owned();
        let canonical = std::fs::canonicalize(source)
            .map_err(|_| "selected OpenCode resource stage source is unavailable")?;
        match sources.get(&destination) {
            Some(prior) if prior == &canonical => continue,
            Some(_) => {
                return Err(
                    "shared OpenCode resource subpath has conflicting sources; retain inputs and reprepare"
                        .into(),
                )
            }
            None => {
                sources.insert(destination.clone(), canonical);
                selections.push(CopySelection {
                    source: source.clone(),
                    destination_relative: destination,
                });
            }
        }
    }
    Ok(selections)
}

/// Keep a package resource that contains the mounted workspace without
/// copying the workspace into the package unit. Each unit is filtered before
/// the aggregate staging copy, so independently selected workspace resources
/// remain eligible for their own resource mounts.
pub(super) fn filter_workspace_from_enclosing_resource_units(
    units: &mut [(
        std::path::PathBuf,
        freshell_runtime_protocol::ProviderResourceMount,
    )],
    provider: &str,
    workspace: &Path,
    scratch_root: &Path,
    excluded_canonical_sources: &[std::path::PathBuf],
) -> Result<(), String> {
    use freshell_platform::provider_environment::{
        copy_environment_excluding_subtree, CopySelection,
    };
    use freshell_runtime_protocol::ProviderResourceKind;

    if units.is_empty() {
        return Ok(());
    }
    let canonical_workspace = std::fs::canonicalize(workspace)
        .map_err(|_| "managed provider workspace is unavailable for resource staging")?;
    let mut filtered_sources = BTreeMap::<std::path::PathBuf, std::path::PathBuf>::new();
    for (index, (source, mount)) in units.iter_mut().enumerate() {
        if mount.kind != ProviderResourceKind::Directory {
            continue;
        }
        let canonical_source = std::fs::canonicalize(&*source)
            .map_err(|_| "selected OpenCode resource stage source is unavailable")?;
        if canonical_workspace == canonical_source {
            continue;
        }
        let contains_workspace = canonical_workspace.starts_with(&canonical_source)
            || resource_contains_workspace_alias(&canonical_source, &canonical_workspace)?;
        if !contains_workspace {
            continue;
        }
        if let Some(filtered_source) = filtered_sources.get(&canonical_source) {
            *source = filtered_source.clone();
            continue;
        }

        let destination_root = scratch_root.join(index.to_string());
        let resource_source_leaf = source
            .file_name()
            .map(|leaf| leaf.to_string_lossy().into_owned())
            .unwrap_or_default();
        let resource_destination_leaf = Path::new(&mount.logical_destination)
            .file_name()
            .map(|leaf| leaf.to_string_lossy().into_owned())
            .unwrap_or_default();
        let started = std::time::Instant::now();
        tracing::info!(
            event = "provider.environment.copy.started",
            stage = "controller",
            provider,
            resource_stage_path = %mount.stage_relative_path,
            resource_source_leaf,
            resource_destination_leaf,
            "Copying bounded provider resource with nested workspace excluded"
        );
        let report = copy_environment_excluding_subtree(
            &[CopySelection {
                source: source.clone(),
                destination_relative: "resource".into(),
            }],
            &destination_root,
            excluded_canonical_sources,
            &canonical_workspace,
            Default::default(),
        );
        let report = match report {
            Ok(report) => report,
            Err(error) => {
                tracing::error!(
                    event = "provider.environment.copy.failed",
                    stage = "controller",
                    provider,
                    operation = error.operation,
                    relative_path = %error.relative_path.display(),
                    resource_stage_path = %mount.stage_relative_path,
                    resource_source_leaf,
                    resource_destination_leaf,
                    limit_kind = error.limit_kind,
                    observed = error.observed,
                    permitted = error.permitted,
                    elapsed_ms = started.elapsed().as_millis() as u64,
                    corrective_message = %error.corrective_message
                );
                return Err(format!(
                    "failed to bound enclosing provider resource: {error}"
                ));
            }
        };
        tracing::info!(
            event = "provider.environment.copy.completed",
            stage = "controller",
            provider,
            resource_stage_path = %mount.stage_relative_path,
            resource_source_leaf,
            resource_destination_leaf,
            entries = report.entries,
            bytes = report.bytes,
            elapsed_ms = started.elapsed().as_millis() as u64
        );
        let filtered_source = destination_root.join("resource");
        filtered_sources.insert(canonical_source, filtered_source.clone());
        *source = filtered_source;
    }
    Ok(())
}

#[cfg(unix)]
fn resource_contains_workspace_alias(source: &Path, workspace: &Path) -> Result<bool, String> {
    let limits = freshell_platform::provider_environment::CopyLimits::default();
    let mut pending = vec![(source.to_owned(), 0usize)];
    let mut entries = 0usize;
    while let Some((directory, depth)) = pending.pop() {
        if depth > limits.max_depth {
            return Err("selected OpenCode resource exceeds the directory depth limit while checking workspace aliases".into());
        }
        let children = std::fs::read_dir(&directory).map_err(|_| {
            "selected OpenCode resource could not be inspected for workspace aliases"
        })?;
        for child in children {
            let child = child.map_err(|_| {
                "selected OpenCode resource could not be inspected for workspace aliases"
            })?;
            entries = entries
                .checked_add(1)
                .ok_or("selected OpenCode resource entry accounting overflow")?;
            if entries > limits.max_entries {
                return Err("selected OpenCode resource exceeds the entry limit while checking workspace aliases".into());
            }
            let path = child.path();
            let file_type = child.file_type().map_err(|_| {
                "selected OpenCode resource could not be inspected for workspace aliases"
            })?;
            if file_type.is_symlink() {
                let target = std::fs::canonicalize(&path).map_err(|_| {
                    "selected OpenCode resource contains a symbolic link that cannot be resolved"
                })?;
                if target == workspace || target.starts_with(workspace) {
                    return Ok(true);
                }
            } else if file_type.is_dir() {
                pending.push((path, depth + 1));
            }
        }
    }
    Ok(false)
}

#[cfg(not(unix))]
fn resource_contains_workspace_alias(_source: &Path, _workspace: &Path) -> Result<bool, String> {
    Ok(false)
}

pub(super) fn current_source_for_resource_mount(
    current: &[(
        std::path::PathBuf,
        freshell_runtime_protocol::ProviderResourceMount,
    )],
    mount: &freshell_runtime_protocol::ProviderResourceMount,
) -> Option<std::path::PathBuf> {
    current
        .iter()
        .find(|(_, candidate)| {
            candidate.stage_relative_path == mount.stage_relative_path
                && candidate.provider_relative_path == mount.provider_relative_path
        })
        .map(|(source, _)| source.clone())
}

pub(super) fn read_source_view(root: &Path, relative: &str) -> Result<String, String> {
    use std::io::Read;
    if Path::new(relative)
        .components()
        .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("accepted source view has an invalid private path".into());
    }
    let path = root.join(relative);
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| "accepted source view must be a physical stage file")?;
    if !metadata.is_file()
        || metadata.file_type().is_symlink()
        || std::fs::canonicalize(&path).map_err(|_| "accepted source view is unavailable")? != path
    {
        return Err("accepted source view must be a physical stage file".into());
    }
    if metadata.len() > MAX_SOURCE_VIEW_BYTES {
        return Err("accepted source view exceeds 16 MiB".into());
    }
    let mut raw = String::new();
    std::fs::File::open(path)
        .map_err(|_| "accepted source view is unavailable")?
        .take(MAX_SOURCE_VIEW_BYTES + 1)
        .read_to_string(&mut raw)
        .map_err(|_| "accepted source view read failed")?;
    if raw.len() as u64 > MAX_SOURCE_VIEW_BYTES {
        return Err("accepted source view exceeds 16 MiB".into());
    }
    Ok(raw)
}

pub(super) fn stage(
    root: &Path,
    home: &Path,
    cwd: &Path,
    plan: &[PlannedSourceOccurrence],
    input: super::OpencodeEphemeralInput<'_>,
) -> Result<(), String> {
    let mut manifest = SourceManifest {
        version: 1,
        cwd: cwd.into(),
        original_home: home.into(),
        global_config_root: Some(
            input
                .config_root
                .unwrap_or(&home.join(".config/opencode"))
                .to_path_buf(),
        ),
        sources: Vec::new(),
        files: Vec::new(),
        frozen_inputs: input.frozen_inputs.unwrap_or(&[]).to_vec(),
        user_owns_freshell_mcp: false,
        native_source_flags: input.native_source_flags.unwrap_or(&[]).to_vec(),
        resource_roots: input.resource_roots.unwrap_or(&[]).to_vec(),
        rebind_enabled: input.rebind_enabled.unwrap_or(true),
        inline_edits: input.inline_edits.cloned().unwrap_or_default(),
    };
    private_directory(&root.join(".freshell/source-views"))?;
    private_directory(&root.join(".freshell/templates"))?;
    let mut files = BTreeMap::new();
    let mut view_budget = crate::managed_provider_references::sources::SourceViewBudget::default();
    for (ordinal, source) in plan.iter().enumerate() {
        if source.source.role == crate::managed_provider_references::sources::DiscoveryRole::Unknown
        {
            return Err("selected configuration discovery role is unrecorded".into());
        }
        if source.source.lane == SourceLane::Main {
            manifest.user_owns_freshell_mcp |= source.user_owns_freshell_mcp;
        }
        view_budget
            .charge(source.references.unexpanded_source())
            .map_err(str::to_string)?;
        view_budget
            .charge(&source.references.template)
            .map_err(str::to_string)?;
        if ordinal >= 8192 {
            return Err("source view profile exceeded before stage publication".into());
        }
        let raw = format!(".freshell/source-views/source-{ordinal}");
        let template = format!(".freshell/templates/source-{ordinal}");
        write_private_bytes(
            &root.join(&raw),
            source.references.unexpanded_source().as_bytes(),
        )?;
        write_private_bytes(&root.join(&template), source.references.template.as_bytes())?;
        for selection in &source.references.selections {
            let index = selection
                .runtime_destination
                .strip_prefix("/home/freshell/provider/.freshell/references/")
                .and_then(|value| value.parse::<u16>().ok())
                .filter(|value| *value < 128)
                .ok_or("source plan contains an invalid indexed destination")?;
            if files
                .insert(index, selection.canonical_source.clone())
                .is_some_and(|prior| prior != selection.canonical_source)
            {
                return Err("source plan changes one indexed source identity".into());
            }
        }
        manifest.sources.push(SourceView {
            logical_path: source.source.logical_path.clone(),
            discovery_role: source.source.role,
            native_destination: Some(
                crate::managed_provider_references::sources::runtime_config_destination(
                    home,
                    input.config_root.unwrap_or(&home.join(".config/opencode")),
                    &source.source.logical_path,
                    source.source.role,
                )
                .to_str()
                .ok_or("native source destination is not UTF-8")?
                .into(),
            ),
            lane: match source.source.lane {
                SourceLane::Main => freshell_platform::opencode_recipe::SourceLane::Main,
                SourceLane::Tui => freshell_platform::opencode_recipe::SourceLane::Tui,
                SourceLane::Inline => freshell_platform::opencode_recipe::SourceLane::Inline,
            },
            unexpanded_relative_path: raw,
            template_relative_path: template,
            template_sha256: Some({
                use sha2::Digest;
                format!(
                    "{:x}",
                    sha2::Sha256::digest(source.references.template.as_bytes())
                )
            }),
            generated_name: source
                .references
                .recipes
                .first()
                .map(|recipe| recipe.generated_name.clone()),
            occurrences: source.references.occurrences.clone(),
            referenced_variables: source.references.referenced_variables.clone(),
            path_variables: source.references.path_variables.clone(),
            original_form: source.original_form,
        });
    }
    for (expected, (source_id, canonical_source)) in files.into_iter().enumerate() {
        if source_id as usize != expected {
            return Err("source indexes are not contiguous".into());
        }
        manifest.files.push(SelectedSourceFile {
            source_id,
            canonical_source,
        });
    }
    let metadata = freshell_runtime_protocol::bounded_json_bytes(&manifest, 64 * 1024 * 1024)
        .map_err(|_| "source manifest metadata profile exceeded")?;
    write_private_bytes(&root.join(".freshell/input-manifest.json"), &metadata)
}

pub(super) struct DescriptionRoots<'a> {
    pub root: &'a Path,
    pub home: &'a Path,
    pub config_root: Option<&'a Path>,
    pub workspace: &'a Path,
}

pub(super) fn describe(
    roots: DescriptionRoots<'_>,
    plan: &[PlannedSourceOccurrence],
    soul: &freshell_runtime_protocol::SoulId,
    capability: &freshell_runtime_protocol::McpCapabilityReference,
    initial_auth_reservation: Option<&str>,
    secret_references: &[freshell_runtime_protocol::ProviderSecretReference],
) -> Result<freshell_runtime_protocol::PreparedProviderInputs, String> {
    use freshell_runtime_protocol::*;
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let DescriptionRoots {
        root,
        home,
        config_root,
        workspace,
    } = roots;
    let runtime_home = Path::new("/home/freshell/provider");
    let default_global = home.join(".config/opencode");
    let global = config_root.unwrap_or(&default_global);
    let resource_mounts: Vec<ProviderResourceMount> = {
        let mut bytes = Vec::new();
        std::fs::File::open(root.join(".freshell/resource-mounts.json"))
            .map_err(|_| "prepared resource manifest unavailable")?
            .take(MAX_CONTROL_FRAME_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| "prepared resource manifest read failed")?;
        if bytes.len() > MAX_CONTROL_FRAME_BYTES {
            return Err("prepared resource descriptor exceeds control profile".into());
        }
        serde_json::from_slice(&bytes).map_err(|_| "prepared resource descriptors invalid")?
    };
    let mut sources = BTreeMap::new();
    let mut binds = Vec::new();
    let mut bind_sources = BTreeMap::<std::path::PathBuf, &str>::new();
    let mut recipes = 0usize;
    let mut aliases = Vec::new();
    let mut alias_sources = BTreeMap::new();
    for (ordinal, occurrence) in plan.iter().enumerate() {
        if occurrence.source.lane != SourceLane::Inline
            && (!occurrence.original_form
                || occurrence.requires_config_bind
                || occurrence.references.template.as_str()
                    != occurrence.references.unexpanded_source())
        {
            let logical = &occurrence.source.logical_path;
            let destination = freshell_platform::opencode_config::lexical_path(
                &crate::managed_provider_references::sources::runtime_config_destination(
                    home,
                    global,
                    logical,
                    occurrence.source.role,
                ),
            );
            let effective = if occurrence.source.role
                == freshell_platform::opencode_recipe::DiscoveryRole::Global
            {
                let relative = logical
                    .strip_prefix(global)
                    .map_err(|_| "global source is outside its discovery root")?;
                let physical = std::fs::canonicalize(root.join(relative))
                    .map_err(|_| "selected global config is unavailable in its private stage")?;
                let relative = physical
                    .strip_prefix(root)
                    .map_err(|_| "selected global config escaped its owned stage")?;
                if let Some((unit, suffix)) = resource_mounts.iter().find_map(|unit| {
                    if !destination.starts_with(&unit.logical_destination) {
                        return None;
                    }
                    let suffix = relative.strip_prefix(&unit.stage_relative_path).ok()?;
                    if unit.kind == ProviderResourceKind::File && !suffix.as_os_str().is_empty() {
                        return None;
                    }
                    Some((unit, suffix))
                }) {
                    // The shared copier can place a global config in its
                    // already selected resource unit. Its private template
                    // must cover that unit's native alias, not a new nested
                    // filename containing the controller's stage path.
                    if suffix.as_os_str().is_empty() {
                        Path::new(&unit.effective_destination).to_owned()
                    } else {
                        Path::new(&unit.effective_destination).join(suffix)
                    }
                } else if relative.starts_with(".freshell/resources") {
                    runtime_home.join(relative)
                } else {
                    runtime_home.join(".config/opencode").join(relative)
                }
            } else if let Some(unit) = resource_mounts
                .iter()
                .find(|unit| destination.starts_with(&unit.logical_destination))
            {
                Path::new(&unit.effective_destination).join(
                    destination
                        .strip_prefix(&unit.logical_destination)
                        .map_err(|_| "config origin is outside its selected resource root")?,
                )
            } else if occurrence.source.role
                == freshell_platform::opencode_recipe::DiscoveryRole::Workspace
                && !logical.starts_with(workspace)
            {
                destination.clone()
            } else {
                crate::managed_provider_references::sources::runtime_config_destination(
                    home,
                    global,
                    &occurrence.source.canonical_source,
                    occurrence.source.role,
                )
            };
            let relative = format!(".freshell/templates/source-{ordinal}");
            let prior = bind_sources.get(&effective);
            if prior.is_some_and(|template| *template != occurrence.references.template.as_str()) {
                return Err("shared effective config target has incompatible templates; retain prior inputs and reprepare".into());
            }
            if prior.is_none() {
                bind_sources.insert(effective.clone(), &occurrence.references.template);
                binds.push(ProviderConfigBind {
                    source_relative_path: relative,
                    logical_destination: destination
                        .to_str()
                        .ok_or("config destination is not UTF-8")?
                        .into(),
                    effective_destination: effective
                        .to_str()
                        .ok_or("config destination is not UTF-8")?
                        .into(),
                });
            }
        }
        recipes = recipes
            .checked_add(occurrence.references.recipes.len())
            .ok_or("source recipe count overflow")?;
        for selected in &occurrence.references.selections {
            let id = selected
                .runtime_destination
                .strip_prefix("/home/freshell/provider/.freshell/references/")
                .and_then(|id| id.parse::<u16>().ok())
                .filter(|id| *id < 128)
                .ok_or("invalid selected source index")?;
            if sources
                .insert(id, &selected.canonical_source)
                .is_some_and(|prior| prior != &selected.canonical_source)
            {
                return Err("selected source identity changed under one index".into());
            }
        }
        if occurrence.original_form {
            for approved in &occurrence.references.occurrences {
                let Some(kind) = occurrence
                    .references
                    .native_alias_kinds
                    .get(&approved.ordinal)
                else {
                    continue;
                };
                let source_id = approved
                    .runtime_destination
                    .strip_prefix("/home/freshell/provider/.freshell/references/")
                    .and_then(|value| value.parse::<u16>().ok())
                    .ok_or("original-form alias has no approved source index")?;
                let selected = sources
                    .get(&source_id)
                    .ok_or("original-form alias index is unavailable")?;
                let logical = match kind {
                    crate::managed_provider_references::NativeAliasKind::Absolute => {
                        approved.approved_alias.clone()
                    }
                    crate::managed_provider_references::NativeAliasKind::Home => {
                        crate::managed_provider_references::sources::runtime_config_destination(
                            home,
                            global,
                            &approved.approved_alias,
                            crate::managed_provider_references::sources::DiscoveryRole::Home,
                        )
                    }
                    crate::managed_provider_references::NativeAliasKind::Relative => {
                        crate::managed_provider_references::sources::runtime_config_destination(
                            home,
                            global,
                            &approved.approved_alias,
                            occurrence.source.role,
                        )
                    }
                };
                // The host installs the selected typed file at this path.
                // Covering it with a readonly alias would prevent its atomic
                // refresh, even when both projections selected the same bytes.
                if let Some(reference) = secret_references.iter().find(|reference| {
                    reference.profile == ProviderSecretProfile::OpencodeOnecliCaFile
                        && reference
                            .profile
                            .provider_file_relative_path()
                            .is_some_and(|relative| runtime_home.join(relative) == logical)
                }) {
                    let typed_source =
                        std::fs::canonicalize(&reference.source_path).map_err(|_| {
                            "selected typed CA source is unavailable before publication"
                        })?;
                    if typed_source != **selected {
                        return Err("selected runtime CA alias conflicts with its typed source; retain prior inputs and reprepare".into());
                    }
                    continue;
                }
                let effective = if let Some(unit) = resource_mounts.iter().find(|unit| {
                    unit.kind == ProviderResourceKind::Directory
                        && logical.starts_with(&unit.logical_destination)
                }) {
                    Path::new(&unit.effective_destination).join(
                        logical
                            .strip_prefix(&unit.logical_destination)
                            .map_err(|_| {
                                "selected private alias lost its approved resource origin"
                            })?,
                    )
                } else {
                    match kind {
                        crate::managed_provider_references::NativeAliasKind::Absolute if logical.starts_with(workspace) => selected.as_path().to_path_buf(),
                        crate::managed_provider_references::NativeAliasKind::Relative
                            if occurrence.source.role == crate::managed_provider_references::sources::DiscoveryRole::Workspace
                                && occurrence.source.logical_path.starts_with(workspace) => selected.as_path().to_path_buf(),
                        _ => logical.clone(),
                    }
                };
                if let Some(prior) = alias_sources.insert(logical.clone(), source_id) {
                    if prior != source_id {
                        return Err("shared source has conflicting private alias selections; reprepare before dispatch".into());
                    }
                    continue;
                }
                if aliases.len() >= 256 {
                    return Err("configuration alias count exceeds 256".into());
                }
                aliases.push(IndexedProviderFileAlias {
                    source_id,
                    logical_destination: logical
                        .to_str()
                        .ok_or("alias destination is not UTF-8")?
                        .into(),
                    effective_destination: effective
                        .to_str()
                        .ok_or("alias destination is not UTF-8")?
                        .into(),
                });
            }
        }
    }
    let mut file = std::fs::File::open(root.join(".freshell/input-manifest.json"))
        .map_err(|_| "prepared source manifest unavailable")?
        .take(64 * 1024 * 1024 + 1);
    let mut hash = Sha256::new();
    let mut used = 0usize;
    let mut buffer = [0; 64 * 1024];
    loop {
        let size = file
            .read(&mut buffer)
            .map_err(|_| "prepared source manifest read failed")?;
        if size == 0 {
            break;
        }
        used = used
            .checked_add(size)
            .ok_or("source manifest size overflow")?;
        if used > 64 * 1024 * 1024 {
            return Err("source manifest metadata exceeds 64 MiB".into());
        }
        hash.update(&buffer[..size]);
    }
    let inputs = PreparedProviderInputs {
        generation_id: capability.grant_id.clone(),
        initial_auth_reservation: initial_auth_reservation.map(str::to_string),
        manifest: ProviderInputManifestReference {
            relative_path: ".freshell/input-manifest.json".into(),
            sha256: format!("{:x}", hash.finalize()),
            source_count: u16::try_from(sources.len())
                .map_err(|_| "selected source count overflow")?,
            alias_count: u16::try_from(aliases.len()).map_err(|_| "source alias count overflow")?,
            recipe_count: u16::try_from(recipes).map_err(|_| "recipe count overflow")?,
        },
        config_binds: binds,
        resource_mounts,
        indexed_files: (!sources.is_empty()).then(|| IndexedProviderFiles {
            volume_name: indexed_provider_volume_name(soul, &capability.grant_id),
            aliases,
            // New launches keep only the original configuration file path in
            // ProviderSecretReference. The supervisor streams bytes directly
            // into the provider's bounded tmpfs input volume; duplicating the
            // payload in this durable generation could persist credentials.
            // `Some(...)` remains supported when adopting older descriptors.
            staged_source_paths: None,
        }),
    };
    inputs
        .validate(Some(capability))
        .map_err(|error| error.message)?;
    let metadata = bounded_json_bytes(&inputs, MAX_CONTROL_FRAME_BYTES)
        .map_err(|_| "prepared descriptor exceeds control profile")?;
    write_private_bytes(&root.join(".freshell/prepared-inputs.json"), &metadata)?;
    super::allow_controller_stage_read(&root.join(".freshell/prepared-inputs.json"))?;
    Ok(inputs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_mcp_ownership_survives_sidecar_cleanup_after_resource_selection() {
        let owned = tempfile::tempdir().unwrap();
        let home = owned.path().join("home");
        let workspace = owned.path().join("workspace");
        let config_dir = workspace.join(".opencode");
        let config = config_dir.join("opencode.json");
        let sidecar = config_dir.join(".freshell-mcp-state.json");
        let stage_root = owned.path().join("stage");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::create_dir(&stage_root).unwrap();
        let command = serde_json::json!(["node", "/opt/freshell-mcp/server.js"]);
        std::fs::write(
            &config,
            serde_json::json!({"mcp":{"freshell":{"command":command}}}).to_string(),
        )
        .unwrap();
        std::fs::write(
            &sidecar,
            serde_json::json!({"createdEntry":true,"ownedCommand":command}).to_string(),
        )
        .unwrap();

        let plan = crate::managed_provider_references::sources::plan_opencode_sources(
            vec![
                crate::managed_provider_references::sources::SourceOccurrence {
                    logical_path: config.clone(),
                    canonical_source: config.clone(),
                    lane: crate::managed_provider_references::sources::SourceLane::Main,
                    role: crate::managed_provider_references::sources::DiscoveryRole::Workspace,
                },
            ],
            &workspace,
            &home,
            &|_, _, _| None,
        )
        .unwrap();
        assert!(plan[0].configured_resources.is_empty());

        // Ordinary OpenCode terminal cleanup can remove this after selection.
        std::fs::remove_file(&sidecar).unwrap();
        stage(
            &stage_root,
            &home,
            &workspace,
            &plan,
            super::super::OpencodeEphemeralInput {
                config_root: Some(&home.join(".config/opencode")),
                ..Default::default()
            },
        )
        .unwrap();

        let manifest: freshell_platform::opencode_recipe::SourceManifest = serde_json::from_slice(
            &std::fs::read(stage_root.join(".freshell/input-manifest.json")).unwrap(),
        )
        .unwrap();
        assert!(
            !manifest.user_owns_freshell_mcp,
            "staging must keep the generated-entry ownership decision paired with resource selection"
        );
    }

    #[test]
    fn accepted_source_view_rejects_actual_oversize_before_reading_or_prior_mutation() {
        let owned = tempfile::tempdir().unwrap();
        let root = owned.path().join("stage");
        std::fs::create_dir(&root).unwrap();
        let path = root.join("view");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(16 * 1024 * 1024 + 1).unwrap();
        let before = std::time::UNIX_EPOCH + std::time::Duration::from_secs(1);
        file.set_times(std::fs::FileTimes::new().set_accessed(before))
            .unwrap();
        let prior = owned.path().join("prior");
        std::fs::write(&prior, b"prior-accepted-source-view").unwrap();
        let result = read_source_view(&root, "view");
        assert!(result.is_err());
        assert_eq!(
            std::fs::metadata(&path).unwrap().accessed().unwrap(),
            before,
            "oversized stage view must be rejected from metadata before source bytes are read"
        );
        assert_eq!(
            std::fs::read(&prior).unwrap(),
            b"prior-accepted-source-view"
        );
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 1);
        file.set_len(16 * 1024 * 1024).unwrap();
        assert_eq!(
            read_source_view(&root, "view").unwrap().len(),
            16 * 1024 * 1024
        );
    }
}
