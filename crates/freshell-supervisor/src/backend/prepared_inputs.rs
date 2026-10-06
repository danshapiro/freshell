use super::*;

pub const INDEXED_VOLUME_OPTIONS: &str =
    "size=64m,mode=0700,uid=65534,gid=0,nr_inodes=1024,nosuid,nodev,noexec";

pub(super) fn mount_descriptors(
    mounts: &docker::TerminalMounts,
    provider_volume: &str,
) -> Result<Vec<Value>, BackendError> {
    let mut selected = BTreeMap::<String, Value>::new();
    let mut add = |destination: &str, value: Value| -> Result<(), BackendError> {
        if selected
            .insert(destination.to_owned(), value.clone())
            .is_some_and(|prior| prior != value)
        {
            return Err(BackendError::InvalidConfig(
                "prepared mounts have conflicting effective destinations".into(),
            ));
        }
        Ok(())
    };
    for bind in &mounts.config_binds {
        add(
            &bind.reference.effective_destination,
            json!({"Type":"bind","Source":bind.source,"Target":bind.reference.effective_destination,"ReadOnly":true}),
        )?;
    }
    for root in &mounts.resource_mounts {
        add(
            &root.effective_destination,
            json!({"Type":"volume","Source":provider_volume,"Target":root.effective_destination,
            "ReadOnly":root.kind==freshell_runtime_protocol::ProviderResourceKind::File,
            "VolumeOptions":{"NoCopy":true,"Subpath":root.provider_relative_path}}),
        )?;
    }
    if let Some(files) = &mounts.indexed_files {
        for (index, source_id) in &mounts.indexed_secret_sources {
            if *index >= mounts.provider_secret_files.len() || *source_id >= 128 {
                return Err(BackendError::InvalidConfig(
                    "prepared private input index is invalid".into(),
                ));
            }
            let destination = format!("/run/freshell-secrets/provider-{index}");
            add(
                &destination,
                json!({"Type":"volume","Source":files.volume_name,"Target":destination,"ReadOnly":true,
                "VolumeOptions":{"NoCopy":true,"Subpath":format!("files/source-{source_id}")}}),
            )?;
        }
        for alias in &files.aliases {
            add(
                &alias.effective_destination,
                json!({"Type":"volume","Source":files.volume_name,"Target":alias.effective_destination,"ReadOnly":true,
                "VolumeOptions":{"NoCopy":true,"Subpath":format!("files/source-{}",alias.source_id)}}),
            )?;
        }
    } else if !mounts.indexed_secret_sources.is_empty() {
        return Err(BackendError::InvalidConfig(
            "prepared private input volume is missing".into(),
        ));
    }
    Ok(selected.into_values().collect())
}

