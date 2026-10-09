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
                r#"{{"instructions":[{obsolete_json}],/* final wins */"instructions":[{instruction_json}]}}"#
            ),
            format!(
                r#"{{"skills":{{"paths":[{obsolete_json}]}},"skills":{{"paths":[{skills_json}]}}}}"#
            ),
            format!(r#"{{"skills":{{"paths":[{obsolete_json}],"pa\u0074hs":[{skills_json}]}}}}"#),
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
                let output = std::process::Command::new(projected.join("run"))
                    .env_clear()
                    .env("PATH", std::env::var_os("PATH").unwrap())
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "winning resource/dependency executable failed: {output:?}"
                );
                assert_eq!(output.stdout, b"winning-resource:winning-dependency");
                assert!(std::fs::read_to_string(projected.join("SKILL.md"))
                    .unwrap()
                    .contains("name: winning"));
            }
            std::fs::rename(&hidden, owned.path().join("external")).unwrap();
            assert_eq!(std::fs::read_to_string(&config).unwrap(), *raw);
        }
        for field in ["plugin", "instructions", "skills-object", "skills-paths"] {
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
                    std::fs::set_permissions(&resource, std::fs::Permissions::from_mode(0))
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
                    std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0)).unwrap();
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
            let output = std::process::Command::new(projected.join("scripts/run"))
                .env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap())
                .output()
                .unwrap();
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
        std::fs::set_permissions(&unreadable, std::fs::Permissions::from_mode(0)).unwrap();
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
    let mut roots = BTreeMap::new();
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
                let canonical = std::fs::canonicalize(&logical)
                    .map_err(|_| "selected OpenCode configured resource is unavailable")?;
                roots.insert((logical.clone(), role), canonical);
            }
        }
    }
    let mut units = Vec::new();
    let mut identities = BTreeMap::new();
    for ((logical, role), canonical) in roots {
        let next = identities.len();
        let ordinal = *identities.entry(canonical.clone()).or_insert(next);
        let kind = if canonical.is_file() {
            ProviderResourceKind::File
        } else {
            ProviderResourceKind::Directory
        };
        let name = if kind == ProviderResourceKind::File {
            format!("root-{ordinal}/source")
        } else {
            format!("root-{ordinal}")
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
            },
        ));
    }
    Ok(units)
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
            manifest.user_owns_freshell_mcp |=
                freshell_platform::opencode_config::source_owns_freshell_mcp(
                    source.references.unexpanded_source(),
                    &source.source.logical_path,
                    cwd,
                )
                .map_err(|error| error.to_string())?;
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

pub(super) fn describe(
    root: &Path,
    home: &Path,
    plan: &[PlannedSourceOccurrence],
    soul: &freshell_runtime_protocol::SoulId,
    capability: &freshell_runtime_protocol::McpCapabilityReference,
    initial_auth_reservation: Option<&str>,
    config_root: Option<&Path>,
    workspace: &Path,
    secret_references: &[freshell_runtime_protocol::ProviderSecretReference],
) -> Result<freshell_runtime_protocol::PreparedProviderInputs, String> {
    use freshell_runtime_protocol::*;
    use sha2::{Digest, Sha256};
    use std::io::Read;
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
                if relative.starts_with(".freshell/resources") {
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