pub(super) fn verify(
    actual: &Value,
    mounts: &docker::TerminalMounts,
    provider_volume: &str,
    volumes: &BTreeMap<String, Value>,
) -> Result<(), BackendError> {
    let expected = mount_descriptors(mounts, provider_volume)?;
    if expected.is_empty() {
        return Ok(());
    }
    let mismatch = || {
        BackendError::OwnershipMismatch(
            "prepared provider mount/subpath/owned-volume topology changed".into(),
        )
    };
    let declared = actual["HostConfig"]["Mounts"]
        .as_array()
        .ok_or_else(mismatch)?;
    let reported = actual["Mounts"].as_array().ok_or_else(mismatch)?;
    if declared.len() != expected.len() {
        return Err(mismatch());
    }
    for mount in expected {
        let target = mount["Target"].as_str().ok_or_else(mismatch)?;
        let declarations = declared
            .iter()
            .filter(|value| value["Target"] == target)
            .collect::<Vec<_>>();
        let reports = reported
            .iter()
            .filter(|value| value["Destination"] == target)
            .collect::<Vec<_>>();
        if declarations.len() != 1 || reports.len() != 1 {
            return Err(mismatch());
        }
        let declaration = declarations[0];
        let report = reports[0];
        if ["Type", "Source", "Target"]
            .iter()
            .any(|key| declaration[key] != mount[key])
            || input_publisher::mount_readonly(&declaration["ReadOnly"])
                != input_publisher::mount_readonly(&mount["ReadOnly"])
            || report["Type"] != mount["Type"]
            || report["RW"].as_bool() != mount["ReadOnly"].as_bool().map(|readonly| !readonly)
        {
            return Err(mismatch());
        }
        if mount["Type"] == "bind" {
            if report["Source"] != mount["Source"] {
                return Err(mismatch());
            }
        } else {
            if declaration["VolumeOptions"]["Subpath"] != mount["VolumeOptions"]["Subpath"]
                || declaration["VolumeOptions"]["NoCopy"] != true
                || !declaration["VolumeOptions"]["DriverConfig"].is_null()
                || report["Name"] != mount["Source"]
            {
                return Err(mismatch());
            }
            let name = mount["Source"].as_str().ok_or_else(mismatch)?;
            let volume = volumes.get(name).ok_or_else(mismatch)?;
            if volume["Name"] != name
                || volume["Driver"] != "local"
                || !volume["Mountpoint"].is_string()
                || report["Source"] != volume["Mountpoint"]
            {
                return Err(mismatch());
            }
            if mounts
                .indexed_files
                .as_ref()
                .is_some_and(|files| files.volume_name == name)
                && volume["Options"]
                    != json!({"type":"tmpfs","device":"tmpfs","o":INDEXED_VOLUME_OPTIONS})
            {
                return Err(mismatch());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_runtime_protocol::{
        IndexedProviderFileAlias, IndexedProviderFiles, ProviderConfigBind, ProviderResourceKind,
        ProviderResourceMount,
    };
    fn fixture() -> (docker::TerminalMounts, Value, BTreeMap<String, Value>) {
        let mounts = docker::TerminalMounts {
            workspace: "/fixture/workspace".into(),
            git_common_dir: None,
            provider_bootstrap_files: vec![],
            provider_secret_files: vec![],
            indexed_secret_sources: BTreeMap::new(),
            provider_user_root: None,
            mcp_capability_file: None,
            input_manifest: None,
            config_binds: vec![docker::ResolvedProviderConfigBind {
                source: "/private-stage/template".into(),
                reference: ProviderConfigBind {
                    source_relative_path: ".freshell/templates/source-0".into(),
                    logical_destination: "/fixture/opencode.json".into(),
                    effective_destination: "/fixture/opencode.json".into(),
                },
            }],
            resource_mounts: vec![ProviderResourceMount {
                stage_relative_path: ".freshell/resource-units/plugin-0".into(),
                provider_relative_path: ".freshell/provider-roots/plugin-0".into(),
                logical_destination: "/outside/plugin".into(),
                effective_destination: "/outside/plugin".into(),
                kind: ProviderResourceKind::Directory,
            }],
            indexed_files: Some(IndexedProviderFiles {
                volume_name: "freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa".into(),
                aliases: vec![IndexedProviderFileAlias {
                    source_id: 0,
                    logical_destination: "/outside/credential".into(),
                    effective_destination: "/outside/credential".into(),
                }],
            }),
        };
        let descriptors = mount_descriptors(&mounts, "owned-provider").unwrap();
        let actual = json!({"HostConfig":{"Mounts":descriptors},"Mounts":[
            {"Type":"bind","Source":"/private-stage/template","Destination":"/fixture/opencode.json","RW":false},
            {"Type":"volume","Name":"owned-provider","Source":"/docker/volumes/owned-provider/_data","Destination":"/outside/plugin","RW":true},
            {"Type":"volume","Name":"freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa","Source":"/docker/volumes/freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa/_data","Destination":"/outside/credential","RW":false},
        ]});
        let volumes = BTreeMap::from([
            (
                "owned-provider".into(),
                json!({"Name":"owned-provider","Driver":"local","Mountpoint":"/docker/volumes/owned-provider/_data","Options":{}}),
            ),
            (
                "freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa".into(),
                json!({"Name":"freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa","Driver":"local","Mountpoint":"/docker/volumes/freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa/_data","Options":{"type":"tmpfs","device":"tmpfs","o":INDEXED_VOLUME_OPTIONS}}),
            ),
        ]);
        (mounts, actual, volumes)
    }

    #[test]
    fn provider_prepared_adoption_accepts_docker_omitted_writable_default() {
        let (mounts, mut actual, volumes) = fixture();
        actual["HostConfig"]["Mounts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|mount| mount["ReadOnly"] == false)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("ReadOnly");
        verify(&actual, &mounts, "owned-provider", &volumes)
            .expect("Docker's absent ReadOnly field means the exact selected writable directory");
        actual["HostConfig"]["Mounts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|mount| mount["Target"] == "/outside/plugin")
            .unwrap()["ReadOnly"] = json!(true);
        assert!(verify(&actual, &mounts, "owned-provider", &volumes).is_err());
    }

    #[test]
    fn provider_prepared_indexed_secret_read_uses_the_published_generation() {
        let (mut mounts, mut actual, volumes) = fixture();
        mounts.provider_secret_files = vec!["/approved/controller-source".into()];
        mounts.indexed_secret_sources.insert(0, 0);
        let descriptors = mount_descriptors(&mounts, "owned-provider").unwrap();
        let private=descriptors.iter().find(|mount|mount["Target"]=="/run/freshell-secrets/provider-0")
            .expect("host input must bind the already-published generation, not the changing controller source");
        assert_eq!(private["Type"], "volume");
        assert_eq!(
            private["Source"],
            "freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert_eq!(private["VolumeOptions"]["Subpath"], "files/source-0");
        assert_eq!(private["ReadOnly"], true);
        actual["HostConfig"]["Mounts"] = json!(descriptors);
        actual["Mounts"].as_array_mut().unwrap().push(json!({"Type":"volume","Name":"freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa","Source":"/docker/volumes/freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa/_data","Destination":"/run/freshell-secrets/provider-0","RW":false}));
        verify(&actual, &mounts, "owned-provider", &volumes).unwrap();
        actual["Mounts"].as_array_mut().unwrap().push(json!({"Type":"bind","Source":"/fixture/workspace","Destination":"/fixture/workspace","RW":true}));
        super::super::verify_workload_mounts(actual["Mounts"].as_array().unwrap(), &mounts)
            .unwrap();
        actual["HostConfig"]["Mounts"]
            .as_array_mut()
            .unwrap()
            .iter_mut()
            .find(|mount| mount["Target"] == "/run/freshell-secrets/provider-0")
            .unwrap()["VolumeOptions"]["Subpath"] = json!("files/source-1");
        assert!(verify(&actual, &mounts, "owned-provider", &volumes).is_err());
    }
    #[test]
    fn provider_prepared_adoption_checks_subpaths_nocopy_and_actual_volume_options() {
        let (mounts, actual, volumes) = fixture();
        verify(&actual, &mounts, "owned-provider", &volumes).unwrap();
        let alias = actual["HostConfig"]["Mounts"]
            .as_array()
            .unwrap()
            .iter()
            .position(|mount| mount["Target"] == "/outside/credential")
            .unwrap();
        for mode in [
            "subpath",
            "nocopy",
            "mount-type",
            "writable",
            "source",
            "volume-options",
        ] {
            let mut changed = actual.clone();
            let mut changed_volumes = volumes.clone();
            match mode {
                "subpath" => {
                    changed["HostConfig"]["Mounts"][alias]["VolumeOptions"]["Subpath"] =
                        json!("files/source-1")
                }
                "nocopy" => {
                    changed["HostConfig"]["Mounts"][alias]["VolumeOptions"]["NoCopy"] = json!(false)
                }
                "mount-type" => changed["Mounts"][2]["Type"] = json!("bind"),
                "writable" => changed["Mounts"][2]["RW"] = json!(true),
                "source" => changed["Mounts"][2]["Source"] = json!("/other/volume/_data"),
                "volume-options" => {
                    changed_volumes
                        .get_mut("freshell-inputs-aaaaaaaaaaaaaaaaaaaaaaaa")
                        .unwrap()["Options"]["o"] = json!("size=512m")
                }
                _ => unreachable!(),
            }
            assert!(
                verify(&changed, &mounts, "owned-provider", &changed_volumes).is_err(),
                "changed {mode} must prevent adoption"
            );
        }
    }
}
